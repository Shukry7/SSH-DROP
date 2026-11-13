# Connection recovery

If the SSH transport closes unexpectedly, SSHDrop shows **Connection lost** and clears the old terminal and file listing. Enter authentication again and choose **Reconnect to server**. Host, port, account, the selected key reference and directory fields stay in the current workspace. Submitted passwords and key passphrases are cleared. A reconnect is a new SSH session and always follows the normal host-key verification rules; a changed key is blocked. It does not restore shell state, pending operations, approvals or output.

Use **Cancel connection attempt** while connecting or reconnecting. This ends setup and invalidates the pending host-verification prompt. If a native verification dialog is in front, its own Cancel button rejects the host. An approval received after cancellation is ignored. SSH authentication, terminal creation and SFTP setup each have a 30-second bound. A stalled terminal fails the attempt. Unavailable SFTP can leave an active terminal; file controls and recovery are unavailable until a new SFTP-capable connection is made.

**Shell closed** means the interactive shell has ended while the SSH transport may still be active. File browsing can remain available. To start a fresh terminal, disconnect and connect again. Conversely, if SFTP closes, its listing and file controls are cleared while the terminal may continue. The app reports the state it observed and does not attempt background recovery.

Interrupted transfers and workflows keep their generic inspection warnings. Check the server and recovery records before retrying: a remote process may still run, and a partial file may remain. Nothing resumes or replays automatically. When idle protection ends a session, it also clears the nonsecret workspace fields; returning shows a blank connection form. Sleep or network changes can still break a connection when idle protection is off. Reconnect is always manual.

## Terminal tabs in 0.4.0-alpha.1

Use **New terminal** to open another shell on the current SSH connection, up to four tabs. Each tab keeps its own scrollback. A shell that exits keeps its output available until you close its tab. Closing one terminal leaves the other shells and file explorer available. Disconnecting clears every terminal tab and its output. Reconnecting starts one fresh shell.
