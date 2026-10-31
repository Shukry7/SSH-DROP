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
export interface TransferUpdate {
  id: string;
  name: string;
  direction: 'upload' | 'download';
  transferred: number;
  total: number;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  error?: string;
}
export type SessionEvent =
  | { type: 'status'; connected: boolean; message: string }
  | { type: 'terminal'; data: string; id: number }
  | { type: 'terminal-exit' }
  | { type: 'transfer'; transfer: TransferUpdate };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  info(): Promise<Result<AppInfo>>;
  chooseKey(): Promise<Result<KeySelection | null>>;
  connect(input: ConnectionInput): Promise<Result<void>>;
  disconnect(): Promise<Result<void>>;
  list(path: string): Promise<Result<DirectoryListing>>;
  upload(directory: string): Promise<Result<void>>;
  download(path: string): Promise<Result<void>>;
  cancel(id: string): Promise<Result<void>>;
  input(data: string): Promise<Result<void>>;
  acknowledge(id: number): Promise<Result<void>>;
  resize(size: { cols: number; rows: number }): Promise<Result<void>>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
}
