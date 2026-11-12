import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utils } from 'ssh2';
import { Session } from '../../src/main/core/session';
import { HostTrust } from '../../src/main/core/host-trust';
import type { SessionEvent, TransferUpdate } from '../../src/shared/contracts';
import { fixtureUserKey, sshFixture } from '../fixtures/ssh-server';

describe('SSH and SFTP over a real loopback connection', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  let events: SessionEvent[];
  let observe: ((update: TransferUpdate) => void) | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sshdrop-session-'));
    fixture = await sshFixture();
    events = [];
    observe = undefined;
    session = new Session(
      new HostTrust(join(directory, 'trust.json'), async () => true),
      (event) => {
        events.push(event);
        if (event.type === 'transfer') observe?.(event.transfer);
      },
    );
  });
  afterEach(async () => {
    session.disconnect();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const credentials = () => ({
    host: '127.0.0.1',
    port: fixture.port,
    username: 'tester',
    password: 'test-password',
  });
  const connect = () => session.connect(credentials());
  const transfers = () =>
    events.filter((event) => event.type === 'transfer').map((event) => event.transfer);
  async function replaceFixture(options: Parameters<typeof sshFixture>[0]) {
    await fixture.close();
    fixture = await sshFixture(options);
  }

  it('connects, allocates a PTY, echoes input, and resizes the remote terminal', async () => {
    await connect();
    session.input('hello\r');
    session.resize(120, 40);
    await vi.waitFor(() => {
      expect(
        events.some((event) => event.type === 'terminal' && event.data.includes('echo:hello')),
      ).toBe(true);
      expect(fixture.getSize()).toEqual({ cols: 120, rows: 40 });
    });
    expect(events).toContainEqual({
      type: 'status',
      connected: true,
      terminal: true,
      sftp: true,
      message: 'Connected. Terminal and SFTP ready.',
    });
  });
  it('authenticates using a real private key', async () => {
    await session.connect({ ...credentials(), password: undefined, privateKey: fixtureUserKey });
    expect((await session.list('/')).entries.some((entry) => entry.name === 'hello.txt')).toBe(
      true,
    );
  });
  it('rejects authentication failure and permits a clean retry', async () => {
    await expect(session.connect({ ...credentials(), password: 'wrong' })).rejects.toThrow();
    await connect();
    expect((await session.list('/')).path).toBe('/');
  });
  it('does not allow replacing an active connection', async () => {
    await connect();
    await expect(connect()).rejects.toThrow('Disconnect');
    expect((await session.list('/')).path).toBe('/');
  });
  it('rejects an unapproved server identity before opening a session', async () => {
    session = new Session({ verify: async () => false }, (event) => events.push(event));
    await expect(connect()).rejects.toThrow();
    expect(events.some((event) => event.type === 'status' && event.connected)).toBe(false);
  });
  it('preserves a meaningful host-trust failure', async () => {
    session = new Session(
      {
        verify: async () => {
          throw new Error('Server host key changed.');
        },
      },
      (event) => events.push(event),
    );
    await expect(connect()).rejects.toThrow('host key changed');
  });
  it('lists directories first and preserves unusual filenames', async () => {
    await connect();
    const listing = await session.list('/folder/../');
    expect(listing.path).toBe('/');
    expect(listing.entries[0]).toMatchObject({ name: 'folder', kind: 'directory' });
    expect(listing.entries).toContainEqual(
      expect.objectContaining({ name: "space 'quote' 日本語.txt", kind: 'file' }),
    );
    expect((await session.list('/folder')).entries[0].name).toBe('nested.txt');
  });
  it('creates, renames, and deletes through SFTP without shell execution', async () => {
    await connect();
    const confirm = vi.fn(async () => true);
    const name = "new 'quoted' 日本語";
    await session.changeFile({ action: 'create-folder', directory: '/', name }, confirm);
    expect((await session.list('/')).entries.some((entry) => entry.name === name)).toBe(true);
    await session.changeFile(
      { action: 'rename', directory: '/', name, newName: 'renamed', kind: 'directory' },
      confirm,
    );
    await session.changeFile(
      { action: 'delete', directory: '/', name: 'renamed', kind: 'directory' },
      confirm,
    );
    expect(fixture.directories.has('/renamed')).toBe(false);
    await session.changeFile(
      { action: 'rename', directory: '/', name: 'hello.txt', newName: 'renamed.txt', kind: 'file' },
      confirm,
    );
    expect(fixture.files.get('/renamed.txt')?.toString()).toContain('Hello');
    await session.changeFile(
      { action: 'delete', directory: '/', name: 'renamed.txt', kind: 'file' },
      confirm,
    );
    expect(fixture.files.has('/renamed.txt')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(5);
  });
  it('refuses nonempty folders, symlinks, and existing rename destinations', async () => {
    await connect();
    const confirm = async () => true;
    await expect(
      session.changeFile(
        { action: 'delete', directory: '/', name: 'folder', kind: 'directory' },
        confirm,
      ),
    ).rejects.toThrow('server refused');
    expect(fixture.files.has('/folder/nested.txt')).toBe(true);
    fixture.symlinks.add('/link');
    await expect(
      session.changeFile({ action: 'delete', directory: '/', name: 'link', kind: 'file' }, confirm),
    ).rejects.toThrow('item type changed');
    await expect(
      session.changeFile(
        { action: 'rename', directory: '/', name: 'hello.txt', newName: 'large.bin', kind: 'file' },
        confirm,
      ),
    ).rejects.toThrow('already exists');
    expect(fixture.files.get('/large.bin')?.length).toBe(2 * 1024 * 1024);
  });
  it('creates only an approved empty file and requests owner-only permissions without truncation', async () => {
    const beforeCreate = vi.fn();
    await replaceFixture({ beforeCreate });
    await connect();
    const input = {
      action: 'create-file',
      directory: '/folder',
      name: "new 'quoted' 日本語.txt",
    } as const;
    expect(await session.changeFile(input, async () => false)).toBe(false);
    expect(beforeCreate).not.toHaveBeenCalled();
    const confirm = vi.fn(async () => true);
    expect(await session.changeFile(input, confirm)).toBe(true);
    const { WRITE, CREAT, EXCL } = utils.sftp.OPEN_MODE;
    expect(beforeCreate).toHaveBeenCalledExactlyOnceWith(
      `/folder/${input.name}`,
      WRITE | CREAT | EXCL,
      0o600,
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ button: 'Create file', detail: expect.stringContaining('0600') }),
    );
    expect(fixture.files.get(`/folder/${input.name}`)).toEqual(Buffer.alloc(0));
    expect((await session.list('/folder')).entries).toContainEqual(
      expect.objectContaining({ name: input.name, kind: 'file', size: 0 }),
    );
    await expect(session.changeFile(input, confirm)).rejects.toThrow('already exists');
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('preserves a file created by another writer after the final preflight', async () => {
    await replaceFixture({ beforeCreate: (path) => fixture.files.set(path, Buffer.from('keep')) });
    await connect();
    await expect(
      session.changeFile(
        { action: 'create-file', directory: '/', name: 'race.txt' },
        async () => true,
      ),
    ).rejects.toThrow('server refused');
    expect(fixture.files.get('/race.txt')?.toString()).toBe('keep');
    expect((await session.list('/')).entries.some((entry) => entry.name === 'race.txt')).toBe(true);
  });
  it('reports uncertain creation and invalidates SFTP if the created handle cannot be closed', async () => {
    await replaceFixture({ failClose: true });
    await connect();
    await expect(
      session.changeFile(
        { action: 'create-file', directory: '/', name: 'closed.txt' },
        async () => true,
      ),
    ).rejects.toThrow('result is uncertain');
    expect(fixture.files.get('/closed.txt')).toEqual(Buffer.alloc(0));
    expect(fixture.openedFiles.filter((path) => path === '/closed.txt')).toHaveLength(1);
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
  });
  it('rejects permission failures while preserving the connection', async () => {
    await replaceFixture({ denyChanges: true });
    await connect();
    await expect(
      session.changeFile(
        { action: 'delete', directory: '/', name: 'hello.txt', kind: 'file' },
        async () => true,
      ),
    ).rejects.toThrow('denied permission');
    expect((await session.list('/')).entries.length).toBeGreaterThan(0);
  });
  it('reports an applied change with a lost acknowledgment as uncertain without retrying', async () => {
    await replaceFixture({ dropAfterChange: true });
    await connect();
    await expect(
      session.changeFile(
        { action: 'create-folder', directory: '/', name: 'possibly-created' },
        async () => true,
      ),
    ).rejects.toThrow('result is uncertain');
    expect(fixture.directories.has('/possibly-created')).toBe(true);
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
  });
  it('cancels without mutation and blocks overlapping transfers and changes while awaiting confirmation', async () => {
    await connect();
    let release!: (value: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const confirm = vi.fn(() => confirmation);
    const change = session.changeFile(
      { action: 'delete', directory: '/', name: 'hello.txt', kind: 'file' },
      confirm,
    );
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    await expect(
      session.changeFile({ action: 'create-folder', directory: '/', name: 'x' }, async () => true),
    ).rejects.toThrow('active file operation');
    await expect(
      session.transfer('download', join(directory, 'out.txt'), '/hello.txt'),
    ).rejects.toThrow('active file operation');
    release(false);
    expect(await change).toBe(false);
    expect(fixture.files.has('/hello.txt')).toBe(true);
  });
  it('never replays confirmed changes after a disconnect and reconnect', async () => {
    await connect();
    let release!: (value: boolean) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const change = session.changeFile(
      { action: 'delete', directory: '/', name: 'hello.txt', kind: 'file' },
      confirm,
    );
    const rejected = expect(change).rejects.toThrow('No file change was sent');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    session.disconnect();
    await connect();
    release(true);
    await rejected;
    expect(fixture.files.has('/hello.txt')).toBe(true);
  });
  it('reports missing and inaccessible directories', async () => {
    await connect();
    await expect(session.list('/missing')).rejects.toThrow();
    await expect(session.list('/blocked')).rejects.toThrow();
  });
  it('keeps the terminal available when the server has no SFTP subsystem', async () => {
    await replaceFixture({ noSftp: true });
    await connect();
    expect(events).toContainEqual({
      type: 'status',
      connected: true,
      terminal: true,
      sftp: false,
      message: 'Terminal connected. SFTP is unavailable on this server.',
    });
    session.input('still works');
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
  });
  it('times out a stalled terminal request and permits a fresh attempt', async () => {
    const stall = ['SHELL'];
    await replaceFixture({ stall });
    session = new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      undefined,
      2000,
    );
    await expect(connect()).rejects.toThrow('setup timed out');
    expect(fixture.shellRequests()).toBe(1);
    expect(events.some((event) => event.type === 'status' && event.connected)).toBe(false);
    stall.length = 0;
    await expect(connect()).resolves.toEqual({ sftp: true });
    expect((await session.list('/')).path).toBe('/');
  });

  it('bounds a stalled SFTP setup and leaves an available terminal', async () => {
    await replaceFixture({ stall: ['SFTP'] });
    session = new Session(
      { verify: async () => true },
      (event) => events.push(event),
      undefined,
      undefined,
      2000,
    );
    await expect(connect()).resolves.toEqual({ sftp: false });
    session.input('still works');
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'status', terminal: true, sftp: false }),
    );
  });
  it('streams an upload and download without changing the bytes', async () => {
    await connect();
    const source = join(directory, 'source.bin');
    const contents = Buffer.alloc(250000, 127);
    await writeFile(source, contents);
    await session.transfer('upload', source, "/new 'file' 日本語.bin");
    expect(fixture.files.get("/new 'file' 日本語.bin")).toEqual(contents);
    const downloaded = join(directory, 'download.bin');
    await session.transfer('download', downloaded, "/new 'file' 日本語.bin");
    expect(await readFile(downloaded)).toEqual(contents);
    expect(transfers().filter((update) => update.status === 'completed')).toHaveLength(2);
    expect(transfers().at(-1)).toMatchObject({
      transferred: contents.length,
      total: contents.length,
    });
  });
  it('uploads to a selected nested directory and lists the new file there', async () => {
    await connect();
    const local = join(directory, 'nested-upload.txt');
    await writeFile(local, 'nested directory bytes');
    await session.transfer('upload', local, '/folder/nested-upload.txt');
    expect(fixture.files.get('/folder/nested-upload.txt')?.toString()).toBe(
      'nested directory bytes',
    );
    expect(fixture.files.has('/nested-upload.txt')).toBe(false);
    expect((await session.list('/folder')).entries).toContainEqual(
      expect.objectContaining({ name: 'nested-upload.txt', kind: 'file' }),
    );
  });

  it('transfers empty files', async () => {
    await connect();
    const source = join(directory, 'empty');
    await writeFile(source, '');
    await session.transfer('upload', source, '/empty');
    await session.transfer('download', join(directory, 'empty-copy'), '/empty');
    expect((await readFile(join(directory, 'empty-copy'))).length).toBe(0);
    expect(transfers().at(-1)?.status).toBe('completed');
  });
  it('refuses to overwrite an existing remote file and leaves its bytes intact', async () => {
    await connect();
    const previous = fixture.files.get('/hello.txt');
    const local = join(directory, 'local');
    await writeFile(local, 'replacement');
    await expect(session.transfer('upload', local, '/hello.txt')).rejects.toThrow(
      'never overwritten',
    );
    expect(fixture.files.get('/hello.txt')).toEqual(previous);
    expect(transfers().at(-1)?.status).toBe('failed');
  });
  it('refuses to overwrite an existing local file', async () => {
    await connect();
    const local = join(directory, 'keep.txt');
    await writeFile(local, 'keep me');
    await expect(session.transfer('download', local, '/hello.txt')).rejects.toThrow();
    expect(await readFile(local, 'utf8')).toBe('keep me');
  });
  it('rejects folders, missing sources, and remote permission failures', async () => {
    await connect();
    await expect(session.transfer('upload', directory, '/folder-copy')).rejects.toThrow(
      'individual file',
    );
    await expect(session.transfer('upload', join(directory, 'absent'), '/new')).rejects.toThrow();
    await expect(session.transfer('download', join(directory, 'new'), '/folder')).rejects.toThrow(
      'individual files',
    );
    await expect(
      session.transfer('download', join(directory, 'new'), '/missing'),
    ).rejects.toThrow();
    await writeFile(join(directory, 'local'), 'bytes');
    await expect(
      session.transfer('upload', join(directory, 'local'), '/blocked/file'),
    ).rejects.toThrow();
  });
  it('removes its own partial upload after a server write failure', async () => {
    await replaceFixture({ failWrites: true });
    await connect();
    const local = join(directory, 'local');
    await writeFile(local, 'bytes');
    await expect(session.transfer('upload', local, '/partial')).rejects.toThrow();
    expect(fixture.files.has('/partial')).toBe(false);
    expect(transfers().at(-1)?.status).toBe('failed');
  });
  it('does not mark a transfer completed if the server rejects closing the file', async () => {
    await replaceFixture({ failClose: true });
    await connect();
    const local = join(directory, 'local');
    await writeFile(local, 'bytes');
    await expect(session.transfer('upload', local, '/bad-close')).rejects.toThrow();
    expect(transfers().at(-1)?.status).toBe('failed');
    expect(fixture.files.has('/bad-close')).toBe(false);
  });
  it.each(['upload', 'download'] as const)(
    'cancels %s immediately without leaving a destination',
    async (direction) => {
      await connect();
      const local = join(directory, direction === 'upload' ? 'source' : 'target');
      if (direction === 'upload') await writeFile(local, Buffer.alloc(100000));
      observe = (update) => {
        if (update.status === 'running') session.cancel(update.id);
      };
      await session.transfer(
        direction,
        local,
        direction === 'upload' ? '/cancelled' : '/large.bin',
      );
      expect(transfers().at(-1)?.status).toBe('cancelled');
      if (direction === 'upload') expect(fixture.files.has('/cancelled')).toBe(false);
      else await expect(readFile(local)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it.each(['upload', 'download'] as const)(
    'cancels an in-progress %s and cleans up its partial file',
    async (direction) => {
      await replaceFixture({ slow: true });
      await connect();
      const local = join(directory, direction === 'upload' ? 'source' : 'target');
      if (direction === 'upload') await writeFile(local, Buffer.alloc(2 * 1024 * 1024));
      let cancelled = false;
      observe = (update) => {
        if (!cancelled && update.status === 'running' && update.transferred > 0) {
          cancelled = true;
          session.cancel(update.id);
        }
      };
      await session.transfer(
        direction,
        local,
        direction === 'upload' ? '/cancelled' : '/large.bin',
      );
      expect(cancelled).toBe(true);
      expect(transfers().at(-1)?.status).toBe('cancelled');
      if (direction === 'upload') expect(fixture.files.has('/cancelled')).toBe(false);
      else await expect(readFile(local)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('reports a closed shell and disables input after it closes', async () => {
    await connect();
    fixture.closeShell();
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'terminal-exit' }));
    expect(() => session.input('data')).toThrow('No active terminal');
  });
  it('preserves UTF-8 characters split across SSH packets', async () => {
    await connect();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'terminal')).toBe(true));
    events.length = 0;
    const character = Buffer.from('日');
    fixture.writeTerminal(character.subarray(0, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    fixture.writeTerminal(character.subarray(1));
    await vi.waitFor(() =>
      expect(
        events
          .filter((event) => event.type === 'terminal')
          .map((event) => event.data)
          .join(''),
      ).toBe('日'),
    );
  });
  it('applies terminal output backpressure until the renderer acknowledges writes', async () => {
    await connect();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'terminal')).toBe(true));
    for (const event of events) if (event.type === 'terminal') session.acknowledge(event.id);
    events.length = 0;
    const contents = Buffer.alloc(2 * 1024 * 1024, 120);
    fixture.writeTerminal(contents);
    const bytes = () =>
      events
        .filter((event) => event.type === 'terminal')
        .reduce((sum, event) => sum + Buffer.byteLength(event.data), 0);
    await vi.waitFor(() => expect(bytes()).toBeGreaterThanOrEqual(512 * 1024));
    expect(bytes()).toBeLessThan(contents.length);
    await vi.waitFor(() => {
      for (const event of events) if (event.type === 'terminal') session.acknowledge(event.id);
      expect(bytes()).toBe(contents.length);
    });
    session.acknowledge(-1);
  });
  it('clears the terminal and suppresses late transfer filenames after disconnect', async () => {
    await connect();
    const source = join(directory, 'private-session-name.txt');
    await writeFile(source, 'disposable fixture');
    observe = () => session.disconnect();
    await expect(session.transfer('upload', source, '/disconnected-transfer')).rejects.toThrow(
      'interrupted',
    );
    const reset = events.map((event) => event.type).lastIndexOf('terminal-reset');
    expect(reset).toBeGreaterThan(0);
    expect(events.slice(reset + 1).some((event) => event.type === 'transfer')).toBe(false);
  });
  it('can reconnect immediately without old shell-close events invalidating the new shell', async () => {
    await connect();
    session.disconnect();
    events.length = 0;
    await connect();
    session.input('new-session');
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) => event.type === 'terminal' && event.data.includes('echo:new-session'),
        ),
      ).toBe(true),
    );
    expect((await session.list('/')).path).toBe('/');
  });
  it('reports a lost connection and never replays terminal input', async () => {
    await connect();
    fixture.drop();
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'status' && !event.connected)).toBe(true),
    );
    expect(() => session.input('anything')).toThrow();
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
  });
  it('rejects operations without an active connection', async () => {
    expect(() => session.input('x')).toThrow('No active terminal');
    expect(() => session.resize(80, 24)).toThrow('No active terminal');
    expect(() => session.cancel('missing')).toThrow('no longer active');
    await expect(session.list('/')).rejects.toThrow('SFTP is unavailable');
    await expect(
      session.changeFile(
        { action: 'delete', directory: '/', name: 'hello.txt', kind: 'file' },
        async () => true,
      ),
    ).rejects.toThrow('SFTP is unavailable');
  });
});
