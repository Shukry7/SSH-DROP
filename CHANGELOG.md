# Changelog

Application versions follow Semantic Versioning. Alpha releases are development previews.

## [Unreleased]

## [0.2.0-alpha.1] — 2026-11-02

### Added

- Named server profiles with add, edit, load, and confirmed deletion. Persist connection settings, starting directories, and native-selected key-file locations across restarts; passwords, passphrases, and key contents remain session-only.
- Profile validation, bounded atomic storage, concurrent-write serialization, and regression coverage for persistence, invalid requests, damaged files, missing keys, and deletion cancellation.
- Confirmed remote folder creation, same-folder rename, and permanent deletion of individual files and empty folders. Strict path/IPC validation, source rechecks, operation serialization, bounded network waits, and explicit uncertain-result handling prevent automatic replay after interruptions. Symlinks and special files are refused.
- Security gates for dependency advisories and tracked secrets, weekly monitoring, pinned Actions, actual packaged-fuse inspection, and a privacy policy with documented review limits.

### Fixed

- Stage transfers in exclusive mode-0600 temporary sibling files, verify destination bytes with SHA-256, and publish only after source rechecks and verification. Bound setup/cleanup waits and stop stalled transfers without imposing a total-duration limit on progressing transfers. Preserve generic interruption warnings across reconnects, refuse automatic replay/rollback of uncertain publication, and reserve transfer slots before asynchronous setup.
- Keep sidebar controls at their full height in short windows and use slim, themed scrollbars. Remove the default Electron application menu.
- Dispose terminal buffers and clear transfer history across connections; suppress late transfer events from disconnected sessions.
- Bound hostile-server directory reads and local JSON storage; validate IPC page origins and prevent multiple app processes from racing local stores.

### Changed

- Update Electron to 45.2.1 and compatible minimatch dependencies to 11.0.1. Retain narrowly reviewed development-only legacy copies under an exception expiring 2026-12-02; raw advisory counts are not hidden.

- Update GitHub Actions dependencies and verify uploaded coverage diagnostics can be downloaded from all three platforms.
- Defer Dependabot's TypeScript 7 updates until the ESLint tooling supports them; compatible TypeScript 6 updates remain enabled.

### Limitations and critical warnings

- Unsigned alpha installers; macOS notarization, independent security review, and real-device platform certification remain pending. Evaluate with disposable files and servers.
- Remote deletion is permanent with no trash or undo and supports only individual files and empty folders. Symlinks, special files, and recursive deletion are refused.
- Transfer setup/finalization waits are bounded at 30 seconds, inactivity at two minutes without progress, and cleanup at three seconds. Interruptions can leave temporary `.sshdrop-*.part` files or an already-published destination; inspect selected folders before retrying. No pause/resume or automatic recovery is implemented.
- Upload verification adds approximately one file's worth of download traffic. Download publication requires filesystem hard-link support and fails safely without it. Checksums and source metadata checks do not establish a transactional snapshot, independent trusted-server digest, or disk durability.
- Profile metadata is stored locally without encryption; passwords, passphrases, and key contents are not saved. Generic interruption notices survive reconnect only in app memory, without old filenames/server details.
- Dependency policy retains 15 raw development-only findings under exact reviewed exceptions expiring 2026-12-02. This is not a zero-vulnerability or complete-security certification.
- Built-in editing, persistent credentials, multiple simultaneous servers, recursive transfers, transfer queues, automatic updates, Docker browsing, and Mobile Bridge remain unimplemented.

## [0.1.0-alpha.1] — 2026-10-31

### Added

- Beginner SSH connection guide and keyboard/touch-accessible field help for host, username, port, authentication, password, private key, passphrase, and starting directory.
- Electron, React, and TypeScript desktop foundation.
- Explicit SSH host trust, session-only authentication, interactive terminal, and SFTP browsing.
- Streamed file transfers with progress, cancellation, and exclusive destination creation.
- Regression tests, desktop smoke tests, and cross-platform GitHub Actions.
- Version consistency checks and coordinated version bump tooling.

### Fixed

- Disable uploads while the explorer is loading a directory, preventing transfers from targeting the previous folder during navigation.
- Resolve filesystem aliases when detecting direct execution of the sandbox helper, so macOS temporary-path tests execute correctly.
- Prevent Electron cold-install download output from contaminating the Ubuntu CI AppArmor profile; validate the profile before installing it.

### Limitations

- Early development preview; installers are unsigned until release signing is configured.
- Credentials are not persisted. Editing, saved profiles, folder transfers, drag-and-drop, and Mobile Bridge are planned.
