import { useState } from 'react';
import { useWorkspace } from './WorkspaceContext';

export function RotateVaultKey() {
  const { api } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  return (
    <>
      <button
        className="secondary compact"
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setNotice('');
          setError('');
          try {
            const result = await api.rotateVaultKey();
            if (!result.ok) throw new Error(result.error);
            if (result.value) setNotice('Recovery vault key rotated and all backups verified.');
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Vault key rotation failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Rotating vault key…' : 'Rotate recovery vault key'}
      </button>
      {busy && <span role="status">Keep SSHDrop open. Large vaults can take several minutes.</span>}
      {notice && <span role="status">{notice}</span>}
      {error && (
        <span role="alert">
          {error} If interrupted, use Rotate recovery vault key again to finish.
        </span>
      )}
    </>
  );
}
