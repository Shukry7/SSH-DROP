import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { folderLimits, folderName } from '../../src/main/core/folder-transfer';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import type { ReplacementApproval } from '../../src/main/core/replacement';
import type { SessionEvent } from '../../src/shared/contracts';
import { backupText, testVault } from '../fixtures/backup-vault';
import { sshFixture } from '../fixtures/ssh-server';

describe('bounded folder queue over real SSH/SFTP', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let events: SessionEvent[];
  let observe: ((event: SessionEvent) => void) | undefined;
  const original = { ...folderLimits };
  async function connect(confirm?: (approval: ReplacementApproval) => Promise<number>) {
    session?.disconnect();
    const root = join(directory, 'backups');
    session = new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        observe?.(event);
      },
      undefined,
      confirm && { store: new RecoveryStore(root, testVault(root)), confirm },
    );
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-folders-'));
    fixture = await sshFixture({ slow: true, atomicReplace: true });
    events = [];
    observe = undefined;
    await connect();
    await mkdir(join(directory, 'source', 'empty'), { recursive: true });
    await mkdir(join(directory, 'source', 'nested'));
    await writeFile(join(directory, 'source', 'nested', 'data.txt'), 'exact folder bytes');
  });
  afterEach(async () => {
    Object.assign(folderLimits, original);
    session.disconnect();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const updates = () =>
    events.filter((event) => event.type === 'transfer').map((event) => event.transfer);
  const finished = async (status: 'completed' | 'failed' | 'cancelled') => {
    await expect.poll(() => updates().at(-1)?.status, { timeout: 10000 }).toBe(status);
  };
  const upload = () =>
    session.enqueue([
      { direction: 'upload', local: join(directory, 'source'), remote: '/copy', folder: true },
    ]);

  it('copies nested files and empty folders both directions with aggregate progress', async () => {
    upload();
    await finished('completed');
    expect(fixture.files.get('/copy/nested/data.txt')?.toString()).toBe('exact folder bytes');
    expect(fixture.directories.has('/copy/empty')).toBe(true);
    session.enqueue([
      { direction: 'download', local: join(directory, 'received'), remote: '/copy', folder: true },
    ]);
    await expect
      .poll(() => updates().filter((item) => item.status === 'completed').length, {
        timeout: 10000,
      })
      .toBe(2);
    expect(await readFile(join(directory, 'received', 'nested', 'data.txt'), 'utf8')).toBe(
      'exact folder bytes',
    );
    expect((await lstat(join(directory, 'received', 'empty'))).isDirectory()).toBe(true);
    expect(updates().at(-1)).toMatchObject({ total: 18, transferred: 18 });
  });
  it('refuses existing remote folders without merging or touching contents', async () => {
    fixture.directories.add('/copy');
    fixture.files.set('/copy/existing', Buffer.from('keep'));
    upload();
    await finished('failed');
    expect(fixture.files.get('/copy/existing')?.toString()).toBe('keep');
    expect(fixture.files.has('/copy/nested/data.txt')).toBe(false);
  });

  it('requires merge approval before writing even an empty destination', async () => {
    fixture.directories.add('/copy');
    const approvals: ReplacementApproval[] = [];
    await connect(async (approval) => {
      approvals.push(approval);
      return 0;
    });
    upload();
    await finished('cancelled');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      title: 'Merge into existing folder?',
      buttons: ['Cancel', expect.any(String)],
    });
    expect(fixture.directories.has('/copy/empty')).toBe(false);
    expect(fixture.files.has('/copy/nested/data.txt')).toBe(false);
  });

  it('reviews each conflict and preserves unrelated files while tracking copied and skipped counts', async () => {
    fixture.directories.add('/copy');
    fixture.directories.add('/copy/nested');
    fixture.files.set('/copy/unrelated.txt', Buffer.from('untouched'));
    const names = ['backup.txt', 'both.txt', 'replace.txt', 'skip.txt'];
    for (const name of names) {
      await writeFile(join(directory, 'source', name), `new ${name}`);
      fixture.files.set(`/copy/${name}`, Buffer.from(`old ${name}`));
    }
    const approvals: ReplacementApproval[] = [];
    await connect(async (approval) => {
      approvals.push(approval);
      if (approval.title !== 'File already exists') return 1;
      expect(approval.buttons).toEqual([
        'Skip file',
        'Keep both',
        'Back up and replace',
        'Replace without backup',
      ]);
      return approval.detail.includes('/copy/backup.txt')
        ? 2
        : approval.detail.includes('/copy/both.txt')
          ? 1
          : approval.detail.includes('/copy/replace.txt')
            ? 3
            : 0;
    });
    upload();
    await finished('completed');
    expect(updates().at(-1)).toMatchObject({ folderFiles: { copied: 4, skipped: 1, total: 5 } });
    expect(approvals.filter((approval) => approval.title === 'File already exists')).toHaveLength(
      4,
    );
    expect(approvals.some((approval) => approval.title === 'Replace without recovery backup')).toBe(
      true,
    );
    for (const [path, data] of Object.entries({
      'backup.txt': 'new backup.txt',
      'both.txt': 'old both.txt',
      'replace.txt': 'new replace.txt',
      'skip.txt': 'old skip.txt',
      'unrelated.txt': 'untouched',
      'nested/data.txt': 'exact folder bytes',
    }))
      expect(fixture.files.get(`/copy/${path}`)?.toString()).toBe(data);
    expect(
      [...fixture.files]
        .find(([path]) => /^\/copy\/both \(copy .*\)\.txt$/.test(path))?.[1]
        .toString(),
    ).toBe('new both.txt');
    const records = await session.recovery();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      path: '/copy/backup.txt',
      encrypted: true,
      state: 'completed',
    });
    expect(await backupText(testVault(join(directory, 'backups')), records[0].id)).toBe(
      'old backup.txt',
    );
  });

  it('merges downloads with the same per-file decision flow', async () => {
    const local = join(directory, 'source');
    await writeFile(join(local, 'nested.txt'), 'preserve me');
    await connect(async (approval) => (approval.title === 'File already exists' ? 0 : 1));
    session.enqueue([{ direction: 'download', local, remote: '/folder', folder: true }]);
    await finished('completed');
    expect(await readFile(join(local, 'nested.txt'), 'utf8')).toBe('preserve me');
    expect(updates().at(-1)).toMatchObject({ folderFiles: { copied: 0, skipped: 1, total: 1 } });
  });

  it.each(['case alias', 'file versus folder', 'symbolic link'])(
    'refuses a destination %s before writing',
    async (kind) => {
      fixture.directories.add('/copy');
      if (kind === 'case alias') fixture.directories.add('/copy/NESTED');
      if (kind === 'file versus folder') fixture.files.set('/copy/nested', Buffer.from('keep'));
      if (kind === 'symbolic link') fixture.symlinks.add('/copy/nested');
      const approvals: ReplacementApproval[] = [];
      await connect(async (approval) => {
        approvals.push(approval);
        return 1;
      });
      upload();
      await finished('failed');
      expect(approvals).toHaveLength(0);
      expect(fixture.directories.has('/copy/empty')).toBe(false);
    },
  );

  it('stops a partial merge when the destination changes during a conflict dialog', async () => {
    fixture.directories.add('/copy');
    fixture.directories.add('/copy/nested');
    fixture.files.set('/copy/nested/data.txt', Buffer.from('original'));
    await writeFile(join(directory, 'source', 'first.txt'), 'already copied');
    await connect(async (approval) => {
      if (approval.title === 'File already exists') {
        fixture.files.set('/copy/nested/data.txt', Buffer.from('external edit'));
        return 2;
      }
      return 1;
    });
    upload();
    await finished('failed');
    expect(fixture.files.get('/copy/first.txt')?.toString()).toBe('already copied');
    expect(fixture.files.get('/copy/nested/data.txt')?.toString()).toBe('external edit');
    expect(updates().at(-1)).toMatchObject({ folderFiles: { copied: 1, skipped: 0, total: 2 } });
    expect(await session.recovery()).toHaveLength(0);
  });
  it('accepts an initially selected parent alias while retaining strict descendant link checks', async () => {
    const alias = join(directory, 'native-parent-alias');
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    session.enqueue([
      { direction: 'upload', local: join(alias, 'source'), remote: '/copy', folder: true },
    ]);
    await finished('completed');
    session.enqueue([
      { direction: 'download', local: join(alias, 'received'), remote: '/copy', folder: true },
    ]);
    await expect.poll(() => updates().filter((item) => item.status === 'completed').length).toBe(2);
    expect(await readFile(join(directory, 'received', 'nested', 'data.txt'), 'utf8')).toBe(
      'exact folder bytes',
    );
  });
  it('refuses existing local folders before writing', async () => {
    session.enqueue([
      { direction: 'download', local: join(directory, 'source'), remote: '/folder', folder: true },
    ]);
    await finished('failed');
    await expect(readFile(join(directory, 'source', 'nested.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('refuses remote symbolic links before creating a destination', async () => {
    fixture.symlinks.add('/folder/link');
    session.enqueue([
      {
        direction: 'download',
        local: join(directory, 'received'),
        remote: '/folder',
        folder: true,
      },
    ]);
    await finished('failed');
    await expect(lstat(join(directory, 'received'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses local hard links before creating a destination', async () => {
    await link(join(directory, 'source', 'nested', 'data.txt'), join(directory, 'source', 'alias'));
    upload();
    await finished('failed');
    expect(fixture.directories.has('/copy')).toBe(false);
  });
  it('refuses local directory links or junctions before any write', async () => {
    await symlink(
      join(directory, 'source', 'nested'),
      join(directory, 'source', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    upload();
    await finished('failed');
    expect(fixture.directories.has('/copy')).toBe(false);
  });
  it('refuses a destination appearing after preflight without merging', async () => {
    observe = (event) => {
      if (event.type === 'transfer' && event.transfer.total > 0) {
        fixture.directories.add('/copy');
        fixture.files.set('/copy/protected', Buffer.from('unchanged'));
        observe = undefined;
      }
    };
    upload();
    await finished('failed');
    expect(fixture.files.get('/copy/protected')?.toString()).toBe('unchanged');
    expect(fixture.files.has('/copy/nested/data.txt')).toBe(false);
  });
  it('detects a source changed after scanning and preserves the partial root', async () => {
    observe = (event) => {
      if (event.type === 'transfer' && event.transfer.total > 0) {
        fixture.files.set('/folder/nested.txt', Buffer.from('changed size after scan'));
        observe = undefined;
      }
    };
    session.enqueue([
      {
        direction: 'download',
        local: join(directory, 'received'),
        remote: '/folder',
        folder: true,
      },
    ]);
    await finished('failed');
    expect((await lstat(join(directory, 'received'))).isDirectory()).toBe(true);
    await expect(lstat(join(directory, 'received', 'nested.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(events.some((event) => event.type === 'transfer-warning')).toBe(true);
  });
  it('interrupts a stalled scan on disconnect without creating any root', async () => {
    const release = fixture.holdNextDirectoryResponse();
    session.enqueue([
      {
        direction: 'download',
        local: join(directory, 'received'),
        remote: '/folder',
        folder: true,
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    session.disconnect();
    release();
    await expect.poll(() => updates().at(-1)?.status === 'completed').toBe(false);
    await expect(lstat(join(directory, 'received'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects ambiguous case-folded remote names before writing', async () => {
    fixture.files.set('/folder/NESTED.txt', Buffer.from('other'));
    session.enqueue([
      {
        direction: 'download',
        local: join(directory, 'received'),
        remote: '/folder',
        folder: true,
      },
    ]);
    await finished('failed');
    await expect(lstat(join(directory, 'received'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['entries', 'depth', 'bytes', 'scan'] as const)(
    'bounds %s before any destination is created',
    async (limit) => {
      folderLimits[limit] = limit === 'scan' ? -1 : 1;
      upload();
      await finished('failed');
      expect(fixture.directories.has('/copy')).toBe(false);
    },
  );
  it('cancels active folder copies and never starts later files', async () => {
    await writeFile(join(directory, 'source', 'nested', 'data.txt'), Buffer.alloc(1024 * 1024));
    upload();
    await expect.poll(() => updates().some((item) => item.transferred > 0)).toBe(true);
    session.cancel(updates()[0].id);
    await finished('cancelled');
    expect(fixture.files.has('/copy/nested/data.txt')).toBe(false);
    expect(events.some((event) => event.type === 'transfer-warning')).toBe(true);
  });
  it('discards remaining folder work on connection loss without replay', async () => {
    await writeFile(join(directory, 'source', 'nested', 'data.txt'), Buffer.alloc(1024 * 1024));
    upload();
    await expect.poll(() => updates().some((item) => item.transferred > 0)).toBe(true);
    fixture.drop();
    await expect
      .poll(() => events.some((event) => event.type === 'status' && !event.connected))
      .toBe(true);
    expect(fixture.files.has('/copy/nested/data.txt')).toBe(false);
  });
  it('rejects a file selected as a folder without creating a destination', async () => {
    session.enqueue([
      {
        direction: 'download',
        local: join(directory, 'received'),
        remote: '/hello.txt',
        folder: true,
      },
    ]);
    await finished('failed');
    await expect(lstat(join(directory, 'received'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['../escape', 'CON.txt', 'trailing.', 'bad:name', '\u202ehidden', 'NUL', 'back\\slash'])(
    'rejects unsafe folder component %s',
    (name) => {
      expect(() => folderName(name)).toThrow();
    },
  );
});
