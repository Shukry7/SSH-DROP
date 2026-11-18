import { useWorkspace } from './WorkspaceContext';
import { useEffect, useRef, useState } from 'react';
import type { RecoveryAction, RecoveryView } from '../../shared/contracts';
import { portableBackupLimit } from '../../shared/portable-backup';
import { PortableBackup } from './PortableBackup';

export function Recovery({
  connected,
  busy,
  revision,
  setBusy,
  report,
}: {
  connected: boolean;
  busy: boolean;
  revision: string;
  setBusy(value: boolean): void;
  report(message: string): void;
}) {
  const { api } = useWorkspace();
  const [records, setRecords] = useState<RecoveryView[]>([]);
  const epoch = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const generation = ++epoch.current;
    if (!connected) return;
    void api.recovery().then((result) => {
      if (generation !== epoch.current) return;
      if (result.ok) setRecords(result.value);
      else report(result.error);
    });
    return () => {
      epoch.current = generation + 1;
    };
  }, [api, connected, revision, report]);
  async function act(id: string, action: RecoveryAction['action']) {
    if (lock.current || busy) return;
    lock.current = true;
    setBusy(true);
    const generation = epoch.current;
    try {
      const result = await api.recover({ id, action });
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Recovery failed.');
    } finally {
      if (generation === epoch.current) {
        const result = await api.recovery();
        if (generation === epoch.current) {
          if (result.ok) setRecords(result.value);
          else report(result.error);
        }
      }
      lock.current = false;
      setBusy(false);
    }
  }
  if (!connected) return null;
  return (
    <section className="panel recovery-panel" aria-label="Recovery backups">
      <div className="panel-heading">
        <h3>Recovery backups</h3>
        <span className="small-label">THIS SERVER & ACCOUNT</span>
      </div>
      <p className="recovery-note">
        New backups and recovery metadata are encrypted with an OS-protected key. Legacy backups
        remain plaintext until you choose Secure backup. An unlocked OS key store is required;
        losing the OS account or vault key can make backups unrecoverable. Keep the backup folder
        and key together. Nothing is restored or deleted automatically. Stop other writers before
        replacing files.
      </p>
      {records.length === 0 && (
        <p className="recovery-note">No replacement backups for this verified server identity.</p>
      )}
      {records.map((record) => (
        <div className="recovery-record" key={record.id}>
          <div>
            <strong>{record.path}</strong>
            <small>
              {record.encrypted ? 'Encrypted' : 'Legacy plaintext'} · {record.direction} ·{' '}
              {record.state} · {record.size} bytes · {new Date(record.created).toLocaleString()}
              {record.imported && ' · Imported, restore-copy only'}
            </small>
          </div>
          <div className="recovery-actions">
            {record.encrypted && record.size <= portableBackupLimit && (
              <PortableBackup id={record.id} disabled={busy} />
            )}
            <button
              className="text-button"
              disabled={busy || !!record.imported}
              onClick={() => void act(record.id, 'encrypt-backup')}
              title="Encrypt a legacy backup or retry interrupted plaintext cleanup"
            >
              Secure backup
            </button>
            <button
              className="text-button"
              disabled={busy || !record.encrypted || !!record.imported}
              onClick={() => void act(record.id, 'inspect')}
            >
              Inspect
            </button>
            <button
              className="text-button"
              disabled={
                busy || !record.encrypted || !!record.imported || record.state !== 'completed'
              }
              onClick={() => void act(record.id, 'rollback')}
            >
              Roll back
            </button>
            <button
              className="text-button"
              disabled={busy || !record.encrypted}
              onClick={() => void act(record.id, 'restore-copy')}
            >
              Restore copy
            </button>
            <button
              className="text-button danger-button"
              disabled={
                busy ||
                (!record.imported &&
                  !['completed', 'restored', 'not-replaced'].includes(record.state))
              }
              onClick={() => void act(record.id, 'delete-backup')}
            >
              Delete backup
            </button>
          </div>
          {!record.imported &&
            ['preparing', 'backup-ready', 'publishing', 'uncertain'].includes(record.state) && (
              <p className="recovery-note">
                Unresolved operation: inspect before retrying. Temporary files may remain beside the
                destination: .sshdrop-recovery-{record.id}.ready and .ready.original. Never remove
                them until you have checked the destination and backup.
              </p>
            )}
        </div>
      ))}
    </section>
  );
}
