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
}

export interface DirectoryListing {
  path: string;
  entries: RemoteEntry[];
}
export type FileAction =
  | { action: 'create-folder'; directory: string; name: string }
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
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  phase?: 'preparing' | 'transferring' | 'verifying' | 'finalizing';
  error?: string;
}
export interface RecoveryView {
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
  action: 'inspect' | 'rollback' | 'restore-copy' | 'delete-backup';
}
export type SessionEvent =
  | { type: 'terminal-reset' }
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'terminal'; data: string; id: number }
  | { type: 'terminal-exit' }
  | { type: 'transfer'; transfer: TransferUpdate }
  | { type: 'transfer-warning'; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  info(): Promise<Result<AppInfo>>;
  chooseKey(): Promise<Result<KeySelection | null>>;
  profiles(): Promise<Result<ServerProfile[]>>;
  saveProfile(input: ProfileInput): Promise<Result<ServerProfile>>;
  loadProfile(id: string): Promise<Result<LoadedProfile>>;
  deleteProfile(id: string): Promise<Result<boolean>>;
  connect(input: ConnectionInput): Promise<Result<void>>;
  disconnect(): Promise<Result<void>>;
  list(path: string): Promise<Result<DirectoryListing>>;
  fileAction(input: FileAction): Promise<Result<boolean>>;
  recovery(): Promise<Result<RecoveryView[]>>;
  recover(input: RecoveryAction): Promise<Result<void>>;
  upload(directory: string): Promise<Result<void>>;
  download(path: string): Promise<Result<void>>;
  cancel(id: string): Promise<Result<void>>;
  input(data: string): Promise<Result<void>>;
  acknowledge(id: number): Promise<Result<void>>;
  resize(size: { cols: number; rows: number }): Promise<Result<void>>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
