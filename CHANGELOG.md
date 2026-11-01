# Changelog

Application versions follow Semantic Versioning. Alpha releases are development previews.

## [Unreleased]

### Added

- Named server profiles with add, edit, load, and confirmed deletion. Persist connection settings, starting directories, and native-selected key-file locations across restarts; passwords, passphrases, and key contents remain session-only.
- Profile validation, bounded atomic storage, concurrent-write serialization, and regression coverage for persistence, invalid requests, damaged files, missing keys, and deletion cancellation.

### Changed

- Update GitHub Actions dependencies and verify uploaded coverage diagnostics can be downloaded from all three platforms.
- Defer Dependabot's TypeScript 7 updates until the ESLint tooling supports them; compatible TypeScript 6 updates remain enabled.

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
