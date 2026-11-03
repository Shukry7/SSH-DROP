import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type {
  DirectoryListing,
  FileAction,
  RecoveryAction,
  SessionEvent,
  TransferUpdate,
} from '../../shared/contracts';
import { remotePath } from '../../shared/validation';
import type { HostTrust } from './host-trust';
import { readDirectory } from './directory';
import { changeRemoteFile, type FileActionWarning } from './file-actions';
import { runTransfer, transferLimits, transferWarning } from './transfer';
import { Replacements, recoveryView, type ReplacementApproval } from './replacement';
import { replacementIO } from './replacement-io';
import { type RecoveryStore, type ServerIdentity } from './recovery-store';
import { TransferQueue, type QueuedFile } from './transfer-queue';
import { runFolderTransfer } from './folder-transfer';

export class Session {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private shell?: ClientChannel;
  private transfers = new Map<string, AbortController>();
  private connecting = false;
  private pendingOutput = new Map<number, number>();
  private outputBytes = 0;
  private outputId = 0;
  private fileAction?: AbortController;
  private identity?: ServerIdentity;
  private recoveryBusy = false;
  private readonly queue = new TransferQueue(
    (job) => this.transfer(job.direction, job.local, job.remote, undefined, job.id, job.folder),
    (transfer) => this.emit({ type: 'transfer', transfer }),
    (queue) => this.emit({ type: 'queue', queue }),
  );

  constructor(
    private readonly trust: Pick<HostTrust, 'verify'>,
    private readonly emit: (event: SessionEvent) => void,
    private readonly transferTiming = transferLimits,
    private readonly recoveryOptions?: {
      store: RecoveryStore;
      confirm: (approval: ReplacementApproval) => Promise<number>;
    },
  ) {}

  async connect(config: ConnectConfig): Promise<void> {
    if (this.client || this.connecting)
      throw new Error('Disconnect the current session before connecting again.');
    this.connecting = true;
    this.emit({ type: 'terminal-reset' });
    const client = new Client();
    this.client = client;
    let trustError: Error | undefined;
    let fingerprint = '';
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
              (accepted) => {
                if (accepted) fingerprint = createHash('sha256').update(key).digest('hex');
                callback(accepted);
              },
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
        this.identity = {
          host: config.host!,
          port: config.port ?? 22,
          username: config.username!,
          fingerprint,
        };
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
    this.fileAction?.abort();
    if (this.transfers.size || this.queue.size)
      this.emit({ type: 'transfer-warning', message: transferWarning });
    this.queue.clear();
    for (const controller of this.transfers.values())
      controller.abort(new Error('Transfer interrupted by disconnection.'));
    this.transfers.clear();
    this.pendingOutput.clear();
    this.outputBytes = 0;
    const client = this.client;
    this.client = undefined;
    this.shell = undefined;
    this.sftp = undefined;
    this.identity = undefined;
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

  async changeFile(
    input: FileAction,
    confirm: (warning: FileActionWarning) => Promise<boolean>,
  ): Promise<boolean> {
    if (this.fileAction || this.transfers.size || this.queue.size)
      throw new Error('Wait for the active file operation or transfer to finish.');
    const sftp = this.files();
    const controller = new AbortController();
    const client = this.client;
    this.fileAction = controller;
    try {
      return await changeRemoteFile(
        sftp,
        input,
        () => this.sftp === sftp,
        controller.signal,
        confirm,
        () => {
          if (this.client !== client) return;
          this.disconnect();
          this.emit({
            type: 'status',
            connected: false,
            message:
              'File operation interrupted. Reconnect and inspect the folder before retrying.',
          });
        },
      );
    } finally {
      if (this.fileAction === controller) this.fileAction = undefined;
    }
  }

  cancel(id: string): void {
    if (this.queue.cancel(id)) return;
    const controller = this.transfers.get(id);
    if (!controller) throw new Error('That transfer is no longer active.');
    controller.abort();
  }
  enqueue(files: QueuedFile[]): void {
    this.files();
    if (this.fileAction || ((this.transfers.size || this.recoveryBusy) && !this.queue.activeId))
      throw new Error('Wait for the active file or recovery operation to finish.');
    this.queue.enqueue(files);
  }
  async resumeQueue(confirm: () => Promise<boolean>): Promise<void> {
    if (this.transfers.size || this.fileAction || this.recoveryBusy)
      throw new Error('Wait for the active operation before continuing the queue.');
    const check = this.lease();
    const revision = this.queue.revision;
    if (!(await confirm())) return;
    check();
    if (this.transfers.size || this.fileAction || this.recoveryBusy)
      throw new Error('Wait for the active operation before continuing the queue.');
    if (revision !== this.queue.revision)
      throw new Error('The queue changed while confirming. Review it and try again.');
    this.queue.resume();
  }

  lease(): () => void {
    const sftp = this.files();
    return () => {
      if (this.sftp !== sftp) throw new Error('The connection changed. Select the file again.');
    };
  }

  async recovery() {
    const check = this.lease();
    if (!this.recoveryOptions || !this.identity) throw new Error('Recovery is unavailable.');
    const records = await this.recoveryOptions.store.list(this.identity);
    check();
    return records.map(recoveryView);
  }

  async recover(action: RecoveryAction): Promise<void> {
    if (!this.recoveryOptions) throw new Error('Recovery is unavailable.');
    await this.transfer('upload', 'Recovery', '/', action);
  }

  async transfer(
    direction: 'upload' | 'download',
    local: string,
    remote: string,
    recoveryAction?: RecoveryAction,
    queueId?: string,
    folder = false,
  ): Promise<void> {
    if (
      this.queue.size &&
      (!queueId || queueId !== this.queue.activeId) &&
      !(recoveryAction && this.queue.isPaused && !this.queue.activeId)
    )
      throw new Error('Finish or cancel the queued files before starting a recovery operation.');
    if (this.fileAction) throw new Error('Wait for the active file operation to finish.');
    if (this.recoveryBusy || (this.recoveryOptions && this.transfers.size))
      throw new Error('Wait for the active transfer or recovery operation to finish.');
    const sftp = this.files();
    const path = remotePath(remote);
    if (this.transfers.size >= 2) throw new Error('Wait for an active transfer to finish.');
    const id = queueId ?? randomUUID();
    const controller = new AbortController();
    this.transfers.set(id, controller);
    const client = this.client;
    const update: TransferUpdate = {
      id,
      name: basename(local),
      direction,
      total: 0,
      transferred: 0,
      status: 'running',
      phase: 'preparing',
    };
    const publish = () => {
      if (this.sftp === sftp) this.emit({ type: 'transfer', transfer: { ...update } });
    };
    const current = () => this.sftp === sftp;
    const invalidate = () => {
      if (this.client !== client) return;
      this.disconnect();
      client?.destroy();
      this.emit({
        type: 'status',
        connected: false,
        message:
          'Transfer interrupted. Reconnect and inspect recovery and the selected folders before retrying.',
      });
    };
    publish();
    try {
      if (folder) {
        await runFolderTransfer({
          sftp,
          direction,
          local,
          remote: path,
          signal: controller.signal,
          current,
          update,
          publish,
          limits: this.transferTiming,
          invalidate,
          warn: () => this.emit({ type: 'transfer-warning', message: transferWarning }),
        });
        return;
      }
      if (this.recoveryOptions && this.identity) {
        this.recoveryBusy = true;
        const check = () => {
          controller.signal.throwIfAborted();
          if (!current()) throw new Error('Connection changed.');
        };
        const replacements = new Replacements({
          store: this.recoveryOptions.store,
          identity: this.identity,
          localIO: replacementIO(undefined, controller.signal, current, invalidate),
          remoteIO: replacementIO(sftp, controller.signal, current, invalidate),
          check,
          confirm: this.recoveryOptions.confirm,
          transfer: async (d, l, r) => {
            check();
            const nested: TransferUpdate = {
              ...update,
              direction: d,
              status: 'running',
              total: 0,
              transferred: 0,
            };
            await runTransfer({
              sftp,
              direction: d,
              local: l,
              remote: r,
              signal: controller.signal,
              current,
              update: nested,
              publish: () => {
                Object.assign(update, {
                  total: nested.total,
                  transferred: nested.transferred,
                  phase: nested.phase,
                });
                publish();
              },
              limits: this.transferTiming,
              warn: () => this.emit({ type: 'transfer-warning', message: transferWarning }),
              invalidate,
            });
            check();
            if (nested.status !== 'completed')
              throw new Error(nested.error ?? 'Transfer cancelled.');
          },
        });
        const completed = recoveryAction
          ? await replacements.recover(recoveryAction.id, recoveryAction.action)
          : await replacements.transfer(direction, local, path);
        update.status = completed ? 'completed' : 'cancelled';
        publish();
        return;
      }
      await runTransfer({
        sftp,
        direction,
        local,
        remote: path,
        signal: controller.signal,
        current: () => this.sftp === sftp,
        update,
        publish,
        limits: this.transferTiming,
        warn: () => this.emit({ type: 'transfer-warning', message: transferWarning }),
        invalidate: () => {
          if (this.client !== client) return;
          this.disconnect();
          client?.destroy();
          this.emit({
            type: 'status',
            connected: false,
            message:
              'Transfer interrupted. Reconnect and inspect the selected folders before retrying.',
          });
        },
      });
    } catch (error) {
      update.status =
        controller.signal.aborted &&
        controller.signal.reason?.name === 'AbortError' &&
        !(error instanceof Error && error.message.includes('uncertain'))
          ? 'cancelled'
          : 'failed';
      update.error = error instanceof Error ? error.message : 'Transfer failed.';
      publish();
      throw error;
    } finally {
      if (this.recoveryOptions) this.recoveryBusy = false;
      this.transfers.delete(id);
    }
  }
}
