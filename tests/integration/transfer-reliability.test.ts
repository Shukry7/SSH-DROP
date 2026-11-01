import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/main/core/session';
import type { SessionEvent, TransferUpdate } from '../../src/shared/contracts';
import { sshFixture } from '../fixtures/ssh-server';

describe('transfer failure recovery over real SSH/SFTP', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let events: SessionEvent[];
  let observe: ((update: TransferUpdate) => void) | undefined;
  const timing = { request: 1000, inactivity: 1200, cleanup: 200 };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-transfer-recovery-'));
    events = [];
    observe = undefined;
  });
  afterEach(async () => {
    session?.disconnect();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function setup(options: Parameters<typeof sshFixture>[0] = {}) {
    fixture = await sshFixture(options);
    session = new Session(
      { verify: async () => true },
      (event) => {
        events.push(event);
        if (event.type === 'transfer') observe?.(event.transfer);
      },
      timing,
    );
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
    await writeFile(join(directory, 'source'), Buffer.alloc(196608, 42));
  }
  const updates = () =>
    events.filter((event) => event.type === 'transfer').map((event) => event.transfer);
  const temporaryRemote = () =>
    [...fixture.files.keys()].filter((path) => /\.sshdrop-.*\.part$/.test(path));
  const warnings = () => events.filter((event) => event.type === 'transfer-warning');
  it('keeps the final name absent while streaming/verifying and verifies bytes before publication', async () => {
    await setup({ slow: true });
    const phases = new Set<string>();
    observe = (update) => {
      if (update.status !== 'running') return;
      phases.add(update.phase!);
      expect(fixture.files.has('/final')).toBe(false);
    };
    await session.transfer('upload', join(directory, 'source'), '/final');
    expect(phases).toEqual(new Set(['preparing', 'transferring', 'verifying', 'finalizing']));
    expect(fixture.files.get('/final')).toEqual(await readFile(join(directory, 'source')));
    expect(temporaryRemote()).toHaveLength(0);
    observe = undefined;
    await session.transfer('download', join(directory, 'download'), '/final');
    expect(await readFile(join(directory, 'download'))).toEqual(fixture.files.get('/final'));
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(0);
  });
  it.each(['LSTAT', 'OPEN', 'FSTAT', 'CLOSE'])(
    'bounds stalled %s setup/finalization requests',
    async (event) => {
      await setup({ stall: [event] });
      await expect(
        session.transfer(
          event === 'FSTAT' ? 'download' : 'upload',
          join(directory, event === 'FSTAT' ? 'download' : 'source'),
          event === 'FSTAT' ? '/hello.txt' : '/final',
        ),
      ).rejects.toThrow('timed out');
      expect(fixture.files.has('/final')).toBe(false);
      await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
      if (event === 'OPEN' || event === 'CLOSE') expect(warnings().length).toBeGreaterThan(0);
    },
  );
  it.each(['READ', 'WRITE'])(
    'bounds a stalled %s even while SSH itself remains alive',
    async (event) => {
      await setup({ stall: [event] });
      await expect(
        session.transfer(
          event === 'READ' ? 'download' : 'upload',
          join(directory, event === 'READ' ? 'download' : 'source'),
          event === 'READ' ? '/large.bin' : '/final',
        ),
      ).rejects.toThrow(/progress|timed out/);
      expect(warnings().length).toBeGreaterThan(0);
      expect(fixture.files.has('/final')).toBe(false);
    },
  );
  it('allows a slow progressing transfer whose total duration exceeds the inactivity window', async () => {
    await setup({ slow: true });
    timing.inactivity = 500;
    await writeFile(join(directory, 'source'), Buffer.alloc(2 * 1024 * 1024, 42));
    try {
      await session.transfer('upload', join(directory, 'source'), '/slow');
      expect(updates().at(-1)?.status).toBe('completed');
    } finally {
      timing.inactivity = 1200;
    }
  });
  it('refuses corrupted remote readback and removes only its own temporary file', async () => {
    await setup({ corruptReadback: true });
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow(
      'SHA-256 verification failed',
    );
    expect(fixture.files.has('/final')).toBe(false);
    expect(temporaryRemote()).toHaveLength(0);
    expect(fixture.files.has('/hello.txt')).toBe(true);
  });
  it('preserves a destination created by another process during verification', async () => {
    await setup();
    observe = (update) => {
      if (update.phase === 'verifying') fixture.files.set('/final', Buffer.from('other writer'));
    };
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow(
      'never overwritten',
    );
    expect(fixture.files.get('/final')?.toString()).toBe('other writer');
    expect(temporaryRemote()).toHaveLength(0);
  });
  it('publishes local downloads exclusively when another process creates the final name at the last moment', async () => {
    await setup();
    const destination = join(directory, 'download');
    observe = (update) => {
      if (update.status === 'running' && update.phase === 'finalizing')
        writeFileSync(destination, 'other writer');
    };
    await expect(session.transfer('download', destination, '/hello.txt')).rejects.toThrow(
      'never overwritten',
    );
    expect(await readFile(destination, 'utf8')).toBe('other writer');
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(0);
  });
  it('reserves transfer slots before setup and supports cancellation before setup finishes', async () => {
    await setup({ stall: ['LSTAT'] });
    const first = session.transfer('upload', join(directory, 'source'), '/first');
    const second = session.transfer('upload', join(directory, 'source'), '/second');
    await expect(session.transfer('upload', join(directory, 'source'), '/third')).rejects.toThrow(
      'active transfer',
    );
    const ids = new Set(updates().map((update) => update.id));
    for (const id of ids) session.cancel(id);
    await Promise.all([first, second]);
    expect(fixture.files.has('/first')).toBe(false);
    expect(fixture.files.has('/second')).toBe(false);
    expect(temporaryRemote()).toHaveLength(0);
  });
  it('detects a changed local source and never publishes a mixed result', async () => {
    await setup({ slow: true });
    let changed: Promise<void> | undefined;
    observe = (update) => {
      if (!changed && update.transferred) changed = writeFile(join(directory, 'source'), 'changed');
    };
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow(
      /source|Source/,
    );
    await changed;
    expect(fixture.files.has('/final')).toBe(false);
    expect(temporaryRemote()).toHaveLength(0);
  });
  it('reports a lost publication acknowledgment as uncertain and never deletes the published file', async () => {
    await setup({ dropAfterChange: true });
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow(
      'uncertain',
    );
    expect(fixture.files.get('/final')).toEqual(await readFile(join(directory, 'source')));
    expect(warnings().length).toBeGreaterThan(0);
    expect(updates().some((update) => update.status === 'completed')).toBe(false);
  });
  it('treats cancellation after publication was sent as uncertain and preserves the final file', async () => {
    await setup({ stall: ['RENAME'] });
    const pending = session.transfer('upload', join(directory, 'source'), '/final');
    const rejected = expect(pending).rejects.toThrow('uncertain');
    await vi.waitFor(() => expect(fixture.files.has('/final')).toBe(true));
    session.cancel(updates()[0].id);
    await rejected;
    expect(fixture.files.get('/final')).toEqual(await readFile(join(directory, 'source')));
    expect(warnings().length).toBeGreaterThan(0);
  });
  it('detects remote source changes during a download and keeps the final local name absent', async () => {
    await setup({ slow: true });
    let changed = false;
    observe = (update) => {
      if (!changed && update.transferred) {
        changed = true;
        fixture.files.set('/large.bin', Buffer.from('changed'));
      }
    };
    await expect(
      session.transfer('download', join(directory, 'download'), '/large.bin'),
    ).rejects.toThrow('source');
    await expect(readFile(join(directory, 'download'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(0);
  });
  it('can cancel during verification without publishing the final name', async () => {
    await setup();
    observe = (update) => {
      if (update.phase === 'verifying' && update.status === 'running') session.cancel(update.id);
    };
    await session.transfer('upload', join(directory, 'source'), '/final');
    expect(updates().at(-1)?.status).toBe('cancelled');
    expect(temporaryRemote()).toHaveLength(0);
    expect(fixture.files.has('/final')).toBe(false);
  });
  it('does not hang on cleanup or claim cleanup succeeded when the server is unresponsive', async () => {
    await setup({ failWrites: true, stall: ['REMOVE'] });
    const started = Date.now();
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(warnings().length).toBeGreaterThan(0);
    expect(temporaryRemote()).toHaveLength(1);
    expect(fixture.files.has('/final')).toBe(false);
  });
  it.each(['upload', 'download'] as const)(
    'cancels an outstanding %s OPEN promptly and closes the connection with an inspection notice',
    async (direction) => {
      await setup({ stall: ['OPEN'] });
      const pending = session.transfer(
        direction,
        join(directory, direction === 'upload' ? 'source' : 'download'),
        direction === 'upload' ? '/final' : '/hello.txt',
      );
      await vi.waitFor(() => expect(fixture.openedFiles.length).toBeGreaterThan(0));
      const id = updates()[0].id;
      session.cancel(id);
      await pending;
      expect(updates().some((update) => update.status === 'completed')).toBe(false);
      expect(warnings().length).toBeGreaterThan(0);
      await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
      expect(fixture.files.has('/final')).toBe(false);
    },
  );
  it('disconnects mid-transfer, preserves a generic warning, and never replays on reconnect', async () => {
    await setup({ slow: true });
    let dropped = false;
    observe = (update) => {
      if (!dropped && update.transferred) {
        dropped = true;
        fixture.drop();
      }
    };
    await expect(session.transfer('upload', join(directory, 'source'), '/final')).rejects.toThrow();
    expect(warnings().length).toBeGreaterThan(0);
    expect(warnings().every((event) => !JSON.stringify(event).includes('/final'))).toBe(true);
    await session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
    expect(fixture.files.has('/final')).toBe(false);
  });
});
