# SSHDrop

A desktop SSH workspace for Windows, Linux, and macOS: an interactive terminal, remote file explorer, and explicit file transfers in one window.

**Status: 0.3.0-alpha.3, early development preview.** Local Windows checks are available; current hosted CI cannot start because of the account billing block. Linux/macOS validation, real-device certification, and signed installers remain pending.

## Current scope

**Development source `0.3.0-alpha.3`** adds editor line numbers and syntax highlighting for JavaScript, TypeScript, JSON, YAML, Python, and shell scripts. The filename selects the initial mode; **Highlighting** lets you change it or choose Plain text. This changes display only and never executes file contents.

**Development source `0.3.0-alpha.2`** adds in-file search and a comparison view to the remote editor. **Compare with server** shows the current server text beside the draft. After review and confirmation, keep the draft against the reviewed baseline or use the server text. A later save still checks for newer remote changes and uses the normal backup/save confirmation.

**Development source `0.3.0-alpha.1`** adds a remote text editor. Select **Edit text** on a regular UTF-8 file up to 1 MiB, edit the draft, and review the save warning. Choose an encrypted recovery backup or confirm saving without a backup. The editor checks for remote changes before replacing the file and verifies the result. LF/CRLF endings and a UTF-8 BOM are preserved. See [remote editing](docs/REMOTE_EDITOR.md).

**Development source `0.2.0-alpha.6`** adds optional [idle session protection](docs/IDLE_PROTECTION.md): a visible timer, final-minute countdown and disconnect-and-clear privacy screen. It defaults off. It does not keep an authenticated connection behind an app lock; expiry may interrupt active work. Existing alpha.5 installers do not contain this feature.

Alpha.6 development source also adds [portable encrypted backup recovery](docs/PORTABLE_BACKUPS.md): export an individual recovery backup up to 32 MiB, then recover it offline into a new local file with its export passphrase. Export and test a copy before losing access to the original OS key store.

If SSH is lost, use **Reconnect to server** to authenticate and start a fresh session. SSHDrop keeps connection fields in the current workspace but clears submitted passwords and key passphrases. It never automatically retries commands, transfers or workflows. A closed shell does not by itself end SSH or file browsing. See [connection recovery](docs/RECONNECT.md).

Version **0.2.0-alpha.5** adds optional **Replace without backup** (permanent, no rollback) and [saved commands/workflows](docs/WORKFLOWS.md), including variables, exact previews and server confirmation enabled by default. It also fixes terminal layout/refitting for clipped rows. Run again reviews the latest saved workflow with fresh variable inputs and the saved confirmation preference; it never resumes or automatically replays previous commands. Older alpha.4 installers do not include these additions.

- Password or private-key authentication for one active SSH connection.
- Beginner connection guide and accessible `?` help for each connection field, with examples and guidance on finding server details.
- Explicit trust prompt for unknown server keys; changed identities are rejected.
- Interactive remote terminal with resizing.
- SFTP directory browsing with an explicit destination.
- Streamed individual uploads/downloads with progress and cancellation. Transfers use exclusive temporary files, SHA-256 destination readback, and publication without replacement. Setup/cleanup waits and stalled transfers are bounded; generic interruption notices survive reconnect without retaining old filenames.
- Session-only credentials; private keys stay on the local machine.
- Saved server profiles: add, edit, delete with confirmation, and load connection details. Profiles remember the chosen key-file location, never passwords, passphrases, or key contents.
- Create remote folders, rename files/folders within their current folder, and permanently delete files or empty folders after native confirmation. Existing destinations are refused; symlinks, special files, recursive deletion, and undo are unsupported.
- **New file** in unreleased `0.2.0-alpha.6` creates an empty file in the displayed remote folder after confirmation. The app requests owner-only read/write permissions (`0600`) and preserves existing paths.
- **Copy or move** in unreleased `0.2.0-alpha.6` sends regular files to an existing folder on the same server. Copies up to 128 MiB stream through the app without a local file, verify SHA-256, and request owner-only permissions. Moves use standard SFTP rename. Both require confirmation and refuse existing destinations. If the server rejects a move across filesystems, the operation stops and preserves the source.
- **Permissions** in unreleased `0.2.0-alpha.6` edits read, write, and execute access for owner, group, and others on one file or folder at a time. The dialog shows both modes before confirmation. The server must support a read-only SFTP open and handle-based permission changes for the selected item. Special permission bits, ownership changes, and recursive updates are outside this feature.
- File transfer conflicts offer Cancel, Keep both, or verified backup and replacement where supported. Persistent recovery records support inspection, restore-copy, and guarded rollback; general undo for deletion or renaming is unsupported.

This version includes saved profiles, remote file actions, a bounded text editor, and hardened transfers. Older `0.1.0-alpha.1` release artifacts do not include them. Upload verification downloads the temporary remote file once, adding roughly its size in network traffic. Downloads require a local filesystem supporting hard links for publication without replacement; unsupported filesystems fail safely. Persistent secrets, terminal directory following, Docker browsing, and Mobile Bridge are planned. See the [roadmap](docs/ROADMAP.md).

For a step-by-step list of implemented behaviors to try, see the [manual testing checklist](docs/MANUAL_TESTING.md).

**Version 0.2.0-alpha.4:** Upload files accepts multiple native-selected files. Select remote-file checkboxes and Download selected to queue downloads into a native-selected folder. The session-only queue runs one file at a time, with at most 100 active/waiting jobs, per-file status/cancellation, and existing verification/overwrite safeguards. A failure pauses the queue until you confirm Continue queue; the failed file is never automatically retried. Disconnect discards waiting jobs. Folder copies are also available in 0.2.0-alpha.4: Upload folder or a remote folder’s Download button copies into a **new** destination folder. A native warning defaults to Cancel and shows both paths. The complete scan is limited to 100 items including folders, 16 levels, 10 GiB and 30 seconds. Links, special files, nonportable/colliding names and existing destination folders are refused. Empty folders are preserved; files are staged and SHA-256 verified. A folder is one queue job with aggregate byte progress and cancellation; a failed/cancelled copy can retain completed files and empty folders. Inspect or rename the partial copy before retrying. There is no folder merging, metadata/ACL preservation, automatic cleanup, automatic retry, or byte-level resume. Stop other writers during a copy. Existing alpha.3 installers do not include the queue.

Queued source contents are read/checked when the job starts, rather than frozen at selection time. Keep selected files and destination folders stable while waiting. Declining an overwrite skips that individual file; active cancellation/failure pauses remaining jobs.

**Unreleased 0.2.0-alpha.6:** Drop up to 100 local files from your file manager onto the remote explorer. Review the displayed destination and confirm to queue the upload. The queue refuses dropped directories, symbolic links, hard-linked files, duplicate names, and files that change after review. Use **Upload folder** for folders and **Upload files** to open the native file picker.

**Workflow library in unreleased 0.2.0-alpha.6:** Search names, descriptions, and groups; assign an optional group; or duplicate a workflow into the editor. Export selected definitions as readable JSON after reviewing the sharing warning. Import opens a definition for review with a new ID and run confirmation enabled. Save it explicitly before running. Exports include saved commands and settings, so review them for private details before sharing.

**Unreleased 0.2.0-alpha.6:** Folder uploads and downloads can also merge into an existing folder after separate confirmation. Each conflicting file offers **Skip file**, **Keep both**, and, where supported, **Back up and replace** or **Replace without backup**. The last option requires another confirmation. A bounded scan checks the destination before writing, and the transfer row shows copied and skipped counts. A merge keeps completed changes after interruption. Stop other writers and inspect partial results before retrying. See the [folder merge checklist](docs/MANUAL_TESTING.md#folder-merges-unreleased-020-alpha6).

## Overwrite and recovery (0.2.0-alpha.2)

Version 0.2.0-alpha.2 offers Cancel / Keep both / Back up and replace when a regular-file destination exists. Replace first stores an independent verified backup locally, stages the incoming file, rechecks the original, and requires atomic replacement support (OpenSSH POSIX rename for uploads; native replacement for local downloads). The **Recovery backups** panel is scoped to the connected server key, address, port, and account. Inspect unresolved outcomes; restore a separate copy if the destination changed. Rollback first backs up the current version too. Nothing is retried or restored automatically.

The existing `0.2.0-alpha.2` installers store **unencrypted backup contents and paths**, retained until explicitly deleted (100 records / 10 GiB accounted contents; 50 MiB reserve). Protect your device and disk. Stop other writers. Remote ACLs, extended attributes, hidden hard links, and power-loss durability cannot be guaranteed. This feature is not in existing `0.2.0-alpha.1` installers; see the [recovery testing checklist](docs/MANUAL_TESTING.md).

**Version 0.2.0-alpha.3:** new backup contents and recovery metadata use AES-256-GCM authenticated encryption, with an OS-protected vault key. There is no plaintext fallback. Legacy backups show **Legacy plaintext** until you explicitly choose **Secure backup**; migration verifies the encrypted copy and saves metadata before removing the original. A non-sensitive format marker prevents older plaintext-only versions from silently starting a second recovery journal. Other legacy contents remain plaintext until individually secured. Repeat Secure backup after interrupted cleanup. This does not securely erase earlier disk contents.

Keep the entire `backups` folder, including `vault-key.json`, and retain access to the original OS account/key store. Losing either can make recovery impossible; copying the folder to another computer/account is not a portable recovery method. Encryption does not protect against other software running as your OS user. Linux requires a recognized, unlocked libsecret/KWallet backend; headless or `basic_text` environments cannot create or unlock encrypted backups. Unique-file transfers and Keep both remain available without a vault. See [encrypted recovery testing](docs/MANUAL_TESTING.md#encrypted-recovery-020-alpha3).

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

Read the [privacy policy](PRIVACY.md) and [security review](docs/SECURITY_REVIEW.md) for local-data handling, automated checks, temporary dependency exceptions, and remaining signing/independent-review requirements. These improvements are not included in the older `0.1.0-alpha.1` installers.
