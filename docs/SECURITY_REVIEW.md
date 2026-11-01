# Security hardening review — 2026-11-02

Scope: development source including saved profiles, automated regression tests, npm dependency advisories, packaging configuration, and CI. This is not an independent penetration test, cryptographic certification, full traffic inspection, memory-forensics assessment, or an assurance that all vulnerabilities are known.

## Implemented controls and evidence

- Electron sandbox and context isolation stay enabled; Node integration and webviews stay disabled. Permissions, navigation, and popup creation are denied. IPC validates the application window, main frame, expected page URL, and operation payload. Desktop tests exercise these restrictions and renderer fetch rejection.
- Renderer storage uses a nonpersistent session. Production DevTools are disabled. Main exposes individual application methods rather than generic shell/filesystem/IPC access.
- Server host identities are checked before authentication; changed identities and malformed/oversized trust stores block connection. Native confirmation is required for new trust.
- Passwords, passphrases, and key contents are not saved. Profile metadata remains intentionally unencrypted and is disclosed in the UI and privacy policy. Atomic bounded storage and a single-instance lock prevent ordinary concurrent application processes from overwriting one another's profile/trust changes.
- A terminal reset disposes the old xterm instance, including pending writes, on disconnect and before connecting. Transfer history clears, and late old-session transfer events are suppressed. Desktop tests verify the old terminal DOM is detached and history removed; this does not prove forensic memory erasure.
- SFTP listings use bounded batches rather than accumulating an unbounded `readdir(path)` result: 10,000 entries, 4 MiB of accounted filename/metadata data, 128 batches, and a 30-second deadline, with bounded best-effort handle cleanup. Invalid filenames and metadata are rejected. Unit tests include endless/empty batches, malformed names, excessive sizes, timeouts, stale sessions, and cleanup. SSH/SFTP parsing still depends on maintained third-party libraries.
- Private keys and transfers use native file selection and exclusive destinations. Existing overwrite, cancellation, host-trust, sandbox, and profile tests remain in the suite.
- Electron updated to 45.2.1. Packaged fuses disable Node mode, Node option environment variables, and Node inspection arguments; application code must load from ASAR, with embedded integrity validation enabled where supported. CI inspects actual packaged binaries and builds full installers on each OS. ASAR/fuses do not replace OS code signing; Linux does not provide the same embedded integrity enforcement as Windows/macOS.
- Official workflow Actions are pinned to commit SHAs. Dependency-policy and tracked-file secret gates run on every platform and release, with weekly monitoring once merged into the default branch. Scan errors fail rather than implying a clean result. Uploaded diagnostics use a restricted path list and synthetic fixtures.

## Remote file action controls

Remote file actions use strict action-specific IPC schemas and SFTP requests only. Main-process native confirmations default to Cancel and show quoted full paths. Delete is permanent and nonrecursive; symlinks/special files and root-like targets are refused. Canonical parent and source metadata are checked again after confirmation. File actions serialize against app transfers; each preflight/post-confirmation network phase has a 10-second deadline, excluding time spent reviewing confirmation. Interruptions after sending are reported as uncertain and never automatically retried or rolled back; network timeout closes the connection to isolate late replies. Standard rename refuses replacement under the [SFTP v3 specification](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5); the overwrite extension is not used. These checks cannot eliminate server-side races, identify every same-metadata replacement, protect against a malicious/nonconforming server, or prevent changes made through the terminal or another client. Use disposable paths and backups for critical data.

## Dependency findings and temporary exception

The initial full npm audit reported 25 moderate findings, all stemming from [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Compatible modern minimatch copies are now overridden to patched 11.0.1. Do not use `npm audit fix --force`: npm suggests downgrading core build/lint tools and can break their APIs.

The raw report still lists 15 moderate transitive findings, rooted in four development-only paths using minimatch 3.1.5 or 5.1.9. Those implementations use an older callable CommonJS API and lack `firstPhasePreProcess`, `secondPhasePreProcess`, and the `optimizationLevel` preprocessing algorithm described in the advisory. Installed-version/API tests support this applicability assessment; it is not an upstream advisory correction or a claim that these packages have no other flaws.

`scripts/security-exceptions.json` records the exact advisory and versions, with expiry **2026-12-02**. The policy rejects other advisories, changed versions, production dependencies, high/critical findings, unknown advisory chains, expired exceptions, incomplete reports, and service failures. Raw findings remain visible in audit output and diagnostics. Review upstream-compatible replacements and the advisory again before expiry; do not extend the exception automatically.

Run `npm run security:audit`, `npm run security:secrets`, `npm run check`, `npm run test:e2e`, and, after packaging, `npm run security:package`. An npm production-only clean scan does not establish the safety of Electron's bundled Chromium/Node binaries or unknown vulnerabilities.

## Release work requiring external resources

- Obtain Windows signing and Apple Developer signing/notarization credentials; exercise signed installation/update paths on real devices. Existing draft installers are unchanged and unsigned.
- Commission an independent security review and hostile-server protocol fuzzing. Perform OS-level traffic, Windows ACL, crash/swap/clipboard, installer, and recovery assessments on real supported devices.
- Review distribution telemetry and privacy again before adding updates, secret persistence, remote editing, third-party services, or Mobile Bridge. No LAN service is implemented.

The source hardening and gates can be reviewed now. Public/stable release certification is not complete.
