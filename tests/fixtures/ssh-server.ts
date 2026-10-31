import { generateKeyPairSync } from 'node:crypto';
import { posix } from 'node:path';
import ssh2, { type Connection, type ServerChannel } from 'ssh2';

const { Server, utils } = ssh2;

export function privateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}
export const fixtureHostKey = privateKey();
export const fixtureUserKey = privateKey();

export async function sshFixture(
  options: {
    key?: string;
    noSftp?: boolean;
    failWrites?: boolean;
    failClose?: boolean;
    slow?: boolean;
  } = {},
) {
  const files = new Map<string, Buffer>([
    ['/hello.txt', Buffer.from('Hello from the remote server.\n')],
    ["/space 'quote' 日本語.txt", Buffer.from('unusual filename\n')],
    ['/folder/nested.txt', Buffer.from('nested\n')],
    ['/large.bin', Buffer.alloc(2 * 1024 * 1024, 42)],
  ]);
  const connections = new Set<Connection>();
  let lastSize = { rows: 0, cols: 0 };
  let lastShell: ServerChannel | undefined;
  let nextDirectoryResponse: Promise<void> | undefined;
  const server = new Server({ hostKeys: [options.key ?? fixtureHostKey] }, (client) => {
    connections.add(client);
    client.on('error', () => undefined);
    client.on('close', () => connections.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'tester') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'test-password') return ctx.accept();
      if (ctx.method === 'publickey') {
        const parsed = utils.parseKey(fixtureUserKey);
        if (
          !(parsed instanceof Error) &&
          parsed.getPublicSSH().equals(ctx.key.data) &&
          (!ctx.signature || parsed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        )
          return ctx.accept();
      }
      ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty, _reject, size) => {
          lastSize = { rows: size.rows, cols: size.cols };
          acceptPty?.();
        });
        session.on('window-change', (acceptChange, _reject, size) => {
          lastSize = { rows: size.rows, cols: size.cols };
          acceptChange?.();
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          lastShell = stream;
          stream.write('fixture-ready\r\n');
          stream.on('data', (chunk: Buffer) =>
            stream.write(Buffer.concat([Buffer.from('echo:'), chunk])),
          );
        });
        session.on('sftp', (acceptSftp, reject) => {
          if (options.noSftp) return reject();
          const sftp = acceptSftp();
          const status = utils.sftp.STATUS_CODE;
          const modes = utils.sftp.OPEN_MODE;
          const handles = new Map<string, { path: string; directory?: boolean; read?: boolean }>();
          let handleId = 0;
          const handle = (path: string, directory = false) => {
            const value = Buffer.from(String(++handleId));
            handles.set(value.toString(), { path, directory });
            return value;
          };
          const attrs = (path: string) => ({
            mode: path === '/' || path === '/folder' ? 0o040755 : 0o100600,
            uid: 1000,
            gid: 1000,
            size: files.get(path)?.length ?? 0,
            atime: 1700000000,
            mtime: 1700000000,
          });
          const exists = (path: string) => files.has(path) || path === '/' || path === '/folder';
          sftp.on('REALPATH', (id, path) =>
            sftp.name(id, [
              { filename: posix.resolve('/', path), longname: '', attrs: attrs(path) },
            ]),
          );
          for (const event of ['STAT', 'LSTAT'] as const)
            sftp.on(event, (id: number, path: string) => {
              if (exists(path)) sftp.attrs(id, attrs(path));
              else sftp.status(id, status.NO_SUCH_FILE);
            });
          sftp.on('OPENDIR', (id, path) => {
            if (path === '/blocked') sftp.status(id, status.PERMISSION_DENIED);
            else if (path === '/' || path === '/folder') sftp.handle(id, handle(path, true));
            else sftp.status(id, status.NO_SUCH_FILE);
          });
          sftp.on('READDIR', (id, raw) => {
            const entry = handles.get(raw.toString());
            if (!entry || entry.read) return sftp.status(id, status.EOF);
            entry.read = true;
            const paths = [
              ...(entry.path === '/' ? ['/folder'] : []),
              ...Array.from(files.keys()).filter((path) => posix.dirname(path) === entry.path),
            ];
            const respond = () =>
              sftp.name(
                id,
                paths.map((path) => ({
                  filename: posix.basename(path),
                  longname: '',
                  attrs: attrs(path),
                })),
              );
            if (nextDirectoryResponse) {
              const response = nextDirectoryResponse;
              nextDirectoryResponse = undefined;
              void response.then(respond);
            } else respond();
          });
          sftp.on('OPEN', (id, path, flags) => {
            if (path.startsWith('/blocked/')) return sftp.status(id, status.PERMISSION_DENIED);
            if (flags & modes.EXCL && files.has(path)) return sftp.status(id, status.FAILURE);
            if (!(flags & modes.CREAT) && !files.has(path))
              return sftp.status(id, status.NO_SUCH_FILE);
            if ((flags & modes.CREAT && !files.has(path)) || flags & modes.TRUNC)
              files.set(path, Buffer.alloc(0));
            sftp.handle(id, handle(path));
          });
          sftp.on('READ', (id, raw, offset, length) => {
            const entry = handles.get(raw.toString());
            const contents = entry && files.get(entry.path);
            if (!contents) return sftp.status(id, status.FAILURE);
            const respond = () => {
              if (offset >= contents.length) sftp.status(id, status.EOF);
              else sftp.data(id, contents.subarray(offset, offset + length));
            };
            if (options.slow) setTimeout(respond, 20);
            else respond();
          });
          sftp.on('WRITE', (id, raw, offset, data) => {
            const entry = handles.get(raw.toString());
            if (!entry || options.failWrites) return sftp.status(id, status.PERMISSION_DENIED);
            const old = files.get(entry.path)!;
            const contents = Buffer.alloc(Math.max(old.length, offset + data.length));
            old.copy(contents);
            data.copy(contents, offset);
            files.set(entry.path, contents);
            const respond = () => sftp.status(id, status.OK);
            if (options.slow) setTimeout(respond, 20);
            else respond();
          });
          sftp.on('CLOSE', (id, raw) => {
            handles.delete(raw.toString());
            sftp.status(id, options.failClose ? status.FAILURE : status.OK);
          });
          sftp.on('REMOVE', (id, path) => {
            if (files.delete(path)) sftp.status(id, status.OK);
            else sftp.status(id, status.NO_SUCH_FILE);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address.');
  return {
    port: address.port,
    files,
    getSize: () => lastSize,
    holdNextDirectoryResponse: () => {
      let release!: () => void;
      nextDirectoryResponse = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    closeShell: () => lastShell?.end(),
    writeTerminal: (data: Buffer) => lastShell?.write(data),
    drop: () => {
      for (const connection of connections) connection.end();
    },
    close: async () => {
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
