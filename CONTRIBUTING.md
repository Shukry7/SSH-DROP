# Contributing to SSHDrop

Use Node.js 24 and npm. Run `npm ci`, `npm run dev`, and `npm run check`.
On Windows, if an unrelated global npm installation is broken, use the npm.cmd bundled with Node.

1. Open an issue describing the behavior and acceptance criteria.
2. Create a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch.
3. Add regression tests with each new operation or bug fix. Cover success and realistic failures; do not replace real service tests with UI-only mocks.
4. Update relevant documentation and the current changelog entry. Several development commits may share one unreleased version.
5. Run `npm run check`, `npm run test:coverage`, and, for desktop changes, `npm run test:e2e`.
6. Open a focused pull request describing behavior, validation, and limitations. Squash merge after required checks pass.

Integration tests start a disposable SSH/SFTP server on loopback with temporary keys and files. Never use a production server or real credentials in tests.

CI runs regression tests and desktop smoke tests on Windows, Linux, and macOS. Packaging checks produce unsigned development artifacts. Signing and public distribution require a separate release setup.

Before a release, run `npm run version:bump -- 0.1.0-alpha.2` (substitute the intended version), finish its changelog entry, and run all checks. Tags use `v` plus the exact application version. See [versioning](docs/VERSIONING.md).
