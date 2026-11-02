# Roadmap

## 0.1 alpha — Core vertical slice

Secure desktop foundation; validated IPC; host verification; session-only password/private-key authentication; beginner connection guide and field help; one remote terminal; SFTP browsing; single-file transfers; regression tests; cross-platform CI; desktop smoke tests; version tooling.

## 0.2 — Everyday file management

Implemented in development source (not in the 0.1.0-alpha.1 installers): saved profiles with add/edit/delete/load, session-only secrets, remembered key-file locations, confirmed remote folder creation, same-folder file/folder rename, and permanent deletion of files and empty folders.

Remaining: supported OS secret storage, multi-file queue, recursive transfers with explicit symlink behavior, file creation, copy/move between folders, permissions editing, reconnect controls, and drag-and-drop uploads. Recursive deletion and general undo for deletion/renaming are not implemented.

Development hardening adds terminal/transfer-history reset, bounded remote directory reads, ephemeral renderer storage, dependency/secret gates, and packaged security-fuse verification. Signing, notarization, independent review, and real-device security validation remain pending; see [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

Transfers stage into temporary files, verify SHA-256 readback, recheck source metadata, use bounded setup/cleanup and a progress-based inactivity timeout, and retain generic interruption warnings across reconnects. Version `0.2.0-alpha.2` adds explicit conflict choices, independent local verified backups, guarded replacement/rollback, and crash-persistent recovery records with manual inspection and restore-copy. Pause/resume, queues, encrypted backup storage, automatic recovery, metadata-complete backups, and atomic compare-and-swap against other writers remain unimplemented. Earlier `0.2.0-alpha.1` installers do not include backup/rollback.

## 0.3 — Remote editing

Monaco, bounded text loading, unsaved changes, safe-save capability handling, encoding policy, and remote-change conflict handling.

## 0.4 — Workspace integration

Multiple terminals, shortcuts, dedicated nano/vim sessions, and optional shell-specific directory following with explicit fallback destinations.

## 1.0 — Stable desktop release

Real-device validation on supported OS/architectures, signing, installation documentation, recovery testing, accessibility review, and security review. CI success alone does not certify platform support.

## Later

Mobile Bridge, container filesystem integration, native drag-out, and remote-to-remote operations. Mobile Bridge needs a separate TLS, pairing, session, permission, and revocation design.
