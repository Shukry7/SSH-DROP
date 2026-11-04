# Manual testing checklist

## Multi-file queue (0.2.0-alpha.4)

Use disposable local/remote files. Existing alpha.3 installers do not include this queue.

Queued files are read and verified when their job starts; selection does not freeze a copy of their contents. Keep selected source files and destination folders stable while work is waiting. Declining a per-file overwrite conflict skips that file; cancelling an active transfer or encountering a failure pauses the remaining queue for inspection.

1. Choose two or more files with Upload files. Confirm one runs while the rest show queued, each completes independently, and uploaded names appear in the explorer after completion. Test empty files and larger files on a slow connection.
2. Select remote-file checkboxes, choose Download selected, and pick a local folder. Verify every file's bytes, its original destination, and progress/status. Folder and symlink rows must not be selectable. Confirm batch filename collisions or unsafe Windows names reject the entire selection before any job starts.
3. Cancel a waiting file: it must never open or publish. Cancel an active transfer: preserve the existing destination, pause the rest if the operation fails, and inspect uncertainty warnings before continuing. Continue queue must use a native confirmation defaulting to Cancel and must not retry the failed file.
4. Trigger an unreadable/missing source, denied write, or a conflict. Existing Cancel/Keep both/verified backup-and-replace choices must still apply per file. Recovery inspection must remain usable while paused; file mutations and navigation stay locked until queued files complete or are cancelled.
5. Disconnect during streaming or a pending picker/continuation confirmation, then reconnect. Old jobs must not run, old names/history must clear, and late approvals must not apply to the new connection. No queue should survive an application restart.
6. Queue more files while one runs; enforce at most 100 active/waiting jobs. Confirm duplicate selected basenames (including case/Unicode variants) reject the batch. There is no persistent queue, folder merging, automatic retry or byte-level pause/resume.

Use a disposable Linux server with SSH and SFTP enabled and an account you are allowed to access. Use a writable test folder and disposable files. The current application version is shown in the top bar. This checklist covers the implemented alpha, not the whole PRD.

## Run the current code

Use `npm run dev`. On this Windows development machine, if the global npm command is broken, use PowerShell:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev
```

An older packaged executable will not pick up source changes. Close it and run the development app, or rebuild with `npm run package:dir` before launching the new preview.

## Connection and beginner help

- [ ] Expand **New to SSH? Start here**. Read the setup steps, example command, and fingerprint guidance.
- [ ] Click each **?** beside Host, Username, Port, Authentication, Password, and Starting directory. Each explanation should fit on screen. Close it with its ×, Escape, or a click outside it.
- [ ] Use Tab to focus a help button and Enter to open it. Help must not submit the connection form or change entered values.
- [ ] Select **Private key**. Check the Private key and Key passphrase help. The password field should be replaced by key selection and a passphrase field.
- [ ] Connect with your server address, SSH port, Linux username, and password. For a new server, verify its fingerprint through a trusted channel before accepting it. Cancelling trust should prevent connection.
- [ ] Try an incorrect password on a test account where failed attempts are allowed. An error should appear, the password field should clear, and correcting it should allow another attempt. Avoid repeated failures on accounts with lockout rules.
- [ ] Disconnect, choose a private key already authorized on the server, supply its passphrase if encrypted, and connect. Keys must be private key files rather than `.pub` files.

Changed host identities are blocked. Do not rotate a real server's host key merely to test this; changed-key behavior is also covered by automated tests.

## Saved server profiles (development source, after 0.1.0-alpha.1)

- [ ] Fill connection details and Starting directory, enter a Profile name, and choose **Save profile**. A password is not needed to save. Saving must not connect to the server.
- [ ] Choose **New**, then select the saved server. Its host, username, port, authentication, and directory should return; password and passphrase must be empty.
- [ ] Enter the needed secret and connect. The explorer should open the saved starting directory. Profile controls are disabled while connected or connecting.
- [ ] Disconnect, change the profile name or connection fields, and choose **Save profile changes**. Restart the app and check the saved settings.
- [ ] Save a private-key profile using the native picker. Restart and load it; the key filename should return without selecting it again. Enter its passphrase if required. If the key was moved or deleted, connecting should show a recoverable error; choose the file again and save the updated profile.
- [ ] Save a second profile and try giving it the first profile's name (ignoring case). The operation should fail without changing either saved entry.
- [ ] Choose **Delete profile**, cancel the native confirmation, and check that it remains. Confirm deletion next; the server's files, local private key, and host trust must remain intact.

Profiles contain connection metadata and key-file locations in local user-data storage. Do not upload or commit `profiles.json`. Passwords, passphrases, and key contents must never appear there. Optional secure credential persistence is not implemented.

## Terminal and browsing

- [ ] Run `pwd`, `ls`, and an interactive program available on your test server, such as `nano`. Exit the program normally.
- [ ] Resize the app. The terminal should resize and remain usable.
- [ ] Navigate into a directory with its name button, use **Parent**, enter an absolute path in the explorer, and use **Refresh**.
- [ ] Check names, sizes, modification times, and hidden files if present. There is no hidden-file toggle yet.
- [ ] Enter an inaccessible or missing directory. An error should appear without disconnecting the terminal.
- [ ] Run `cd` in the terminal. The explorer should remain at its separately selected directory. This is intentional; automatic directory following is not implemented.

## Individual file transfers

- [ ] Browse to your writable test folder and select **Upload file**. Choose one small local file. Confirm progress/completion and the new listing entry.
- [ ] Navigate to a different folder. While the directory is loading, **Upload file** should be disabled. When it becomes available, uploads must go into the newly displayed folder.
- [ ] Choose **Download** on that file and a new local filename. Compare its contents with the original.
- [ ] Upload the same filename again. The transfer should fail without overwriting the existing remote file.
- [ ] Try downloading into an existing local filename. SSHDrop should refuse to overwrite it even if the native dialog asks about replacement.
- [ ] Transfer a sufficiently large disposable file and select **Cancel** while running. It should report cancellation and attempt to remove its own temporary `.sshdrop-*.part` sibling file. If cleanup fails, inspect the selected folders before retrying.
- [ ] Cancel a native upload/download file dialog. No transfer should start.

Uploads target the folder displayed in the explorer, not the terminal's current working directory. Version 0.2.0-alpha.4 supports bounded folder copies into new destinations; see the folder checklist below. Drag-and-drop is not implemented.

- [ ] On a throttled disposable connection, observe **preparing**, **transferring**, **verifying**, and **finalizing**. Long transfers must continue while progress occurs; the final filename should not appear until verification/publication. Upload verification reads the remote temporary file once, adding download traffic.
- [ ] Block SFTP data requests while leaving SSH alive. After two minutes with no progress, the app should stop and disconnect. Setup/finalization requests are separately bounded at 30 seconds; cleanup is bounded at three seconds. Never test this by interfering with production servers.
- [ ] Interrupt a running disposable transfer, then reconnect. Transfer filenames must clear, but a generic warning to inspect selected folders must remain until dismissed or the app closes. There must be no automatic replay.
- [ ] If the connection cuts during **finalizing**, inspect both the final name and `.sshdrop-*.part` files before retrying. An unacknowledged publication may already have succeeded. The app must not delete the final file to roll back an uncertain result.
- [ ] Change a disposable source during transfer. Size/metadata changes or destination checksum mismatch must prevent completion/publication. This is not a snapshot guarantee against concurrent writers or malicious servers.
- [ ] Test local download publication on supported local filesystems. Filesystems that do not support hard links must fail safely without falling back to an overwrite-capable rename or directly writing a partial final file.

## Remote file actions (development source)

Use only disposable files. Deletion is permanent: there is no trash or undo.

- [ ] Select **New folder**, enter one name, and choose **Review change**. The native confirmation must show the complete remote path, default to Cancel, and explain permissions. Cancel first; nothing should be created. Confirm next; the new folder should appear in the displayed directory. The app requests mode 0700; inspect actual permissions on the server.
- [ ] Try a duplicate name, `..`, a name containing `/` or `\`, and a name exceeding 255 UTF-8 bytes. These must fail without changing existing items. Spaces, quotes, and Unicode names are supported.
- [ ] Choose **Rename** on a disposable file and folder. Cancel the native confirmation, then retry and confirm. The listing should refresh. Existing destination names must be rejected and their contents preserved.
- [ ] Choose **Delete** on a disposable file or empty folder. The native warning must show the full path, default to Cancel, and explain permanent deletion. Cancel first, then confirm. The item should disappear only after confirmation.
- [ ] Try deleting a nonempty disposable folder. It must fail without removing anything inside. Symbolic links and special files must not offer rename/delete controls.
- [ ] While confirmation is pending, interrupt the test connection. Accepting the old confirmation must not apply the action on a new connection. Reconnect and inspect before retrying.
- [ ] On a disposable server, remove write permission on a test folder and attempt an action. An error should appear; browsing and the terminal should remain usable.
- [ ] If an acknowledgment is lost after a change, treat the result as uncertain. The app must disconnect, warn to inspect the remote folder, and never automatically repeat or roll back the operation.

Remote changes use SFTP, not shell commands. Other server processes can change paths between checks; source rechecks are not a transaction or a filesystem identity guarantee. Rename relies on standard SFTP no-replacement behavior; nonconforming servers cannot be made safe by client-side checks alone. Avoid concurrent modifications of the same test paths.

## Session recovery and current limits

- [ ] Disconnect. The terminal should stop accepting input, and the explorer should clear.
- [ ] Reconnect. It should create a fresh shell; old commands and transfers must not replay.
- [ ] Before disconnecting, produce a distinctive disposable terminal message and complete a transfer. Disconnect and reconnect: the previous terminal buffer and transfer names must disappear. This clears the app UI, not clipboard contents or forensic memory copies.
- [ ] On a disposable setup, interrupt the network connection. The app should report disconnection when detected and allow a new connection. An interrupted remote transfer can leave a partial file if the server is unreachable during cleanup.

Not implemented: saved passwords/passphrases; multiple simultaneous servers or terminal tabs; file preview/edit/save; file creation, copy/move between folders, permission changes, recursive deletion or undo; persistent queues or byte-level resume; local split pane; Docker browsing; Mobile Bridge; signed installers; automatic updates. A manual `nano` session edits through the remote terminal and is different from a built-in graphical editor.

When reporting an issue, include the app version, OS, steps, expected behavior, and actual behavior. Do not share passwords, private keys, sensitive terminal output, or server files.

## Overwrite and recovery checklist (0.2.0-alpha.2)

This section describes the existing alpha.2 installer. Version 0.2.0-alpha.3 has a separate encrypted recovery checklist below.

Use disposable files and a server with SFTP; stop other writers. Test a `0.2.0-alpha.2` build or current development source. Earlier `0.2.0-alpha.1` installers do not contain this feature.

1. Upload a file whose remote name already exists. Cancel: both files stay unchanged. Keep both: inspect the generated filename and verify both files remain.
2. Back up and replace: verify the native warning identifies the server/path and discloses unencrypted local storage. Compare bytes and basic permissions. On a server without OpenSSH atomic rename, only Cancel and Keep both should be available.
3. Download onto an existing local file. Replace, then open Recovery backups and Roll back. Confirm it first backs up the current version; inspect both recovery records. Repeat with spaces, quotes and Unicode filenames.
4. Edit the destination outside SSHDrop after replacement. Rollback must refuse. Restore copy should create a different filename and keep the external edit. Corrupt a disposable `.bak`: inspection/rollback must refuse its checksum.
5. Disconnect during staging or publication. Reconnect to the same server/account and Inspect the record. Do not repeat an uncertain operation automatically. Check destination, `.ready`, `.ready.original`, and local `.bak` before manually cleaning temporary files.
6. Restart the app: recovery records must remain; nothing should auto-run. Connect to another server/account: old paths must not appear. Disconnect: the panel must disappear. Credentials must not appear in recovery JSON.
7. Cancel backup deletion, then confirm deletion for a resolved record: only its local backup and record should disappear. An unresolved record must not be deletable through the UI.
8. Try denied permissions, a read-only filesystem, exhausted space, unsupported atomic replacement, local hard links, symlinks, corrupt recovery JSON and interrupted native dialogs. Original contents must remain or the result must explicitly be reported as uncertain with recoverable evidence retained. Protect the local disk; ordinary deletion is not secure erasure.

## Encrypted recovery (0.2.0-alpha.3)

Use an isolated test OS account/application data directory and disposable local/remote files. Keep existing production backups untouched. Desktop automation mocks the OS provider; it does not certify real-device keychain behavior.

1. With the OS key store available, overwrite a test upload and download. Check that each recovery row says Encrypted. The backup folder should contain `vault-key.json`, `recovery.enc`, and UUID `.bak.enc` files, without a newly created plaintext `.bak` or plaintext recovery metadata. `recovery.json` is a non-sensitive format marker only. Ciphertext must not expose the original contents, server address, username, or destination path. Filenames and ciphertext sizes remain observable.
2. Restart under the same OS account and verify Inspect, restore-copy, rollback with a new independent backup, and confirmed deletion. Repeat for empty files and files larger than several 64 KiB chunks. Restore-copy may leave an intentional plaintext destination; staging is not published until authentication and SHA-256 pass.
3. On an isolated copy of the test backup folder, corrupt ciphertext, authentication tag, metadata, or the wrapped key; remove the key; swap two encrypted backup files. Recovery/replacement must stop and preserve evidence. Never reset or regenerate a key to recover encrypted data. Restore the intact test folder afterward.
4. Lock or deny access to the actual OS key store. Replacement and encrypted recovery must fail closed. Unique-file transfers and Keep both must still work. On Linux, test GNOME/libsecret and KWallet; `basic_text`, unknown backends, and unavailable providers must be refused. Windows DPAPI and macOS Keychain must be tested on real devices, including unsigned app identity prompts. Linux key access currently uses Electron 45's synchronous provider and may block while the keyring prompts.
5. With an isolated alpha.2 legacy folder, connect to its original verified server/account. Rows must say Legacy plaintext. Cancel Secure backup and verify no migration occurs. Confirm it, then check encrypted contents and metadata, preserved unrelated legacy backups, and removal of only the migrated plaintext original. `recovery.json` must contain only the non-sensitive `{"version":2,"encrypted":true}` marker, so older binaries fail closed. Legacy recovery requires migration first.
6. Interrupt encryption or force a metadata write failure during migration. The plaintext original must remain, and no destination must change. Retry Secure backup explicitly. Also retry after interruption between committing metadata and unlinking plaintext; the same button must finish cleanup without replacing the vault key. Deletion is not secure disk erasure.
7. Cut the network or cancel during encryption/decryption/restore staging. Never publish partially authenticated bytes or automatically retry a replacement. Inspect uncertain outcomes and destination-side temporary files before removing them. Losing the OS account or key can make these backups unrecoverable; portable export and key rotation are not implemented.

## Version 0.2.0-alpha.4 folder copies

Use disposable data and new destination names. Existing alpha.3 installers do not include this feature.

1. Upload a small folder containing nested files, zero-byte files and empty directories. Cancel the native warning first and verify no change. Confirm next; both paths and limits should be visible, defaulting to Cancel. Check every file byte-for-byte and verify empty directories.
2. Download that remote folder using its row’s Download button and select a local parent. Confirm the copied root retains its name and exact contents. Check aggregate progress and cancellation controls.
3. Retry with the same destination. It must refuse the existing root and leave existing bytes unchanged. No folder merging or recursive deletion is offered.
4. Test symbolic links, local junctions/hard-linked files, special files, case/Unicode-normalization collisions and Windows-reserved names on supported test devices. The scan must fail before creating the root.
5. Test more than 100 items (root/folders count), more than 16 levels and more than 10 GiB. Verify refusal without a destination. Never use important data for these checks.
6. Cancel during a slow copy or disconnect mid-file. Completed files/folders may remain; inspect them. Later files must not start and reconnect must not replay the copy. Delete or rename the partial root manually before retrying. Waiting folder cancellation must touch no destination.
7. Change a source or replace a parent during a disposable copy; detected changes must stop work. These checks do not prevent all filesystem races; stop other writers in normal use. There is no folder rollback, resume, permission/ACL preservation or automatic partial-tree cleanup.

## 0.2.0-alpha.5 overwrite, workflows and terminal sizing

Use disposable files and servers. Choose Replace without backup for uploads and downloads: cancel the final permanent warning first, then confirm; verify new bytes, no recovery record and no vault-key requirement. Re-test backed replacement and rollback. Interrupt a disposable replacement and inspect before retrying; no rollback is available for no-backup mode.

Follow WORKFLOWS.md to create, edit, delete and restart with a saved workflow. Confirm definitions remain available across servers while values/results clear on disconnect. Test text containing apostrophes and shell metacharacters: previews must show quoted arguments and execution must match the native confirmed script. Cancel first. Fail the middle step and verify later steps never run; test Stop, follow mode, output limits, disconnect during confirmation and reconnect without replay. Use only generic commands and disposable data for destructive-command testing. After success, failure and Stop, test Run again: it must reload the latest saved definition, clear variable values, start from step 1 and honor the saved confirmation preference (on by default). With confirmation on, require a fresh preview and native confirmation. With it off, variable-free rerun starts immediately; variable workflows still need fresh values and preview submission. Cancel the opt-out save warning and verify the setting is not changed. Re-enable confirmation and verify it is honored on the next rerun. Cancel confirmation and verify no command runs. Delete the definition and verify rerun is refused. Disconnect must clear rerun availability. Check maximum-runtime help explains immediate execution rather than a delay.

On the macOS DMG and Windows/Linux builds, connect and resize through small/large window sizes, change display scaling and wait for fonts. Scroll to the terminal; the bottom row, cursor and scrollbar must fit inside its panel without overlap with recovery/workflows. Exercise terminal reconnect and resizing while output arrives. CI geometry tests are not a substitute for testing the actual affected Mac/display.
