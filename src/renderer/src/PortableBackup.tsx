import { useEffect, useRef, useState, type FormEvent } from 'react';

export function PortableBackup({ id, disabled = false }: { id?: string; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const title = id ? 'Export encrypted backup' : 'Open portable backup';
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
    if (id && passphrase !== fields.get('repeat')) {
      setError('The passphrases do not match.');
      return;
    }
    form.reset();
    setBusy(true);
    setError('');
    try {
      const result = id
        ? await window.sshdrop.exportBackup({ id, passphrase })
        : await window.sshdrop.openBackup(passphrase);
      if (!result.ok) throw new Error(result.error);
      if (result.value)
        setNotice(id ? 'Encrypted backup exported.' : 'Restored to a new local copy.');
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
              {id
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
                autoComplete={id ? 'new-password' : 'off'}
                disabled={busy}
              />
            </label>
            {id && (
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
