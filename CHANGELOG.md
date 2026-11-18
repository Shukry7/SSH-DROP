# Changelog

Application versions follow Semantic Versioning. Alpha releases are development previews.

## [0.5.0-alpha.9] — Unreleased

### Added

- Saved folder upload merges support Back up and replace when the server supports OpenSSH atomic rename. Encrypted local backups and completed remote replacements are verified before continuing after reconnect.

## [0.5.0-alpha.8] — Unreleased

### Added

- Saved folder download merges offer Back up and replace. Completed replacements stay linked to their encrypted recovery backups. Unrecorded or uncertain replacement outcomes require inspection before the merge can continue.

## [0.5.0-alpha.7] — Unreleased

### Added

- Recover interrupted folder upload merges using **Skip file** and **Keep both**. SSHDrop verifies original remote files and completed copies before resuming and stops when it finds an unrecorded copy.

## [0.5.0-alpha.6] — Unreleased

### Added

- Recover interrupted folder download merges with explicit approval and verified checkpoints. Saved merges offer Skip file and Keep both for conflicts and preserve existing files.

## [0.5.0-alpha.5] — Unreleased

### Added

- Opt-in folder upload recovery into a new remote folder up to 128 MiB. Review explicitly after reconnecting. SSHDrop verifies the source, completed files, and any recorded temporary upload before continuing.

### Fixed

- Keep local file handles open until transfer cleanup finishes, preventing descriptor errors when an upload or download verification is interrupted.
- Unpack Linux image-preview libraries so the packaged app starts with its bundled native dependencies.

## [0.5.0-alpha.4] — Unreleased

### Added

- Opt-in folder download recovery between files for new destinations up to 128 MiB. Retrying requires approval and verifies the source manifest and partial folder before copying any remaining files.

## [0.5.0-alpha.3] — Unreleased

### Added

- Saved uploads can continue from an SSHDrop temporary file after explicit approval. SSHDrop compares the remote prefix with the local source, verifies the full staged file, and publishes into an empty destination.

## [0.5.0-alpha.2] — Unreleased

### Added

- Saved downloads can continue from encrypted partial bytes after a detected connection interruption. Review the retry first. SSHDrop checks the checkpoint against the remote prefix and verifies the original full-file hash before publishing. Saved uploads still restart from byte zero.

## [0.5.0-alpha.1] — Unreleased

### Added

- Opt-in encrypted recovery for individual queued transfers. Reconnect to the original verified server and account to review an interrupted transfer, retry it from the beginning into an empty destination, or forget its local record.

## [0.4.0-alpha.4] — Unreleased

### Added

- Open up to four independent SSH connection tabs, each with its own terminals, Files, editor drafts, image previews, transfers, and workflow runs. Switching tabs leaves ongoing operations on their original connection.

## [0.4.0-alpha.3] — Unreleased

### Added

- Open a remote file in a dedicated Nano or Vim terminal tab after reviewing a confirmation. Both editors run on the connected server and share the four-tab limit.

## [0.4.0-alpha.2] — Unreleased

### Added

- Open the selected terminal tab’s reported working directory in Files. Shell directory reports are tracked per tab, and navigation uses the current SFTP connection after the user clicks Open shell folder.

## [0.4.0-alpha.1] — Unreleased

### Added

- Open up to four terminal tabs on one SSH connection. Tabs preserve separate output and scrollback, and closing a shell asks for confirmation. The file explorer and other shells remain available.

## [0.3.0-alpha.5] — Unreleased

### Added

- Open up to eight remote text files in separate editor tabs. Return to the file explorer without losing drafts, undo history, search, or comparison state. Each tab uses its own verified save baseline and asks before discarding unsaved changes.

## [0.3.0-alpha.4] — Unreleased

### Added

- Read-only PNG/JPEG/WebP/GIF image previews with dimensions, file size, zoom, fit and actual-size controls. Animated images show a still first frame.
- Bounded SFTP reads and image decoding, validated request IDs, cancellation, metadata-stripped PNG display copies, and cleanup on close, disconnect and idle clearing. SVG and unsupported or oversized files are refused.

### Limits

- Preview sources are limited to 10 MiB, 8,388,608 pixels and 8,192 pixels per side. Images remain in memory; no local preview files are created. Native decoder packages require Linux/macOS packaging and device validation. Editor tabs remain planned.

## [0.3.0-alpha.3] — Unreleased

### Added

- Remote editor line numbers, filename-based syntax highlighting for JavaScript, TypeScript, JSON, YAML, Python and shell scripts, plus a manual language/plain-text selector. Unknown extensions use plain text.
- Bounded scrolling and keyboard undo/redo in the draft editor. Existing literal search, unsaved-change protection, reviewed conflict handling, encoding preservation and verified saves remain in place.

## [0.3.0-alpha.2] — Unreleased

### Added

- Case-sensitive literal search inside the remote editor, with next/previous navigation, Ctrl/Cmd+F, and up to 1,000 match positions.
- Compare a draft with the current server text. Adopt the reviewed version as a new save baseline while retaining the draft, or load the reviewed text after confirmation. The server is rechecked before accepting a comparison, and saves still require separate confirmation and verification.

## [0.3.0-alpha.1] — Unreleased

### Added

- Edit remote UTF-8 text files up to 1 MiB from the explorer. Drafts have unsaved-change protection and preserve the original LF/CRLF line endings and UTF-8 BOM.
- Verified saves with remote-change detection, basic permission preservation, encrypted recovery backup or a separately confirmed save without backup. Unsupported replacement servers, binary files, mixed line endings, special files, and stale sessions are refused.

### Limits

- One plain-text editor is available at a time. Drafts are held in memory and are cleared when idle protection replaces the workspace. Network loss keeps a draft visible for copying but disables saving until the file is reopened.
- Syntax highlighting, large-file editing, automatic merging, multiple editor tabs, and saved local drafts remain planned. Stop other writers while saving because SFTP cannot provide a compare-and-swap against external edits.

## [0.2.0-alpha.6] — Unreleased

### Added

- Opt-in idle session protection with Off/5/10/15/30/60-minute settings, a top-bar timer and a final-minute modal countdown with Stay active and End session now. Optional generic background notifications never steal focus.
- Main-owned timing and API enforcement, connection/approval invalidation, native-dialog cancellation and renderer replacement at expiry. Return opens a blank connection form; it never restores the old session or replays commands.
- Persisted validated settings, conservative handling of corrupt data, and regressions for warning boundaries, clocks, sleep/lock events, pending approvals/pickers and workflow interruption.
- Export individual encrypted recovery backups up to 32 MiB as passphrase-protected portable files. Open them offline into new local copies without the original OS key store. Wrong passphrases and damaged exports produce no destination file; existing files are never overwritten.
- Explicit Reconnect to server and Cancel connection attempt controls. Keep nonsecret connection fields in the current workspace, clear submitted credentials, and distinguish a lost SSH connection from a closed terminal or unavailable SFTP. Connection setup is bounded, and a late host approval cannot authorize a cancelled attempt. Interrupted operations are never replayed.
- Merge folder uploads and downloads after a bounded destination scan and separate approval. Each conflicting file can be skipped, copied under a new name, or replaced with or without a recovery backup where supported. Transfer rows show how many files were copied or skipped. A failed merge stops and leaves completed changes available for inspection.
- Create an empty remote file from the explorer after confirmation. SSHDrop requests owner-only access and uses exclusive SFTP creation to preserve existing paths.
- Copy or move regular files to another folder on the connected server after confirmation. Copies are limited to 128 MiB and verified before publication. Moves use SFTP rename and preserve the source if the server refuses the move. Existing destinations are refused.
- Edit ordinary read, write, and execute permissions on one remote file or folder. Review both modes before confirming, and verify the requested mode through SFTP after the change.
- Drop local files onto the remote explorer to review the destination and queue uploads. The queue rejects files changed since review and applies the usual transfer verification and overwrite choices.
- Search and group saved workflows, duplicate definitions into the editor, and export/import individual workflow JSON files. Imports open for review with new IDs and run confirmation enabled. Existing definitions and entered variable values are preserved separately.

### Limits

- This is disconnect-and-clear protection, not an authenticated app lock. Expiry or supported screen-lock/sleep events may interrupt active transfers and workflows; remote processes can continue. Unsaved inputs are lost; saved local configuration and recovery backups remain.
- Automatic protection defaults off. OS integration, notifications, accessibility and real-device behavior require platform validation. Existing alpha.5 installers remain unchanged; no alpha.6 release has been published.

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
