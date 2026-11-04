# SSHDrop 0.2.0-alpha.5 validation

Prepared on 2026-11-04 on `feat/saved-workflows`. This source change adds saved remote workflows and optional overwrite without retained backup, and addresses terminal clipping reported in the macOS DMG. It does not update existing alpha.4 installers.

## Local validation

- Version metadata, lockfile, README and changelog agree on alpha.5. Formatting, lint, types, coverage thresholds and the production build pass through `npm run check`.
- An initial local run exceeded timing bounds in two existing folder/recovery tests; both passed in isolation and the complete suite passed on repeat. The folder completion assertion now uses the same explicit 10-second asynchronous wait as the surrounding transfer assertions.
- Core/integration tests: 397 passed, two Unix-only permission tests skipped on Windows; 94.19% line coverage. Tests cover unavailable key storage, permanent-replacement cancellation, source/destination changes, lost publication acknowledgement, no backup record, and preservation of the existing backup/rollback paths.
- Workflow regressions cover versioned atomic storage, corrupt-file preservation, bounds, typed substitution/quoting, literal Docker field formats, sequential execution, nonzero/missing exits, setup/execution deadlines, output limits, stop and disconnect isolation.
- All 21 Windows desktop regressions pass, including create/edit/delete/restart/global availability, substituted preview/native cancellation, saved-definition invalidation, stale confirmation after reconnect, unsafe IPC, terminal fitting after viewport changes and long output, rerun after completion/failure/stop, changed/deleted definitions and explicit confirmation opt-out/re-enabling. New and older definitions default to confirmation on; opt-out saving requires a native default-Cancel warning.
- Terminal and workflow-preview screenshots were visually inspected. Geometry assertions check the xterm screen fits within its surface/container at several window sizes. Real-device macOS DMG/display/font testing remains required; Windows geometry tests do not certify the affected Mac.
- Windows unpacked packaging and security-fuse checks pass. Builds remain unsigned. Dependency policy passes with 15 raw moderate development-only findings covered by the existing four reviewed paths, expiring 2026-12-02; no new dependency is added.
- Secret scans cover tracked and untracked source. User `workflows.json` is ignored and rejected by the tracked-data scanner, like profiles and recovery metadata.

## Gates and limitations

Windows/Linux/macOS GitHub Actions checks and native packaging must pass before merge/release. The user authorized commit, push, PR, merge after green checks and a private draft release. This report records local validation; live CI/release results must be checked on GitHub. Publication and repository visibility changes remain unauthorized.

Workflow definitions are unencrypted local configuration; values/output are session-only. Commands require a remote POSIX shell and can perform arbitrary actions as the SSH user. Each step gets a separate shell/working directory; only its reported exit status determines success. Stop/disconnect/timeouts cannot guarantee remote process termination. There is no command rollback, automatic replay or automatic service restart. Review every custom command before execution. No production command or server was exercised by the automated tests. Run again always starts from step 1 with fresh values. With the saved confirmation preference disabled, variable-free explicit reruns start immediately; this can duplicate changes or repeat destructive actions.

No-backup replacement still requires staged verification and atomic replacement support. It intentionally has no recovery record or rollback. External writers and unacknowledged publication remain risks; inspect uncertain outcomes before retrying. Independent security review, signing/notarization and real-device failure testing remain pending.
