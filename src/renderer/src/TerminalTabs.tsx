import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionEvent } from '../../shared/contracts';
import { terminalTabLimit } from '../../shared/terminal-limits';
import { Terminal, type TerminalOutput } from './Terminal';

type OutputEvent = Extract<SessionEvent, { type: 'terminal' | 'terminal-exit' }>;
interface Tab {
  id: string;
  number: number;
  running: boolean;
  directory?: string;
}

export function TerminalTabs({
  connected,
  canBrowse,
  browse,
}: {
  connected: boolean;
  canBrowse: boolean;
  browse: (directory: string) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [selected, setSelected] = useState('');
  const [opening, setOpening] = useState(false);
  const [confirmClose, setConfirmClose] = useState('');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const generation = useRef(0);
  const outlets = useRef(new Map<string, { listener?: TerminalOutput; pending: OutputEvent[] }>());
  const selectedTab = tabs.find((tab) => tab.id === selected) ?? tabs[0];

  useEffect(
    () =>
      window.sshdrop.onEvent((event) => {
        if (event.type === 'terminal-reset') {
          generation.current++;
          sequence.current = 0;
          outlets.current.clear();
          setTabs([]);
          setSelected('');
          setConfirmClose('');
          setOpening(false);
          setError('');
        } else if (event.type === 'terminal-opened') {
          outlets.current.set(event.terminalId, { pending: [] });
          const tab = { id: event.terminalId, number: ++sequence.current, running: true };
          setTabs((previous) => [...previous, tab]);
          setSelected(tab.id);
          setConfirmClose('');
        } else if (event.type === 'terminal' || event.type === 'terminal-exit') {
          const outlet = outlets.current.get(event.terminalId);
          if (outlet?.listener) outlet.listener(event);
          else if (outlet) outlet.pending.push(event);
          if (event.type === 'terminal-exit')
            setTabs((previous) =>
              previous.map((tab) =>
                tab.id === event.terminalId
                  ? { ...tab, running: false, directory: undefined }
                  : tab,
              ),
            );
        }
      }),
    [],
  );

  const subscribe = useCallback((id: string, listener: TerminalOutput) => {
    const outlet = outlets.current.get(id);
    if (!outlet) return () => {};
    outlet.listener = listener;
    for (const event of outlet.pending) listener(event);
    outlet.pending = [];
    return () => {
      outlet.listener = undefined;
    };
  }, []);

  const onDirectory = useCallback((id: string, directory: string | undefined) => {
    setTabs((previous) => {
      const tab = previous.find((item) => item.id === id);
      if (!tab?.running || tab.directory === directory) return previous;
      return previous.map((item) => (item === tab ? { ...item, directory } : item));
    });
  }, []);

  async function open() {
    const current = generation.current;
    setOpening(true);
    setError('');
    try {
      const result = await window.sshdrop.openTerminal();
      if (!result.ok) throw new Error(result.error);
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : 'The terminal could not be opened.');
    } finally {
      if (current === generation.current) setOpening(false);
    }
  }

  async function close(id: string) {
    const current = generation.current;
    try {
      const result = await window.sshdrop.closeTerminal(id);
      if (!result.ok) throw new Error(result.error);
      if (current !== generation.current) return;
      outlets.current.delete(id);
      setTabs((previous) => previous.filter((tab) => tab.id !== id));
      setConfirmClose('');
      setError('');
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : 'The terminal could not be closed.');
    }
  }

  return (
    <section className="terminal-panel panel" aria-label="Terminal panel">
      <div className="panel-heading">
        <h3>
          <span className="terminal-symbol">›_</span> Terminal
        </h3>
        <div className="toolbar">
          {connected && !tabs.some((tab) => tab.running) && (
            <span className="small-label">SHELL CLOSED</span>
          )}
          <button
            className="secondary compact"
            disabled={!connected || opening || tabs.length >= terminalTabLimit}
            onClick={() => void open()}
          >
            {opening ? 'Opening terminal…' : 'New terminal'}
          </button>
          {selectedTab && (
            <button
              className="secondary compact"
              onClick={() => {
                if (selectedTab.running) setConfirmClose(selectedTab.id);
                else void close(selectedTab.id);
              }}
            >
              Close terminal
            </button>
          )}
        </div>
      </div>
      {tabs.length > 0 && (
        <div
          className="editor-tabs"
          role="tablist"
          aria-label="Open terminals"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const index = tabs.findIndex((tab) => tab.id === selectedTab?.id);
            const step = event.key === 'ArrowRight' ? 1 : -1;
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + step + tabs.length) % tabs.length;
            event.preventDefault();
            setSelected(tabs[next].id);
            setConfirmClose('');
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`terminal-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={tab.id === selectedTab?.id}
              aria-controls={`terminal-panel-${tab.id}`}
              tabIndex={tab.id === selectedTab?.id ? 0 : -1}
              onClick={() => {
                setSelected(tab.id);
                setConfirmClose('');
              }}
            >
              Terminal {tab.number}
              {tab.running ? '' : ' · Closed'}
            </button>
          ))}
        </div>
      )}
      {connected && selectedTab?.running && (
        <div className="terminal-directory">
          <button
            className="secondary compact"
            disabled={!canBrowse || selectedTab.directory === undefined}
            onClick={() => {
              if (selectedTab.directory !== undefined) browse(selectedTab.directory);
            }}
          >
            Open shell folder
          </button>
          {selectedTab.directory ? (
            <bdi className="terminal-directory-path" title={selectedTab.directory}>
              {selectedTab.directory}
            </bdi>
          ) : (
            <span className="muted">
              Waiting for a directory report. You can enter a path in Files.
            </span>
          )}
        </div>
      )}
      {confirmClose && (
        <div className="terminal-notice" role="alert">
          <p>Close this shell? Running commands in this terminal may stop.</p>
          <button className="secondary compact" onClick={() => setConfirmClose('')}>
            Cancel
          </button>
          <button
            className="secondary compact danger-button"
            onClick={() => void close(confirmClose)}
          >
            Close shell
          </button>
        </div>
      )}
      {error && (
        <p className="error-banner terminal-notice" role="alert">
          {error}
        </p>
      )}
      <div className="terminal-container">
        {tabs.map((tab) => (
          <Terminal
            key={tab.id}
            id={tab.id}
            subscribe={subscribe}
            onDirectory={onDirectory}
            visible={tab.id === selectedTab?.id}
            connected={connected && tab.running}
          />
        ))}
        {!tabs.length && (
          <>
            <Terminal
              key="placeholder"
              subscribe={subscribe}
              onDirectory={onDirectory}
              visible
              connected={false}
            />
            <div className="terminal-placeholder">
              {connected ? (
                'Open a terminal to start a new shell.'
              ) : (
                <>
                  <span>$</span> Your next command starts here.
                  <i />
                </>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
