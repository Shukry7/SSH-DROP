import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Session } from '../../src/main/core/session';
import { RecoveryStore } from '../../src/main/core/recovery-store';
import type { SessionEvent, TransferUpdate } from '../../src/shared/contracts';
import { sshFixture } from '../fixtures/ssh-server';
import { testVault } from '../fixtures/backup-vault';

describe('queued transfers over real SSH/SFTP with recovery', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let events: SessionEvent[];
  let observe: ((update: TransferUpdate) => void) | undefined;
  let choice: number;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-queue-'));
    fixture = await sshFixture({ atomicReplace: true, slow: true });
    events = [];
    observe = undefined;
    choice = 2;
    session = new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        if (event.type === 'transfer') observe?.(event.transfer);
      },
      undefined,
      {
        store: new RecoveryStore(join(directory, 'backups'), testVault(join(directory, 'backups'))),
        confirm: async () => choice,
      },
    );
    await connect();
    await writeFile(join(directory, 'source.txt'), Buffer.alloc(131072, 81));
  });
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  const updates = () =>
    events.filter((event) => event.type === 'transfer').map((event) => event.transfer);
  const lastQueue = () => events.filter((event) => event.type === 'queue').at(-1)?.queue;
  const upload = (remote: string, local = join(directory, 'source.txt')) => ({
    direction: 'upload' as const,
    local,
    remote,
  });
  afterEach(async () => {
    session.disconnect();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it('runs mixed selections sequentially and retains encrypted per-file overwrite protection', async () => {
    const downloaded = join(directory, 'downloaded.txt');
    session.enqueue([
      upload('/first.txt'),
      upload('/hello.txt'),
      { direction: 'download', local: downloaded, remote: '/hello.txt' },
    ]);
    await expect
      .poll(() => updates().filter((update) => update.status === 'completed').length, {
        timeout: 10000,
      })
      .toBe(3);
    expect(await readFile(downloaded)).toEqual(await readFile(join(directory, 'source.txt')));
    expect(fixture.files.get('/first.txt')).toEqual(fixture.files.get('/hello.txt'));
    const records = await session.recovery();
    expect(records).toHaveLength(1);
    expect(records[0].encrypted).toBe(true);
    const started = updates().filter(
      (update) => update.status === 'running' && update.phase === 'preparing',
    );
    expect(new Set(started.map((update) => update.id)).size).toBe(3);
    await expect.poll(() => lastQueue()).toEqual({ pending: 0, active: false, paused: false });
  });
  it('cancels waiting files without touching their destinations', async () => {
    session.enqueue([upload('/first.txt'), upload('/never.txt')]);
    const queued = updates().filter((update) => update.status === 'queued');
    session.cancel(queued[1].id);
    await expect
      .poll(() =>
        updates().some((update) => update.id === queued[0].id && update.status === 'completed'),
      )
      .toBe(true);
    expect(fixture.files.has('/never.txt')).toBe(false);
    expect(
      updates().find((update) => update.id === queued[1].id && update.status === 'cancelled'),
    ).toBeDefined();
  });
  it('pauses remaining work after active cancellation and requires an explicit continuation', async () => {
    let cancelled = false;
    observe = (update) => {
      if (!cancelled && update.status === 'running' && update.transferred > 0) {
        cancelled = true;
        session.cancel(update.id);
      }
    };
    session.enqueue([upload('/cancelled.txt'), upload('/remaining.txt')]);
    await expect.poll(() => lastQueue()?.paused).toBe(true);
    expect(fixture.files.has('/cancelled.txt')).toBe(false);
    expect(fixture.files.has('/remaining.txt')).toBe(false);
    await session.resumeQueue(async () => false);
    expect(fixture.files.has('/remaining.txt')).toBe(false);
    observe = undefined;
    await session.resumeQueue(async () => true);
    await expect.poll(() => fixture.files.has('/remaining.txt')).toBe(true);
    expect(fixture.files.has('/cancelled.txt')).toBe(false);
    await expect.poll(() => lastQueue()?.active).toBe(false);
  });
  it('allows recovery inspection while paused and refuses a changed resume confirmation', async () => {
    await session.transfer('upload', join(directory, 'source.txt'), '/hello.txt');
    const [record] = await session.recovery();
    session.enqueue([upload('/bad.txt', join(directory, 'missing')), upload('/waiting.txt')]);
    await expect.poll(() => lastQueue()?.paused).toBe(true);
    await session.recover({ id: record.id, action: 'inspect' });
    expect((await session.recovery())[0].state).toBe('completed');
    const waiting = updates()
      .filter((update) => update.status === 'queued')
      .at(-1)!;
    await expect(
      session.resumeQueue(async () => {
        session.cancel(waiting.id);
        return true;
      }),
    ).rejects.toThrow('queue changed');
    expect(fixture.files.has('/waiting.txt')).toBe(false);
    expect(lastQueue()?.pending).toBe(0);
  });
  it('does not resume old work after disconnect/reconnect during native confirmation', async () => {
    session.enqueue([upload('/bad.txt', join(directory, 'missing')), upload('/must-not-run.txt')]);
    await expect.poll(() => lastQueue()?.paused).toBe(true);
    await expect(
      session.resumeQueue(async () => {
        session.disconnect();
        await connect();
        return true;
      }),
    ).rejects.toThrow('connection changed');
    expect(lastQueue()).toEqual({ pending: 0, active: false, paused: false });
    expect(fixture.files.has('/must-not-run.txt')).toBe(false);
    expect(
      events
        .filter((event) => event.type === 'transfer-warning')
        .every((event) => !event.message.includes('must-not-run')),
    ).toBe(true);
  });
  it('clears waiting work on a network cut and never replays it after reconnect', async () => {
    let dropped = false;
    observe = (update) => {
      if (!dropped && update.transferred > 0) {
        dropped = true;
        fixture.drop();
      }
    };
    session.enqueue([upload('/interrupted.txt'), upload('/old-waiting.txt')]);
    await expect
      .poll(() => events.some((event) => event.type === 'status' && !event.connected))
      .toBe(true);
    await expect.poll(() => lastQueue()?.pending).toBe(0);
    observe = undefined;
    await connect();
    expect(fixture.files.has('/old-waiting.txt')).toBe(false);
    expect(fixture.files.has('/interrupted.txt')).toBe(false);
  });
});
