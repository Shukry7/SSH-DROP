# Transfer recovery

In SSHDrop, **Saved transfers** appears after connecting to a server with SFTP. Enable **Remember new file transfers and folder downloads in this connection** before selecting files. This setting starts off in a new connection tab and lasts while the tab remains open. Folder uploads and transfers queued with the setting off stay session-only.

Recovery accepts up to eight files per batch, 32 MiB per file, and 100 saved records across the app. The queue must be idle before saving a batch. Choose an unused destination. SSHDrop reads and hashes each source before queuing, so large batches can take time. An unavailable OS key store blocks saving encrypted records.

Reconnect to the same host, port, account and verified host key after interruption or restart. Review the paths and inspect the destination before choosing **Review upload resume** for an upload or **Review download resume** for a download. SSHDrop checks the original source hash, requires an empty destination and verifies the staged transfer before publication. If a previous transfer created the destination, inspect it and choose a fresh destination through the normal Files controls.

**Forget transfer** removes the encrypted record and any saved individual download checkpoint. Inspect any partial files through Files. Successful transfers, cancelled queued jobs and explicitly cancelled individual transfers remove their records. Terminal contents, file contents and SSH credentials are excluded from the journal. Stored paths, host identity and hashes are encrypted using the OS key store. Pending records survive idle disconnect and app exit.

## Download checkpoints in 0.5.0-alpha.2

When SSHDrop detects an interrupted download, it encrypts the bytes already written to staging before cleaning up the temporary file. Forced termination or power loss can prevent this checkpoint from being saved. A saved download without a checkpoint starts at byte zero.

On retry, SSHDrop authenticates the checkpoint and compares the retained prefix with the remote bytes. That check rereads the prefix over SFTP, so this implementation does not promise bandwidth savings. A mismatch, a damaged checkpoint or a changed full-file hash prevents publication. The final file appears only after verification.

## Upload checkpoints in 0.5.0-alpha.3

For a saved upload, SSHDrop creates an exclusive owner-only temporary file in the remote destination folder and records its name in the encrypted journal before writing bytes. After interruption, reconnect and review the upload. SSHDrop checks the original source, the recorded temporary file and its prefix before writing the remaining bytes. It reads back the complete staged file before publishing. A missing temporary file starts a fresh upload. A mismatched or unsafe temporary file stops the retry without publishing a final file.

The remote partial file contains the uploaded bytes and uses owner-only permissions. A failed upload can leave it on the server. Forgetting the record leaves the remote file available for inspection. Keep other writers away from the temporary file and destination while resuming.

## Folder download recovery in 0.5.0-alpha.4

Enable transfer recovery, choose **Download folder**, and select a parent where the destination folder does not exist. The original scan limits of 100 entries and 16 levels apply, with a 128 MiB total size limit for saved folders. Disable recovery for ordinary larger folder copies or merges.

After a disconnect, reconnect to the same verified server and account and select **Review folder download**. The review shows how many files were recorded as copied. SSHDrop rechecks the source tree and its file hashes, verifies recorded local files, and starts unfinished files from byte zero. Source changes, missing or changed completed paths, and unexpected destination entries stop the retry. If the app stopped between publishing an entry and saving its record, the retry also stops. Inspect the partial folder and download into a new destination in that case. Cancelling an active folder download leaves its record available for another explicit review. **Forget transfer** removes the record and leaves copied files in place. Finished downloads are ordinary local files. Folder upload and merge recovery remain planned.
