# SSHDrop 0.2.0-alpha.4 validation

Prepared on 2026-11-03. This unsigned alpha adds the session-only multi-file queue and bounded folder copies. It does not certify every device, server or failure mode.

## Local automated validation

- `npm run check`: 353 passed, two Unix-permission tests skipped on Windows, 94.1% line coverage. Version metadata, formatting, lint, types, coverage thresholds and production build pass.
- `npm run test:e2e`: all 16 desktop regressions passed against the final alpha.4 build on Windows.
- Desktop regressions use isolated application-data directories and disposable loopback SSH/SFTP servers. No production profiles, credentials, servers or backup data are used. Windows recovery exercises real OS key protection; headless Linux/macOS recovery uses an isolated test provider.
- Queue regressions cover sequential execution, waiting/active cancellation, failure pause, explicit continuation, no failed-job retry, bounded selections, unsafe IPC, stale native pickers/confirmations, and connection isolation.
- Folder regressions cover nested and empty directories, exact transferred bytes, aggregate progress, existing/newly appeared destinations, symbolic links/junctions, local hard links, colliding/unsafe names, scan/item/depth/size limits, changed sources, cancellation, stalled scans and network loss. Every file retains staged SHA-256 readback and no-replace publication.
- Secret scanning includes tracked and untracked release source. Dependency policy passes with 15 raw moderate development-only findings in four reviewed paths; existing exceptions expire 2026-12-02. No new dependency is introduced.
- The folder controls and layout were inspected in an automated Windows screenshot. This is distinct from hands-on native installation or real-device certification.

## Release gates

The final version must pass desktop regression tests locally and the pull-request CI on Windows, Linux and macOS before merging. The annotated release tag must point to the resulting main commit. The tagged-release workflow repeats verification and packaging for all three platforms, checks packaged security fuses, and assembles a draft with SHA-256 checksums. Inspect and verify the actual downloaded draft assets before accepting the draft. Keep the repository private and the release unpublished.

## Limits and further testing

Folder copies require a new destination, at most 100 items including folders, 16 levels, 10 GiB, and a 30-second scan. They do not merge folders, preserve ACLs/ownership/executable permissions, resume interrupted files, or recursively remove partial results. Completed plaintext files and empty folders can remain after failure; inspect before retrying. Files added after scanning are not included. Use trusted parent folders and stop other writers: metadata/canonical-path checks cannot provide atomic directory-relative confinement against concurrent path swaps through SFTP v3 or reveal hidden remote hard links.

Signing/notarization, native macOS/Linux keychain lifecycle, real hardware/network fault testing, non-NTFS local filesystems, Windows ACLs, disk-full/power-loss testing and independent security review remain pending. Existing alpha.3 installers are unchanged and do not include these queue/folder features. See the manual checklist for disposable real-device testing.
