# Privacy and local data

SSHDrop has no implemented analytics, advertising, cloud account, or cloud-sync service. The reviewed application source connects to the SSH server you choose. Production renderer network requests are blocked by CSP; development mode permits local Vite connections. This is a source-level description and tested renderer restriction, not a certification based on exhaustive OS packet capture or third-party binary analysis.

## What stays on this device

| Data                                                                                               | Location and retention                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved profile name, host, username, port, authentication method, starting directory, key-file path | Unencrypted `profiles.json` in Electron's application user-data directory, until you delete the profile or remove that file while the app is closed.                      |
| Trusted server fingerprints                                                                        | `known-hosts.json` in the same directory. Deleting a profile deliberately preserves trust. Remove an old identity only after independently verifying a server-key change. |
| Passwords and key passphrases                                                                      | Not intentionally written to disk. Fields clear after connection attempts and when switching profiles/authentication methods.                                             |
| Private key contents                                                                               | Read from the file chosen through the native picker, used for authentication, and not copied into profile storage. The original file remains on disk.                     |
| Terminal output and transfer filenames                                                             | Kept in the current application session. Terminal views and transfer history reset on disconnect or a new connection attempt. No terminal log is implemented.             |
| Uploaded/downloaded files                                                                          | Remain at the explicitly selected destination. Deleting a profile does not delete transferred files.                                                                      |

Application user data is separate from the project source. Its precise location follows Electron's `userData` setting for the installation and OS; development tests use isolated temporary directories. Uninstalling an application may leave user-data files behind. Close SSHDrop before removing its local data. Ordinary deletion is not secure disk erasure, and backups may retain copies.

Profile metadata can reveal private infrastructure and local account names even though it contains no login secret. File permissions are owner-only on supported Unix filesystems; Windows relies on the user's application-data directory ACLs. Users sharing an OS account, administrators, malware, backups, and disk access are outside this protection. Full-disk encryption and separate OS accounts remain useful protections. Profile encryption and OS credential persistence are not implemented.

JavaScript strings and dependency/OS memory cannot be reliably zeroed. Clearing a field or disposing the terminal prevents ordinary UI reuse, not forensic recovery from memory, swap, screenshots, clipboard contents, or crash dumps. SSHDrop does not clear the system clipboard, which may belong to other applications.

## What leaves this device

The remote server receives SSH authentication and commands/file operations needed for your actions. Verify its fingerprint through a trusted source before approving it. The app cannot protect credentials given to a server whose identity you incorrectly trust.

Installing/building the source contacts dependency and build-asset services. `npm run security:audit` sends dependency names/versions to the configured npm advisory service. These are developer/CI operations, not application analytics. GitHub Actions stores test coverage, synthetic test screenshots, traces, and dependency reports for the configured retention period. Tests use disposable loopback servers and generated test keys; do not substitute production credentials or files.

Do not share profiles, host records, private keys, sensitive terminal output, or downloaded server files in issues, screenshots, or Git commits. The tracked-file secret scan is a baseline detector, not an exhaustive historical secret audit.
