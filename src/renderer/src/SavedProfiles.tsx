import { useEffect, useState } from 'react';
import type { LoadedProfile, ProfileInput, Result, ServerProfile } from '../../shared/contracts';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function SavedProfiles({
  disabled,
  details,
  onLoad,
  onNew,
  onError,
  onBusy,
}: {
  disabled: boolean;
  details: Omit<ProfileInput, 'id' | 'name'>;
  onLoad: (value: LoadedProfile) => void;
  onNew: () => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void window.sshdrop
      .profiles()
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setProfiles(result.value);
          setReady(true);
        } else onError(result.error);
      })
      .catch(() => {
        if (active) onError('Saved profiles could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [onError]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setNotice('');
    onError('');
    try {
      await operation();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Profile operation failed.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <section className="saved-profiles" aria-label="Saved server profiles">
      <fieldset disabled={disabled || busy || !ready}>
        <div className="connection-field">
          <div className="field-heading">
            <label htmlFor="saved-profile">Saved server</label>
          </div>
          <select
            id="saved-profile"
            value={selected}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) {
                setSelected('');
                setName('');
                setNotice('');
                onNew();
                return;
              }
              void run(async () => {
                const loaded = unwrap(await window.sshdrop.loadProfile(id));
                onLoad(loaded);
                setSelected(id);
                setName(loaded.profile.name);
                setNotice(
                  'Profile loaded. Enter your password or key passphrase if needed, then connect.',
                );
              });
            }}
          >
            <option value="">New connection</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor="profile-name">
          Profile name
          <input
            id="profile-name"
            maxLength={80}
            value={name}
            placeholder="My development server"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="profile-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={() =>
              void run(async () => {
                const saved = unwrap(
                  await window.sshdrop.saveProfile({
                    ...details,
                    name,
                    ...(selected ? { id: selected } : {}),
                  }),
                );
                setProfiles((previous) => [...previous.filter((p) => p.id !== saved.id), saved]);
                setSelected(saved.id);
                setName(saved.name);
                setNotice('Profile saved. Passwords and passphrases are never saved.');
              })
            }
          >
            {selected ? 'Save profile changes' : 'Save profile'}
          </button>
          {selected && (
            <>
              <button
                type="button"
                className="secondary compact"
                onClick={() => {
                  setSelected('');
                  setName('');
                  setNotice('');
                  onNew();
                }}
              >
                New
              </button>
              <button
                type="button"
                className="secondary compact"
                onClick={() =>
                  void run(async () => {
                    if (!unwrap(await window.sshdrop.deleteProfile(selected))) return;
                    setProfiles((previous) => previous.filter((p) => p.id !== selected));
                    setSelected('');
                    setName('');
                    onNew();
                    setNotice('Profile deleted.');
                  })
                }
              >
                Delete profile
              </button>
            </>
          )}
        </div>
      </fieldset>
      <p className="profile-note">
        Fill the connection fields below, then save a profile. Only connection details and a
        key-file location are saved. Passwords and passphrases stay in this session.
      </p>
      <p className="profile-notice" role="status">
        {notice || (!ready ? 'Saved profiles unavailable or loading.' : '')}
      </p>
    </section>
  );
}
