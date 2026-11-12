import { useEffect, useRef, useState } from 'react';
import type { EditorDocument } from '../../shared/editor';

export function RemoteEditor({
  document,
  active,
  close,
}: {
  document: EditorDocument;
  active: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(document.text);
  const [saved, setSaved] = useState(document.text);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState('');
  const dirty = text !== saved;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscarding(true);
    else close();
  };
  const save = async () => {
    if (busy || !active || !dirty) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.sshdrop.saveEditor({ token: document.token, text });
      if (!result.ok) throw new Error(result.error);
      if (result.value) setSaved(text);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The draft could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="remote-editor-dialog"
      aria-labelledby="remote-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
      <h3 id="remote-editor-title">Edit remote text file</h3>
      <p>
        <bdi>{document.path}</bdi>
      </p>
      <p className="muted">
        UTF-8 text · 1 MiB limit · Original LF/CRLF line endings and UTF-8 BOM are preserved.
      </p>
      {!active && (
        <p role="alert">
          The connection changed. Copy your draft elsewhere before closing, then reopen the remote
          file to edit again.
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <label>
        File contents
        <textarea
          autoFocus
          aria-label="Remote file contents"
          value={text}
          disabled={busy}
          spellCheck={false}
          maxLength={1048576}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <p role="status">
        {busy
          ? 'Waiting for save confirmation or verification…'
          : dirty
            ? 'Unsaved changes'
            : 'No unsaved changes'}
      </p>
      {discarding ? (
        <div role="alert">
          <p>Discard this unsaved draft?</p>
          <button className="secondary" onClick={() => setDiscarding(false)}>
            Keep editing
          </button>
          <button className="secondary danger-button" onClick={close}>
            Discard draft
          </button>
        </div>
      ) : (
        <div className="toolbar">
          <button
            className="primary"
            disabled={busy || !dirty || !active}
            onClick={() => void save()}
          >
            Save changes
          </button>
          <button className="secondary" disabled={busy} onClick={requestClose}>
            Close editor
          </button>
        </div>
      )}
      <p className="muted">
        Drafts stay in memory. Idle protection clears the workspace, including unsaved drafts. Stop
        other writers while saving.
      </p>
    </dialog>
  );
}
