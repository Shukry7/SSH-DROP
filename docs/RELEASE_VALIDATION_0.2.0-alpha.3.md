# SSHDrop 0.2.0-alpha.3 validation

Validated on 2026-11-02. This is an unsigned alpha draft, not a certification that every environment or failure mode is safe.

## Hands-on Windows review

Used an isolated application-data directory, disposable loopback SSH/SFTP server and files, and real Windows OS key protection. No production server, credentials, profiles or backups were used.

- Confirmed alpha.3 in the header/footer, the connected server identity, and the Encrypted recovery label.
- Reviewed the recovery warning, long destination path, action availability, sidebar/main scrolling, and beginner SSH guide.
- Invoked Inspect and observed the completed record and controls recover after the operation.
- Opened the real native Restore copy confirmation. Verified the destination, server/account, preservation warning, and default Cancel choice. Cancelled with Escape; checked on disk that the selected destination stayed unchanged and no restore-copy file appeared.
- Disconnected and confirmed the recovery panel, transfer history and terminal output cleared, leaving the disconnected view.
- Checked the local encrypted backup does not contain the known original bytes, encrypted metadata does not expose the known destination path, and the legacy-format marker contains no recovery data.

## Automated Windows validation

- `npm run check`: 297 passed, two Unix-permission tests skipped on Windows; coverage thresholds pass. Includes formatting, lint, types, version consistency and production build.
- `npm run test:e2e`: 12 passed. The Windows backup/recovery flow uses actual OS key wrapping; unavailable-key behavior is simulated. Linux/macOS desktop automation uses an isolated provider because headless runners do not provide interactive keychains.
- Existing regressions cover profiles, authentication failures, host trust, file actions, transfers, source/destination changes, cancellation, network loss, and reconnect isolation.
- New regressions cover authenticated encryption, empty and multi-chunk files, corrupted/swapped/partial ciphertext, missing/corrupt/unavailable keys, migration cancellation/retry, failed metadata commits, and legacy cleanup.
- Secret scan passes. Dependency policy passes with the existing 15 raw moderate development-only findings and four exact reviewed dependency paths; the exceptions expire 2026-12-02.

The pull-request and tagged-release workflows must pass on Windows, Linux and macOS before accepting the draft artifacts. Their results and artifact checksums are recorded in GitHub Actions and the draft release.

## Still requires real-device validation

macOS Keychain and unsigned/signed application identity, GNOME/libsecret and KWallet prompts/lock transitions, full Windows key-account lifecycle, Windows ACLs, non-NTFS local filesystems, forced power loss/disk faults, hostile server protocol behavior, and independent cryptographic review. Hardware/network failures cannot be exhaustively reproduced here. Portable encrypted export and vault key rotation are not implemented. Keep the backup folder and access to the original OS account/key store together.
