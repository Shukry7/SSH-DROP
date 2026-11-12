# Portable encrypted backups

In alpha.6 development source, **Recovery backups → Export encrypted backup** creates a passphrase-protected `.sshdrop-backup` file for an existing encrypted backup up to 32 MiB. Connect to the same verified server and account, unlock the original OS key store, and secure any legacy plaintext backup first. Use a unique, strong passphrase of at least 16 characters; a generated passphrase from a password manager is preferable. Keep it separately from the file. The original recovery record and encrypted backup are preserved.

On a different computer, choose **Open portable backup** in the top bar, enter the export passphrase, select the file and choose a new destination. Confirm the warning before writing the restored copy. The copy is an ordinary unencrypted file; choose a private folder. The operation works without SSH or OS key-store access. It never adds to the recovery journal, writes to a server, applies an old rollback, or replaces an existing file. The chosen filesystem must support hard links for verified no-overwrite publication. The app's own data directory cannot be used as an output folder.

The export contains authenticated encrypted bytes of the previous file only. It contains no original filename, server identity, paths, credentials, permissions or master vault key. The file size still reveals approximate content size. Keep a separate private note describing the backup if needed, and treat the export as sensitive even though encrypted.

## Format and failure behavior

Version 1 uses AES-256-GCM with a fresh 16-byte salt and 12-byte nonce. The header (`SSHDROP-PB1` followed by NUL, salt and nonce) is authenticated. The 32-byte key is derived with asynchronous scrypt, fixed N=131072, r=8, p=1; the file cannot choose weaker or unbounded parameters. The payload is followed by a 16-byte authentication tag. Passphrases use their exact UTF-8 representation. Passphrases are not logged or stored by SSHDrop. Memory and OS swap are outside any guarantee of secure erasure.

Export checks both vault authentication and the recorded SHA-256 and byte count. Import authenticates the complete file in memory before creating any output; wrong passphrase or tampering produces no copy. Main owns the native selections, approvals and a single active derivation, with idle/session checks at publication. Both paths verify a staged file before linking it to a new filename. Use a trusted destination directory. A crash or cleanup failure can leave an operation's `.sshdrop-portable-*.part` file; a restore stage contains plaintext and should be handled accordingly. File permissions request owner-only access where supported. The app cannot protect the copy against processes with access to that folder or erase filesystem remnants.

## Key recovery and rotation

Before reinstalling the OS or moving to a different account, export each important backup and verify that it opens with the passphrase into a disposable new copy. This is recovery of the exported file contents; it is not recovery of the old OS-protected vault key. If the old key is lost before export, these tools cannot decrypt that vault. A forgotten export passphrase cannot be reset.

To change an export's passphrase, make a new verified export while the original vault is still available; old copies remain decryptable with their original passphrase. Whole-vault key rotation and migration remain separate work: retain the old key and data, stage and verify the new vault before switching, and test interrupted migration before deleting the old vault. There is no in-place rekey, bulk export or portable rollback in this version.
