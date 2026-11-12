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
  const relocating = 'destinationDirectory' in input;
  const [name, setName] = useState(input.action === 'rename' ? input.name : '');
  const [destinationDirectory, setDestinationDirectory] = useState('');
  const [operation, setOperation] = useState<'copy' | 'move'>('copy');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const title = relocating
    ? 'Copy or move remote file'
    : input.action === 'rename'
      ? 'Rename remote item'
      : input.action === 'create-file'
        ? 'Create remote file'
        : 'Create remote folder';
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
            relocating
              ? { ...input, action: operation, destinationDirectory }
              : input.action === 'rename'
                ? { ...input, newName: name }
                : { ...input, name },
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
        {relocating ? (
          <>
            <p className="muted">
              File: <bdi>{input.name}</bdi>
            </p>
            <label>
              Operation
              <select
                value={operation}
                disabled={busy}
                onChange={(event) => setOperation(event.target.value === 'move' ? 'move' : 'copy')}
              >
                <option value="copy">Copy</option>
                <option value="move">Move</option>
              </select>
            </label>
            <label>
              Destination folder
              <input
                autoFocus
                required
                maxLength={4096}
                placeholder="/path/to/folder"
                value={destinationDirectory}
                disabled={busy}
                onChange={(event) => setDestinationDirectory(event.target.value)}
              />
            </label>
            <p className="muted">
              Use an existing absolute folder path on this server. The filename stays the same.
              Copies are limited to 128 MiB.
            </p>
          </>
        ) : (
          <>
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
          </>
        )}
        <div className="profile-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="secondary"
            disabled={
              busy ||
              (relocating
                ? !destinationDirectory.startsWith('/') || destinationDirectory === input.directory
                : !name || (input.action === 'rename' && name === input.name))
            }
          >
            {busy ? 'Waiting…' : 'Review change'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
