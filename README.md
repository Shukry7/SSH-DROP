# SSHDrop

A desktop SSH workspace for Windows, Linux, and macOS: an interactive terminal, remote file explorer, and explicit file transfers in one window.

**Status: 0.1.0-alpha.1, early development preview.** Cross-platform checks run in GitHub Actions; consult the latest workflow for each platform’s results. Real-device certification and signed installers are still pending.

## Current scope

- Password or private-key authentication for one active SSH connection.
- Beginner connection guide and accessible `?` help for each connection field, with examples and guidance on finding server details.
- Explicit trust prompt for unknown server keys; changed identities are rejected.
- Interactive remote terminal with resizing.
- SFTP directory browsing with an explicit destination.
- Streamed individual uploads/downloads with progress and cancellation. Existing destinations are refused rather than overwritten.
- Session-only credentials; private keys stay on the local machine.

Saved profiles, persistent secrets, editing, folder transfers, drag-and-drop, terminal directory following, Docker browsing, and Mobile Bridge are planned. See the [roadmap](docs/ROADMAP.md).

For a step-by-step list of implemented behaviors to try, see the [manual testing checklist](docs/MANUAL_TESTING.md).

## Development

Install Node.js 24, then:

```sh
npm ci
npm run dev
```

Use a disposable Linux SSH server with SFTP enabled. The first connection prompts you to verify its SHA-256 fingerprint through a trusted channel. The explorer path is independent of the terminal's directory.

```sh
npm run check          # metadata, formatting, lint, types, regression coverage, build
npm run test:coverage  # core coverage and thresholds
npm run test:e2e       # real Electron desktop/security checks
npm run package:dir    # unpacked application for this platform
npm run dist           # unsigned development installers
```

Headless Linux desktop tests need `xvfb-run -a npm run test:e2e`. Build on each target operating system. macOS release distribution needs signing and notarization; signing is not configured in this alpha.

## Contributing and releases

Use focused branches and pull requests, with regression tests for new operations and bug fixes. GitHub Actions checks Windows, Linux, and macOS. See [contributing](CONTRIBUTING.md), [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), [versioning](docs/VERSIONING.md), and [changelog](CHANGELOG.md).

Licensed under [MIT](LICENSE).
