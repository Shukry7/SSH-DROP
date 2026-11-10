# Changelog

Application versions follow Semantic Versioning. Alpha releases are development previews.

## [0.2.0-alpha.5] — 2026-11-04

### Added

- Run again reloads the latest saved workflow from step 1, clears variable inputs and uses fresh connection-bound execution tokens and the saved confirmation preference (enabled by default). Disabling confirmation requires a native safety warning when saving; variable-free Run again then starts immediately. Completed, failed and stopped runs can be reviewed for rerun; deleted definitions and disconnected results cannot be replayed. Maximum-runtime help clarifies that the timeout is not a delay.

- Replace without backup for existing regular files, with a separate permanent-replacement warning, verified staging, source/destination rechecks and atomic replacement. No vault backup, recovery record or rollback is created; unsupported atomic replacement remains refused.
- Global locally saved command/workflow definitions with add/edit/delete, typed text/integer variables, exact substituted previews, per-run native server confirmation and a generic non-destructive example. Commands run in separate SSH execution channels, step by step, with live results and failure stops.
- Connection-bound single-use previews, stale-definition checks, bounded output and timeouts, explicit stop/following-logs mode and regression tests for execution, quoting, persistence, failure and disconnect isolation.

### Fixed

- Prevent the terminal panel shrinking below its contents; refit xterm after viewport and font loading changes to address clipped terminal rows seen in the macOS DMG.

### Limits

- Commands require a remote POSIX shell. Definitions are stored unencrypted locally; entered values and output are session-only. Stop/disconnect cannot guarantee remote process termination. No automatic replay, general command rollback, folder merging, unattended execution or secret-variable storage is added.
- Existing alpha.4 installers are unchanged; these features require alpha.5. Signing, real-device macOS certification and independent security review remain pending.

## [Unreleased]

### Fixed

- Development macOS packages now explicitly use ad-hoc signing after bundle/fuse changes, with Electron runtime entitlements. This is integrity signing only, not Apple Developer ID signing or notarization.
- Add macOS validation of nested signatures, DMG checksums/mounting, embedded version/ASAR bytes and host-architecture packaged startup. A manual CI mode compares existing alpha.2 and alpha.5 release DMGs without modifying them.

### Changed

- CI runs on main pushes and pull requests instead of duplicating every feature push; successful runs retain no diagnostic artifacts, failure diagnostics and release handoff artifacts expire after one day. Tagged releases still retain their independent release assets.

## [0.2.0-alpha.4] — 2026-11-03

### Added

- A session-only multi-file transfer queue: select multiple local files for upload or select remote files and a native destination folder for downloads. At most 100 active/waiting files run sequentially, retaining per-file progress, cancellation, verification, and overwrite/backup safeguards.
- Waiting files can be cancelled without opening their sources or modifying destinations. A failed/interrupted active file pauses the remaining queue; Continue queue requires a native confirmation and never retries the failed file. Disconnect discards pending work and clears connection-specific names rather than replaying it after reconnect.
- Strict batch validation, conservative destination-collision detection, Windows filename protection for batch downloads, and regression coverage for cancellation, failure pauses, stale pickers/confirmations and connection isolation.

- Bounded folder uploads/downloads into new destinations, with native default-Cancel warnings showing both paths, empty-folder preservation, aggregate progress/cancellation, strict link/name/size/depth limits and per-file staged SHA-256 verification. Existing folder destinations are refused; partial copies remain for inspection after failure.

### Fixed

- Resolve the initially selected local parent to support native macOS path aliases such as `/var` → `/private/var`, while retaining link checks on the selected folder and all descendants.

### Limits

- No folder merging, persistent queue, automatic retries or byte-level transfer pause/resume. Navigation and remote file mutations are locked while files remain queued; recovery inspection remains available while the queue is paused. New queued work retains the originally selected destination.
- Existing 0.2.0-alpha.3 installers are unchanged; queue and folder copies require 0.2.0-alpha.4. Installers remain unsigned development previews.

## [0.2.0-alpha.3] — 2026-11-02

### Added

- AES-256-GCM encryption for new local recovery backups and recovery metadata, with random per-file nonces and a random vault key protected by the OS key store. Backup encryption streams directly to disk; recovery authenticates and verifies staged contents before publishing.
- Explicit Secure backup migration for legacy plaintext backups. Originals remain until encrypted content verifies and metadata is committed; interrupted migrations and plaintext cleanup can be retried. Other legacy backup contents remain plaintext until secured individually.
- Failure-path regressions for locked/unavailable OS storage, missing/corrupt keys, ciphertext tampering and substitution, partial encryption, migration failures, and recovery staging.

### Safety and compatibility

- No plaintext key-store fallback. Windows and macOS use Electron asynchronous safeStorage; Linux requires an available recognized libsecret/KWallet backend and uses the verified synchronous provider to avoid the independent asynchronous fallback. Linux provider migration will need review before upgrading past Electron 45.
- Keep `vault-key.json` with the entire backup folder and retain access to the original OS account/key store. Copying the folder alone does not make a portable backup. Encryption does not protect against software running as the same OS user; ordinary deletion is not secure erasure.
- Existing alpha.2 installers are unchanged. These changes are included in the 0.2.0-alpha.3 draft prerelease. Installers remain unsigned, and real-device macOS/Linux key-store validation is pending.

## [0.2.0-alpha.2] — 2026-11-02

### Added

- Native conflict confirmation with Cancel, Keep both, and Back up and replace. Replacement requires a verified independent local backup, a staged incoming file, a destination recheck, and supported atomic replacement; ordinary transfers still publish without replacing existing files.
- Persistent, bounded recovery records tied to the exact SSH host key, address, port, and account. The Recovery backups panel can inspect uncertain operations, restore a separate copy, roll back with another backup of the current version, and explicitly delete resolved backups.
- Failure-path coverage for interrupted replacement, stale approvals, changed destinations, corrupted backups/records, storage limits, unsupported servers, and native Windows replacement.

### Data and safety notes

- Backups store **unencrypted file contents and path metadata** locally until explicitly removed. Limit: 100 recovery records / 10 GiB of accounted backup contents, plus a 50 MiB free-space reserve. Protect the device and its disk. There is no automatic retention deletion or automatic recovery replay.
- Regular files only; local multiple-hard-link files and special permission bits are refused. Basic owner/group/mode are checked; remote ACLs, extended attributes, hidden hard links and concurrent writers cannot be fully detected or preserved. Stop other writers and test with disposable files. Hashes cover ordinary file contents, not alternate streams or all metadata; atomic replacement does not guarantee power-loss durability.
- Version `0.2.0-alpha.2` includes these changes; earlier `0.2.0-alpha.1` artifacts remain unchanged. Installers are unsigned, macOS notarization and independent security review remain pending, and real-device validation is still required. Test disposable files and servers.
- Dependency policy retains 15 raw moderate development-only findings under exact reviewed exceptions expiring 2026-12-02. Passing the policy is not a zero-vulnerability claim; see the security review for scope and remaining work.

### Review fixes

- Refuse replacement and rollback after timestamp-only destination edits. Verify the independent backup again immediately before publication, and compare restored remote copies with the recorded backup hash.
- Clear connection-specific errors and busy controls on disconnect; suppress delayed recovery/transfer errors from older connections so their paths cannot reappear in the next session.
- Validate recovery paths before native confirmations, reject misleading control/bidirectional characters, and reject special permission bits and non-file recovery metadata before use.
- Report cancelled conflict/recovery confirmations as cancelled operations instead of completed transfers.

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
