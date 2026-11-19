# Portable encrypted backups

## Whole-vault portability in 0.6.0-alpha.1

Choose **Vault tools → Export recovery vault** to create a password-protected `.sshdrop-vault` archive of all recovery records and backup contents. This version supports up to 100 encrypted backups and 64 MiB of total backup contents. Secure legacy backups before export. The source OS key store must be unlocked. The archive contains encrypted server/account identities, paths, metadata and backup bytes. Credentials, saved transfer queues and profiles are outside this archive.

On another device or OS account, choose **Vault tools → Import recovery vault**, supply the archive passphrase and confirm. The destination OS key store must be available. Every entry is checked before installation, then encrypted with the destination vault key. Matching backups are verified and skipped. Conflicting records, wrong passwords, corrupt entries and storage-limit failures stop the import. Finish transfers, file operations and workflows in all tabs first.

Connect to the same verified server and account to review imported records in **Recovery backups**. Imported records allow **Restore copy** into a new native-selected local file. Their recorded paths cannot be used for rollback or automatic inspection. Imported copies retain their server identity and original operation metadata. The restored local file is unencrypted. Backups already on the destination computer retain their original recovery behavior.

The archive uses AES-256-GCM and the existing fixed scrypt parameters, with the distinct authenticated `SSHDROP-VL1` format header. Source and destination vault keys are excluded. Loss of the original key before export remains unrecoverable. Keep the archive passphrase separately. The app checks and decrypts this bounded archive in memory. A crash can leave encrypted import staging or unreferenced encrypted backups, which are retained when a metadata commit has an uncertain outcome. Retrying a committed import skips its records.

## Individual portable backups

In alpha.6 development source, **Recovery backups → Export encrypted backup** creates a passphrase-protected `.sshdrop-backup` file for an existing encrypted backup up to 32 MiB. Connect to the same verified server and account, unlock the original OS key store, and secure any legacy plaintext backup first. Use a unique, strong passphrase of at least 16 characters; a generated passphrase from a password manager is preferable. Keep it separately from the file. The original recovery record and encrypted backup are preserved.

On a different computer, choose **Open portable backup** in the top bar, enter the export passphrase, select the file and choose a new destination. Confirm the warning before writing the restored copy. The copy is an ordinary unencrypted file; choose a private folder. The operation works without SSH or OS key-store access. It never adds to the recovery journal, writes to a server, applies an old rollback, or replaces an existing file. The chosen filesystem must support hard links for verified no-overwrite publication. The app's own data directory cannot be used as an output folder.

The export contains authenticated encrypted bytes of the previous file only. It contains no original filename, server identity, paths, credentials, permissions or master vault key. The file size still reveals approximate content size. Keep a separate private note describing the backup if needed, and treat the export as sensitive even though encrypted.

## Format and failure behavior

Version 1 uses AES-256-GCM with a fresh 16-byte salt and 12-byte nonce. The header (`SSHDROP-PB1` followed by NUL, salt and nonce) is authenticated. The 32-byte key is derived with asynchronous scrypt, fixed N=131072, r=8, p=1; the file cannot choose weaker or unbounded parameters. The payload is followed by a 16-byte authentication tag. Passphrases use their exact UTF-8 representation. Passphrases are not logged or stored by SSHDrop. Memory and OS swap are outside any guarantee of secure erasure.

Export checks both vault authentication and the recorded SHA-256 and byte count. Import authenticates the complete file in memory before creating any output; wrong passphrase or tampering produces no copy. Main owns the native selections, approvals and a single active derivation, with idle/session checks at publication. Both paths verify a staged file before linking it to a new filename. Use a trusted destination directory. A crash or cleanup failure can leave an operation's `.sshdrop-portable-*.part` file; a restore stage contains plaintext and should be handled accordingly. File permissions request owner-only access where supported. The app cannot protect the copy against processes with access to that folder or erase filesystem remnants.

## Key recovery and rotation

Before reinstalling the OS or moving to a different account, export each important backup and verify that it opens with the passphrase into a disposable new copy. This is recovery of the exported file contents; it is not recovery of the old OS-protected vault key. If the old key is lost before export, these tools cannot decrypt that vault. A forgotten export passphrase cannot be reset.

To change an export's passphrase, make a new verified export while the original vault is still available; old copies remain decryptable with their original passphrase. Whole-vault export/import is available within the limits above. Portable rollback remains planned. Retain the original key and data until the imported vault and restored copies have been verified.

### Active recovery vault rotation in 0.6.0-alpha.2

Choose **Vault tools → Rotate recovery vault key**, then review the native confirmation (Cancel is the default). First export and verify an independent password-protected archive of important backups. Rotation changes the local recovery encryption key, not the OS key-store provider, SSH credentials, exported archive passwords or the separate saved-transfer checkpoint vault. The OS key store must be unlocked. Finish transfers, file operations and workflows in all connection tabs first. Large vaults may take several minutes; keep the app open. Rotation is bounded to 30 minutes and remains subject to idle protection.

The app checks all referenced encrypted backups and metadata before changing the key, rejects legacy plaintext records and unreferenced `.enc` files, and requires enough space for the largest staged file plus a 50 MiB reserve. The new key is OS-wrapped and tested before publication. A version 2 `vault-key.json` temporarily retains both wrapped keys. Each file is streamed into an exclusively created encrypted stage, fully authenticated and checked against SHA-256/size, then atomically renamed. No plaintext staging file is created. All published files are checked using only the new key before the previous key is removed from the live envelope. Existing recovery records and server identity bindings retain their behavior.

If cancellation, OS locking, a timeout or a disk error interrupts rotation, keep the entire backups directory together. Mixed old/new ciphertext remains readable with the retained keys. Choose **Rotate recovery vault key** again to finish with the same pending replacement key. Do not manually restore an old key file or delete either key from the envelope. A process crash can leave encrypted `.rotation.tmp` stages; preserve them for review. An error reported after a rename may mean that step committed; the app never rolls the key file back on such an error.

Older application versions reject the version 2 key envelope; downgrade requires a separately verified export, not replacing the live key file. Rotation does not securely erase old keys or ciphertext in filesystem snapshots, backups, disk remnants or memory, and cannot protect against a compromised OS account. Directory rename ordering is synced on POSIX; Node offers no equivalent portable directory sync on Windows. Power loss, filesystem corruption and faulty storage can still require the independent archive. Native Windows/macOS/Linux key-store and power-loss testing remain release requirements.
