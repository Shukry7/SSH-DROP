# Architecture

The React renderer owns presentation. A sandbox-compatible preload exposes individual methods, never raw IPC. Electron main validates the sender and every request, owns SSH connections, and opens native file dialogs. Core SSH/SFTP and trust services have no Electron dependency and are exercised over real SSH protocol in regression tests.

One SSH connection provides an independent shell channel and SFTP channel. Terminal output pauses above a bounded pending-data threshold until xterm acknowledges rendering it; stale session events cannot clear a newer shell. The explorer has an explicit absolute POSIX path. It never guesses a terminal's working directory. Local paths use local OS path rules.

Host keys are compared by host and port. Unknown keys require explicit native confirmation; changed keys are rejected. The local trust file is atomically replaced. Credentials are session-only. Private-key selection uses a native file picker and an opaque handle; the renderer cannot request arbitrary local file reads.

Transfers stream with backpressure. Initial transfers exclusively create a new destination and refuse overwrites. Failed transfers remove only their own partial file. Mutations are not replayed on reconnect. Recursive transfers are not implemented.

electron-vite bundles application processes; electron-builder creates platform artifacts. The application version comes from package.json through Electron metadata. No backend, remote agent, or local PTY is required for a remote SSH shell.
