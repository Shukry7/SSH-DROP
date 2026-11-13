import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorDocument } from '../../shared/editor';
import { RemoteEditor } from './RemoteEditor';

export interface EditorTab {
  document: EditorDocument;
  epoch: number;
}

export function EditorTabs({
  tabs,
  selected,
  shown,
  isCurrent,
  select,
  hide,
  close,
}: {
  tabs: EditorTab[];
  selected: string;
  shown: boolean;
  isCurrent: (tab: EditorTab) => boolean;
  select: (id: string) => void;
  hide: () => void;
  close: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const currentEditor = useRef<{ requestClose: () => void }>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyTabs((previous) => ({ ...previous, [id]: dirty }));
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (shown && !element?.open) element?.showModal();
    if (!shown && element?.open) element.close();
  }, [shown]);

  return (
    <dialog
      ref={dialog}
      className="remote-editor-dialog"
      aria-labelledby="remote-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        currentEditor.current?.requestClose();
      }}
    >
      <div className="editor-tab-heading">
        <h3 id="remote-editor-title">Edit remote text file</h3>
        <button className="secondary compact" onClick={hide}>
          Back to files
        </button>
      </div>
      <div
        className="editor-tabs"
        role="tablist"
        aria-label="Open files"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const index = tabs.findIndex((tab) => tab.document.token === selected);
          const step = event.key === 'ArrowRight' ? 1 : -1;
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + step + tabs.length) % tabs.length;
          const button =
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
          event.preventDefault();
          select(tabs[next].document.token);
          button?.focus();
        }}
      >
        {tabs.map(({ document: { token, path } }) => (
          <button
            key={token}
            id={`editor-tab-${token}`}
            type="button"
            role="tab"
            aria-selected={token === selected}
            aria-controls={`editor-panel-${token}`}
            tabIndex={token === selected ? 0 : -1}
            title={path}
            onClick={() => select(token)}
          >
            <bdi>{path}</bdi>
            {dirtyTabs[token] && <span className="editor-unsaved"> · Unsaved</span>}
          </button>
        ))}
      </div>
      {tabs.map((tab) => {
        const id = tab.document.token;
        return (
          <RemoteEditor
            key={id}
            id={id}
            ref={id === selected ? currentEditor : undefined}
            document={tab.document}
            active={isCurrent(tab)}
            visible={id === selected}
            onDirtyChange={onDirtyChange}
            close={() => {
              setDirtyTabs((previous) => {
                const remaining = { ...previous };
                delete remaining[id];
                return remaining;
              });
              close(id);
            }}
          />
        );
      })}
    </dialog>
  );
}
