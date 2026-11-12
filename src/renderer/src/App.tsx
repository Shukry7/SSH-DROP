import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AppInfo,
  DirectoryListing,
  FileAction,
  KeySelection,
  Result,
  TransferUpdate,
  QueueState,
} from '../../shared/contracts';
import { Terminal } from './Terminal';
import { ConnectionField, ConnectionGuide, connectionHelp } from './ConnectionHelp';
import { SavedProfiles } from './SavedProfiles';
import { FileActionDialog } from './FileActionDialog';
import { Recovery } from './Recovery';
import { PortableBackup } from './PortableBackup';
import { Workflows } from './Workflows';

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

export function App({ sessionProtection }: { sessionProtection?: ReactNode }) {
  const [info, setInfo] = useState<AppInfo>();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [lost, setLost] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const connectionAttempt = useRef(false);
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
  const [queue, setQueue] = useState<QueueState>({ pending: 0, active: false, paused: false });
  const [selected, setSelected] = useState<string[]>([]);
  const listingPath = useRef<string | undefined>(undefined);
  const selectableFiles = listing?.entries.filter((entry) => entry.kind === 'file') ?? [];
  const selectionPage = selectableFiles.slice(0, 100);
  const [transferNotice, setTransferNotice] = useState('');
  const navigation = useRef(0);
  const connectionEpoch = useRef(0);
  const actionLock = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionInput, setActionInput] = useState<Exclude<FileAction, { action: 'delete' }>>();
  const filesReady = connected && sftpOpen;
  const fileBusy =
    actionBusy ||
    loading ||
    queue.active ||
    queue.pending > 0 ||
    transfers.some((transfer) => transfer.status === 'running' || transfer.status === 'queued');

  useEffect(() => {
    void window.sshdrop.info().then((result) => {
      if (result.ok) setInfo(result.value);
      else setError(result.error);
    });
    const clearListing = () => {
      setSelected([]);
      listingPath.current = undefined;
      navigation.current++;
      setListing(undefined);
      setLoading(false);
    };
    return window.sshdrop.onEvent((event) => {
      if (event.type === 'status') {
        setConnected(event.connected);
        setLost(event.lost === true);
        setTerminalOpen(event.connected && event.terminal !== false);
        setSftpOpen(event.connected && event.sftp !== false);
        setMessage(event.message);
        if (!event.connected) {
          connectionEpoch.current++;
          setError('');
          setActionBusy(false);
          setActionInput(undefined);
          setTransfers([]);
          setQueue({ pending: 0, active: false, paused: false });
          clearListing();
        }
      }
      if (event.type === 'terminal-exit') setTerminalOpen(false);
      if (event.type === 'sftp-exit') {
        setSftpOpen(false);
        setActionInput(undefined);
        clearListing();
        setMessage('File browsing closed. The SSH connection may still be active.');
      }
      if (event.type === 'terminal-reset') setTransfers([]);
      if (event.type === 'transfer-warning') setTransferNotice(event.message);
      if (event.type === 'queue') setQueue(event.queue);
      if (event.type === 'transfer') {
        setTransfers((previous) =>
          [event.transfer, ...previous.filter((item) => item.id !== event.transfer.id)].filter(
            (item, index) => item.status === 'queued' || item.status === 'running' || index < 150,
          ),
        );
        if (
          event.transfer.status === 'completed' &&
          event.transfer.direction === 'upload' &&
          listingPath.current
        ) {
          const directory = listingPath.current;
          const epoch = connectionEpoch.current;
          const request = ++navigation.current;
          void window.sshdrop.list(directory).then((result) => {
            if (epoch !== connectionEpoch.current || request !== navigation.current) return;
            if (result.ok) setListing(result.value);
            else
              setError(
                'Transfer completed, but refreshing failed. Inspect the folder before retrying.',
              );
          });
        }
      }
    });
  }, []);

  async function run(operation: () => Promise<unknown>) {
    setError('');
    const epoch = connectionEpoch.current;
    try {
      await operation();
    } catch (failure) {
      if (epoch === connectionEpoch.current)
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
        listingPath.current = result.path;
        setSelected([]);
        setPath(result.path);
      }
    } finally {
      if (request === navigation.current) setLoading(false);
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    if (connectionAttempt.current || connected || profileBusy) return;
    connectionAttempt.current = true;
    void run(async () => {
      setConnecting(true);
      setMessage(
        `${lost ? 'Reconnecting' : 'Connecting'}… verify the server fingerprint if prompted.`,
      );
      let established = false;
      try {
        const attempt = window.sshdrop.connect({
          host,
          port: Number(port),
          username,
          auth,
          ...(auth === 'password' ? { password } : { keyId: key?.id, passphrase }),
        });
        setPassword('');
        setPassphrase('');
        const { sftp } = unwrap(await attempt);
        established = true;
        if (sftp) await browse(path);
      } catch (failure) {
        if (failure instanceof Error && failure.message === 'Connection attempt cancelled.') {
          setMessage('Connection attempt cancelled. Enter your credentials to try again.');
          return;
        }
        if (!established)
          setMessage('Connection failed. Check the connection details and try again.');
        throw failure;
      } finally {
        connectionAttempt.current = false;
        setConnecting(false);
        setCancelling(false);
      }
    });
  }

  // Capture this render's connection. An old recovery promise must not publish
  // paths/errors or release a new connection's controls after disconnecting.
  const recoveryEpoch = connectionEpoch.current;
  const reportRecovery = useCallback(
    (message: string) => {
      if (recoveryEpoch === connectionEpoch.current) setError(message);
    },
    [recoveryEpoch],
  );
  const markRecoveryBusy = useCallback(
    (value: boolean) => {
      if (recoveryEpoch === connectionEpoch.current) setActionBusy(value);
    },
    [recoveryEpoch],
  );

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
          <PortableBackup />
          {sessionProtection}
          <span
            aria-live="polite"
            className={`connection-pill ${connected ? 'live' : lost ? 'lost' : ''}`}
          >
            <i />
            {connected
              ? `${username}@${host}`
              : connecting
                ? lost
                  ? 'Reconnecting…'
                  : 'Connecting…'
                : lost
                  ? 'Connection lost'
                  : 'No active connection'}
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
              setLost(false);
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
              setLost(false);
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
          {lost && (
            <p className="reconnect-note">
              Connection lost. Check the server details and authenticate again to start a fresh
              session. Interrupted operations will not resume.
            </p>
          )}
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
                {connecting
                  ? lost
                    ? 'Reconnecting…'
                    : 'Connecting…'
                  : lost
                    ? 'Reconnect to server'
                    : 'Connect to server'}
                <span aria-hidden="true">↗</span>
              </button>
            </fieldset>
          </form>
          {connecting && !connected && (
            <button
              className="secondary disconnect-button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void run(async () => unwrap(await window.sshdrop.cancelConnect())).finally(() =>
                  setCancelling(false),
                );
              }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel connection attempt'}
            </button>
          )}
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
          {transferNotice && (
            <div role="alert" className="error-banner">
              {transferNotice}
              <button aria-label="Dismiss transfer warning" onClick={() => setTransferNotice('')}>
                ×
              </button>
            </div>
          )}
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
                  disabled={!filesReady || fileBusy}
                  onClick={() =>
                    void run(() => browse(listing?.path.replace(/\/[^/]+\/?$/, '') || '/'))
                  }
                >
                  ↑ Parent
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || fileBusy}
                  onClick={() => void run(() => browse(listing?.path ?? path))}
                >
                  ↻ Refresh
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || !listing || actionBusy || loading}
                  onClick={() =>
                    void run(async () => unwrap(await window.sshdrop.upload(listing!.path)))
                  }
                >
                  ↑ Upload files
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || !listing || actionBusy || loading}
                  onClick={() =>
                    void run(async () => unwrap(await window.sshdrop.uploadFolder(listing!.path)))
                  }
                >
                  Upload folder
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || !listing || !selected.length || actionBusy || loading}
                  onClick={() =>
                    void run(async () => {
                      unwrap(
                        await window.sshdrop.downloadMany(
                          selected.map((name) => join(listing!.path, name)),
                        ),
                      );
                      setSelected([]);
                    })
                  }
                >
                  Download selected ({selected.length})
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || !listing || fileBusy}
                  onClick={() => {
                    setError('');
                    setActionInput({ action: 'create-folder', directory: listing!.path, name: '' });
                  }}
                >
                  New folder
                </button>
                <button
                  className="secondary compact"
                  disabled={!filesReady || !listing || fileBusy}
                  onClick={() => {
                    setError('');
                    setActionInput({ action: 'create-file', directory: listing!.path, name: '' });
                  }}
                >
                  New file
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
                disabled={!filesReady || actionBusy}
              />
              <button type="submit" disabled={!filesReady || fileBusy}>
                Go →
              </button>
            </form>
            {!listing ? (
              <div className="empty-state">
                <div className="empty-icon">▱</div>
                <h3>
                  {filesReady
                    ? 'Your remote files belong here.'
                    : connected
                      ? 'File browsing is unavailable.'
                      : 'Your server. A familiar view.'}
                </h3>
                <p>
                  {filesReady
                    ? 'Enter an accessible directory above to browse files.'
                    : connected
                      ? 'This SSH session has no active SFTP channel. Disconnect and reconnect to try again.'
                      : 'Connect to browse folders, move files, and get to work.'}
                </p>
                <span className="small-label">EXPLICIT DESTINATIONS. NO GUESSWORK.</span>
              </div>
            ) : (
              <div className="file-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label={
                            selectableFiles.length > 100
                              ? 'Select first 100 files'
                              : 'Select all files'
                          }
                          disabled={actionBusy || loading || !selectionPage.length}
                          checked={
                            selectionPage.length > 0 &&
                            selectionPage.every((entry) => selected.includes(entry.name))
                          }
                          onChange={(event) =>
                            setSelected(
                              event.target.checked ? selectionPage.map((entry) => entry.name) : [],
                            )
                          }
                        />{' '}
                        Name
                      </th>
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
                          <div className="file-label">
                            {entry.kind === 'file' && (
                              <input
                                type="checkbox"
                                aria-label={`Select ${entry.name}`}
                                disabled={
                                  actionBusy ||
                                  loading ||
                                  (!selected.includes(entry.name) && selected.length >= 100)
                                }
                                checked={selected.includes(entry.name)}
                                onChange={(event) =>
                                  setSelected((previous) =>
                                    event.target.checked
                                      ? previous.includes(entry.name) || previous.length >= 100
                                        ? previous
                                        : [...previous, entry.name]
                                      : previous.filter((name) => name !== entry.name),
                                  )
                                }
                              />
                            )}
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
                          </div>
                        </td>
                        <td>{entry.kind === 'directory' ? '—' : size(entry.size)}</td>
                        <td>{new Date(entry.modified).toLocaleString()}</td>
                        <td>
                          {(entry.kind === 'file' || entry.kind === 'directory') && (
                            <button
                              className="text-button"
                              disabled={actionBusy || loading}
                              onClick={() =>
                                void run(async () =>
                                  unwrap(
                                    await (entry.kind === 'directory'
                                      ? window.sshdrop.downloadFolder(
                                          join(listing.path, entry.name),
                                        )
                                      : window.sshdrop.download(join(listing.path, entry.name))),
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
                                disabled={!filesReady || fileBusy}
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
                              {entry.kind === 'file' && (
                                <button
                                  className="text-button"
                                  disabled={!filesReady || fileBusy}
                                  onClick={() => {
                                    setError('');
                                    setActionInput({
                                      action: 'copy',
                                      directory: listing.path,
                                      name: entry.name,
                                      destinationDirectory: '',
                                    });
                                  }}
                                >
                                  Copy or move
                                </button>
                              )}
                              <button
                                className="text-button danger-button"
                                disabled={!filesReady || fileBusy}
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
              <span className="small-label">
                {terminalOpen ? 'INTERACTIVE SSH' : connected ? 'SHELL CLOSED' : 'NOT CONNECTED'}
              </span>
            </div>
            <div className="terminal-container">
              <Terminal connected={connected && terminalOpen} />
              {!connected && (
                <div className="terminal-placeholder">
                  <span>$</span> Your next command starts here.
                  <i />
                </div>
              )}
            </div>
          </section>
          <Workflows connected={connected} />
          {transfers.length > 0 && (
            <section className="transfers panel" aria-label="File transfers">
              <div className="panel-heading">
                <h3>Transfers</h3>
                <span className="small-label">{queue.pending} WAITING · ONE FILE AT A TIME</span>
              </div>
              {queue.paused && (
                <div className="queue-notice" role="status">
                  Queue paused after a failed or cancelled file. Inspect its destination before
                  continuing. The failed file will not be retried.
                  <button
                    className="text-button"
                    disabled={queue.active || !queue.pending || actionBusy}
                    onClick={() => void run(async () => unwrap(await window.sshdrop.resumeQueue()))}
                  >
                    Continue queue
                  </button>
                </div>
              )}
              {transfers.map((transfer) => (
                <div
                  className="transfer-row"
                  key={transfer.id}
                  role="group"
                  aria-label={`Transfer ${transfer.name}`}
                >
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
                        `${size(transfer.transferred)} / ${size(transfer.total)} · ${transfer.status === 'running' ? (transfer.phase ?? 'transferring') : transfer.status}`}
                    </small>
                    {transfer.folderFiles && (
                      <small>
                        {transfer.folderFiles.copied} of {transfer.folderFiles.total} files copied ·{' '}
                        {transfer.folderFiles.skipped} skipped
                      </small>
                    )}
                  </div>
                  {(transfer.status === 'running' || transfer.status === 'queued') && (
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
          {filesReady && (
            <Recovery
              key={connectionEpoch.current}
              connected={filesReady}
              busy={
                actionBusy ||
                loading ||
                queue.active ||
                transfers.some((transfer) => transfer.status === 'running')
              }
              revision={transfers
                .filter((t) => t.status !== 'running' && t.status !== 'queued')
                .map((t) => t.id)
                .join(',')}
              setBusy={markRecoveryBusy}
              report={reportRecovery}
            />
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
