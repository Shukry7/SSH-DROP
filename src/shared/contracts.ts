export interface ConnectionInput {
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key';
  password?: string;
  keyId?: string;
  passphrase?: string;
}

export interface RemoteEntry {
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: number;
  modified: number;
  mode?: number;
}

export interface DirectoryListing {
  path: string;
  entries: RemoteEntry[];
}
export type FileAction =
  | { action: 'create-file'; directory: string; name: string }
  | { action: 'create-folder'; directory: string; name: string }
  | { action: 'copy' | 'move'; directory: string; name: string; destinationDirectory: string }
  | {
      action: 'permissions';
      directory: string;
      name: string;
      kind: 'file' | 'directory';
      expectedMode: number;
      mode: string;
    }
  | {
      action: 'rename';
      directory: string;
      name: string;
      newName: string;
      kind: 'file' | 'directory';
    }
  | { action: 'delete'; directory: string; name: string; kind: 'file' | 'directory' };
export interface AppInfo {
  name: string;
  version: string;
  description: string;
  platform: string;
}
export interface KeySelection {
  id: string;
  name: string;
}
export interface ProfileDetails {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key';
  startingDirectory: string;
}
export interface ProfileInput extends ProfileDetails {
  id?: string;
  keyId?: string;
}
export interface ServerProfile extends ProfileDetails {
  id: string;
  keyName?: string;
}
export interface LoadedProfile {
  profile: ServerProfile;
  key: KeySelection | null;
}
export interface TransferUpdate {
  id: string;
  name: string;
  direction: 'upload' | 'download';
  transferred: number;
  total: number;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  phase?: 'preparing' | 'transferring' | 'verifying' | 'finalizing';
  folderFiles?: { copied: number; skipped: number; total: number };
  error?: string;
}
export interface QueueState {
  pending: number;
  active: boolean;
  paused: boolean;
}
export interface SavedTransfer {
  id: string;
  local: string;
  remote: string;
  direction: 'upload' | 'download';
  created: string;
  folder?: true;
  copiedFiles?: number;
  skippedFiles?: number;
  merge?: true;
  totalFiles?: number;
}
export interface RecoveryView {
  encrypted: boolean;
  imported?: true;
  id: string;
  direction: 'upload' | 'download';
  path: string;
  created: string;
  state:
    | 'preparing'
    | 'backup-ready'
    | 'publishing'
    | 'completed'
    | 'uncertain'
    | 'restored'
    | 'not-replaced';
  size: number;
}
export interface RecoveryAction {
  id: string;
  action: 'inspect' | 'rollback' | 'restore-copy' | 'delete-backup' | 'encrypt-backup';
}
export type SessionEvent =
  | { type: 'idle'; state: import('./idle').IdleState }
  | { type: 'workflow-warning'; message: string }
  | { type: 'workflow'; update: import('./workflows').WorkflowUpdate }
  | { type: 'workflow-reset' }
  | { type: 'queue'; queue: QueueState }
  | { type: 'terminal-reset' }
  | { type: 'terminal-opened'; terminalId: string; editor?: { name: 'nano' | 'vim'; path: string } }
  | {
      type: 'status';
      connected: boolean;
      message: string;
      lost?: true;
      terminal?: boolean;
      sftp?: boolean;
    }
  | { type: 'terminal'; terminalId: string; data: string; id: number }
  | { type: 'terminal-exit'; terminalId: string }
  | { type: 'sftp-exit' }
  | { type: 'transfer'; transfer: TransferUpdate }
  | { type: 'transfer-warning'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  createWorkspace(): Promise<Result<{ id: string; number: number }>>;
  closeWorkspace(): Promise<Result<boolean>>;
  forWorkspace(id: string): DesktopAPI;
  exportBackup(value: { id: string; passphrase: string }): Promise<Result<boolean>>;
  openBackup(passphrase: string): Promise<Result<boolean>>;
  exportVault(passphrase: string): Promise<Result<boolean>>;
  importVault(passphrase: string): Promise<Result<boolean>>;
  idleStatus(): Promise<Result<import('./idle').IdleState>>;
  idleSettings(
    settings: import('./idle').IdleSettings,
  ): Promise<Result<import('./idle').IdleState>>;
  idleStayActive(): Promise<Result<void>>;
  idleEnd(): Promise<Result<void>>;
  idleReturn(): Promise<Result<void>>;
  workflows(): Promise<Result<import('./workflows').Workflow[]>>;
  importWorkflow(): Promise<Result<import('./workflows').Workflow | null>>;
  exportWorkflow(id: string): Promise<Result<boolean>>;
  saveWorkflow(
    value: import('./workflows').Workflow,
  ): Promise<Result<import('./workflows').Workflow>>;
  deleteWorkflow(id: string): Promise<Result<void>>;
  previewWorkflow(value: {
    id: string;
    values: Record<string, string>;
  }): Promise<Result<{ token: string; server: string; plan: import('./workflows').WorkflowPlan }>>;
  runWorkflow(token: string): Promise<Result<boolean>>;
  stopWorkflow(id: string): Promise<Result<void>>;
  info(): Promise<Result<AppInfo>>;
  chooseKey(): Promise<Result<KeySelection | null>>;
  profiles(): Promise<Result<ServerProfile[]>>;
  saveProfile(input: ProfileInput): Promise<Result<ServerProfile>>;
  loadProfile(id: string): Promise<Result<LoadedProfile>>;
  deleteProfile(id: string): Promise<Result<boolean>>;
  connect(input: ConnectionInput): Promise<Result<{ sftp: boolean }>>;
  cancelConnect(): Promise<Result<void>>;
  disconnect(): Promise<Result<void>>;
  list(path: string): Promise<Result<DirectoryListing>>;
  fileAction(input: FileAction): Promise<Result<boolean>>;
  openImage(input: {
    directory: string;
    name: string;
    requestId: string;
  }): Promise<Result<import('./image-preview').ImagePreview>>;
  cancelImage(requestId: string): Promise<Result<void>>;
  openEditor(input: {
    directory: string;
    name: string;
  }): Promise<Result<import('./editor').EditorDocument>>;
  saveEditor(input: { token: string; text: string }): Promise<Result<boolean>>;
  closeEditor(token: string): Promise<Result<void>>;
  compareEditor(token: string): Promise<Result<import('./editor').EditorComparison>>;
  acceptEditorReview(input: {
    token: string;
    reviewToken: string;
    keepDraft: boolean;
  }): Promise<Result<import('./editor').EditorDocument | null>>;
  recovery(): Promise<Result<RecoveryView[]>>;
  recover(input: RecoveryAction): Promise<Result<void>>;
  upload(directory: string): Promise<Result<void>>;
  uploadFolder(directory: string): Promise<Result<void>>;
  downloadFolder(path: string): Promise<Result<void>>;
  download(path: string): Promise<Result<void>>;
  downloadMany(paths: string[]): Promise<Result<void>>;
  resumeQueue(): Promise<Result<void>>;
  transferMemory(enabled: boolean): Promise<Result<void>>;
  savedTransfers(): Promise<Result<SavedTransfer[]>>;
  reviewSavedTransfer(input: { id: string; action: 'retry' | 'forget' }): Promise<Result<void>>;
  cancel(id: string): Promise<Result<void>>;
  openTerminal(): Promise<Result<void>>;
  openTerminalEditor(input: { directory: string; name: string }): Promise<Result<void>>;
  closeTerminal(terminalId: string): Promise<Result<void>>;
  input(data: string, terminalId?: string): Promise<Result<void>>;
  acknowledge(id: number): Promise<Result<void>>;
  resize(size: { cols: number; rows: number; terminalId?: string }): Promise<Result<void>>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  onDropError(listener: (error: string) => void): () => void;
}
