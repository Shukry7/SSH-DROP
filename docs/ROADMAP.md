# Roadmap

## Implementation priorities after 0.2.0-alpha.5

The disconnect-and-clear part of priority 1 is implemented in alpha.6 development source as described below; authenticated lock/unlock remains planned. Alpha.6 development source includes per-file encrypted exports and offline restore-to-copy; whole-vault migration and rotation remain planned. Alpha.5 is a private draft with merged source, green cross-platform CI and verified release checksums. First manually validate its installers on supported devices, including the affected macOS terminal/display, workflow confirmation preferences and overwrite/recovery behavior. CI does not replace this device testing.

| Priority | Work                                             | Scope and completion criteria                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Idle locking and visible countdown               | Configurable inactivity limit; warning modal above all SSHDrop panels during the final minute; live seconds countdown, Stay active and Lock now. Hide sensitive content and block actions when locked. Complete the unlock design before treating this as a security boundary.      |
| 2        | Backup portability and key recovery              | Per-file encrypted export and offline restore-to-copy up to 32 MiB are implemented in development source. Whole-vault migration and rotation remain planned. See [portable backups](PORTABLE_BACKUPS.md).                                                                           |
| 3        | Connection recovery and optional idle disconnect | Explicit reconnect, cancel, setup bounds and separate shell/SFTP status are implemented in development source. Idle disconnect is covered by session protection. Automatic resume and authenticated lock are separate future work. See [connection recovery](RECONNECT.md).         |
| 4        | Folder merging and conflicts                     | Development source supports upload/download merges with per-file skip, keep both and both replacement options where supported. Includes bounded scans, verified publication and partial-result counts. See [manual testing](MANUAL_TESTING.md#folder-merges-unreleased-020-alpha6). |
| 5        | Everyday file tools                              | Development source supports file creation, cross-folder copy/move for regular files, single-item permissions, and drag-and-drop file uploads. Recursive deletion needs a separate destructive-operation design.                                                                     |
| 6        | Workflow library improvements                    | Development source includes search, optional groups, duplicate into editor, and individual JSON import/export. Imports open for review with new IDs and confirmation enabled. Review exported commands for private details.                                                         |
| 7        | Remote editor (0.3 series)                       | Development source includes bounded UTF-8 editing, search, draft/server comparison, reviewed baseline adoption, unsaved drafts, and verified saves. Syntax highlighting, automatic merging, and tabs remain planned. See [remote editing](REMOTE_EDITOR.md).                        |
| 8        | Workspace integration (0.4 series)               | Multiple terminals, session tabs, dedicated terminal editors and optional directory following with explicit fallback destinations.                                                                                                                                                  |
| 9        | Resumable transfers and persistent queues        | Identity-bound recovery, source/destination revalidation and explicit user approval after interruption. Design byte-level resume separately from retrying a whole transfer; never silently overwrite or replay uncertain work.                                                      |
| 10       | Optional saved credentials                       | Opt-in OS-backed credential storage with lock/unlock, deletion and platform failure behavior. Session-only secrets remain the default; backup key protection is not saved SSH authentication.                                                                                       |
| 11       | Later integrations                               | Container filesystem browsing, remote-to-remote transfers, native drag-out and a separately designed Mobile Bridge. Each needs its own permissions and data-exposure review.                                                                                                        |

Signing/notarization, platform key-store testing, accessibility, dependency maintenance and independent security review progress alongside these priorities and are required before a stable public 1.0. Repository visibility and release publication remain separate maintainer decisions.

Version allocation is provisional: disconnect-and-clear idle protection is scoped for 0.2.0-alpha.6, with later 0.2 alphas scoped around data safety and file management. Confirm scope and use the version tooling at each release boundary; do not reserve an alpha number for every roadmap row or bump the application for this documentation update.

### Alpha.6 source scope and remaining idle protection

Alpha.6 development source adds opt-in disconnect-and-clear protection, a final-minute countdown, optional generic background notifications and main-owned timing/API gates. It defaults Off; expiry, supported OS lock events and suspend disconnect SSH, invalidate approvals and replace the renderer with a privacy screen. Return opens a blank form. Existing alpha.5 installers are unchanged. See [IDLE_PROTECTION.md](IDLE_PROTECTION.md).

The following describes the broader target design. In particular, authenticated locking that keeps active connections running is **not implemented**. The user selected disconnect-and-clear as the first implementation because uniform secure OS unlock is unavailable.

### Broader idle-protection target

- Separate policies for locking the app and disconnecting SSH. A 10-minute inactivity setting is an example, not a mandatory default: show a persistent status indicator, warn at nine minutes and count down the remaining minute. Choose the shipped default during implementation and explain it in settings.
- The warning is an accessible in-app modal above every SSHDrop panel, with visible text, keyboard access and a screen-reader announcement strategy that does not announce every second. Optional desktop notifications may alert a background user without stealing focus or forcing SSHDrop above other applications. Never include commands, paths, credentials or server output in a notification.
- Main owns the deadline and enforces the locked state across relevant IPC actions. Count local intentional input only; remote output, transfer progress and keepalives do not reset inactivity. Once the warning is shown, require Stay active explicitly; mouse movement must not dismiss it.
- Lock hides terminal content, file listings, server details, recovery records and workflow results; blocks terminal input and sensitive actions; and invalidates pending execution approvals. Active transfers and remote workflows may continue under the lock policy. Remote processes can continue even after a disconnect.
- Design OS-authenticated unlock per platform before implementation. If a secure unlock provider is unavailable, explain the limitation and use a conservative policy such as disconnecting and requiring SSH authentication again; a click-to-dismiss screen is not authenticated locking. This feature supplements the operating system screen lock and cannot defend against a compromised local account.
- Lock on OS lock/sleep where supported. Recheck elapsed deadlines on wake and resume, handle clock changes, and never execute commands or trust an old preview as part of reconnecting. Keep SSH keepalives independent of user inactivity.
- Optional idle disconnect uses its own clearly labeled warning and countdown, explains transfer interruption and uncertain remote outcomes, and never resumes or reruns work automatically. Decide and document active-operation behavior before enabling the policy.
- Required regressions include countdown boundaries, Stay active/Lock now, background/minimized windows, keyboard accessibility, remote-output inactivity, IPC rejection while locked, pending dialogs/approvals, active operations, disconnect/reconnect, clock changes, sleep/wake and unavailable authentication providers. Validate native OS behavior on real devices as well as in CI.

## 0.1 alpha — Core vertical slice

Secure desktop foundation; validated IPC; host verification; session-only password/private-key authentication; beginner connection guide and field help; one remote terminal; SFTP browsing; single-file transfers; regression tests; cross-platform CI; desktop smoke tests; version tooling.

## 0.2 — Everyday file management

Implemented in development source (not in the 0.1.0-alpha.1 installers): saved profiles with add/edit/delete/load, session-only secrets, remembered key-file locations, confirmed remote folder creation, same-folder file/folder rename, and permanent deletion of files and empty folders.

Version 0.2.0-alpha.4 adds a bounded, session-only multi-file upload/download queue with sequential execution, per-file cancellation, explicit continuation after failure, and no replay after disconnect. Version 0.2.0-alpha.4 also adds bounded folder copies into new destinations (100 items, 16 levels, 10 GiB, 30-second scan), refusing links/special files and preserving empty folders. Cancellation keeps partial results for inspection. Existing alpha.3 installers include neither queue nor folder copies.

The unreleased alpha.6 adds confirmed creation of empty remote files, same-server copy/move of regular files between existing folders, single-item editing of ordinary permission bits, and drag-and-drop uploads for individual files. Optional saved credential storage, recursive deletion, and general undo for deletion/renaming remain planned.

Development hardening adds terminal/transfer-history reset, bounded remote directory reads, ephemeral renderer storage, dependency/secret gates, and packaged security-fuse verification. Signing, notarization, independent review, and real-device security validation remain pending; see [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

Transfers stage into temporary files, verify SHA-256 readback, recheck source metadata, use bounded setup/cleanup and a progress-based inactivity timeout, and retain generic interruption warnings across reconnects. Version `0.2.0-alpha.2` adds explicit conflict choices, independent local verified backups, guarded replacement/rollback, and crash-persistent recovery records with manual inspection and restore-copy. Version `0.2.0-alpha.3` encrypts new backup contents and recovery metadata with an OS-protected key, and provides explicit verified migration of legacy plaintext backups. Real-device keychain validation, signed app identity, OS key rotation handling, and migration from Electron 45's synchronous Linux provider remain pending. Byte-level pause/resume, persistent queues, automatic recovery, metadata-complete backups, and atomic compare-and-swap against other writers remain unimplemented. Earlier `0.2.0-alpha.1` installers do not include backup/rollback.

Version 0.2.0-alpha.5 adds verified overwrite without retained backup, local global command/workflow definitions, typed variables, exact previews and server confirmation enabled by default, bounded sequential SSH execution, explicit Run again with fresh inputs and a saved confirmation preference, and a generic non-destructive example. These are distinct from multiple interactive terminals, unattended automation and shell-directory following, which remain planned.

## 0.3 — Remote editing

The `0.3.0-alpha.1` development source includes a single plain-text editor for UTF-8 files up to 1 MiB, preservation of LF/CRLF and BOM, unsaved-change protection, remote-change detection, and verified saves with optional encrypted recovery. Alpha.2 adds literal search, draft/server comparison, and reviewed baseline adoption. Monaco/syntax highlighting, automatic merging, additional encodings, and editor tabs remain planned.

## 0.4 — Workspace integration

Multiple terminals, shortcuts, dedicated nano/vim sessions, and optional shell-specific directory following with explicit fallback destinations.

## 1.0 — Stable desktop release

Real-device validation on supported OS/architectures, signing, installation documentation, recovery testing, accessibility review, and security review. CI success alone does not certify platform support.

## Later

Mobile Bridge, container filesystem integration, native drag-out, and remote-to-remote operations. Mobile Bridge needs a separate TLS, pairing, session, permission, and revocation design.
