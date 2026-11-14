# Remote text editing

The `0.3.0-alpha.1` development source provides one plain-text editor through **Edit text** in the remote explorer. It accepts ordinary UTF-8 files up to 1 MiB with consistent LF or CRLF line endings. A UTF-8 BOM and the original line-ending style are preserved when saving. Binary data, invalid UTF-8, mixed line endings, links, special permission bits, and special files are refused.

The editor keeps a draft in memory. Close editor asks before discarding changes. Closing the application with a draft prompts to keep editing or discard and close. Reloading while dirty also opens that prompt. Network loss disables saving and leaves the draft visible for copying elsewhere. Reopen the file after reconnecting to establish a fresh baseline. Idle protection deliberately clears the entire workspace, including drafts.

Save changes, or Ctrl/Cmd+S, opens a native confirmation. Back up and save keeps an encrypted recovery copy using the existing local vault and requires an available OS key store. Save without backup requires a second confirmation and has no rollback. The server must support atomic replacement. Basic permission bits and owner/group checks are preserved. ACLs, extended attributes, and remote hard links cannot be fully preserved or detected.

Before saving, SSHDrop compares the original file's contents and metadata with the current remote file. A conflict leaves the draft open. Copy it elsewhere before closing and reopening the remote file. Writes use verified temporary staging and recheck the original before publication. Stop other writers during editing; SFTP cannot make the final check and replacement atomic against an external edit. If a result is uncertain after disconnection, inspect the remote file and recovery records before retrying.

## Search and comparison in 0.3.0-alpha.2

Use Find in draft or Ctrl/Cmd+F to search for literal, case-sensitive text. Next match and Previous match wrap through the first 1,000 matches. Enter moves forward and Shift+Enter moves backward from the search field. Selecting a result focuses the draft at that text.

Compare with server reads a fresh bounded snapshot and displays it beside the draft. Read both versions and edit the draft as needed. Refresh comparison reads the latest version again. Comparing and closing the comparison leave the save baseline intact.

Keep my draft asks for confirmation, rechecks the server, and uses the reviewed version for the next save checks while preserving the draft. Save changes then requires its normal confirmation and verification. Use server text asks before discarding unsaved edits and loading the reviewed text into the editor. It also rechecks the server first. If the server changes during review, refresh the comparison before accepting it. The reviewed encoding becomes the encoding used by the next save.

## Highlighting and line numbers in 0.3.0-alpha.3

The draft editor uses CodeMirror with line numbers, bounded horizontal/vertical scrolling, and undo/redo (Ctrl/Cmd+Z; redo with Ctrl/Cmd+Shift+Z). It initially detects JavaScript, TypeScript, JSON, YAML, Python, and shell scripts from the filename. Unknown extensions open as Plain text. Use Highlighting to select another mode or Plain text without changing the draft, its save baseline, or the bytes sent to the server. This selection lasts for the open editor only. Highlighting is visual assistance, not a syntax validator. The reviewed server pane remains read-only plain text.

The editor does not run scripts or load language servers, remote plugins, or external document resources. Files are never rendered as HTML or executed by the editor. File contents are excluded from logs and local storage. The draft remains bounded to 1,048,576 UTF-16 code units, and saves additionally enforce the original 1 MiB UTF-8 byte limit. An edit that would exceed the draft limit is refused. Automatic merging and large-file support remain planned.

## Editor tabs in 0.3.0-alpha.5

Open up to eight files with **Edit text**. Use **Back to files** to browse for another file, or **Open editors** to return to your tabs. Opening the same path on the current connection selects its existing tab. With the tab strip focused, use Left/Right arrows to switch or Home/End to select the first/last tab.

Each tab keeps its own draft, undo history, search and comparison. **Close editor** closes the selected tab and asks before discarding unsaved text. Closing SSHDrop warns about unsaved edits even when the editor is hidden. Disconnection disables saving old tabs and leaves drafts available for copying. Idle protection clears all tabs.

## Edit in Nano or Vim in 0.4.0-alpha.3

Choose **Edit in terminal** beside a regular remote file. Review the path in the confirmation, then choose **Open Nano** or **Open Vim**. The editor opens in a dedicated tab on the same SSH connection and counts toward the four-terminal limit. Nano or Vim must be installed on the server. If launch fails, check the terminal output.

Nano saves with Ctrl+O followed by Enter, and exits with Ctrl+X. In Vim, press Esc, then use `:w` to save or `:q` to exit. Save and exit inside the editor before closing its tab. Closing the terminal can lose unsaved text. Refresh Files after editing to see updated metadata.

Terminal editors write directly on the server. For verified saves, conflict checks, and optional SSHDrop recovery backups, use **Edit text**. Avoid editing the same file concurrently in both editors.
