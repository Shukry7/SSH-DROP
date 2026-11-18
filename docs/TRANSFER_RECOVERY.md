# Transfer recovery

In SSHDrop, **Saved transfers** appears after connecting to a server with SFTP. Enable **Remember new file and folder transfers in this connection** before selecting files. This setting starts off in a new connection tab and lasts while the tab remains open. Transfers queued with the setting off stay session-only.

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

After a disconnect, reconnect to the same verified server and account and select **Review folder download**. The review shows how many files were recorded as copied. SSHDrop rechecks the source tree and its file hashes, verifies recorded local files, and starts unfinished files from byte zero. Source changes, missing or changed completed paths, and unexpected destination entries stop the retry. If the app stopped between publishing an entry and saving its record, the retry also stops. Inspect the partial folder and download into a new destination in that case. Cancelling an active folder download leaves its record available for another explicit review. **Forget transfer** removes the record and leaves copied files in place. Finished downloads are ordinary local files.

## Folder upload recovery in 0.5.0-alpha.5

Enable recovery and use **Upload folder** to copy into a new remote destination. The 128 MiB, 100-entry and 16-level limits apply. After reconnecting to the same verified server and account, select **Review folder upload** to see the recorded progress and approve continuing. SSHDrop verifies the source tree and completed remote files. If an unfinished file has a recorded remote temporary file, SSHDrop checks its ownership, permissions and bytes before continuing. A missing temporary file starts that file from byte zero. Changed files or unexpected remote entries stop the retry.

The temporary file contains the uploaded bytes and requests owner-only permissions. Forgetting the record leaves remote files and any temporary file available for inspection.

## Folder download merge recovery in 0.5.0-alpha.6

Enable transfer recovery and download a folder into a parent with an existing folder of the same name. The native confirmation identifies both paths. The saved merge offers **Skip file** or **Keep both** for existing files. The 100-entry and 16-level source limits apply, along with separate 128 MiB limits for incoming files and existing conflicts. Keep other writers away from both folders while the merge runs.

After reconnecting to the same server and account, select **Review folder merge**. SSHDrop shows copied and skipped counts, verifies the source, original conflict files, recorded copies and directory entries, then asks for a decision on each remaining conflict. If a copy was published before its checkpoint was saved, the extra file stops recovery and stays available for inspection. Disable transfer recovery to use the ordinary merge options, including replacements.

## Folder upload merge recovery in 0.5.0-alpha.7

Enable transfer recovery, choose **Upload folder**, and select a folder whose name matches an existing remote folder. The saved merge offers **Skip file** and **Keep both**. The same 100-entry, 16-level, and separate 128 MiB incoming and conflict limits apply. Reconnect to the original verified server and account and select **Review folder merge** to resume. SSHDrop rechecks the local source, remote originals, and completed copies.

If a **Keep both** copy or temporary file appears on the server without a matching completed record, recovery stops so you can inspect it. Files with no conflict can reuse a verified upload checkpoint. Disable transfer recovery for upload overwrite options.

## Backed-up download merge recovery in 0.5.0-alpha.8

Saved folder download merges also offer **Back up and replace**. SSHDrop first retains an encrypted, verified local backup, then stages and verifies the incoming file before replacing the approved destination. An unlocked OS key store and sufficient space for the backup and staging are required. Keep other writers away from the destination.

After reconnecting, SSHDrop verifies completed replacements and their linked backups before continuing. Corrupt, missing, deleted or unavailable backups block continuation. A replacement started without a recorded completion stops the merge for inspection in **Recovery backups**, even when the destination appears correct. Inspect it and choose a new transfer after resolving the uncertain result. Rollback and restore-copy use the existing Recovery backups controls. Forgetting the saved merge leaves its independent backups available.

## Backed-up upload merge recovery in 0.5.0-alpha.9

Saved folder upload merges offer **Back up and replace** when the connected server supports OpenSSH atomic rename. A verified encrypted copy of the previous remote file is retained on this computer before replacement. An unlocked OS key store and sufficient local storage are required. The incoming file is staged, verified and published with the previous file's ordinary permissions and owner/group checks. Additional remote metadata is outside the backup's scope.

After reconnecting, review the saved merge. SSHDrop verifies completed remote replacements and their local backups. Changed remote files or corrupt/unavailable backups block continuation. An uncertain replacement keeps its backup and stops the merge for inspection in **Recovery backups**. Use its rollback or restore-copy actions after inspecting the outcome. Servers without atomic replacement continue to offer **Skip file** and **Keep both**. Saved merge replacement without a retained backup remains planned.
