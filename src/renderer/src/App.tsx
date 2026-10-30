import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AppInfo,
  DirectoryListing,
  KeySelection,
  Result,
  TransferUpdate,
} from '../../shared/contracts';
import { Terminal } from './Terminal';

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
          navigation.current++;
          setListing(undefined);
          setLoading(false);
        }
      }
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
          <form onSubmit={connect} className="connection-form">
            <fieldset disabled={connected || connecting}>
              <label>
                Host
                <input
                  required
                  autoComplete="off"
                  placeholder="192.168.1.10"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  Username
                  <input
                    required
                    autoComplete="off"
                    placeholder="deploy"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </label>
                <label className="port-field">
                  Port
                  <input
                    required
                    type="number"
                    min="1"
                    max="65535"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
              </div>
              <label>
                Authentication
                <select
                  value={auth}
                  onChange={(e) => setAuth(e.target.value as 'password' | 'key')}
                >
                  <option value="password">Password</option>
                  <option value="key">Private key</option>
                </select>
              </label>
              {auth === 'password' ? (
                <label>
                  Password
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Session only"
                  />
                </label>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary key-button"
                    onClick={() =>
                      void run(async () => setKey(unwrap(await window.sshdrop.chooseKey())))
                    }
                  >
                    {key ? key.name : 'Choose private key…'}
                  </button>
                  <label>
                    Key passphrase
                    <input
                      type="password"
                      autoComplete="off"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="If required"
                    />
                  </label>
                </>
              )}
              <label>
                Starting directory
                <input
                  required
                  pattern="/.*"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
              <button className="primary connect-button" type="submit">
                {connecting ? 'Connecting…' : 'Connect to server'}
                <span>↗</span>
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
          {error && (
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
                  disabled={!connected || loading}
                  onClick={() =>
                    void run(() => browse(listing?.path.replace(/\/[^/]+\/?$/, '') || '/'))
                  }
                >
                  ↑ Parent
                </button>
                <button
                  className="secondary compact"
                  disabled={!connected || loading}
                  onClick={() => void run(() => browse(listing?.path ?? path))}
                >
                  ↻ Refresh
                </button>
                <button
                  className="secondary compact"
                  disabled={!connected || !listing}
                  onClick={() =>
                    void run(async () => {
                      unwrap(await window.sshdrop.upload(listing!.path));
                      await browse(listing!.path);
                    })
                  }
                >
                  ↑ Upload file
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
                disabled={!connected}
              />
              <button type="submit" disabled={!connected || loading}>
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
                            disabled={entry.kind !== 'directory'}
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
