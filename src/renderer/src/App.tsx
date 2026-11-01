import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AppInfo,
  DirectoryListing,
  FileAction,
  KeySelection,
  Result,
  TransferUpdate,
} from '../../shared/contracts';
import { Terminal } from './Terminal';
import { ConnectionField, ConnectionGuide, connectionHelp } from './ConnectionHelp';
import { SavedProfiles } from './SavedProfiles';
import { FileActionDialog } from './FileActionDialog';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function size(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
}
function join(directory: string, name: string): string {
  return `${directory === '/' ? '' : directory}/${name}`;
}

export function App() {
  const [info, setInfo] = useState<AppInfo>();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [message, setMessage] = useState('Ready when you are. Connect to a server to begin.');
  const [error, setError] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [key, setKey] = useState<KeySelection | null>(null);
  const [path, setPath] = useState('/');
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<TransferUpdate[]>([]);
  const navigation = useRef(0);
  const connectionEpoch = useRef(0);
  const actionLock = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionInput, setActionInput] = useState<Exclude<FileAction, { action: 'delete' }>>();
  const fileBusy =
    actionBusy || loading || transfers.some((transfer) => transfer.status === 'running');

  useEffect(() => {
    void window.sshdrop.info().then((result) => {
      if (result.ok) setInfo(result.value);
      else setError(result.error);
    });
    return window.sshdrop.onEvent((event) => {
      if (event.type === 'status') {
        setConnected(event.connected);
        setMessage(event.message);
        if (!event.connected) {
          connectionEpoch.current++;
          setActionInput(undefined);
          setTransfers([]);
          navigation.current++;
          setListing(undefined);
          setLoading(false);
        }
      }
      if (event.type === 'terminal-reset') setTransfers([]);
      if (event.type === 'transfer')
        setTransfers((previous) =>
          [event.transfer, ...previous.filter((item) => item.id !== event.transfer.id)].slice(
            0,
            30,
          ),
        );
    });
  }, []);

  async function run(operation: () => Promise<unknown>) {
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Operation failed.');
    }
  }

  async function changeFile(input: FileAction): Promise<boolean> {
    if (actionLock.current) return false;
    actionLock.current = true;
    setActionBusy(true);
    setError('');
    const epoch = connectionEpoch.current;
    let changed = false;
    try {
      changed = unwrap(await window.sshdrop.fileAction(input));
      if (epoch !== connectionEpoch.current) return true;
      if (changed) {
        setMessage('Remote change completed.');
        try {
          await browse(input.directory);
        } catch {
          setError(
            'The change completed, but refreshing failed. Refresh or reconnect to inspect the folder; do not repeat the change.',
          );
        }
      }
      return true;
    } catch (failure) {
      setError(
        epoch === connectionEpoch.current && failure instanceof Error
          ? failure.message
          : 'Connection changed during a file operation. Its result may be uncertain; inspect the remote folder before retrying.',
      );
      return changed;
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function browse(destination: string) {
    const request = ++navigation.current;
    setLoading(true);
    try {
      const result = unwrap(await window.sshdrop.list(destination));
      if (request === navigation.current) {
        setListing(result);
        setPath(result.path);
      }
    } finally {
      if (request === navigation.current) setLoading(false);
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setConnecting(true);
      setMessage('Connecting… verify the server fingerprint if prompted.');
      let established = false;
      try {
        unwrap(
          await window.sshdrop.connect({
            host,
            port: Number(port),
            username,
            auth,
            ...(auth === 'password' ? { password } : { keyId: key?.id, passphrase }),
          }),
        );
        established = true;
        await browse(path);
      } catch (failure) {
        if (!established)
          setMessage('Connection failed. Check the connection details and try again.');
        throw failure;
      } finally {
        setConnecting(false);
        setPassword('');
        setPassphrase('');
      }
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">↗</span>
          <strong>
            SSHDrop<span className="brand-dot">.</span>
          </strong>
          <span className="version">v{info?.version ?? '…'}</span>
        </div>
        <div className="topbar-right">
          <span className={`connection-pill ${connected ? 'live' : ''}`}>
            <i />
            {connected ? `${username}@${host}` : 'No active connection'}
          </span>
          <span className="preview-badge">EARLY PREVIEW</span>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="section-label">YOUR WORKSPACE</div>
          <h1>
            Make yourself
            <br />
            at remote.
          </h1>
          <p className="muted">
            Your terminal and files,
            <br />
            in the same place.
          </p>
          <div className="sidebar-divider" />
          <div className="section-label">SSH CONNECTION</div>
          <SavedProfiles
            disabled={connected || connecting}
            details={{
              host,
              port: Number(port),
              username,
              auth,
              startingDirectory: path,
              ...(auth === 'key' && key ? { keyId: key.id } : {}),
            }}
            onError={setError}
            onBusy={setProfileBusy}
            onLoad={({ profile, key: savedKey }) => {
              setHost(profile.host);
              setPort(String(profile.port));
              setUsername(profile.username);
              setAuth(profile.auth);
              setPath(profile.startingDirectory);
              setKey(savedKey);
              setPassword('');
              setPassphrase('');
            }}
            onNew={() => {
              setHost('');
              setPort('22');
              setUsername('');
              setAuth('password');
              setPath('/');
              setKey(null);
              setPassword('');
              setPassphrase('');
            }}
          />
          <ConnectionGuide />
          <form onSubmit={connect} className="connection-form">
            <fieldset disabled={connected || connecting || profileBusy}>
              <ConnectionField id="connection-host" label="Host" help={connectionHelp.host}>
                <input
                  id="connection-host"
                  aria-describedby="connection-host-help"
                  required
                  autoComplete="off"
                  placeholder="192.168.1.10"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </ConnectionField>
              <div className="form-row">
                <ConnectionField
                  id="connection-username"
                  label="Username"
                  help={connectionHelp.username}
                >
                  <input
                    id="connection-username"
                    aria-describedby="connection-username-help"
                    required
                    autoComplete="off"
                    placeholder="deploy"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </ConnectionField>
                <ConnectionField
                  id="connection-port"
                  label="Port"
                  help={connectionHelp.port}
                  className="port-field"
                >
                  <input
                    id="connection-port"
                    aria-describedby="connection-port-help"
                    required
                    type="number"
                    min="1"
                    max="65535"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </ConnectionField>
              </div>
              <ConnectionField
                id="connection-auth"
                label="Authentication"
                help={connectionHelp.authentication}
              >
                <select
                  id="connection-auth"
                  aria-describedby="connection-auth-help"
                  value={auth}
                  onChange={(e) => {
                    setAuth(e.target.value as 'password' | 'key');
                    setPassword('');
                    setPassphrase('');
                    setKey(null);
                  }}
                >
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                </select>
              </ConnectionField>
              {auth === 'password' ? (
                <ConnectionField
                  id="connection-password"
                  label="Password"
                  help={connectionHelp.password}
                >
                  <input
                    id="connection-password"
                    aria-describedby="connection-password-help"
                    required
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Session only"
                  />
                </ConnectionField>
              ) : (
                <>
                  <ConnectionField
                    id="connection-key"
                    label="Private key"
                    help={connectionHelp.privateKey}
                    labelInput={false}
                  >
                    <button
                      id="connection-key"
                      aria-describedby="connection-key-help"
                      type="button"
                      className="secondary key-button"
                      onClick={() =>
                        void run(async () => setKey(unwrap(await window.sshdrop.chooseKey())))
                      }
                    >
                      {key ? key.name : 'Choose private key…'}
                    </button>
                  </ConnectionField>
                  <ConnectionField
                    id="connection-passphrase"
                    label="Key passphrase"
                    help={connectionHelp.passphrase}
                  >
                    <input
                      id="connection-passphrase"
                      aria-describedby="connection-passphrase-help"
                      type="password"
                      autoComplete="off"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="If required"
                    />
                  </ConnectionField>
                </>
              )}
              <ConnectionField
                id="connection-directory"
                label="Starting directory"
                help={connectionHelp.directory}
              >
                <input
                  id="connection-directory"
                  aria-describedby="connection-directory-help"
                  required
                  pattern="/.*"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </ConnectionField>
              <button className="primary connect-button" type="submit">
                {connecting ? 'Connecting…' : 'Connect to server'}
                <span aria-hidden="true">↗</span>
              </button>
            </fieldset>
          </form>
          {connected && (
            <button
              className="secondary disconnect-button"
              onClick={() => void run(async () => unwrap(await window.sshdrop.disconnect()))}
            >
              Disconnect
            </button>
          )}
          <div className="privacy-note">
            <span>◇</span>
            <p>
              Credentials stay in this session.
              <br />
              Server identity is always checked.
            </p>
          </div>
          <div className="sidebar-footer">BUILT FOR THE WAY YOU WORK</div>
        </aside>
        <main className="main-area">
          <div className="workspace-heading">
            <div>
              <div className="section-label">REMOTE WORKSPACE</div>
              <h2>{connected ? host : 'A little closer to your server.'}</h2>
            </div>
            <span className="protocol-label">SSH / SFTP</span>
          </div>
          {error && !actionInput && (
            <div role="alert" className="error-banner">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          <section className="explorer panel" aria-label="Remote file explorer">
            <div className="panel-heading">
              <h3>
                <span className="panel-icon">▱</span> Files
              </h3>
              <div className="toolbar">
                <button
                  className="secondary compact"
                  disabled={!connected || fileBusy}
                  onClick={() =>
                    void run(() => browse(listing?.path.replace(/\/[^/]+\/?$/, '') || '/'))
                  }
                >
                  ↑ Parent
                </button>
                <button
                  className="secondary compact"
                  disabled={!connected || fileBusy}
                  onClick={() => void run(() => browse(listing?.path ?? path))}
                >
                  ↻ Refresh
                </button>
                <button
                  className="secondary compact"
                  disabled={!connected || !listing || fileBusy}
                  onClick={() =>
                    void run(async () => {
                      unwrap(await window.sshdrop.upload(listing!.path));
                      await browse(listing!.path);
                    })
                  }
                >
                  ↑ Upload file
                </button>
                <button
                  className="secondary compact"
                  disabled={!connected || !listing || fileBusy}
                  onClick={() => {
                    setError('');
                    setActionInput({ action: 'create-folder', directory: listing!.path, name: '' });
                  }}
                >
                  New folder
                </button>
              </div>
            </div>
            <form
              className="pathbar"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => browse(path));
              }}
            >
              <span>/</span>
              <input
                aria-label="Remote directory"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={!connected || actionBusy}
              />
              <button type="submit" disabled={!connected || fileBusy}>
                Go →
              </button>
            </form>
            {!listing ? (
              <div className="empty-state">
                <div className="empty-icon">▱</div>
                <h3>
                  {connected ? 'Your remote files belong here.' : 'Your server. A familiar view.'}
                </h3>
                <p>
                  {connected
                    ? 'Enter an accessible directory above to browse files.'
                    : 'Connect to browse folders, move files, and get to work.'}
                </p>
                <span className="small-label">EXPLICIT DESTINATIONS. NO GUESSWORK.</span>
              </div>
            ) : (
              <div className="file-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>Modified</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.entries.map((entry) => (
                      <tr key={entry.name}>
                        <td>
                          <button
                            className="file-name"
                            onClick={() => {
                              if (entry.kind === 'directory')
                                void run(() => browse(join(listing.path, entry.name)));
                            }}
                            disabled={entry.kind !== 'directory' || fileBusy}
                          >
                            <span
                              className={
                                entry.kind === 'directory' ? 'folder-icon' : 'document-icon'
                              }
                            >
                              {entry.kind === 'directory'
                                ? '▰'
                                : entry.kind === 'symlink'
                                  ? '↗'
                                  : '▫'}
                            </span>
                            {entry.name}
                          </button>
                        </td>
                        <td>{entry.kind === 'directory' ? '—' : size(entry.size)}</td>
                        <td>{new Date(entry.modified).toLocaleString()}</td>
                        <td>
                          {entry.kind === 'file' && (
                            <button
                              className="text-button"
                              disabled={actionBusy || loading}
                              onClick={() =>
                                void run(async () =>
                                  unwrap(
                                    await window.sshdrop.download(join(listing.path, entry.name)),
                                  ),
                                )
                              }
                            >
                              Download ↓
                            </button>
                          )}
                          {(entry.kind === 'file' || entry.kind === 'directory') && (
                            <>
                              <button
                                className="text-button"
                                disabled={!connected || fileBusy}
                                onClick={() => {
                                  setError('');
                                  setActionInput({
                                    action: 'rename',
                                    directory: listing.path,
                                    name: entry.name,
                                    newName: entry.name,
                                    kind: entry.kind as 'file' | 'directory',
                                  });
                                }}
                              >
                                Rename
                              </button>
                              <button
                                className="text-button danger-button"
                                disabled={!connected || fileBusy}
                                title="Permanently delete this file or empty folder. Cannot be undone."
                                onClick={() =>
                                  void changeFile({
                                    action: 'delete',
                                    directory: listing.path,
                                    name: entry.name,
                                    kind: entry.kind as 'file' | 'directory',
                                  })
                                }
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {listing.entries.length === 0 && (
                  <p className="empty-directory">This directory is empty.</p>
                )}
              </div>
            )}
            <div className="panel-footer">
              <span>
                {loading
                  ? 'Loading directory…'
                  : listing
                    ? `${listing.entries.length} items`
                    : 'Waiting for connection'}
              </span>
              <span>Remote Linux filesystem</span>
            </div>
          </section>
          {actionInput && (
            <FileActionDialog
              input={actionInput}
              busy={actionBusy}
              error={error}
              submit={changeFile}
              close={() => {
                setActionInput(undefined);
                setError('');
              }}
            />
          )}
          <section className="terminal-panel panel" aria-label="Terminal panel">
            <div className="panel-heading">
              <h3>
                <span className="terminal-symbol">›_</span> Terminal{' '}
                <span className="terminal-tab">shell 01</span>
              </h3>
              <span className="small-label">{connected ? 'INTERACTIVE SSH' : 'NOT CONNECTED'}</span>
            </div>
            <div className="terminal-container">
              <Terminal connected={connected} />
              {!connected && (
                <div className="terminal-placeholder">
                  <span>$</span> Your next command starts here.
                  <i />
                </div>
              )}
            </div>
          </section>
          {transfers.length > 0 && (
            <section className="transfers panel" aria-label="File transfers">
              <div className="panel-heading">
                <h3>Transfers</h3>
                <span className="small-label">THIS SESSION</span>
              </div>
              {transfers.map((transfer) => (
                <div className="transfer-row" key={transfer.id}>
                  <span>{transfer.direction === 'upload' ? '↑' : '↓'}</span>
                  <div className="transfer-details">
                    <strong>{transfer.name}</strong>
                    <progress
                      value={transfer.transferred}
                      max={transfer.total || 1}
                      aria-label={`Progress for ${transfer.name}`}
                    />
                    <small>
                      {transfer.error ??
                        `${size(transfer.transferred)} / ${size(transfer.total)} · ${transfer.status}`}
                    </small>
                  </div>
                  {transfer.status === 'running' && (
                    <button
                      className="text-button"
                      onClick={() =>
                        void run(async () => unwrap(await window.sshdrop.cancel(transfer.id)))
                      }
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          <i className={connected ? 'status-dot active' : 'status-dot'} />
          {message}
        </span>
        <span>
          {info?.platform ?? 'desktop'} <b>·</b> v{info?.version ?? '…'}
        </span>
      </footer>
    </div>
  );
}
