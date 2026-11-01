# Manual testing checklist

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

Uploads target the folder displayed in the explorer, not the terminal's current working directory. Recursive folder transfers and drag-and-drop are not implemented.

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

Not implemented: saved passwords/passphrases; multiple simultaneous servers or terminal tabs; file preview/edit/save; file creation, copy/move between folders, permission changes, recursive deletion or undo; a transfer queue or resume; local split pane; Docker browsing; Mobile Bridge; signed installers; automatic updates. A manual `nano` session edits through the remote terminal and is different from a built-in graphical editor.

When reporting an issue, include the app version, OS, steps, expected behavior, and actual behavior. Do not share passwords, private keys, sensitive terminal output, or server files.
