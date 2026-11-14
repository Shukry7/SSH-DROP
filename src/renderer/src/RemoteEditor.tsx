import { useWorkspace } from './WorkspaceContext';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { EditorDocument, EditorComparison } from '../../shared/editor';
import { findEditorMatches } from '../../shared/editor-search';
import { EditorSurface, type EditorSurfaceHandle } from './EditorSurface';
import { detectEditorLanguage, editorLanguages, type EditorLanguage } from './editor-language';

export function RemoteEditor({
  document,
  active,
  id,
  visible,
  onDirtyChange,
  ref,
  close,
}: {
  document: EditorDocument;
  active: boolean;
  id: string;
  visible: boolean;
  onDirtyChange: (id: string, dirty: boolean) => void;
  ref?: Ref<{ requestClose: () => void }>;
  close: () => void;
}) {
  const { api } = useWorkspace();
  const draft = useRef<EditorSurfaceHandle>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [language, setLanguage] = useState(() => detectEditorLanguage(document.path));
  const [token, setToken] = useState(document.token);
  const [text, setText] = useState(document.text);
  const [saved, setSaved] = useState(document.text);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState<EditorComparison>();
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const matches = useMemo(() => findEditorMatches(text, query), [text, query]);
  const dirty = text !== saved;
  useEffect(() => {
    onDirtyChange(id, dirty);
  }, [onDirtyChange, id, dirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  const finishClose = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.closeEditor(token);
      if (!result.ok) throw new Error(result.error);
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The tab could not be closed.');
    } finally {
      setBusy(false);
    }
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscarding(true);
    else void finishClose();
  };
  useImperativeHandle(ref, () => ({ requestClose }));
  const save = async () => {
    if (busy || !active || !dirty) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.saveEditor({ token, text });
      if (!result.ok) throw new Error(result.error);
      if (result.value) {
        setSaved(text);
        setComparison(undefined);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The draft could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const compare = async () => {
    if (busy || !active) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.compareEditor(token);
      if (!result.ok) throw new Error(result.error);
      setComparison(result.value);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The server version could not be read.',
      );
    } finally {
      setBusy(false);
    }
  };
  const accept = async (keepDraft: boolean) => {
    if (!comparison || busy || !active) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.acceptEditorReview({
        token,
        reviewToken: comparison.reviewToken,
        keepDraft,
      });
      if (!result.ok) throw new Error(result.error);
      if (result.value) {
        setToken(result.value.token);
        setSaved(result.value.text);
        if (!keepDraft) {
          setText(result.value.text);
          setMatchIndex(-1);
        }
        setComparison(undefined);
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The comparison could not be accepted.',
      );
    } finally {
      setBusy(false);
    }
  };
  const find = (direction: 1 | -1) => {
    const textarea = draft.current;
    if (!textarea || !matches.length) return;
    const index =
      matchIndex < 0
        ? direction === 1
          ? 0
          : matches.length - 1
        : (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index);
    const start = matches[index];
    textarea.select(start, start + query.length);
  };
  return (
    <section
      role="tabpanel"
      id={`editor-panel-${id}`}
      aria-labelledby={`editor-tab-${id}`}
      hidden={!visible}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          findInput.current?.focus();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
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
      <label className="editor-language">
        Highlighting
        <select
          value={language}
          onChange={(event) => setLanguage(event.target.value as EditorLanguage)}
        >
          {Object.entries(editorLanguages).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <span className="muted">
          Detected from the filename. Changes affect display only; files are never executed.
        </span>
      </label>
      <div className="editor-search toolbar">
        <label>
          Find in draft
          <input
            ref={findInput}
            type="search"
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                find(event.shiftKey ? -1 : 1);
              }
            }}
          />
        </label>
        <button
          className="secondary compact"
          disabled={!matches.length || busy}
          onClick={() => find(-1)}
        >
          Previous match
        </button>
        <button
          className="secondary compact"
          disabled={!matches.length || busy}
          onClick={() => find(1)}
        >
          Next match
        </button>
        <span aria-live="polite">
          {query
            ? !matches.length
              ? 'No matches'
              : `${matchIndex < 0 ? '' : `${matchIndex + 1} of `}${matches.length}${matches.length === 1000 ? ' (first 1000)' : ''} matches`
            : 'Case-sensitive literal search'}
        </span>
      </div>
      {comparison && (
        <p>
          {comparison.changed
            ? 'The server file has changed.'
            : 'The server file matches the version used for save checks.'}{' '}
          Review both versions, then choose how to continue.
        </p>
      )}
      <div className={comparison ? 'editor-comparison' : undefined}>
        <label>
          File contents
          <EditorSurface
            ref={draft}
            text={text}
            language={language}
            busy={busy}
            onChange={(value) => {
              setText(value);
              setMatchIndex(-1);
            }}
          />
        </label>
        {comparison && (
          <label>
            Reviewed server version
            <textarea
              aria-label="Reviewed server version"
              readOnly
              spellCheck={false}
              wrap="off"
              value={comparison.text}
            />
            <span>
              {comparison.lineEndings} line endings{comparison.bom ? ' · UTF-8 BOM' : ''}
            </span>
          </label>
        )}
      </div>
      {comparison && (
        <div className="toolbar">
          <button
            className="secondary"
            disabled={busy || !active}
            onClick={() => void accept(true)}
          >
            Keep my draft
          </button>
          <button
            className="secondary"
            disabled={busy || !active}
            onClick={() => void accept(false)}
          >
            Use server text
          </button>
          <button className="secondary" disabled={busy} onClick={() => setComparison(undefined)}>
            Close comparison
          </button>
        </div>
      )}
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
          <button className="secondary" disabled={busy} onClick={() => setDiscarding(false)}>
            Keep editing
          </button>
          <button
            className="secondary danger-button"
            disabled={busy}
            onClick={() => void finishClose()}
          >
            Discard draft
          </button>
        </div>
      ) : (
        <div className="toolbar">
          <button className="secondary" disabled={busy || !active} onClick={() => void compare()}>
            {comparison ? 'Refresh comparison' : 'Compare with server'}
          </button>
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
    </section>
  );
}
