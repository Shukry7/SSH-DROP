# Continuous integration and release checks

CI runs on pushes and pull requests using Node.js 24 on Windows, Ubuntu 24.04, and macOS 15. Each platform checks metadata, formatting, lint, types, regression coverage, the production build, real Electron smoke tests, and unpacked application packaging. Linux desktop tests run under Xvfb. Failed-run reports and screenshots are retained briefly as artifacts.

Core coverage gates are 80% statements, lines, and functions and 70% branches. New features still need meaningful behavior and failure tests; high coverage is not a correctness guarantee. Integration tests use a disposable loopback SSH/SFTP server with generated keys, never production credentials.

Desktop tests explicitly keep Chromium sandboxing enabled. On the disposable Ubuntu runner, a narrowly scoped AppArmor profile permits the test Electron binary to create its user-namespace sandbox. This does not change the machine-wide AppArmor restriction and is not an end-user installation procedure.

The profile is generated directly from the executable path returned by Electron's Node module. Installer logs are never treated as path data. The script checks for malformed paths and validates the temporary profile with AppArmor's parser before installing it. A regression test simulates a cold Electron install that prints download messages. Actual Ubuntu parser and sandbox behavior still require a successful hosted Linux run.

After the first successful GitHub run, a maintainer should enable a ruleset for main requiring pull requests and these checks:

- `Checks (ubuntu-24.04)`
- `Checks (windows-latest)`
- `Checks (macos-15)`

Also restrict force pushes and enable private vulnerability reporting where available. Workflow files alone cannot enforce branch protection; these are repository settings.

The release workflow only runs on v-prefixed tags. It rechecks the exact tag/version, runs tests on all three OSes, produces unsigned development installers, generates SHA-256 checksums, and creates a draft release. It does not publish the draft automatically. No signing credentials are used in contributor CI.

The macOS installer builds target Apple Silicon and Intel, while the native test runner exercises its own architecture. Other architectures and real-device behavior need additional validation before a supported-platform claim.
