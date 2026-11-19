import { useWorkspace } from './WorkspaceContext';
import { useEffect, useRef, useState, type FormEvent } from 'react';

export function PortableBackup({
  id,
  vault,
  disabled = false,
}: {
  id?: string;
  vault?: 'export' | 'import';
  disabled?: boolean;
}) {
  const { api, active: workspaceActive } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (open && workspaceActive && !element?.open) element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [open, workspaceActive]);
  const exporting = !!id || vault === 'export';
  const title = vault
    ? exporting
      ? 'Export recovery vault'
      : 'Import recovery vault'
    : id
      ? 'Export encrypted backup'
      : 'Open portable backup';
  const close = () => {
    setOpen(false);
    setError('');
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const passphrase = String(fields.get('passphrase') ?? '');
    if (exporting && passphrase !== fields.get('repeat')) {
      setError('The passphrases do not match.');
      return;
    }
    form.reset();
    setBusy(true);
    setError('');
    try {
      const result = vault
        ? exporting
          ? await api.exportVault(passphrase)
          : await api.importVault(passphrase)
        : id
          ? await api.exportBackup({ id, passphrase })
          : await api.openBackup(passphrase);
      if (!result.ok) throw new Error(result.error);
      if (result.value)
        setNotice(
          vault
            ? exporting
              ? 'Encrypted recovery vault exported.'
              : 'Recovery vault imported. Connect to the original server and account to review backups.'
            : id
              ? 'Encrypted backup exported.'
              : 'Restored to a new local copy.',
        );
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Portable backup operation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={id ? 'text-button' : 'secondary compact'}
        disabled={disabled}
        onClick={() => {
          setNotice('');
          setOpen(true);
        }}
      >
        {title}
      </button>
      {notice && (
        <span className="portable-notice" role="status">
          {notice}
        </span>
      )}
      {open && (
        <dialog
          ref={dialog}
          className="file-action-dialog"
          aria-label={title}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) close();
          }}
        >
          <form onSubmit={(event) => void submit(event)}>
            <h3>{title}</h3>
            <p className="muted">
              {vault
                ? 'Move up to 100 encrypted recovery backups with up to 64 MiB of contents. Server identities and paths are encrypted in the archive. Use a unique passphrase of at least 16 characters. Finish active operations in all tabs first.'
                : id
                  ? 'Export up to 32 MiB. Use a unique passphrase of at least 16 characters and keep it separately. Without it, the exported file cannot be recovered.'
                  : 'Open a .sshdrop-backup file with its export passphrase. No SSH connection or original device is needed. The restored copy is unencrypted; choose a private folder.'}
            </p>
            <label>
              Backup passphrase
              <input
                autoFocus
                type="password"
                name="passphrase"
                minLength={16}
                maxLength={256}
                required
                autoComplete={exporting ? 'new-password' : 'off'}
                disabled={busy}
              />
            </label>
            {exporting && (
              <label>
                Repeat backup passphrase
                <input
                  type="password"
                  name="repeat"
                  minLength={16}
                  maxLength={256}
                  required
                  autoComplete="new-password"
                  disabled={busy}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            <div className="profile-actions">
              <button type="button" className="secondary" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || disabled}>
                {busy ? 'Working…' : 'Choose files'}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
