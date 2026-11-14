import { createHash, randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
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
import { terminalTabLimit } from '../../shared/terminal-limits';
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
import { readDroppedFileFingerprint } from './dropped-files';
import { RemoteEditor } from './remote-editor';
import { readImagePreview } from './image-preview';
import type { EditorDocument, EditorComparison } from '../../shared/editor';
import { runWorkflow } from './workflow-runner';
import { shellQuote, type WorkflowPlan } from '../../shared/workflows';
import { TransferFailure, transferWait } from './transfer-wait';
import {
  TransferRecovery,
  checkRecoverablePaths,
  fingerprintRecoverableFile,
  savedTransferByteLimit,
} from './transfer-recovery';

interface TerminalShell {
  channel: ClientChannel;
  pendingBytes: number;
}

type TerminalEditor = 'nano' | 'vim';
interface TerminalEdit {
  path: string;
  choose: (signal: AbortSignal) => Promise<TerminalEditor | undefined>;
}

export class Session {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private readonly terminals = new Map<string, TerminalShell>();
  private readonly closingTerminals = new Set<ClientChannel>();
  private readonly exitedTerminals = new Set<string>();
  private primaryTerminal?: string;
  private openingTerminal?: AbortController;
  private transfers = new Map<string, AbortController>();
  private connecting = false;
  private setup?: AbortController;
  private pendingOutput = new Map<number, { terminal: TerminalShell; bytes: number }>();
  private outputId = 0;
  private fileAction?: AbortController;
  private imageRequest?: { id: string; controller: AbortController };
  private identity?: ServerIdentity;
  private recoveryBusy = false;
  private workflow?: { id: string; controller: AbortController };
  private commandServer = '';
  private rememberTransfers = false;
  private readonly editor = new RemoteEditor();
  private readonly queue = new TransferQueue(
    (job) => this.runQueuedTransfer(job),
    (transfer) => this.emit({ type: 'transfer', transfer }),
    (queue) => this.emit({ type: 'queue', queue }),
    (job, cancelled) => {
      if (job.recoveryId) void this.settleSavedTransfer(job.recoveryId, cancelled);
    },
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
    private readonly transferRecovery?: TransferRecovery,
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
      this.primaryTerminal = this.registerTerminal(shell);
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
          this.editor.clear();
          this.emit({ type: 'sftp-exit' });
        };
        sftp.on('error', filesClosed);
        sftp.on('close', filesClosed);
      } catch {
        setup.signal.throwIfAborted();
        if (this.client !== client) throw new Error('Connection was cancelled.');
      }
      const terminal = this.terminals.size > 0;
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
    this.editor.clear();
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
    this.openingTerminal?.abort();
    this.openingTerminal = undefined;
    this.pendingOutput.clear();
    this.terminals.clear();
    this.closingTerminals.clear();
    this.exitedTerminals.clear();
    this.primaryTerminal = undefined;
    const client = this.client;
    this.client = undefined;
    this.sftp = undefined;
    this.identity = undefined;
    client?.end();
    this.emit({ type: 'terminal-reset' });
  }

  private registerTerminal(
    channel: ClientChannel,
    editor?: { name: TerminalEditor; path: string },
  ): string {
    const terminalId = randomUUID();
    const terminal = { channel, pendingBytes: 0 };
    const decoder = new StringDecoder('utf8');
    this.terminals.set(terminalId, terminal);
    channel.on('data', (data: Buffer) => {
      if (this.terminals.has(terminalId)) this.output(terminalId, terminal, decoder.write(data));
    });
    channel.on('error', () => {
      /* The close event reports shell termination. */
    });
    channel.on('close', () => {
      if (!this.terminals.has(terminalId)) return;
      this.output(terminalId, terminal, decoder.end());
      this.releaseTerminal(terminalId, terminal);
      this.exitedTerminals.add(terminalId);
      this.emit({ type: 'terminal-exit', terminalId });
    });
    this.emit({ type: 'terminal-opened', terminalId, ...(editor && { editor }) });
    return terminalId;
  }

  async openTerminal(edit?: TerminalEdit): Promise<void> {
    const client = this.client;
    if (!client || this.connecting) throw new Error('Connect to a server first.');
    if (this.openingTerminal) throw new Error('A terminal is already opening.');
    if (
      this.terminals.size + this.closingTerminals.size + this.exitedTerminals.size >=
      terminalTabLimit
    )
      throw new Error('Close a terminal before opening another.');
    const controller = new AbortController();
    this.openingTerminal = controller;
    let started = false;
    let replied = false;
    const release = () => {
      if (this.openingTerminal === controller) this.openingTerminal = undefined;
    };
    try {
      const sftp = edit && this.files();
      const check = () => {
        controller.signal.throwIfAborted();
        if (this.client !== client || (sftp && sftp !== this.sftp))
          throw new Error('The connection changed while opening a terminal.');
      };
      let editor: { name: TerminalEditor; path: string } | undefined;
      if (edit && sftp) {
        const path = remotePath(edit.path);
        const name = await edit.choose(controller.signal);
        check();
        if (!name) return;
        const parent = posix.dirname(path);
        const canonical = await transferWait<string>(
          (done) => sftp.realpath(parent, done),
          this.setupTimeout,
          controller.signal,
        );
        check();
        if (canonical !== parent)
          throw new Error('Refresh the file list and open the canonical folder.');
        const stats = await transferWait<import('ssh2').Stats>(
          (done) => sftp.lstat(path, done),
          this.setupTimeout,
          controller.signal,
        );
        check();
        if (!stats.isFile()) throw new Error('Choose a regular remote file.');
        editor = { name, path };
      }
      const pty = { term: 'xterm-256color', cols: 100, rows: 28 };
      const channel = await transferWait<ClientChannel>(
        (done) => {
          const callback = (error: Error | undefined, channel: ClientChannel) => {
            replied = true;
            done(error, channel);
            release();
          };
          started = true;
          try {
            if (editor) {
              const command =
                editor.name === 'nano' ? 'nano -I' : "vim --clean -n --cmd 'set nomodeline'";
              client.exec(`exec ${command} -- ${shellQuote(editor.path)} 2>&1`, { pty }, callback);
            } else {
              client.shell(pty, callback);
            }
          } catch (error) {
            started = false;
            throw error;
          }
        },
        this.setupTimeout,
        controller.signal,
        (late) => {
          if (this.client === client) this.endTerminal(late);
          else late.close();
        },
      );
      try {
        check();
      } catch (error) {
        if (this.client === client) this.endTerminal(channel);
        else channel.close();
        throw error;
      }
      this.registerTerminal(channel, editor);
    } finally {
      if (!started || replied) release();
    }
  }

  private releaseTerminal(terminalId: string, terminal: TerminalShell): void {
    this.terminals.delete(terminalId);
    for (const [id, pending] of this.pendingOutput)
      if (pending.terminal === terminal) this.pendingOutput.delete(id);
  }

  closeTerminal(terminalId: string): void {
    this.exitedTerminals.delete(terminalId);
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    this.releaseTerminal(terminalId, terminal);
    this.endTerminal(terminal.channel);
  }

  private endTerminal(channel: ClientChannel): void {
    this.closingTerminals.add(channel);
    channel.on('error', () => {
      /* The close event releases the channel slot. */
    });
    channel.once('close', () => this.closingTerminals.delete(channel));
    channel.close();
  }

  private output(terminalId: string, terminal: TerminalShell, data: string): void {
    if (!data) return;
    const id = ++this.outputId;
    const bytes = Buffer.byteLength(data);
    this.pendingOutput.set(id, { terminal, bytes });
    terminal.pendingBytes += bytes;
    if (terminal.pendingBytes >= 512 * 1024) terminal.channel.pause();
    this.emit({ type: 'terminal', terminalId, data, id });
  }

  acknowledge(id: number): void {
    const pending = this.pendingOutput.get(id);
    if (!pending) return;
    this.pendingOutput.delete(id);
    pending.terminal.pendingBytes -= pending.bytes;
    if (pending.terminal.pendingBytes < 256 * 1024) pending.terminal.channel.resume();
  }

  private terminal(terminalId = this.primaryTerminal): ClientChannel {
    const terminal = terminalId && this.terminals.get(terminalId);
    if (!terminal) throw new Error('No active terminal.');
    return terminal.channel;
  }

  input(data: string, terminalId?: string): void {
    this.terminal(terminalId).write(data);
  }

  resize(cols: number, rows: number, terminalId?: string): void {
    this.terminal(terminalId).setWindow(rows, cols, 0, 0);
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
  cancelImage(requestId: string): void {
    if (this.imageRequest?.id === requestId)
      this.imageRequest.controller.abort(new Error('Image preview cancelled.'));
  }
  async previewImage(path: string, requestId: string) {
    if (
      this.workflow ||
      this.fileAction ||
      this.transfers.size ||
      this.queue.size ||
      this.recoveryBusy
    )
      throw new Error('Finish the active operation before previewing an image.');
    remotePath(path);
    const sftp = this.files();
    const controller = new AbortController();
    this.fileAction = controller;
    this.imageRequest = { id: requestId, controller };
    const timer = setTimeout(
      () =>
        controller.abort(new Error('Image preview timed out. Try again on a stable connection.')),
      60000,
    );
    try {
      return await readImagePreview(path, {
        sftp,
        signal: controller.signal,
        current: () => this.sftp === sftp,
        invalidate: () => {
          if (this.sftp !== sftp) return;
          this.disconnect();
          this.emit({
            type: 'status',
            connected: false,
            lost: true,
            message: 'Image preview interrupted. Reconnect to try again.',
          });
        },
      });
    } finally {
      clearTimeout(timer);
      if (this.fileAction === controller) this.fileAction = undefined;
      if (this.imageRequest?.controller === controller) this.imageRequest = undefined;
    }
  }
  closeEditor(token: string): void {
    if (this.fileAction) throw new Error('Wait for the active file operation to finish.');
    this.editor.close(token);
  }

  async editText(input: { path: string }): Promise<EditorDocument>;
  async editText(input: { token: string; text: string }): Promise<boolean>;
  async editText(input: { token: string; compare: true }): Promise<EditorComparison>;
  async editText(input: {
    token: string;
    reviewToken: string;
    keepDraft: boolean;
  }): Promise<EditorDocument | null>;
  async editText(
    input:
      | { path: string }
      | { token: string; text: string }
      | { token: string; compare: true }
      | { token: string; reviewToken: string; keepDraft: boolean },
  ) {
    if (
      this.workflow ||
      this.fileAction ||
      this.transfers.size ||
      this.queue.size ||
      this.recoveryBusy
    )
      throw new Error('Finish the active operation before opening or saving an editor file.');
    const sftp = this.files();
    const controller = new AbortController();
    this.fileAction = controller;
    const current = () => this.sftp === sftp;
    const check = () => {
      controller.signal.throwIfAborted();
      if (!current()) throw new Error('The connection changed. Reopen the editor file.');
    };
    const invalidate = () => {
      if (!current()) return;
      this.disconnect();
      this.emit({
        type: 'status',
        connected: false,
        lost: true,
        message:
          'Editor operation interrupted. Inspect the remote file and recovery before retrying.',
      });
    };
    try {
      return await this.editor.operate(
        { sftp, signal: controller.signal, current, invalidate },
        async (io, guard) => {
          if ('path' in input) return this.editor.open(input.path, io, guard);
          if ('compare' in input) return this.editor.compare(input.token, io, guard);
          if (!this.recoveryOptions || !this.identity)
            throw new Error('Editor saving is unavailable.');
          if ('reviewToken' in input)
            return this.editor.accept(
              input.token,
              input.reviewToken,
              input.keepDraft,
              io,
              guard,
              this.recoveryOptions.confirm,
            );
          return this.editor.save(input.token, input.text, io, guard, {
            ...this.recoveryOptions,
            identity: this.identity,
            check,
          });
        },
      );
    } catch (error) {
      if (error instanceof Error && /uncertain/i.test(error.message))
        this.emit({ type: 'transfer-warning', message: transferWarning });
      throw error;
    } finally {
      if (this.fileAction === controller) this.fileAction = undefined;
    }
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
  setTransferMemory(enabled: boolean): void {
    this.rememberTransfers = enabled;
  }

  async queueFiles(files: QueuedFile[]): Promise<void> {
    if (!this.rememberTransfers || files.some((file) => file.folder && file.direction === 'upload'))
      return this.enqueue(files);
    const store = this.savedTransferStore();
    if (files.length > 8)
      throw new Error('Queue up to eight files at a time with transfer recovery enabled.');
    await this.withIdleTransferSlot(async (sftp, identity, signal) => {
      const batch = [];
      for (const file of this.queue.validate(files))
        batch.push({
          file,
          hash: file.folder ? undefined : await fingerprintRecoverableFile(sftp, file, signal),
        });
      const records = await store.add(identity, batch);
      try {
        signal.throwIfAborted();
        if (this.sftp !== sftp) throw new Error('The connection changed.');
        this.queue.enqueue(
          records.map((record) => ({
            ...record.file,
            recoveryId: record.id,
            expectedSourceHash: record.hash,
          })),
          false,
        );
      } catch (error) {
        for (const { id } of records) store.release(id);
        throw error;
      }
    });
  }

  private savedTransferStore() {
    if (!this.transferRecovery) throw new Error('Saved transfers are unavailable.');
    return this.transferRecovery;
  }

  private async withIdleTransferSlot<T>(
    action: (sftp: SFTPWrapper, identity: ServerIdentity, signal: AbortSignal) => Promise<T>,
  ) {
    const sftp = this.files();
    const identity = this.identity;
    if (
      !identity ||
      this.workflow ||
      this.fileAction ||
      this.transfers.size ||
      this.queue.size ||
      this.recoveryBusy
    )
      throw new Error('Finish queued transfers and other file operations first.');
    const controller = new AbortController();
    this.fileAction = controller;
    try {
      return await action(sftp, identity, controller.signal);
    } finally {
      if (this.fileAction === controller) this.fileAction = undefined;
      this.queue.start();
    }
  }

  async savedTransfers() {
    const check = this.lease();
    const records = await this.savedTransferStore().list(this.identity!);
    check();
    return records;
  }

  async reviewSavedTransfer(
    id: string,
    action: 'retry' | 'forget',
    confirm: (record: {
      local: string;
      remote: string;
      direction: 'upload' | 'download';
      folder?: true;
      copiedFiles?: number;
      totalFiles?: number;
    }) => Promise<boolean>,
  ) {
    const store = this.savedTransferStore();
    await this.withIdleTransferSlot(async (sftp, identity, signal) => {
      const record = await store.claim(identity, id);
      let queued = false;
      try {
        const savedFiles = record.folderCheckpoint?.entries.filter((entry) => entry.hash);
        if (
          !(await confirm({
            ...record.file,
            copiedFiles: savedFiles?.filter((entry) => entry.destinationKey).length,
            totalFiles: savedFiles?.length,
          }))
        )
          return;
        signal.throwIfAborted();
        if (this.sftp !== sftp) throw new Error('The connection changed.');
        if (action === 'forget') return await store.finish(id);
        if (!record.file.folder) {
          if (record.file.direction === 'download')
            await checkRecoverablePaths(sftp, record.file, signal);
          else if ((await fingerprintRecoverableFile(sftp, record.file, signal)) !== record.hash)
            throw new Error('The saved transfer source changed. Select the file again.');
        }
        signal.throwIfAborted();
        if (this.sftp !== sftp) throw new Error('The connection changed.');
        this.queue.enqueue(
          [{ ...record.file, recoveryId: id, expectedSourceHash: record.hash }],
          false,
        );
        queued = true;
      } finally {
        if (!queued) store.release(id);
      }
    });
  }

  private async settleSavedTransfer(id: string, remove: boolean) {
    if (!remove) return this.transferRecovery?.release(id);
    try {
      await this.transferRecovery?.finish(id);
    } catch {
      this.emit({
        type: 'transfer-warning',
        message:
          'Could not clear a saved transfer. Inspect the destination before reviewing it again.',
      });
    }
  }

  private async runQueuedTransfer(job: import('./transfer-queue').QueuedJob) {
    const sftp = this.sftp;
    let finished = false;
    try {
      await this.transfer(
        job.direction,
        job.local,
        job.remote,
        undefined,
        job.id,
        job.folder,
        job.sourceFingerprint,
        job.expectedSourceHash,
        job.recoveryId,
      );
      finished = !!sftp && sftp === this.sftp;
    } finally {
      if (job.recoveryId) await this.settleSavedTransfer(job.recoveryId, finished);
    }
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
    sourceFingerprint?: string,
    expectedSourceHash?: string,
    recoveryId?: string,
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
    const verifyDroppedSource = async () => {
      if (!sourceFingerprint) return;
      const latest = await transferWait<string>(
        (done) => {
          void readDroppedFileFingerprint(local).then(
            (value) => done(undefined, value),
            (error: Error) => done(error),
          );
        },
        this.transferTiming.request,
        controller.signal,
      );
      if (latest !== sourceFingerprint)
        throw new Error('A dropped file changed after review. Drop it again.');
    };
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
      if (sourceFingerprint) await verifyDroppedSource();
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
          checkpoint: recoveryId
            ? {
                load: () => this.savedTransferStore().readFolderCheckpoint(recoveryId),
                save: (checkpoint) =>
                  this.savedTransferStore().saveFolderCheckpoint(recoveryId, checkpoint),
              }
            : undefined,
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
      if (replacements && !expectedSourceHash) {
        this.recoveryBusy = true;
        const check = () => {
          controller.signal.throwIfAborted();
          if (!current()) throw new Error('Connection changed.');
        };
        const replacement = replacements(
          async (d, l, r) => {
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
              sourceFingerprint: d === 'upload' && l === local ? sourceFingerprint : undefined,
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
            if (nested.status !== 'completed')
              throw new Error(nested.error ?? 'Transfer cancelled.');
          },
          sourceFingerprint ? verifyDroppedSource : undefined,
        );
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
        sourceFingerprint,
        expectedSourceHash,
        uploadCheckpoint:
          recoveryId && direction === 'upload' && this.transferRecovery
            ? {
                maxBytes: savedTransferByteLimit,
                load: () => this.savedTransferStore().readUploadStage(recoveryId),
                save: (stage) => this.savedTransferStore().saveUploadStage(recoveryId, stage),
              }
            : undefined,
        downloadCheckpoint:
          recoveryId && direction === 'download' && this.transferRecovery
            ? {
                maxBytes: savedTransferByteLimit,
                load: () => this.savedTransferStore().readDownloadPrefix(recoveryId),
                save: (bytes, size) =>
                  this.savedTransferStore().saveDownloadPrefix(recoveryId, bytes, size),
              }
            : undefined,
        beforePublish: expectedSourceHash
          ? () => checkRecoverablePaths(sftp, { direction, local, remote: path }, controller.signal)
          : undefined,
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
