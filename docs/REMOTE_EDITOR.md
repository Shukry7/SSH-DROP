# Remote text editing

The `0.3.0-alpha.1` development source provides one plain-text editor through **Edit text** in the remote explorer. It accepts ordinary UTF-8 files up to 1 MiB with consistent LF or CRLF line endings. A UTF-8 BOM and the original line-ending style are preserved when saving. Binary data, invalid UTF-8, mixed line endings, links, special permission bits, and special files are refused.

The editor keeps a draft in memory. Close editor asks before discarding changes. Closing the application with a draft prompts to keep editing or discard and close. Reloading while dirty also opens that prompt. Network loss disables saving and leaves the draft visible for copying elsewhere. Reopen the file after reconnecting to establish a fresh baseline. Idle protection deliberately clears the entire workspace, including drafts.

Save changes, or Ctrl/Cmd+S, opens a native confirmation. Back up and save keeps an encrypted recovery copy using the existing local vault and requires an available OS key store. Save without backup requires a second confirmation and has no rollback. The server must support atomic replacement. Basic permission bits and owner/group checks are preserved. ACLs, extended attributes, and remote hard links cannot be fully preserved or detected.

Before saving, SSHDrop compares the original file's contents and metadata with the current remote file. A conflict leaves the draft open. Copy it elsewhere before closing and reopening the remote file. Writes use verified temporary staging and recheck the original before publication. Stop other writers during editing; SFTP cannot make the final check and replacement atomic against an external edit. If a result is uncertain after disconnection, inspect the remote file and recovery records before retrying.

Files are never rendered as HTML or executed by the editor. File contents are excluded from logs and local storage. Syntax highlighting, a graphical diff/merge tool, multiple tabs, and large-file support remain planned.
