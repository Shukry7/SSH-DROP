# SSHDrop

A desktop SSH workspace for Windows, Linux, and macOS: an interactive terminal, remote file explorer, and explicit file transfers in one window.

**Status: 0.1.0-alpha.1, early development preview.** Cross-platform checks run in GitHub Actions; consult the latest workflow for each platform’s results. Real-device certification and signed installers are still pending.

## Current scope

- Password or private-key authentication for one active SSH connection.
- Beginner connection guide and accessible `?` help for each connection field, with examples and guidance on finding server details.
- Explicit trust prompt for unknown server keys; changed identities are rejected.
- Interactive remote terminal with resizing.
- SFTP directory browsing with an explicit destination.
- Streamed individual uploads/downloads with progress and cancellation. Development transfers use exclusive temporary files, SHA-256 destination readback, and publication without replacement. Setup/cleanup waits and stalled transfers are bounded; generic interruption notices survive reconnect without retaining old filenames.
- Session-only credentials; private keys stay on the local machine.
- Saved server profiles: add, edit, delete with confirmation, and load connection details. Profiles remember the chosen key-file location, never passwords, passphrases, or key contents.
- Development source: create remote folders, rename files/folders within their current folder, and permanently delete files or empty folders after native confirmation. Existing destinations are refused; symlinks, special files, recursive deletion, and undo are unsupported.

Saved profiles, remote file actions, and hardened transfers are available in the development source after the alpha. The existing `0.1.0-alpha.1` release artifacts do not include them. Upload verification downloads the temporary remote file once, adding roughly its size in network traffic. Downloads require a local filesystem supporting hard links for publication without replacement; unsupported filesystems fail safely. Persistent secrets, editing, folder transfers, drag-and-drop, terminal directory following, Docker browsing, and Mobile Bridge are planned. See the [roadmap](docs/ROADMAP.md).

For a step-by-step list of implemented behaviors to try, see the [manual testing checklist](docs/MANUAL_TESTING.md).

## Download the alpha

Public builds, when published, are available from [GitHub Releases](https://github.com/Shukry7/SSH-DROP/releases). Start with the installation notes and known platform limitations in [INSTALLING.md](docs/INSTALLING.md). This alpha uses unsigned installers and should be evaluated with disposable test servers.

End users do not need Node.js or npm for a packaged build. Developers building from source need Node.js 24.

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

Read the [privacy policy](PRIVACY.md) and [security review](docs/SECURITY_REVIEW.md) for local-data handling, automated checks, temporary dependency exceptions, and remaining signing/independent-review requirements. Development hardening is not included in the existing alpha installers.
