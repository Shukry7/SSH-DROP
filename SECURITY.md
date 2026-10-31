# Security policy

SSHDrop is an early alpha. No stable release is supported yet. Use disposable test systems while evaluating it.

Do not post credentials, private keys, terminal output, or production files in issues. Report suspected vulnerabilities through the repository's private vulnerability reporting feature if enabled. If unavailable, open an issue asking for a private contact channel without disclosing exploit details.

Host identities are checked before authentication. Credentials are held for the active connection only; passwords and passphrases are not saved. Host trust records contain public server identities, not login secrets.

Remote content is untrusted. The renderer is sandboxed, has no Node integration, and accesses a restricted, validated preload bridge. File operations use SFTP rather than generated shell commands. The initial release does not open a LAN listener.

Code signing, credential persistence, auto-updates, and Mobile Bridge require additional security work before being represented as supported features.
