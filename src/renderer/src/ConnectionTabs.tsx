import { useState, type ReactNode } from 'react';
import type { DesktopAPI } from '../../shared/contracts';
import { App } from './App';
import { WorkspaceContext } from './WorkspaceContext';

interface Tab {
  id?: string;
  number: number;
  api: DesktopAPI;
  server?: string;
}

export function ConnectionTabs({ sessionProtection }: { sessionProtection: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([{ number: 1, api: window.sshdrop }]);
  const [selected, setSelected] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = tabs.find((tab) => tab.number === selected) ?? tabs[0];

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The connection tab could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connection-workspaces">
      <div className="connection-tabbar">
        <div
          className="editor-tabs"
          role="tablist"
          aria-label="SSH connections"
          onKeyDown={(event) => {
            const index = tabs.indexOf(active);
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            setSelected(tabs[next].number);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.number}
              id={`workspace-tab-${tab.number}`}
              role="tab"
              type="button"
              aria-selected={tab === active}
              aria-controls={`workspace-panel-${tab.number}`}
              tabIndex={tab === active ? 0 : -1}
              onClick={() => setSelected(tab.number)}
            >
              Connection {tab.number}
              {tab.server && (
                <>
                  {' '}
                  · <bdi>{tab.server}</bdi>
                </>
              )}
            </button>
          ))}
        </div>
        <button
          className="secondary compact"
          disabled={busy || tabs.length >= 4}
          onClick={() =>
            void perform(async () => {
              const result = await window.sshdrop.createWorkspace();
              if (!result.ok) throw new Error(result.error);
              const tab = { ...result.value, api: window.sshdrop.forWorkspace(result.value.id) };
              setTabs((previous) => [...previous, tab]);
              setSelected(tab.number);
            })
          }
        >
          New connection tab
        </button>
        <button
          className="secondary compact"
          disabled={busy || tabs.length === 1}
          onClick={() =>
            void perform(async () => {
              const result = await active.api.closeWorkspace();
              if (!result.ok) throw new Error(result.error);
              if (result.value)
                setTabs((previous) => previous.filter((tab) => tab.number !== active.number));
            })
          }
        >
          Close connection tab
        </button>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {tabs.map((tab) => (
        <section
          key={tab.number}
          id={`workspace-panel-${tab.number}`}
          aria-labelledby={`workspace-tab-${tab.number}`}
          hidden={tab !== active}
          inert={tab !== active}
          className="connection-workspace"
          data-sshdrop-workspace={tab.id ?? ''}
        >
          <WorkspaceContext.Provider value={{ api: tab.api, active: tab === active }}>
            <App
              sessionProtection={sessionProtection}
              onServer={(server) => {
                setTabs((previous) =>
                  previous.map((item) => (item.number === tab.number ? { ...item, server } : item)),
                );
              }}
            />
          </WorkspaceContext.Provider>
        </section>
      ))}
    </div>
  );
}
