import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { folderLimits, folderName } from '../../src/main/core/folder-transfer';
import type { SessionEvent } from '../../src/shared/contracts';
import { sshFixture } from '../fixtures/ssh-server';

describe('bounded folder queue over real SSH/SFTP', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let events: SessionEvent[];
  let observe: ((event: SessionEvent) => void) | undefined;
  const original = { ...folderLimits };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-folders-'));
    fixture = await sshFixture({ slow: true });
    events = [];
    observe = undefined;
    session = new Session({ verify: async () => true }, (event) => {
      events.push(event);
      observe?.(event);
    });
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
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
