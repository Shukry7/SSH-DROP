import { useEffect, useRef, useState } from 'react';
import { ConnectionTabs } from './ConnectionTabs';
import type { IdleSettings, IdleState } from '../../shared/idle';
import type { Result } from '../../shared/contracts';

const unwrap = <T,>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

function Countdown({
  state,
  stay,
  end,
  busy,
  error,
}: {
  state: IdleState;
  stay: () => void;
  end: () => void;
  busy: boolean;
  error: string;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    modal.current?.showModal();
  }, []);
  return (
    <dialog
      ref={modal}
      className="idle-dialog"
      aria-labelledby="idle-warning-title"
      aria-describedby="idle-warning-detail"
      onCancel={(event) => event.preventDefault()}
    >
      <h2 id="idle-warning-title">Your session is about to end</h2>
      <p id="idle-warning-detail" role="alert">
        SSHDrop will disconnect and clear this workspace due to inactivity. Choose Stay active to
        keep working.
      </p>
      <div
        className="idle-countdown"
        role="timer"
        aria-label="Time until session ends"
        aria-live="off"
      >
        {time(state.seconds)}
      </div>
      <p>
        Active transfers and workflows may be interrupted. Remote commands may keep running. Unsaved
        inputs will be cleared; completed changes are not undone.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="toolbar">
        <button className="primary" autoFocus disabled={busy} onClick={stay}>
          Stay active
        </button>
        <button className="secondary" disabled={busy} onClick={end}>
          End session now
        </button>
      </div>
    </dialog>
  );
}

function Settings({
  settings,
  busy,
  error,
  apply,
  close,
  end,
}: {
  settings: IdleSettings;
  busy: boolean;
  error: string;
  apply: (value: IdleSettings) => void;
  close: () => void;
  end: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    modal.current?.showModal();
  }, []);
  return (
    <dialog
      ref={modal}
      className="idle-dialog"
      aria-labelledby="idle-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <h2 id="idle-settings-title">Idle session protection</h2>
        <p>
          This version ends the SSH connection and clears the workspace. It does not preserve an
          authenticated session behind an app lock.
        </p>
        <label>
          End session after inactivity
          <select
            aria-label="Idle timeout"
            value={draft.minutes}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, minutes: Number(event.target.value) as IdleSettings['minutes'] })
            }
          >
            <option value={0}>Off</option>
            {[5, 10, 15, 30, 60].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        </label>
        <label className="workflow-check">
          <input
            type="checkbox"
            checked={draft.notifications}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, notifications: event.target.checked })}
          />
          Desktop warning when the app is in the background (if supported)
        </label>
        <p>
          The final minute shows a countdown. Only local keyboard input, clicks and scrolling reset
          activity before the warning. During the warning, explicitly choose Stay active.
        </p>
        <p>
          When enabled, OS screen locking (where supported) and sleep also end the session.
          Transfers may be interrupted, and remote work may continue. Unsaved inputs are lost. Saved
          local profiles and workflow definitions remain on this computer.
        </p>
        <p>
          Use your operating system screen lock to protect local data. Returning to the connection
          screen is not OS authentication; reconnecting requires fresh SSH authentication.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy} type="submit">
            Apply idle settings
          </button>
          <button className="secondary" disabled={busy} type="button" onClick={close}>
            Cancel
          </button>
          <button className="text-button danger-button" disabled={busy} type="button" onClick={end}>
            End session now
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function IdleProtection() {
  const [state, setState] = useState<IdleState>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    let receivedEvent = false;
    const unsubscribe = window.sshdrop.onEvent((event) => {
      if (event.type === 'idle') {
        receivedEvent = true;
        if (event.state.phase !== 'active') setSettingsOpen(false);
        setState(event.state);
      }
    });
    void window.sshdrop
      .idleStatus()
      .then((result) => {
        if (alive && !receivedEvent) setState(unwrap(result));
      })
      .catch(() => {
        if (alive)
          setError(
            'Session protection status could not be loaded. Restart SSHDrop before connecting.',
          );
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Session protection request failed.');
    } finally {
      setBusy(false);
    }
  };
  const end = () => {
    void perform(async () => {
      unwrap(await window.sshdrop.idleEnd());
    });
  };
  if (!state)
    return (
      <main className="privacy-screen">
        <h1>SSHDrop</h1>
        <p role="status">{error || 'Checking session protection…'}</p>
      </main>
    );
  if (state.phase === 'shielded')
    return (
      <main className="privacy-screen">
        <section className="privacy-card" aria-labelledby="privacy-title">
          <span className="section-label">SESSION PROTECTION</span>
          <h1 id="privacy-title">Your session has ended</h1>
          <p>
            SSHDrop disconnected and cleared the workspace{' '}
            {state.reason === 'idle'
              ? 'after inactivity'
              : state.reason === 'sleep'
                ? 'because the computer suspended'
                : state.reason === 'os-lock'
                  ? 'because the screen locked'
                  : state.reason === 'clock-change'
                    ? 'because the system clock changed unexpectedly'
                    : 'at your request'}
            .
          </p>
          <p>
            Active operations may have been interrupted. Remote processes may still be running;
            inspect the server before retrying. Nothing will reconnect or rerun automatically.
          </p>
          <p>
            This screen protects the ended session, not saved local configuration. Use your
            operating system screen lock to protect this computer.
          </p>
          {state.settingsError && <p role="alert">{state.settingsError}</p>}
          {error && <p role="alert">{error}</p>}
          <button
            className="primary"
            autoFocus
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                unwrap(await window.sshdrop.idleReturn());
                setSettingsOpen(false);
              })
            }
          >
            Return to connection screen
          </button>
        </section>
      </main>
    );
  return (
    <>
      <ConnectionTabs
        sessionProtection={
          <button
            className="secondary compact idle-indicator"
            aria-label="Idle protection settings"
            onClick={() => {
              setError('');
              setSettingsOpen(true);
            }}
          >
            {state.settings.minutes ? (
              <>
                Session ends in <span aria-live="off">{time(state.seconds)}</span>
              </>
            ) : (
              'Idle protection off'
            )}
          </button>
        }
      />
      {state.settingsError && (
        <div className="idle-settings-error" role="alert">
          {state.settingsError}
        </div>
      )}
      {state.phase === 'active' && settingsOpen && (
        <Settings
          settings={state.settings}
          busy={busy}
          error={error}
          close={() => setSettingsOpen(false)}
          end={end}
          apply={(value) =>
            void perform(async () => {
              setState(unwrap(await window.sshdrop.idleSettings(value)));
              setSettingsOpen(false);
            })
          }
        />
      )}
      {state.phase === 'warning' && (
        <Countdown
          state={state}
          busy={busy}
          error={error}
          end={end}
          stay={() =>
            void perform(async () => {
              unwrap(await window.sshdrop.idleStayActive());
              setSettingsOpen(false);
            })
          }
        />
      )}
    </>
  );
}
