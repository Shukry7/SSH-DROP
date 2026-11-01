import { useEffect, useRef, useState } from 'react';
import type { FileAction } from '../../shared/contracts';

export function FileActionDialog({
  input,
  busy,
  error,
  submit,
  close,
}: {
  input: Exclude<FileAction, { action: 'delete' }>;
  busy: boolean;
  error: string;
  submit: (input: FileAction) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(input.action === 'rename' ? input.name : '');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const title = input.action === 'rename' ? 'Rename remote item' : 'Create remote folder';
  return (
    <dialog
      ref={dialog}
      className="file-action-dialog"
      aria-labelledby="file-action-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(
            input.action === 'rename' ? { ...input, newName: name } : { ...input, name },
          ).then((done) => {
            if (done) close();
          });
        }}
      >
        <h3 id="file-action-title">{title}</h3>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        <p className="muted">
          Folder: <bdi>{input.directory}</bdi>
        </p>
        <label>
          New name
          <input
            autoFocus
            required
            maxLength={255}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted">
          Use one name without slashes. You will review the full remote path before confirming.
          Existing items are not replaced.
        </p>
        <div className="profile-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="secondary"
            disabled={busy || !name || (input.action === 'rename' && name === input.name)}
          >
            {busy ? 'Waiting…' : 'Review change'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
