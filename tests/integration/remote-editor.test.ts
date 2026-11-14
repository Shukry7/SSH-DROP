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
  it('keeps comparisons and save baselines separate and releases closed tabs', async () => {
    const first = await open();
    const second = await session.editText({ path: '/folder/nested.txt' });
    fixture.files.set('/hello.txt', Buffer.from('external first'));
    fixture.files.set('/folder/nested.txt', Buffer.from('external second'));
    const firstReview = await session.editText({ token: first.token, compare: true });
    const secondReview = await session.editText({ token: second.token, compare: true });
    await expect(
      session.editText({
        token: first.token,
        reviewToken: secondReview.reviewToken,
        keepDraft: true,
      }),
    ).rejects.toThrow('comparison is no longer current');
    const accepted = await session.editText({
      token: first.token,
      reviewToken: firstReview.reviewToken,
      keepDraft: true,
    });
    expect(accepted?.text).toBe('external first');
    await expect(session.editText({ token: accepted!.token, text: 'saved first' })).resolves.toBe(
      true,
    );
    expect(fixture.files.get('/folder/nested.txt')?.toString()).toBe('external second');
    await expect(
      session.editText({
        token: second.token,
        reviewToken: secondReview.reviewToken,
        keepDraft: false,
      }),
    ).resolves.toMatchObject({ text: 'external second', path: '/folder/nested.txt' });
    session.closeEditor(accepted!.token);
    await expect(session.editText({ token: accepted!.token, compare: true })).rejects.toThrow(
      'closed',
    );
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('saved first');
  });
  it('bounds simultaneous tabs and reuses capacity after close', async () => {
    const first = await open();
    for (let index = 1; index <= 8; index++)
      fixture.files.set(`/tab-${index}.txt`, Buffer.from('tab'));
    for (let index = 1; index < 8; index++) await session.editText({ path: `/tab-${index}.txt` });
    await expect(session.editText({ path: '/tab-8.txt' })).rejects.toThrow('Close an editor tab');
    session.closeEditor(first.token);
    await expect(session.editText({ path: '/tab-8.txt' })).resolves.toMatchObject({ text: 'tab' });
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
  it('compares without changing the save baseline and adopts reviewed changes only after confirmation', async () => {
    const document = await open();
    fixture.files.set('/hello.txt', Buffer.from('reviewed server update'));
    const comparison = await session.editText({ token: document.token, compare: true });
    expect(comparison).toMatchObject({
      text: 'reviewed server update',
      changed: true,
      lineEndings: 'LF',
    });
    await expect(session.editText({ token: document.token, text: 'draft' })).rejects.toThrow(
      'remote file changed',
    );
    choice = 0;
    expect(
      await session.editText({
        token: document.token,
        reviewToken: comparison.reviewToken,
        keepDraft: true,
      }),
    ).toBeNull();
    await expect(session.editText({ token: document.token, text: 'draft' })).rejects.toThrow(
      'remote file changed',
    );
    choice = 1;
    const next = await session.editText({
      token: document.token,
      reviewToken: comparison.reviewToken,
      keepDraft: true,
    });
    expect(next?.text).toBe('reviewed server update');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('reviewed server update');
    await expect(session.editText({ token: document.token, text: 'old token' })).rejects.toThrow(
      'old session',
    );
    await session.editText({ token: next!.token, text: 'manually merged draft' });
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('manually merged draft');
    const [record] = await session.recovery();
    expect(await backupText(testVault(join(directory, 'backups')), record.id)).toBe(
      'reviewed server update',
    );
  });
  it('rejects a stale comparison after another external change during approval', async () => {
    const document = await open();
    const first = await session.editText({ token: document.token, compare: true });
    const second = await session.editText({ token: document.token, compare: true });
    await expect(
      session.editText({ token: document.token, reviewToken: first.reviewToken, keepDraft: false }),
    ).rejects.toThrow('no longer current');
    duringApproval = () => fixture.files.set('/hello.txt', Buffer.from('changed during review'));
    await expect(
      session.editText({
        token: document.token,
        reviewToken: second.reviewToken,
        keepDraft: false,
      }),
    ).rejects.toThrow('server changed again');
    expect(fixture.files.get('/hello.txt')?.toString()).toBe('changed during review');
    await expect(session.editText({ token: document.token, text: 'draft' })).rejects.toThrow(
      'remote file changed',
    );
  });
  it('adopts the reviewed encoding for future saves and invalidates review tokens after reconnect', async () => {
    const document = await open();
    fixture.files.set('/hello.txt', Buffer.from('\ufeffreviewed\r\n'));
    const comparison = await session.editText({ token: document.token, compare: true });
    expect(comparison).toMatchObject({ lineEndings: 'CRLF', bom: true, text: 'reviewed\n' });
    const next = await session.editText({
      token: document.token,
      reviewToken: comparison.reviewToken,
      keepDraft: false,
    });
    await session.editText({ token: next!.token, text: 'edited\n' });
    expect(fixture.files.get('/hello.txt')).toEqual(Buffer.from('\ufeffedited\r\n'));
    const stale = await session.editText({ token: next!.token, compare: true });
    session.disconnect();
    await connect();
    await expect(
      session.editText({ token: next!.token, reviewToken: stale.reviewToken, keepDraft: true }),
    ).rejects.toThrow('old session');
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
