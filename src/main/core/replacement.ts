import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, posix, resolve } from 'node:path';
import type { RecoveryAction, RecoveryView } from '../../shared/contracts';
import {
  RecoveryStore,
  identitySchema,
  recoveryPathsSchema,
  type FileSnapshot,
  type RecoveryRecord,
  type ServerIdentity,
} from './recovery-store';
import { join as localJoin } from 'node:path';
import { privateFile } from './backup-vault';
import type { ReplacementIO } from './replacement-io';

export interface ReplacementApproval {
  title: string;
  detail: string;
  buttons: string[];
}
export interface ReplacementContext {
  store: RecoveryStore;
  identity: ServerIdentity;
  localIO: ReplacementIO;
  remoteIO: ReplacementIO;
  check(): void;
  beforePublish?: () => Promise<void>;
  transfer(direction: 'upload' | 'download', local: string, remote: string): Promise<void>;
  confirm(approval: ReplacementApproval): Promise<number>;
}
export const equalFile = (a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean =>
  !!a &&
  !!b &&
  a.size === b.size &&
  a.hash === b.hash &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid;
// Restored copies have new timestamps, but a destination guarded by an approval
// must still have the same observed modification time, even if its bytes match.
const unchangedFile = (a: FileSnapshot | undefined, b: FileSnapshot | undefined): boolean =>
  equalFile(a, b) && a?.modified === b?.modified;
const equalBytes = (a: FileSnapshot | undefined, b: FileSnapshot): boolean =>
  !!a && a.size === b.size && a.hash === b.hash;
const destination = (r: Pick<RecoveryRecord, 'direction' | 'local' | 'remote'>) =>
  r.direction === 'upload' ? r.remote : r.local;
export function copyName(path: string, remote: boolean): string {
  const p = remote ? posix : { basename, dirname, extname, join };
  const extension = p.extname(path);
  // Bound the generated basename even when the selected original is near NAME_MAX.
  const stem = p.basename(path, extension).slice(0, 40);
  return p.join(
    p.dirname(path),
    `${stem} (copy ${randomUUID().slice(0, 8)})${extension.slice(0, 16)}`,
  );
}
export const recoveryView = (r: RecoveryRecord): RecoveryView => ({
  id: r.id,
  direction: r.direction,
  path: destination(r),
  created: r.created,
  state: r.state,
  size: r.previous.size,
  encrypted: !!r.encrypted,
});

export class Replacements {
  constructor(private readonly c: ReplacementContext) {}
  private io(direction: 'upload' | 'download') {
    return direction === 'upload' ? this.c.remoteIO : this.c.localIO;
  }
  private async approve(approval: ReplacementApproval): Promise<number> {
    this.c.check();
    const choice = await this.c.confirm(approval);
    this.c.check();
    return choice;
  }
  private describe(path: string): string {
    const i = this.c.identity;
    return `Server: ${i.username}@${i.host}:${i.port}\nDestination: ${path}\n\n`;
  }
  async saveEditedFile(
    remote: string,
    previous: FileSnapshot,
    incoming: FileSnapshot,
  ): Promise<boolean> {
    identitySchema.parse(this.c.identity);
    const local = resolve('Edited in SSHDrop');
    recoveryPathsSchema.parse({ local, remote });
    const io = this.c.remoteIO;
    if (!unchangedFile(await io.snapshot(remote), previous))
      throw new Error(
        'The remote file changed. Your draft is still open. Compare with the server to review its current contents before saving.',
      );
    if (!(await io.supports(remote)))
      throw new Error(
        'This server does not support atomic replacement. The draft has not been saved.',
      );
    const choice = await this.approve({
      title: 'Save edited remote file',
      buttons: ['Cancel', 'Back up and save', 'Save without backup'],
      detail:
        this.describe(remote) +
        'Saving replaces the remote file contents. Back up and save keeps an encrypted recovery copy on this computer and requires its OS key store. Save without backup has no rollback. Stop other writers while saving. Basic permissions are preserved; ACLs and extended metadata may change.',
    });
    if (choice === 0) return false;
    await this.c.beforePublish?.();
    if (choice === 1) {
      await this.replace({ direction: 'upload', local, remote, previous }, undefined, incoming);
    } else if (choice === 2) {
      if (
        (await this.approve({
          title: 'Save without recovery backup',
          buttons: ['Cancel', 'Save permanently'],
          detail:
            this.describe(remote) +
            'The previous contents will have no SSHDrop backup or rollback. Inspect the remote file if the connection fails.',
        })) !== 1
      )
        return false;
      await this.replaceWithoutBackup('upload', local, remote, previous, incoming);
    } else throw new Error('Invalid editor save choice.');
    return true;
  }
  async transfer(
    direction: 'upload' | 'download',
    local: string,
    remote: string,
    skipLabel = 'Cancel',
  ): Promise<boolean> {
    // Reject control/bidirectional characters before displaying a native warning,
    // rather than waiting until a recovery record is written after approval.
    identitySchema.parse(this.c.identity);
    recoveryPathsSchema.parse({ local, remote });
    const target = direction === 'upload' ? remote : local;
    const io = this.io(direction);
    const previous = await io.snapshot(target);
    if (!previous) {
      await this.c.transfer(direction, local, remote);
      return true;
    }
    const alternate = copyName(target, direction === 'upload');
    const incoming = await this.io(direction === 'upload' ? 'download' : 'upload').snapshot(
      direction === 'upload' ? local : remote,
    );
    if (!incoming) throw new Error('The source file is missing.');
    const supported = await io.supports(target);
    const choice = await this.approve({
      title: 'File already exists',
      buttons: [
        skipLabel,
        'Keep both',
        ...(supported ? ['Back up and replace', 'Replace without backup'] : []),
      ],
      detail:
        this.describe(target) +
        `Existing file: ${previous.size} bytes; modified ${previous.modified === undefined ? 'unknown' : new Date(previous.modified).toISOString()}\nIncoming file: ${incoming.size} bytes; modified ${incoming.modified === undefined ? 'unknown' : new Date(incoming.modified).toISOString()}\nBackup requires at least ${previous.size} bytes locally plus a 50 MiB reserve and staging space.\nKeep both creates: ${alternate}\n\n` +
        (supported
          ? 'Back up and replace first stores an independent SHA-256 verified, encrypted copy in SSHDrop’s local backup folder. Contents and recovery metadata use authenticated encryption with an OS-protected key. An unlocked OS key store is required; there is no plaintext fallback. Backups stay until you remove them (100 records / 10 GiB limit). Losing the OS account or vault key can make backups unrecoverable. Encryption does not protect against other software running as your OS user. Replace without backup instead permanently replaces the previous contents without a recovery record or rollback and does not require the vault.\n\nOnly ordinary file contents and basic permissions are verified. Remote ACLs, extended attributes and hard links cannot be preserved or fully detected. Stop other writers: SSH cannot guarantee a compare-and-swap against external edits. Replacement may affect services using this file.'
          : 'This server does not advertise atomic replacement. Choose Keep both; the existing file will be preserved.'),
    });
    if (choice === 0) return false;
    if (choice === 1) {
      await this.c.transfer(
        direction,
        direction === 'upload' ? local : alternate,
        direction === 'upload' ? alternate : remote,
      );
      return true;
    }
    if (choice === 3 && supported) {
      if (
        (await this.approve({
          title: 'Replace without recovery backup',
          buttons: ['Cancel', 'Replace permanently'],
          detail:
            this.describe(target) +
            'The previous contents will not be recoverable through SSHDrop. No retained backup or rollback record will be created. Verified staging is still required. Stop other writers; replacement may affect running services. If the connection fails, inspect the destination before retrying.',
        })) !== 1
      )
        return false;
      await this.replaceWithoutBackup(direction, local, remote, previous, incoming);
      return true;
    }
    if (choice !== 2 || !supported) throw new Error('Invalid replacement choice.');
    await this.replace({ direction, local, remote, previous }, undefined, incoming);
    return true;
  }
  private async replaceWithoutBackup(
    direction: 'upload' | 'download',
    local: string,
    remote: string,
    previous: FileSnapshot,
    expected: FileSnapshot,
  ): Promise<void> {
    const c = this.c;
    const io = this.io(direction);
    const target = direction === 'upload' ? remote : local;
    const stage = io.sibling(target, randomUUID());
    let publishing = false;
    let owned = false;
    try {
      c.check();
      await c.transfer(
        direction,
        direction === 'upload' ? local : stage,
        direction === 'upload' ? stage : remote,
      );
      owned = true;
      c.check();
      await io.preserve(stage, previous);
      const installed = await io.snapshot(stage);
      if (!equalBytes(installed, expected))
        throw new Error(
          'The source changed after approval. The destination has not been replaced.',
        );
      if (!unchangedFile(await io.snapshot(target), previous))
        throw new Error('Destination changed. The original has not been replaced.');
      await c.beforePublish?.();
      c.check();
      publishing = true;
      await io.replace(stage, target);
      c.check();
      if (!equalFile(await io.snapshot(target), installed))
        throw new Error('The final destination could not be verified.');
    } catch (error) {
      if (!publishing && owned) await io.remove(stage).catch(() => undefined);
      if (publishing)
        throw new Error(
          'Replacement outcome is uncertain and no recovery backup exists. Inspect the destination and staging files before retrying; nothing was repeated.',
          { cause: error },
        );
      throw error;
    }
  }
  private async replace(
    input: Pick<RecoveryRecord, 'direction' | 'local' | 'remote' | 'previous'> & {
      parentId?: string;
    },
    backupSource?: RecoveryRecord,
    expected?: FileSnapshot,
  ): Promise<void> {
    const c = this.c;
    const io = this.io(input.direction);
    const target = destination(input);
    c.check();
    const record = await c.store.create({ ...input, identity: c.identity });
    const stage = io.sibling(target, record.id);
    const safety = `${stage}.original`;
    let publishing = false;
    let stageOwned = false;
    try {
      try {
        await c.store.save(record, io.read(target), () => c.check());
      } catch (error) {
        throw new Error('Backup verification failed. The original has not been replaced.', {
          cause: error,
        });
      }
      c.check();
      await c.store.update(record.id, c.identity, { state: 'backup-ready' });
      if (backupSource) {
        await io.write(
          stage,
          c.store.contents(backupSource, () => c.check()),
          backupSource.previous,
        );
      } else
        await c.transfer(
          input.direction,
          input.direction === 'upload' ? input.local : stage,
          input.direction === 'upload' ? stage : input.remote,
        );
      stageOwned = true;
      c.check();
      await io.preserve(stage, input.previous);
      const installed = await io.snapshot(stage);
      if (!installed) throw new Error('Staged replacement is missing.');
      if (expected && !equalBytes(installed, expected))
        throw new Error(
          'The source changed after approval. The destination has not been replaced.',
        );
      if (backupSource) {
        const parent = await c.store.load(input.parentId!, c.identity);
        if (!equalBytes(installed, parent.previous))
          throw new Error('Rollback contents changed. The destination has not been replaced.');
      }
      try {
        await c.store.verify(record, () => c.check());
      } catch (error) {
        throw new Error(
          'Backup changed before publication. The destination has not been replaced.',
          { cause: error },
        );
      }
      if (!unchangedFile(await io.snapshot(target), input.previous))
        throw new Error('Destination changed. The original has not been replaced.');
      if (
        input.direction === 'download' &&
        process.platform === 'win32' &&
        (await io.snapshot(safety))
      )
        throw new Error(
          'The native safety-copy name is already occupied. The original has not been replaced.',
        );
      c.check();
      await c.store.update(record.id, c.identity, { state: 'publishing', installed });
      await c.beforePublish?.();
      c.check();
      publishing = true;
      await io.replace(stage, target, safety);
      c.check();
      if (!equalFile(await io.snapshot(target), installed))
        throw new Error('The final destination could not be verified.');
      await c.store.update(record.id, c.identity, { state: 'completed' });
      // Windows ReplaceFile retains a second, same-volume original. Only remove it after
      // acknowledgement, verification and a durable independent recovery record.
      if (input.direction === 'download' && process.platform === 'win32')
        await io.remove(safety).catch(() => undefined);
    } catch (error) {
      await c.store
        .update(record.id, c.identity, { state: publishing ? 'uncertain' : 'not-replaced' })
        .catch(() => undefined);
      if (!publishing && stageOwned) await io.remove(stage).catch(() => undefined);
      if (publishing)
        throw new Error(
          'Replacement outcome is uncertain. The backup and recovery record were retained. Reconnect and Inspect recovery; do not retry automatically.',
          { cause: error },
        );
      throw error;
    }
  }
  async recover(id: string, action: RecoveryAction['action']): Promise<boolean> {
    const c = this.c;
    const record = await c.store.load(id, c.identity);
    c.check();
    const io = this.io(record.direction);
    const target = destination(record);
    if (action === 'encrypt-backup') {
      if (
        (await this.approve({
          title: 'Secure recovery backup',
          detail:
            this.describe(target) +
            'Encrypt this legacy backup and the recovery metadata using this OS account? The plaintext original is removed only after the encrypted backup verifies and metadata is saved. Other legacy backup contents remain plaintext until secured individually. Interrupted cleanup can be retried with this button. This is not secure disk erasure. Keep the vault key with the backup folder; loss of this OS account/key may make recovery impossible.',
          buttons: ['Cancel', 'Encrypt and clean up legacy copy'],
        })) !== 1
      )
        return false;
      const path = localJoin(c.store.directory, `${record.id}.bak`);
      if (!record.encrypted) await privateFile(path);
      await c.store.encryptLegacy(record, c.localIO.read(path), () => c.check());
      return true;
    }
    if (action === 'delete-backup') {
      if (
        (await this.approve({
          title: 'Delete recovery backup',
          detail:
            this.describe(target) +
            'Permanently delete this local backup and recovery record? This removes rollback protection. Server and destination files are kept.',
          buttons: ['Cancel', 'Delete backup permanently'],
        })) !== 1
      )
        return false;
      await c.store.remove(id, c.identity);
      return true;
    }
    await c.store.verify(record, () => c.check());
    if (action === 'restore-copy') {
      const alternate = copyName(target, record.direction === 'upload');
      if (
        (await this.approve({
          title: 'Restore backup as a new file',
          detail:
            this.describe(alternate) +
            'Restore the verified backup to this new filename? The current destination is kept.',
          buttons: ['Cancel', 'Restore copy'],
        })) !== 1
      )
        return false;
      await c.store.verify(record, () => c.check());
      await io.write(
        alternate,
        c.store.contents(record, () => c.check()),
        record.previous,
      );
      c.check();
      if (!equalBytes(await io.snapshot(alternate), record.previous))
        throw new Error('Restored copy verification failed. Inspect the new file before use.');
      return true;
    }
    const current = await io.snapshot(target);
    if (action === 'inspect') {
      const state = unchangedFile(current, record.installed)
        ? 'completed'
        : equalFile(current, record.previous)
          ? record.state === 'restored'
            ? 'restored'
            : 'not-replaced'
          : 'uncertain';
      await c.store.update(id, c.identity, { state });
      return true;
    }
    if (record.state !== 'completed' || !unchangedFile(current, record.installed))
      throw new Error(
        'The destination changed or the outcome is unresolved. Inspect, then restore to a new filename instead.',
      );
    if (!(await io.supports(target)))
      throw new Error('Atomic replacement is unavailable. Restore to a new filename instead.');
    if (
      (await this.approve({
        title: 'Roll back replacement',
        detail:
          this.describe(target) +
          'Restore the verified older contents? SSHDrop will first back up the current version as a separate recovery record. Other writers must be stopped. File services may be affected.',
        buttons: ['Cancel', 'Back up current and roll back'],
      })) !== 1
    )
      return false;
    // Verify the backup again after the native dialog and before using it as a source.
    await c.store.verify(record, () => c.check());
    await this.replace(
      {
        direction: record.direction,
        local: record.local,
        remote: record.remote,
        previous: current!,
        parentId: id,
      },
      record,
    );
    await c.store.update(id, c.identity, { state: 'restored' });
    return true;
  }
}
