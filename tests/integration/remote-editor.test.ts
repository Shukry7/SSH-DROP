import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import { backupText, testVault } from '../fixtures/backup-vault';
import { sshFixture } from '../fixtures/ssh-server';
import type { ReplacementApproval } from '../../src/main/core/replacement';

describe('bounded remote UTF-8 editor', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let choice: number;
  let duringApproval: (() => void) | undefined;
  let approvals: ReplacementApproval[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-editor-'));
    fixture = await sshFixture({ atomicReplace: true });
    choice = 1;
    approvals = [];
    duringApproval = undefined;
    session = new Session({ verify: async () => true }, () => {}, undefined, {
      store: new RecoveryStore(join(directory, 'backups'), testVault(join(directory, 'backups'))),
      confirm: async (approval) => {
        approvals.push(approval);
        duringApproval?.();
        return approval.title === 'Save without recovery backup' ? 1 : choice;
      },
    });
    await connect();
  });
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  const open = async () => {
    const document = await session.editText({ path: '/hello.txt' });
    if (typeof document === 'boolean') throw new Error('Editor did not return a document.');
    return document;
  };
  afterEach(async () => {
    session.disconnect();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it('backs up the previous bytes, verifies the edited file, and supports a later save', async () => {
    const original = fixture.files.get('/hello.txt')!;
    const document = await open();
    expect(document.text).toBe(original.toString());
    expect(await session.editText({ token: document.token, text: 'edited 日本語\n' })).toBe(true);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('edited 日本語\n');
    const records = await session.recovery();
    expect(records).toHaveLength(1);
    expect(await backupText(testVault(join(directory, 'backups')), records[0].id)).toBe(
      original.toString(),
    );
    choice = 0;
    expect(await session.editText({ token: document.token, text: 'cancelled' })).toBe(false);
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('edited 日本語\n');
    choice = 2;
    expect(await session.editText({ token: document.token, text: 'second edit' })).toBe(true);
    expect(approvals.at(-1)?.title).toBe('Save without recovery backup');
    expect(await session.recovery()).toHaveLength(1);
  });
  it('restores the pre-edit contents through the existing guarded rollback flow', async () => {
    const original = fixture.files.get('/hello.txt')!;
    const document = await open();
    await session.editText({ token: document.token, text: 'edited' });
    const [record] = await session.recovery();
    await session.recover({ id: record.id, action: 'rollback' });
    expect(fixture.files.get('/hello.txt')).toEqual(original);
  });
  it('preserves BOM and CRLF and supports an unchanged draft round trip', async () => {
    const original = Buffer.from('\ufefffirst\r\nsecond\r\n');
    fixture.files.set('/hello.txt', original);
    const document = await open();
    expect(document.text).toBe('first\nsecond\n');
    await session.editText({ token: document.token, text: document.text });
    expect(fixture.files.get('/hello.txt')).toEqual(original);
    await session.editText({ token: document.token, text: 'edited\nsecond\n' });
    expect(fixture.files.get('/hello.txt')).toEqual(Buffer.from('\ufeffedited\r\nsecond\r\n'));
  });
  it.each([
    Buffer.alloc(1024 * 1024 + 1, 65),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('binary\0data'),
    Buffer.from('mixed\r\nlines\n'),
  ])('refuses unsupported editor files', async (bytes) => {
    fixture.files.set('/hello.txt', bytes);
    await expect(open()).rejects.toThrow();
    expect(approvals).toHaveLength(0);
    expect(fixture.files.get('/hello.txt')).toEqual(bytes);
  });
  it('detects an external edit before approval and another edit during approval', async () => {
    let document = await open();
    fixture.files.set('/hello.txt', Buffer.from('external first'));
    await expect(session.editText({ token: document.token, text: 'draft' })).rejects.toThrow(
      'remote file changed',
    );
    expect(approvals).toHaveLength(0);
    document = await open();
    duringApproval = () => fixture.files.set('/hello.txt', Buffer.from('external second'));
    await expect(session.editText({ token: document.token, text: 'draft' })).rejects.toThrow(
      'remote file changed',
    );
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('external second');
    expect(await session.recovery()).toHaveLength(0);
  });
  it('rejects old tokens after reconnect and refuses symbolic links', async () => {
    const document = await open();
    session.disconnect();
    await connect();
    await expect(session.editText({ token: document.token, text: 'stale draft' })).rejects.toThrow(
      'old session',
    );
    fixture.symlinks.add('/link');
    await expect(session.editText({ path: '/link' })).rejects.toThrow('regular files');
    expect(fixture.files.get('/hello.txt')?.toString()).toContain('Hello');
  });
  it('retains the recovery backup when publication loses its acknowledgment', async () => {
    session.disconnect();
    await fixture.close();
    fixture = await sshFixture({ atomicReplace: true, dropAfterReplace: true });
    await connect();
    const document = await open();
    await expect(
      session.editText({ token: document.token, text: 'published before connection loss' }),
    ).rejects.toThrow('uncertain');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('published before connection loss');
    await connect();
    const [record] = await session.recovery();
    expect(record.state).toBe('uncertain');
    expect(await backupText(testVault(join(directory, 'backups')), record.id)).toContain('Hello');
    await expect(
      session.editText({ token: document.token, text: 'must not replay' }),
    ).rejects.toThrow('old session');
  });
  it('refuses a save when the server cannot replace atomically', async () => {
    session.disconnect();
    await fixture.close();
    fixture = await sshFixture();
    await connect();
    const document = await open();
    await expect(session.editText({ token: document.token, text: 'unsaved' })).rejects.toThrow(
      'atomic replacement',
    );
    expect(approvals).toHaveLength(0);
    expect(fixture.files.get('/hello.txt')?.toString()).toContain('Hello');
  });
  it('saves at the byte limit and refuses an expanded multibyte draft above it', async () => {
    const document = await open();
    const bytes = 'a'.repeat(1024 * 1024);
    choice = 2;
    await session.editText({ token: document.token, text: bytes });
    expect(fixture.files.get('/hello.txt')).toEqual(Buffer.from(bytes));
    await expect(
      session.editText({ token: document.token, text: '界'.repeat(400000) }),
    ).rejects.toThrow('1 MiB');
    expect(fixture.files.get('/hello.txt')).toEqual(Buffer.from(bytes));
  }, 60000);
});
