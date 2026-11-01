import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { DirectoryListing, SessionEvent, TransferUpdate } from '../../shared/contracts';
import { remotePath } from '../../shared/validation';
import type { HostTrust } from './host-trust';
import { readDirectory } from './directory';

export class Session {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private shell?: ClientChannel;
  private transfers = new Map<string, AbortController>();
  private connecting = false;
  private pendingOutput = new Map<number, number>();
  private outputBytes = 0;
  private outputId = 0;

  constructor(
    private readonly trust: Pick<HostTrust, 'verify'>,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  async connect(config: ConnectConfig): Promise<void> {
    if (this.client || this.connecting)
      throw new Error('Disconnect the current session before connecting again.');
    this.connecting = true;
    this.emit({ type: 'terminal-reset' });
    const client = new Client();
    this.client = client;
    let trustError: Error | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', (error) => reject(trustError ?? error));
        client.once('close', () => reject(trustError ?? new Error('Connection closed.')));
        client.connect({
          ...config,
          readyTimeout: 30000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
            void this.trust.verify(config.host!, config.port ?? 22, key).then(
              (accepted) => callback(accepted),
              (error: Error) => {
                trustError = error;
                callback(false);
              },
            );
          },
        });
      });
      client.on('error', () => {
        /* The close event reports the disconnected state. */
      });
      client.on('close', () => {
        if (this.client === client) {
          this.disconnect();
          this.emit({
            type: 'status',
            connected: false,
            message: 'Connection closed. Connect again to start a new shell.',
          });
        }
      });
      const shell = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell({ term: 'xterm-256color', cols: 100, rows: 28 }, (error, stream) =>
          error ? reject(error) : resolve(stream),
        ),
      );
      if (this.client !== client) {
        shell.close();
        throw new Error('Connection was cancelled.');
      }
      this.shell = shell;
      const decoder = new StringDecoder('utf8');
      shell.on('data', (data: Buffer) => {
        if (this.shell === shell) this.output(decoder.write(data));
      });
      shell.on('error', () => {
        /* The close event reports shell termination. */
      });
      shell.on('close', () => {
        if (this.shell !== shell) return;
        const tail = decoder.end();
        if (tail) this.output(tail);
        this.shell = undefined;
        this.emit({ type: 'terminal-exit' });
      });
      try {
        const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
          client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
        );
        if (this.client !== client) {
          sftp.end();
          throw new Error('Connection was cancelled.');
        }
        this.sftp = sftp;
        sftp.on('error', () => {
          if (this.sftp === sftp) this.sftp = undefined;
        });
        this.emit({
          type: 'status',
          connected: true,
          message: 'Connected. Terminal and SFTP ready.',
        });
      } catch {
        if (this.client !== client) throw new Error('Connection was cancelled.');
        this.emit({
          type: 'status',
          connected: true,
          message: 'Terminal connected. SFTP is unavailable on this server.',
        });
      }
    } catch (error) {
      this.disconnect();
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): void {
    for (const controller of this.transfers.values()) controller.abort();
    this.transfers.clear();
    this.pendingOutput.clear();
    this.outputBytes = 0;
    const client = this.client;
    this.client = undefined;
    this.shell = undefined;
    this.sftp = undefined;
    client?.end();
    this.emit({ type: 'terminal-reset' });
  }

  private output(data: string): void {
    if (!data) return;
    const id = ++this.outputId;
    const bytes = Buffer.byteLength(data);
    this.pendingOutput.set(id, bytes);
    this.outputBytes += bytes;
    if (this.outputBytes >= 512 * 1024) this.shell?.pause();
    this.emit({ type: 'terminal', data, id });
  }

  acknowledge(id: number): void {
    const bytes = this.pendingOutput.get(id);
    if (bytes === undefined) return;
    this.pendingOutput.delete(id);
    this.outputBytes -= bytes;
    if (this.outputBytes < 256 * 1024) this.shell?.resume();
  }

  input(data: string): void {
    if (!this.shell) throw new Error('No active terminal.');
    this.shell.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.shell) throw new Error('No active terminal.');
    this.shell.setWindow(rows, cols, 0, 0);
  }

  private files(): SFTPWrapper {
    if (!this.sftp) throw new Error('SFTP is unavailable. Connect to a server with SFTP enabled.');
    return this.sftp;
  }

  async list(path: string): Promise<DirectoryListing> {
    const sftp = this.files();
    return readDirectory(sftp, path, () => this.sftp === sftp);
  }

  cancel(id: string): void {
    const controller = this.transfers.get(id);
    if (!controller) throw new Error('That transfer is no longer active.');
    controller.abort();
  }

  async transfer(direction: 'upload' | 'download', local: string, remote: string): Promise<void> {
    const sftp = this.files();
    const path = remotePath(remote);
    if (this.transfers.size >= 2) throw new Error('Wait for an active transfer to finish.');
    const total =
      direction === 'upload'
        ? await stat(local).then((info) => {
            if (!info.isFile())
              throw new Error('Select an individual file. Folder transfers are not available yet.');
            return info.size;
          })
        : await new Promise<number>((resolve, reject) =>
            sftp.stat(path, (error, info) => {
              if (error) reject(error);
              else if (!info.isFile())
                reject(new Error('Only individual files can be downloaded.'));
              else resolve(info.size);
            }),
          );
    if (this.sftp !== sftp) throw new Error('The connection changed before the transfer started.');
    if (this.transfers.size >= 2) throw new Error('Wait for an active transfer to finish.');
    const id = randomUUID();
    const controller = new AbortController();
    this.transfers.set(id, controller);
    const update: TransferUpdate = {
      id,
      name: basename(local),
      direction,
      total,
      transferred: 0,
      status: 'running',
    };
    const publish = () => {
      if (this.sftp === sftp) this.emit({ type: 'transfer', transfer: { ...update } });
    };
    let ownsDestination = false;
    let remoteHandle: Buffer | undefined;
    let localHandle: FileHandle | undefined;
    const closeTarget = async () => {
      if (remoteHandle) {
        const handle = remoteHandle;
        remoteHandle = undefined;
        await new Promise<void>((resolve, reject) =>
          sftp.close(handle, (error) => (error ? reject(error) : resolve())),
        );
      }
      if (localHandle) {
        const handle = localHandle;
        localHandle = undefined;
        await handle.close();
      }
    };
    let lastUpdate = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        update.transferred += chunk.length;
        if (Date.now() - lastUpdate > 100) {
          lastUpdate = Date.now();
          publish();
        }
        callback(null, chunk);
      },
    });
    publish();
    try {
      controller.signal.throwIfAborted();
      if (direction === 'upload')
        remoteHandle = await new Promise<Buffer>((resolve, reject) =>
          sftp.open(path, 'wx', 0o600, (error, handle) =>
            error ? reject(error) : resolve(handle),
          ),
        );
      else localHandle = await open(local, 'wx', 0o600);
      ownsDestination = true;
      controller.signal.throwIfAborted();
      const source = direction === 'upload' ? createReadStream(local) : sftp.createReadStream(path);
      const target =
        direction === 'upload'
          ? sftp.createWriteStream(path, { handle: remoteHandle, autoClose: false })
          : createWriteStream(local, { fd: localHandle!.fd, autoClose: false });
      await pipeline(source, meter, target, { signal: controller.signal });
      await closeTarget();
      update.status = 'completed';
      update.transferred = total;
    } catch (error) {
      update.status = controller.signal.aborted ? 'cancelled' : 'failed';
      update.error = controller.signal.aborted
        ? 'Transfer cancelled.'
        : 'Transfer failed. Existing files are never overwritten; check the destination and permissions.';
      await closeTarget().catch(() => undefined);
      if (ownsDestination) {
        try {
          if (direction === 'upload')
            await new Promise<void>((resolve, reject) =>
              sftp.unlink(path, (failure) => (failure ? reject(failure) : resolve())),
            );
          else await unlink(local);
        } catch {
          update.error += ' A partial destination may remain; inspect it before retrying.';
        }
      }
      if (!controller.signal.aborted) throw new Error(update.error, { cause: error });
    } finally {
      this.transfers.delete(id);
      publish();
    }
  }
}
