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
import {
  Replacements,
  recoveryView,
  type ReplacementApproval,
  type ReplacementContext,
} from './replacement';
import { replacementIO } from './replacement-io';
import { type RecoveryRecord, type RecoveryStore, type ServerIdentity } from './recovery-store';
import { TransferQueue, type QueuedFile } from './transfer-queue';
import { runFolderTransfer } from './folder-transfer';
import { runWorkflow } from './workflow-runner';
import type { WorkflowPlan } from '../../shared/workflows';
import { TransferFailure, transferWait } from './transfer-wait';

export class Session {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private shell?: ClientChannel;
  private transfers = new Map<string, AbortController>();
  private connecting = false;
  private setup?: AbortController;
  private pendingOutput = new Map<number, number>();
  private outputBytes = 0;
  private outputId = 0;
  private fileAction?: AbortController;
  private identity?: ServerIdentity;
  private recoveryBusy = false;
  private workflow?: { id: string; controller: AbortController };
  private commandServer = '';
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
    private readonly setupTimeout = 30000,
  ) {}

  async connect(config: ConnectConfig, signal?: AbortSignal): Promise<{ sftp: boolean }> {
    if (this.client || this.connecting)
      throw new Error('Disconnect the current session before connecting again.');
    signal?.throwIfAborted();
    this.connecting = true;
    const setup = new AbortController();
    this.setup = setup;
    const cancel = () => setup.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    this.emit({ type: 'terminal-reset' });
    const client = new Client();
    this.client = client;
    let trustError: Error | undefined;
    let fingerprint = '';
    client.on('error', () => {
      /* The setup promise or transport close reports the failure. */
    });
    client.on('close', () => {
      if (this.client !== client) return;
      if (this.setup === setup) {
        setup.abort(trustError ?? new Error('Connection closed during setup.'));
        return;
      }
      this.disconnect();
      this.emit({
        type: 'status',
        connected: false,
        lost: true,
        message: 'Connection lost. Reconnect to start a new session; nothing will be replayed.',
      });
    });
    try {
      await transferWait<void>(
        (done) => {
          client.once('ready', () => done());
          client.once('error', (error) => done(trustError ?? error));
          client.connect({
            ...config,
            readyTimeout: this.setupTimeout,
            keepaliveInterval: 15000,
            keepaliveCountMax: 3,
            hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
              void this.trust.verify(config.host!, config.port ?? 22, key, setup.signal).then(
                (accepted) => {
                  if (setup.signal.aborted) return;
                  if (accepted) fingerprint = createHash('sha256').update(key).digest('hex');
                  callback(accepted);
                },
                (error: Error) => {
                  if (setup.signal.aborted) return;
                  trustError = error;
                  callback(false);
                },
              );
            },
          });
        },
        this.setupTimeout,
        setup.signal,
      );
      const shell = await transferWait<ClientChannel>(
        (done) => client.shell({ term: 'xterm-256color', cols: 100, rows: 28 }, done),
        this.setupTimeout,
        setup.signal,
        (late) => late.close(),
      );
      if (setup.signal.aborted || this.client !== client) {
        shell.close();
        throw new Error('Connection was cancelled.');
      }
      this.commandServer = `${config.username}@${config.host}:${config.port ?? 22}`;
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
        const sftp = await transferWait<SFTPWrapper>(
          (done) => client.sftp(done),
          this.setupTimeout,
          setup.signal,
          (late) => late.end(),
        );
        if (setup.signal.aborted || this.client !== client) {
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
        const filesClosed = () => {
          if (this.sftp !== sftp) return;
          this.sftp = undefined;
          this.identity = undefined;
          this.emit({ type: 'sftp-exit' });
        };
        sftp.on('error', filesClosed);
        sftp.on('close', filesClosed);
      } catch {
        setup.signal.throwIfAborted();
        if (this.client !== client) throw new Error('Connection was cancelled.');
      }
      const terminal = !!this.shell;
      const sftp = !!this.sftp;
      this.emit({
        type: 'status',
        connected: true,
        terminal,
        sftp,
        message: terminal
          ? sftp
            ? 'Connected. Terminal and SFTP ready.'
            : 'Terminal connected. SFTP is unavailable on this server.'
          : 'SSH connected, but the terminal shell closed.',
      });
      return { sftp };
    } catch (error) {
      if (this.client === client) this.disconnect();
      client.destroy();
      if (error instanceof TransferFailure)
        throw new Error('SSH connection setup timed out. Check the server and try again.', {
          cause: error,
        });
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.setup = undefined;
      this.connecting = false;
    }
  }

  disconnect(): void {
    this.setup?.abort(new Error('Connection was cancelled.'));
    if (this.workflow)
      this.emit({
        type: 'workflow-warning',
        message:
          'A remote workflow was interrupted. Remote work may still be running or services may remain stopped. Inspect the server before retrying; no commands were automatically replayed. This notice contains no command or server names.',
      });
    this.workflow?.controller.abort();
    this.workflow = undefined;
    this.commandServer = '';
    this.emit({ type: 'workflow-reset' });
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
  workflowContext() {
    const client = this.client;
    if (!client || this.connecting || !this.commandServer)
      throw new Error('Connect to a server first.');
    return {
      server: this.commandServer,
      check: () => {
        if (this.client !== client || this.connecting)
          throw new Error('The connection changed. Review the workflow again.');
      },
    };
  }
  async executeWorkflow(plan: WorkflowPlan, id: string): Promise<void> {
    this.workflowContext();
    if (
      this.workflow ||
      this.queue.size ||
      this.transfers.size ||
      this.fileAction ||
      this.recoveryBusy
    )
      throw new Error(
        'Finish active transfers, recovery or file actions before running a workflow.',
      );
    const client = this.client!;
    const controller = new AbortController();
    const active = { id, controller };
    this.workflow = active;
    try {
      await runWorkflow(
        plan,
        id,
        (script, cb) => client.exec(script, (error, channel) => cb(error, channel)),
        controller.signal,
        () => this.client === client,
        (update) => this.emit({ type: 'workflow', update }),
      );
    } finally {
      if (this.workflow === active) this.workflow = undefined;
    }
  }
  stopWorkflow(id: string): void {
    if (this.workflow?.id !== id) throw new Error('That workflow is no longer running.');
    this.workflow.controller.abort();
  }

  async list(path: string): Promise<DirectoryListing> {
    const sftp = this.files();
    return readDirectory(sftp, path, () => this.sftp === sftp);
  }

  async changeFile(
    input: FileAction,
    confirm: (warning: FileActionWarning) => Promise<boolean>,
  ): Promise<boolean> {
    if (this.workflow) throw new Error('Stop the running workflow before changing files.');
    if (this.fileAction || this.transfers.size || this.queue.size || this.recoveryBusy)
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
          client?.destroy();
          this.emit({
            type: 'status',
            connected: false,
            lost: true,
            message:
              'File operation interrupted. Reconnect and inspect the affected folders before retrying.',
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
    if (this.workflow) throw new Error('Stop the running workflow before transferring files.');
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

  async withBackupExport<T>(
    id: string,
    operation: (record: RecoveryRecord, store: RecoveryStore, check: () => void) => Promise<T>,
  ): Promise<T> {
    const store = this.recoveryOptions?.store;
    if (!store || !this.identity)
      throw new Error('Connect to the verified server to export its backups.');
    if (
      this.recoveryBusy ||
      this.transfers.size ||
      this.fileAction ||
      this.workflow ||
      (this.queue.size && !this.queue.isPaused)
    )
      throw new Error(
        'Finish active transfers, workflows or recovery operations before exporting.',
      );
    const check = this.lease();
    this.recoveryBusy = true;
    try {
      const record = await store.load(id, this.identity);
      check();
      if (!record.encrypted) throw new Error('Secure this legacy backup before exporting.');
      return await operation(record, store, check);
    } finally {
      this.recoveryBusy = false;
    }
  }

  async transfer(
    direction: 'upload' | 'download',
    local: string,
    remote: string,
    recoveryAction?: RecoveryAction,
    queueId?: string,
    folder = false,
  ): Promise<void> {
    if (this.workflow) throw new Error('Stop the running workflow before transferring files.');
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
        lost: true,
        message:
          'Transfer interrupted. Reconnect and inspect recovery and the selected folders before retrying.',
      });
    };
    const warn = () => this.emit({ type: 'transfer-warning', message: transferWarning });
    const recovery = this.recoveryOptions;
    const identity = this.identity;
    const replacements =
      recovery && identity
        ? (transfer: ReplacementContext['transfer'], guard?: () => Promise<void>) =>
            new Replacements({
              store: recovery.store,
              identity,
              localIO: replacementIO(undefined, controller.signal, current, invalidate),
              remoteIO: replacementIO(sftp, controller.signal, current, invalidate),
              check: () => {
                controller.signal.throwIfAborted();
                if (!current()) throw new Error('Connection changed.');
              },
              confirm: async (approval) => {
                await guard?.();
                const choice = await recovery.confirm(approval);
                await guard?.();
                return choice;
              },
              beforePublish: guard,
              transfer,
            })
        : undefined;
    publish();
    try {
      if (folder) {
        this.recoveryBusy = !!replacements;
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
          warn,
          merge:
            recovery && replacements
              ? {
                  confirm: recovery.confirm,
                  conflict: (local, remote, transfer, guard) =>
                    replacements(transfer, guard).transfer(direction, local, remote, 'Skip file'),
                }
              : undefined,
        });
        return;
      }
      if (replacements) {
        this.recoveryBusy = true;
        const check = () => {
          controller.signal.throwIfAborted();
          if (!current()) throw new Error('Connection changed.');
        };
        const replacement = replacements(async (d, l, r) => {
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
            warn,
            invalidate,
          });
          check();
          if (nested.status !== 'completed') throw new Error(nested.error ?? 'Transfer cancelled.');
        });
        const completed = recoveryAction
          ? await replacement.recover(recoveryAction.id, recoveryAction.action)
          : await replacement.transfer(direction, local, path);
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
        warn,
        invalidate,
      });
    } catch (error) {
      update.status =
        controller.signal.aborted &&
        controller.signal.reason?.name === 'AbortError' &&
        !(error instanceof Error && error.message.includes('uncertain'))
          ? 'cancelled'
          : 'failed';
      update.error = error instanceof Error ? error.message : 'Transfer failed.';
      if (/uncertain/i.test(update.error))
        this.emit({ type: 'transfer-warning', message: transferWarning });
      publish();
      throw error;
    } finally {
      if (this.recoveryOptions) this.recoveryBusy = false;
      this.transfers.delete(id);
    }
  }
}
