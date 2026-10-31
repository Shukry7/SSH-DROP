> Original product vision supplied by the project owner. Implemented scope and current release plans are tracked in [ROADMAP.md](ROADMAP.md) and [CHANGELOG.md](../CHANGELOG.md).

# SSHDrop — Full Project Requirements Document (PRD)

**Version:** 1.0 — Proposed Project Scope

**Product category:** Desktop Application / Developer Productivity / SSH & SFTP

**Target platforms:** Windows first, followed by Linux and macOS

**Proposed stack:** Electron, React, TypeScript, Node.js, xterm.js, ssh2, Monaco Editor

---

## 1. Project Overview

### 1.1 What is SSHDrop?

SSHDrop is a cross-platform desktop application that combines a real SSH terminal with a visual remote file manager.

It allows users to connect to remote Linux servers and interact with their files through both graphical controls and traditional terminal commands.

Users can browse directories, double-click files, preview content, edit code, upload and download files, rename or move files, manage permissions, and perform server operations without switching between multiple applications.

SSHDrop is designed to make remote server file management feel as natural as working with files on a personal computer.

### 1.2 What problem does it solve?

Developers commonly use several tools to manage remote servers:

- SSH terminals to execute Linux commands.
- `scp` or `sftp` for transferring files.
- Graphical SFTP applications for browsing remote directories.
- Code editors for modifying remote configuration files.
- Docker commands for managing containerized applications.

Switching between these tools creates unnecessary friction.

SSHDrop brings the most common operations into one integrated desktop workspace.

### 1.3 Main goal

**Enable users to connect to a server, browse files, transfer files, edit files, and execute Linux commands in one application without sacrificing the power of the terminal.**

### 1.4 Target users

- Software engineers and full-stack developers.
- DevOps engineers and system administrators.
- Developers managing VPS servers.
- Students learning Linux and SSH.
- Developers working with Docker-based applications.
- Freelancers managing client deployments.

---

## 2. Main Application Interface

SSHDrop should have a clean, modern desktop interface.

The primary workspace contains the following sections.

| Interface section       | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| Top navigation bar      | Server name, connection status, reconnect, settings |
| Server sidebar          | Saved server profiles and active connections        |
| Visual File Explorer    | Browse remote Linux folders and files               |
| Main workspace          | File preview, code editor, and configurable panels  |
| Integrated SSH Terminal | Execute commands and interact with Linux programs   |
| Transfer panel          | Track uploads, downloads, progress, errors          |
| Status bar              | Current server, selected directory, SFTP status     |

### 2.1 Recommended layout

**Left panel — File Explorer**

A remote folder tree similar to Windows Explorer or VS Code.

Example:

- `/home/deploy`
  - `myapp/`
    - `src/`
    - `public/`
    - `package.json`
    - `.env`
    - `README.md`
  - `backups/`
  - `uploads/`

**Center panel — File Editor / Preview**

When the user opens a file, show its contents in an editor or preview.

**Bottom or right panel — SSH Terminal**

The real SSH terminal should remain accessible while the user works with files.

**Transfer tray**

A collapsible panel displays uploads, downloads, progress, and notifications.

### 2.2 Layout customization

Users should be able to:

- Resize panels.
- Collapse the file explorer.
- Expand the terminal.
- Switch between editor and terminal.
- Open multiple file tabs.
- Use a terminal-focused fullscreen view.
- Choose dark or light theme.

The main principle is that users should never be forced to leave the terminal to perform a common file operation.

---

## 3. Server Connection Management

### 3.1 Add SSH server

Users can create a server profile containing:

| Field             | Description                                   |
| ----------------- | --------------------------------------------- |
| Profile name      | Friendly display name, such as Production VPS |
| Host              | IP address or hostname                        |
| Port              | SSH port, default 22                          |
| Username          | Remote Linux username                         |
| Authentication    | Password or SSH private key                   |
| Key passphrase    | Provided securely when required               |
| Default directory | Starting folder for the file explorer         |

### 3.2 Connection features

- Connect and disconnect.
- Reconnect after network interruption.
- Save server profiles.
- Edit and delete profiles.
- Support multiple server connections.
- Display connection status.
- Display understandable authentication errors.
- Verify server host keys.
- Support SSH-agent-based authentication when implemented.

Saved passwords or private-key secrets must use secure credential storage, not ordinary plaintext configuration files.

---

## 4. Integrated SSH Terminal

### 4.1 Real terminal functionality

SSHDrop should provide a fully functioning remote terminal using SSH and xterm.js.

Users should be able to execute normal Linux commands, including:

- `ls`, `pwd`, `cd`
- `cat`, `less`, `tail`
- `nano`, `vim`
- `mkdir`, `touch`
- `mv`, `cp`, `rm`
- `chmod`, `chown` (where authorized)
- `find`, `grep`
- `git`
- `npm`, `node`
- `docker`, `docker compose`
- Other programs available on the remote server

The app must support interactive programs and ordinary terminal input/output.

### 4.2 Terminal features

- Interactive shell.
- ANSI colors and cursor handling.
- Terminal scrolling.
- Copy and paste.
- Terminal resizing.
- Multiple terminal tabs.
- Clear terminal.
- Command history through the remote shell.
- Keyboard shortcuts.
- Terminal search.
- Configurable font size and colors.

### 4.3 Multiple terminals

A user should eventually be able to open multiple terminal sessions for one server.

Example:

- Terminal 1: application commands.
- Terminal 2: `docker logs -f`.
- Terminal 3: server monitoring.

Each terminal session maintains its own shell state and current working directory.

---

## 5. Visual Remote File Explorer

This is one of the primary features of the new SSHDrop concept.

### 5.1 Browse remote directories

After connecting to a server, SSHDrop should display the remote filesystem through SFTP.

Users can navigate directories without typing commands.

Features:

- Expand and collapse folders.
- Double-click folders to open them.
- Navigate backward and forward.
- Go to parent directory.
- Display the current directory path.
- Refresh directory contents.
- Show hidden files.
- Sort by name, size, type, or modification date.
- Display file icons and folder icons.
- Show file sizes and modification dates.
- Search or filter the current folder.

### 5.2 File selection

Support:

- Single-click selection.
- Double-click opening.
- Multi-selection.
- Keyboard navigation.
- Context menus.
- Copying a remote file path.
- Opening the selected directory in a terminal.

### 5.3 Right-click actions

The file context menu should provide:

| Action           | Expected behavior                                   |
| ---------------- | --------------------------------------------------- |
| Open             | Open file in preview/editor                         |
| Open with nano   | Open remote file in interactive terminal editor     |
| Open with vim    | Open remote file in vim                             |
| View contents    | Display readable file content                       |
| Rename           | Change the remote filename                          |
| Copy             | Duplicate file or prepare copying to another folder |
| Move             | Move file to another location                       |
| Download         | Transfer remote file to local computer              |
| Delete           | Remove file after confirmation                      |
| Permissions      | View/change supported filesystem permissions        |
| Properties       | Show size, owner, permissions and timestamps        |
| Copy path        | Copy absolute remote path                           |
| Open in terminal | Prepare terminal interaction with the selected path |

Permissions and file ownership must follow the remote account's privileges.

---

## 6. File Preview and Double-Click Behavior

SSHDrop should recognize common file types.

### 6.1 Supported file types

| File type                | Double-click action                                              |
| ------------------------ | ---------------------------------------------------------------- |
| `.txt`, `.md`, `.log`    | Open text viewer/editor                                          |
| `.js`, `.ts`, `.json`    | Open syntax-highlighted editor                                   |
| `.php`, `.py`, `.java`   | Open code editor                                                 |
| `.html`, `.css`          | Open code editor                                                 |
| `.env`, `.conf`, `.yaml` | Open text editor                                                 |
| `.png`, `.jpg`, `.webp`  | Open image preview                                               |
| `.pdf`                   | Open PDF preview when supported                                  |
| `.zip`, `.tar`, `.gz`    | Show file details; archive browsing later                        |
| Executable files         | Show properties or relevant actions, never execute automatically |
| Unknown binary files     | Show metadata and offer download                                 |

### 6.2 Preview behavior

Text files should be opened through an SFTP read operation.

Binary files should not be interpreted as ordinary text.

Large files should use size limits, streaming, or partial preview instead of loading everything into memory.

For logs, a dedicated viewer with a follow mode can be added.

---

## 7. Built-in Code Editor

### 7.1 Main requirement

Users should be able to edit remote files without opening a separate text editor.

Use Monaco Editor for syntax highlighting and editing.

### 7.2 Editing features

- Open remote text files.
- Syntax highlighting.
- Search and replace.
- Line numbers.
- Undo and redo.
- Multiple editor tabs.
- Save using Ctrl+S.
- Unsaved-changes indicator.
- Read-only mode for files without write permission.
- Refresh from remote server.
- Detect conflicts when another process modifies the same file.

### 7.3 Save process

Example:

1. User double-clicks `config.json`.
2. SSHDrop reads it through SFTP.
3. Monaco Editor displays the contents.
4. User modifies the file.
5. User presses Ctrl+S.
6. SSHDrop checks for relevant remote changes.
7. The application writes the updated content securely.
8. The user receives a save confirmation.

Where supported, saving should use a temporary file and safe replacement to reduce the risk of leaving partially written files.

It must preserve appropriate file permissions and handle remote modifications carefully.

### 7.4 External editor support

A future feature could allow a remote file to be opened in the user's preferred local editor.

After changes, SSHDrop can detect that the local temporary file was saved and offer to upload it again.

---

## 8. Drag-and-Drop File Transfers

This feature comes from the original SSHDrop idea and remains essential.

### 8.1 Upload from computer to server

The user should be able to drag a local file from Windows Explorer, Linux Files, or macOS Finder into SSHDrop.

Supported drop locations:

- Remote file explorer.
- Specific remote folder.
- Integrated terminal drop area.

The application transfers the file using SFTP.

### 8.2 Dragging onto terminal

When a user drops a file into the terminal area, SSHDrop should offer to upload it to the selected destination directory.

For the initial version, the destination is explicitly selected.

Once reliable shell-directory integration is implemented, SSHDrop can suggest the terminal's current remote directory.

### 8.3 Upload features

- Single-file upload.
- Multiple-file upload.
- Recursive folder upload.
- Progress percentage.
- Upload speed and transferred bytes.
- Cancel upload.
- Retry failed upload.
- Filename conflict handling.
- Permission error handling.
- Transfer history for the active session.

### 8.4 Download features

Users should be able to:

- Right-click and download remote files.
- Download multiple selected files.
- Download complete directories.
- Choose a local destination folder.
- View download progress.

Dragging files directly from the remote explorer to the operating system's file manager can be added after native desktop drag-out behavior is implemented and tested.

### 8.5 File conflict handling

If the destination file already exists, display options such as:

- Replace.
- Keep both with a new name.
- Skip.
- Cancel.

Never silently overwrite important files.

---

## 9. Linux Command Integration

This is an important part of the visual-first concept.

SSHDrop should offer graphical actions corresponding to common Linux commands while preserving full support for entering commands manually.

### 9.1 Command-to-action mapping

| Linux command | Visual action                  |
| ------------- | ------------------------------ |
| `ls`          | Display folder contents        |
| `cd`          | Open another directory         |
| `pwd`         | Show current working directory |
| `cat`         | View file contents             |
| `nano`        | Edit file in terminal          |
| `vim`         | Edit file in terminal          |
| `mv`          | Rename or move file            |
| `cp`          | Duplicate or copy file         |
| `mkdir`       | Create folder                  |
| `touch`       | Create empty file              |
| `rm`          | Delete file                    |
| `chmod`       | Change permissions             |
| `tail -f`     | Follow log output              |
| `find`        | Search remote files            |

### 9.2 Two types of operations

**Graphical file operations:** SSHDrop uses SFTP where appropriate. For example, rename might use the SFTP rename operation rather than executing `mv`.

**Shell-based operations:** SSHDrop executes a real remote command when SFTP alone cannot provide the required functionality.

Some operations, such as server-side file copying, may require an SSH command or an explicitly supported SFTP extension.

All generated commands must handle paths and arguments safely.

### 9.3 Open with nano

When a user chooses "Open with nano," SSHDrop launches an interactive remote editor in a suitable terminal session.

For example:

`nano -- /var/www/myapp/config.json`

The application must not blindly inject this command into a terminal currently running another program.

### 9.4 Command Learning Mode

This is an optional educational feature.

When enabled, SSHDrop displays an equivalent Linux command after graphical operations.

Example:

User renames `old.txt` to `new.txt`.

SSHDrop displays:

`Equivalent command: mv -- old.txt new.txt`

The user can copy the command or learn what it means.

The UI must distinguish between an actual command executed and an equivalent command shown for learning purposes.

### 9.5 Command palette

A future command palette could allow users to search for operations using natural labels.

Examples:

- "Create folder"
- "Open file in nano"
- "Copy current path"
- "Show file permissions"
- "Follow selected log"

This does not require AI.

---

## 10. Terminal and Explorer Synchronization

This feature creates a close connection between terminal commands and the visual explorer.

### 10.1 Desired behavior

Suppose the user enters:

`cd /var/www/myapp`

SSHDrop should update the visual explorer to show `/var/www/myapp`, provided it can reliably determine the shell's directory.

Similarly, when the user opens a folder in the explorer, SSHDrop should offer a command to switch the terminal to that directory.

### 10.2 Important technical limitation

The interactive SSH shell and SFTP channel do not automatically share their working directory.

Therefore, SSHDrop must not assume that an SFTP operation knows the shell's current directory.

### 10.3 Proposed solutions

**Initial solution:**

Maintain an explicit remote directory for the visual explorer and transfer destination.

**Advanced solution:**

Implement optional shell integration that reports the current working directory through supported mechanisms, such as shell hooks and terminal control sequences.

The user should be able to turn automatic folder following on or off.

### 10.4 Special cases

Synchronization must handle or gracefully fall back when users enter:

- Nested SSH sessions.
- Docker containers.
- Terminal multiplexers such as tmux.
- Unsupported shells.
- Directories without access permissions.

If the current path cannot be verified, SSHDrop should retain the last confirmed destination and display an appropriate warning instead of guessing.

---

## 11. File and Folder Operations

### 11.1 Create operations

- Create file.
- Create folder.
- Duplicate file.
- Create nested folder structures.

### 11.2 Modify operations

- Rename files and folders.
- Move files and folders.
- Copy files and folders.
- Edit text files.
- Change permissions.
- Refresh metadata.

### 11.3 Delete operations

Support deleting files and folders with appropriate confirmation.

A recoverable remote trash system can be explored later, but it should not be presented as guaranteed because filesystem permissions and different mounted volumes may prevent it.

### 11.4 Clipboard operations

Provide Copy, Cut, and Paste actions within the visual file explorer.

For remote-to-remote operations, support safe transfer strategies that work with the server's capabilities.

---

## 12. Local and Remote File Management

A future split-pane view should allow users to browse both filesystems.

**Local pane:** Files on the user's Windows, Linux, or macOS computer.

**Remote pane:** Files on the connected Linux server.

Users should eventually be able to move or copy files between these panes through supported drag-and-drop and transfer actions.

This view should be optional so SSHDrop does not become unnecessarily complicated for users who prefer the terminal-focused experience.

---

## 13. Docker and Container Integration

This is an advanced feature for a later release.

### 13.1 Problem

A developer may connect to a Linux server and run:

`docker exec -it my-container sh`

The terminal is now inside a container, but ordinary SFTP still accesses the host filesystem.

### 13.2 Proposed feature

SSHDrop could provide separate destinations for:

- Remote host filesystem.
- Selected Docker container filesystem.

Users could browse supported containers and manage files where they have the necessary permissions.

### 13.3 Implementation considerations

Container transfers may involve staging files on the host and using Docker's copy capabilities.

This must be implemented with explicit user authorization, correct container identification, safe temporary file cleanup, and suitable permission checks.

The application must not assume that changing into a container shell automatically changes the SFTP destination.

---

## 14. User Experience and Visual Design

SSHDrop should feel like a modern developer application rather than a traditional file-transfer utility.

### 14.1 Design direction

- Minimal, professional interface.
- Dark theme by default.
- Clear icons for files and folders.
- Smooth panel resizing.
- Subtle animations.
- Easy-to-read terminal typography.
- Syntax highlighting.
- Responsive layout for different desktop window sizes.
- Clear transfer progress and status notifications.

### 14.2 Important interactions

- Double-click folders to navigate.
- Double-click files to open.
- Right-click for actions.
- Drag files to upload.
- Keyboard shortcuts for common operations.
- One-click copy remote path.
- One-click refresh.
- One-click switch between terminal and editor.

### 14.3 Terminal-focused mode

Some users may prefer not to use graphical panels all the time.

Provide a mode where the terminal occupies most of the application and the explorer opens as a collapsible panel.

An optional future terminal-native file manager could provide keyboard-driven navigation inside the terminal itself.

The graphical file explorer, however, should remain a separate UI component integrated into the same desktop application—not fake terminal output.

---

## 15. System Architecture

### 15.1 Technology stack

| Layer               | Technology                             |
| ------------------- | -------------------------------------- |
| Desktop application | Electron                               |
| Frontend            | React + TypeScript                     |
| Styling             | Tailwind CSS                           |
| Terminal renderer   | xterm.js                               |
| SSH client          | ssh2                                   |
| File transfers      | SFTP via ssh2                          |
| File editor         | Monaco Editor                          |
| Settings            | Local JSON or SQLite                   |
| Credential storage  | OS credential store / SSH agent        |
| Packaging           | Electron packaging and installer tools |

### 15.2 Architecture overview

**User interface layer**

React components handle the terminal display, explorer, editor, server profiles, and transfer progress.

**Electron preload bridge**

Provides a restricted interface for requesting privileged operations.

**Electron main process**

Manages SSH connections, SFTP operations, local file access, credentials, and transfer sessions.

**Remote Linux server**

Provides the SSH server, interactive shell, filesystem, and SFTP subsystem.

### 15.3 Main modules

1. Connection Manager — authentication and server sessions.
2. Terminal Manager — shell sessions and stream handling.
3. SFTP Manager — remote file operations.
4. File Transfer Manager — upload/download queue.
5. Explorer Manager — folder navigation and metadata.
6. Editor Manager — file opening, editing, saving, conflicts.
7. Command Manager — controlled remote command execution.
8. Settings Manager — preferences and saved profiles.
9. Security Manager — host-key trust, credential protection, authorization checks.
10. Optional Shell Integration Manager — working directory detection and synchronization.

### 15.4 Remote server requirements

A standard Linux server with a working SSH service and SFTP subsystem should be sufficient for the core application.

The MVP should not require installing a custom SSHDrop server agent.

Where SFTP is unavailable, terminal access may still work, but graphical file management should indicate that it is unavailable.

---

## 16. Security Requirements

Because SSHDrop can modify files on remote production servers, security is a critical requirement.

The application must:

- Verify SSH server host keys.
- Warn about changed host keys.
- Protect SSH private keys and passwords.
- Keep privileged operations outside the renderer.
- Use Electron context isolation and secure IPC.
- Validate file paths and action parameters.
- Avoid command injection.
- Never execute dropped or double-clicked files automatically.
- Ask for confirmation before destructive actions.
- Respect remote Linux permissions.
- Avoid silently overwriting remote files.
- Prevent untrusted terminal output from triggering privileged actions.
- Handle unexpected disconnections safely.

Sensitive files such as `.env` must not be uploaded to analytics services or logged unnecessarily.

Cloud synchronization, telemetry, and AI analysis are not required.

---

## 17. Error Handling

SSHDrop should provide understandable messages for common failures.

| Situation                | Expected response                                                        |
| ------------------------ | ------------------------------------------------------------------------ |
| Invalid host             | Show connection failure                                                  |
| Wrong credentials        | Explain authentication failure                                           |
| Unknown server host key  | Show fingerprint and ask for verification                                |
| Changed host key         | Block automatic reconnection until reviewed                              |
| Missing remote directory | Show folder-not-found error                                              |
| Permission denied        | Explain operation is not permitted                                       |
| File already exists      | Show conflict options                                                    |
| File changed remotely    | Ask user to compare, reload, or resolve                                  |
| Network interrupted      | Preserve useful state and offer reconnection                             |
| Upload failed            | Show error and allow retry                                               |
| Unsupported file preview | Offer download or file properties                                        |
| SFTP unavailable         | Disable explorer and transfer features, preserve terminal where possible |

---

## 18. Development Roadmap

### Phase 1 — SSHDrop Core (v0.1)

**Goal:** Functional SSH terminal and file transfer.

Features:

- Add SSH server connection.
- Connect using SSH credentials.
- Integrated real terminal.
- Select upload destination.
- Drag-and-drop upload.
- Transfer progress.
- Download files.
- Basic error handling and host-key verification.

### Phase 2 — SSHDrop Explorer (v0.2)

**Goal:** Add visual remote filesystem navigation.

Features:

- Folder tree.
- Double-click folder navigation.
- File metadata.
- Hidden files.
- File preview.
- Basic file operations.
- Context menus.
- Copy remote file paths.

### Phase 3 — SSHDrop Editor (v0.3)

**Goal:** Make remote file modification convenient.

Features:

- Monaco-based file editor.
- Syntax highlighting.
- Multiple file tabs.
- Save through SFTP.
- Unsaved-changes warnings.
- Remote change conflict detection.
- Open with nano/vim.
- Permission viewer/editor.

### Phase 4 — SSHDrop Advanced (v0.4)

**Goal:** Improve terminal and explorer interaction.

Features:

- Terminal-directory synchronization.
- Command Learning Mode.
- Search and shortcuts.
- Multiple terminal tabs.
- Better upload management.
- Improved file copying and moving.
- Optional split local/remote file view.

### Phase 5 — Stable Release (v1.0)

**Goal:** Public, reliable developer tool.

Features:

- Windows installer.
- Linux/macOS support after platform testing.
- Stable server profiles.
- Tested authentication and security.
- Reliable uploads and downloads.
- Good error recovery.
- Keyboard accessibility.
- User documentation.
- Public GitHub repository.
- Release notes and automated tests.

### Future releases

Potential features:

- Docker container file explorer.
- Remote log viewer.
- SSH jump host support.
- Multiple server file transfers.
- Session restoration.
- Terminal-native visual file manager.
- Optional plugin architecture.

---

## 19. Main User Workflow

A typical SSHDrop session would look like this:

1. The user launches SSHDrop.
2. The user selects a saved DigitalOcean Linux server.
3. SSHDrop establishes the SSH connection.
4. The interactive terminal becomes available.
5. The visual explorer opens the configured remote folder.
6. The user double-clicks `myapp`.
7. The explorer displays the project's files.
8. The user double-clicks `.env`.
9. The file opens in the built-in text editor.
10. The user edits a value and saves the file.
11. SSHDrop reports the save result.
12. The user drags `logo.png` from their local computer into the `public` folder.
13. SSHDrop uploads the image and displays progress.
14. The user right-clicks a file and selects Rename.
15. SSHDrop renames the remote file.
16. If Command Learning Mode is enabled, the corresponding Linux command is displayed.
17. The user opens the terminal and runs `docker compose ps`.
18. The user opens another terminal tab to inspect application logs.
19. The user disconnects safely.

All these tasks happen inside SSHDrop.

---

## 20. Testing and Acceptance Criteria

The first stable release should satisfy the following conditions.

### Connection tests

- Connect to a standard OpenSSH Linux server.
- Authenticate using supported SSH keys.
- Reject an unexpected host-key change.
- Recover gracefully from a disconnected server.

### Terminal tests

- Run common Linux commands.
- Open nano and vim interactively.
- Handle terminal resizing.
- Support terminal colors and text input.
- Preserve independent terminal sessions.

### Explorer tests

- Browse nested directories.
- Open folders by double-clicking.
- Display hidden files when enabled.
- Rename, create, delete, and move supported files.
- Handle inaccessible directories.

### Transfer tests

- Upload local files.
- Upload directories recursively.
- Download remote files.
- Handle large files without loading them fully into memory.
- Handle destination conflicts.
- Stop failed or cancelled transfers safely.

### Editor tests

- Open common text files.
- Save modified files.
- Warn about unsaved changes.
- Detect when a file has been modified remotely.
- Prevent unintended binary-file editing.

### Integration tests

- Open a folder from the explorer in a terminal.
- Copy remote paths.
- Open files using interactive terminal editors.
- Show correct equivalent commands in learning mode.
- Synchronize directories where supported.
- Use an explicit destination when synchronization is unavailable.

---

## 21. What Is Not Required for the First Version?

The following are deliberately excluded from the MVP:

- AI chatbot.
- Custom AI model training.
- Cloud backend service.
- User registration.
- Subscription payments.
- Browser-based remote access.
- Custom daemon installation on Linux servers.
- Full VS Code replacement.
- Docker filesystem integration.
- Advanced server monitoring.
- Shared multi-user accounts.

Keeping these outside the MVP helps concentrate on building a small, reliable application.

---

## 22. Unique Product Direction

SSHDrop should not compete simply by offering the largest number of SSH features.

Its proposed identity should be:

**A visual-first SSH workspace that makes remote file operations feel native to the terminal.**

The main product principles are:

1. Terminal functionality remains fully available.
2. File operations should be fast and simple.
3. Visual and command-based interactions should complement each other.
4. Users should understand which server and directory they are modifying.
5. Common tasks should require fewer steps.
6. Advanced functionality should not complicate the basic interface.
7. Security should never be sacrificed for convenience.

Possible tagline:

**SSHDrop — Your remote files, right where you work.**

---

## 23. Complete Feature Checklist

### Essential project concept

- [ ] Cross-platform desktop application.
- [ ] Real interactive SSH terminal.
- [ ] SSH server connection management.
- [ ] Visual remote folder/file explorer.
- [ ] Double-click directory navigation.
- [ ] Double-click file opening.
- [ ] Right-click file operations.
- [ ] Drag-and-drop file uploading.
- [ ] File downloading.
- [ ] File previews.
- [ ] Built-in code editor.
- [ ] `cat`, `nano`, `mv`, and `cp`-related actions.
- [ ] File and folder creation, renaming, moving, copying, and deletion.
- [ ] Upload/download progress.
- [ ] Remote file path handling.
- [ ] Proper SSH and SFTP security.

### Advanced product features

- [ ] Command Learning Mode.
- [ ] Terminal-directory synchronization.
- [ ] Multiple terminal tabs.
- [ ] Local and remote split file manager.
- [ ] Search and file filtering.
- [ ] Keyboard shortcuts.
- [ ] Terminal-focused layout.
- [ ] Docker/container integration.
- [ ] Remote log viewer.
- [ ] Advanced multi-server operations.

---

## 24. Final Project Definition

SSHDrop is a modern desktop SSH workspace designed to simplify the way developers interact with remote Linux servers.

It integrates a fully functional SSH terminal, visual file explorer, file-transfer system, built-in code editor, and graphical Linux file operations into a unified interface.

Users can navigate remote directories, open files by double-clicking, edit code, transfer files through drag and drop, execute shell commands, and manage server files without constantly switching between separate tools.

The application will prioritize simplicity, reliable file operations, strong security, and smooth interaction between visual components and the terminal.

The initial release will focus on dependable SSH access and file transfers. Subsequent releases will introduce visual file management, code editing, terminal-directory synchronization, command learning features, and optional Docker integration.

**The long-term goal is to make SSHDrop an open-source developer utility that combines the convenience of a graphical file manager with the flexibility and control of a traditional SSH terminal.**
