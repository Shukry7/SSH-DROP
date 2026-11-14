# Connection recovery

If the SSH transport closes unexpectedly, SSHDrop shows **Connection lost** and clears the old terminal and file listing. Enter authentication again and choose **Reconnect to server**. Host, port, account, the selected key reference and directory fields stay in the current workspace. Submitted passwords and key passphrases are cleared. A reconnect is a new SSH session and always follows the normal host-key verification rules; a changed key is blocked. It does not restore shell state, pending operations, approvals or output.

Use **Cancel connection attempt** while connecting or reconnecting. This ends setup and invalidates the pending host-verification prompt. If a native verification dialog is in front, its own Cancel button rejects the host. An approval received after cancellation is ignored. SSH authentication, terminal creation and SFTP setup each have a 30-second bound. A stalled terminal fails the attempt. Unavailable SFTP can leave an active terminal; file controls and recovery are unavailable until a new SFTP-capable connection is made.

**Shell closed** means the interactive shell has ended while the SSH transport may still be active. File browsing can remain available. To start a fresh terminal, disconnect and connect again. Conversely, if SFTP closes, its listing and file controls are cleared while the terminal may continue. The app reports the state it observed and does not attempt background recovery.

Interrupted transfers and workflows keep their generic inspection warnings. Check the server and recovery records before retrying: a remote process may still run, and a partial file may remain. Nothing resumes or replays automatically. When idle protection ends a session, it also clears the nonsecret workspace fields; returning shows a blank connection form. Sleep or network changes can still break a connection when idle protection is off. Reconnect is always manual.

## Terminal tabs in 0.4.0-alpha.1

Use **New terminal** to open another shell on the current SSH connection, up to four tabs. Each tab keeps its own scrollback. A shell that exits keeps its output available until you close its tab. Closing one terminal leaves the other shells and file explorer available. Disconnecting clears every terminal tab and its output. Reconnecting starts one fresh shell.

## Open the shell folder in 0.4.0-alpha.2

Select a terminal tab and click **Open shell folder** to browse the path shown next to the button. The button becomes available when your shell emits an OSC 7 working directory report and SFTP is ready. SSHDrop uses the path from the report on your current connection. Check the displayed path before starting file operations, since programs running in the shell can also emit reports.

For a one-time report from a shell with Python 3, run this on the server after changing directory:

```sh
python3 -c 'import os, urllib.parse; print("\033]7;file://" + urllib.parse.quote(os.getcwd(), safe="/") + "\007", end="")'
```

If the shell does not report a path or the directory is unavailable through SFTP, enter a path in **Files** and choose **Go**. A failed lookup leaves the current listing in place. Directory reports clear when the shell closes or the connection ends.

## Connection tabs in 0.4.0-alpha.4

Choose **New connection tab** to open a separate workspace and connect to another server or account. Up to four tabs can be open. The tab shows the server and port after connecting. Use the arrow keys in the tab strip to switch connections. Use **Back to files** before switching from an open text editor dialog.

Each tab owns its terminals, file browser, drafts, transfer queue, and workflow runs. Switching tabs keeps ongoing work on its original connection. Native confirmations identify the connection when several tabs are open. Saved profiles and workflow definitions are shared. Recovery records retain their existing server and account scoping.

**Disconnect** ends the connection in the current tab. **Close connection tab** asks before disconnecting and discarding that tab’s workspace. Idle protection disconnects every tab and clears the entire workspace.
