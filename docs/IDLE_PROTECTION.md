# Idle session protection (0.2.0-alpha.6 development source)

This version implements the selected **disconnect-and-clear** policy. It is not an authenticated app lock that keeps SSH running. Existing alpha.5 installers do not include it. Automatic protection is off by default to avoid interrupting existing work without consent.

## Settings and countdown

Open Idle protection settings in the top bar. Choose Off, 5, 10, 15, 30 or 60 minutes and optionally enable a generic desktop warning when SSHDrop is in the background. Applying a change requires a native default-Cancel warning explaining interruption and data loss. Settings are saved locally across app restarts in the versioned, bounded `idle-settings.json` in the application user-data directory. They contain only the timeout and notification preference, not input history.

The status indicator shows time remaining. At one minute remaining, a modal appears above the app panels and counts down in seconds. Choose **Stay active** to restart the full interval, or **End session now** to disconnect immediately. Escape, mouse movement, remote logs, transfer progress and SSH keepalives cannot dismiss the warning. Before the warning, keyboard presses, mouse clicks and scrolling delivered to the app window reset activity. Activity in another application or a native OS file picker does not reset it. Isolated preload reports only trusted keyboard/pointer-down/wheel events while the page is visible, with no key contents or activity method exposed to page code. Scripted DOM events are ignored.

The accessible modal traps focus through native HTML dialog behavior. Its initial warning is announced; the per-second timer is not a screen-reader live region. Background notification support depends on the OS and its notification settings. SSHDrop does not force itself above other applications or steal focus. OS-owned dialogs may appear above the in-app warning; expiry closes the old window and its native dialogs regardless.

## Expiry and sleep

At expiry, main blocks new sensitive API requests, invalidates in-flight approvals, clears private-key handles and disconnects SSH. It destroys the old window/renderer and recreates a generic privacy screen, clearing terminal output, file listings, input fields, workflow values/results and unsaved UI edits. It preserves the minimized/background state and does not automatically reconnect. Pending operations may finish or leave partial/uncertain results; the feature cannot undo completed changes or promise forensic erasure from RAM, swap, crash dumps or screenshots.

The privacy screen's **Return to connection screen** opens a blank connection form. It never restores the old SSH connection, command approvals or private-key selection. Saved local profiles, workflow definitions, trust records and recovery backups remain on disk. Loading them later is intentional; the screen is not an authenticated vault protecting this local configuration. A user with access to the local account or files can still access those records. Use the operating system screen lock and disk/account protections.

When automatic protection is enabled, supported OS screen-lock events and system suspend end the session immediately. Electron reports screen-lock events on Windows/macOS; Linux desktop/session integration varies and is not certified by simulated events. Resume rechecks main-owned deadlines, never reconnecting or rerunning work. Main combines wall and monotonic elapsed time; a substantial backwards clock change ends the session conservatively. Reloading, minimizing or throttling the renderer cannot reset the timer. Protection also applies to an idle disconnected workspace while enabled.

Transfers, queued items and workflows may be interrupted. Remote commands, descendants, containers or background jobs can continue despite disconnection. Inspect the server and recovery records before retrying. The idle feature is separate from SSH keepalives, transfer inactivity bounds and workflow per-command runtime limits.

Invalid, unsupported or oversized settings are preserved and edits are refused. Startup uses a visible conservative 10-minute policy rather than silently disabling protection. Close SSHDrop and repair or deliberately remove the invalid `idle-settings.json` before reopening; removing it restores the default Off policy. No automatic migration discards unreadable data.

## Validation and remaining work

Unit and desktop regressions cover deadline boundaries, explicit continuation, clock changes, main API enforcement, persistence/corruption, sleep/lock events, minimization/reload, stale native confirmations/pickers and workflow interruption without replay. Simulated OS events do not establish real-device behavior. Test actual screen locking, suspend/resume, scaling, assistive technology and notifications on Windows, Linux and macOS before release.

Authenticated OS unlock with connections continuing behind a lock remains planned separately. This implementation does not add saved credentials, app passwords, workflow rollback, automatic reconnect or persistent transfer resume. Publication, signing/notarization and cross-platform device certification remain separate work.
