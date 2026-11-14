import { useEffect, useState } from 'react';
import type { SavedTransfer } from '../../shared/contracts';
import { useWorkspace } from './WorkspaceContext';

export function SavedTransfers({ blocked }: { blocked: boolean }) {
  const { api } = useWorkspace();
  const [remember, setRemember] = useState(false);
  const [records, setRecords] = useState<SavedTransfer[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void api.savedTransfers().then((result) => {
      if (!current) return;
      if (result.ok) setRecords(result.value);
      else setError(result.error);
    });
    return () => {
      current = false;
    };
  }, [api, blocked]);

  async function perform(operation: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true);
    setError('');
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error);
      const latest = await api.savedTransfers();
      if (latest.ok) setRecords(latest.value);
      else setError(latest.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update saved transfers.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel saved-transfers" aria-label="Saved transfers">
      <div className="panel-heading">
        <h3>Saved transfers</h3>
      </div>
      <div className="workflow-content">
        <label className="workflow-check">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy || blocked}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void perform(async () => {
                const result = await api.transferMemory(enabled);
                if (result.ok) setRemember(enabled);
                return result;
              });
            }}
          />
          Remember new file transfers and folder downloads in this connection
        </label>
        <p>
          SSHDrop encrypts the paths and file hashes on this computer. With recovery enabled, queue
          up to eight individual files at a time, up to 32 MiB each. Folder downloads up to 128 MiB
          can also be saved. Choose a new destination for each transfer.
        </p>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {records.length === 0 && <p>No saved transfers to review for this server and account.</p>}
        {records.map((record) => (
          <div key={record.id} className="saved-transfer">
            <strong>
              {record.folder
                ? 'Folder download'
                : record.direction === 'upload'
                  ? 'Upload'
                  : 'Download'}
            </strong>
            {record.folder && record.totalFiles !== undefined && (
              <p>
                {record.copiedFiles} of {record.totalFiles} files recorded as copied
              </p>
            )}
            <p>
              From <bdi>{record.direction === 'upload' ? record.local : record.remote}</bdi>
            </p>
            <p>
              To <bdi>{record.direction === 'upload' ? record.remote : record.local}</bdi>
            </p>
            <button
              className="secondary compact"
              disabled={busy || blocked}
              onClick={() =>
                void perform(() => api.reviewSavedTransfer({ id: record.id, action: 'retry' }))
              }
            >
              {record.folder
                ? 'Review folder download'
                : record.direction === 'download'
                  ? 'Review download resume'
                  : 'Review upload resume'}
            </button>
            <button
              className="secondary compact"
              disabled={busy || blocked}
              onClick={() =>
                void perform(() => api.reviewSavedTransfer({ id: record.id, action: 'forget' }))
              }
            >
              Forget transfer
            </button>
          </div>
        ))}
        <button
          className="secondary compact"
          disabled={busy || blocked}
          onClick={() => void perform(async () => ({ ok: true }))}
        >
          Check for saved transfers
        </button>
      </div>
    </section>
  );
}
