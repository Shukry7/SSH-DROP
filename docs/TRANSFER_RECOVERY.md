# Transfer recovery

In SSHDrop 0.5.0-alpha.1, **Saved transfers** appears after connecting to a server with SFTP. Enable **Remember new individual transfers in this connection** before selecting files. This setting starts off in a new connection tab and lasts while the tab remains open. Existing ordinary transfers and folder transfers stay session-only.

Recovery accepts up to eight files per batch, 32 MiB per file, and 100 saved records across the app. The queue must be idle before saving a batch. Choose an unused destination. SSHDrop reads and hashes each source before queuing, so large batches can take time. An unavailable OS key store blocks saving encrypted records.

Reconnect to the same host, port, account and verified host key after interruption or restart. Review the paths and inspect the destination before choosing **Review retry**. SSHDrop checks the original source hash and requires an empty destination. It starts from byte zero and verifies the staged transfer before publication. If a previous transfer created the destination, inspect it and choose a fresh destination through the normal Files controls.

**Forget transfer** removes the encrypted record. Inspect any partial files through Files. Successful transfers and explicit cancellations remove their records. Terminal contents, file contents and SSH credentials are excluded from the journal. Stored paths, host identity and hashes are encrypted using the OS key store. Pending records survive idle disconnect and app exit. Byte-level resume and recovery for folders remain planned.
