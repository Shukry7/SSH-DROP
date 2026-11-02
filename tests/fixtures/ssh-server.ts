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
    denyChanges?: boolean;
    dropAfterChange?: boolean;
    stall?: string[];
    corruptReadback?: boolean;
    atomicReplace?: boolean;
    dropAfterReplace?: boolean;
  } = {},
) {
  const files = new Map<string, Buffer>([
    ['/hello.txt', Buffer.from('Hello from the remote server.\n')],
    ["/space 'quote' 日本語.txt", Buffer.from('unusual filename\n')],
    ['/folder/nested.txt', Buffer.from('nested\n')],
    ['/large.bin', Buffer.alloc(2 * 1024 * 1024, 42)],
  ]);
  const connections = new Set<Connection>();
  const directories = new Set(['/', '/folder']);
  const symlinks = new Set<string>();
  const openedFiles: string[] = [];
  let lastSize = { rows: 0, cols: 0 };
  let lastShell: ServerChannel | undefined;
  let nextDirectoryResponse: Promise<void> | undefined;
  let afterRename: ((path: string) => void) | undefined;
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
          if (options.atomicReplace) {
            // ssh2's test server emits no extension advertisement API. Extend only
            // its VERSION packet to exercise the real client's negotiated support.
            const protocol = (
              sftp as unknown as { _protocol: { channelData(channel: number, data: Buffer): void } }
            )._protocol;
            const send = protocol.channelData.bind(protocol);
            protocol.channelData = (channel, data) => {
              if (data.length === 9 && data[4] === 2) {
                const extension = Buffer.from('posix-rename@openssh.com');
                const packet = Buffer.alloc(9 + 4 + extension.length + 4 + 1);
                data.copy(packet);
                packet.writeUInt32BE(packet.length - 4);
                packet.writeUInt32BE(extension.length, 9);
                extension.copy(packet, 13);
                packet.writeUInt32BE(1, 13 + extension.length);
                packet[packet.length - 1] = 49;
                return send(channel, packet);
              }
              send(channel, data);
            };
          }
          const status = utils.sftp.STATUS_CODE;
          const changed = (id: number) => {
            if (options.dropAfterChange) client.end();
            else sftp.status(id, status.OK);
          };
          const modes = utils.sftp.OPEN_MODE;
          const handles = new Map<string, { path: string; directory?: boolean; read?: boolean }>();
          let handleId = 0;
          const handle = (path: string, directory = false) => {
            const value = Buffer.from(String(++handleId));
            handles.set(value.toString(), { path, directory });
            return value;
          };
          const attrs = (path: string) => ({
            mode: directories.has(path) ? 0o040755 : symlinks.has(path) ? 0o120777 : 0o100600,
            uid: 1000,
            gid: 1000,
            size: files.get(path)?.length ?? 0,
            atime: 1700000000,
            mtime: 1700000000,
          });
          const exists = (path: string) =>
            files.has(path) || directories.has(path) || symlinks.has(path);
          sftp.on('REALPATH', (id, path) =>
            sftp.name(id, [
              { filename: posix.resolve('/', path), longname: '', attrs: attrs(path) },
            ]),
          );
          for (const event of ['STAT', 'LSTAT'] as const)
            sftp.on(event, (id: number, path: string) => {
              if (options.stall?.includes(event)) return;
              if (exists(path)) sftp.attrs(id, attrs(path));
              else sftp.status(id, status.NO_SUCH_FILE);
            });
          sftp.on('FSTAT', (id, raw) => {
            if (options.stall?.includes('FSTAT')) return;
            const entry = handles.get(raw.toString());
            if (entry && exists(entry.path)) sftp.attrs(id, attrs(entry.path));
            else sftp.status(id, status.NO_SUCH_FILE);
          });
          sftp.on('SETSTAT', (id) => sftp.status(id, status.OK));
          sftp.on('EXTENDED', (id, name, data: Buffer) => {
            if (!options.atomicReplace || name !== 'posix-rename@openssh.com')
              return sftp.status(id, status.OP_UNSUPPORTED);
            const length = data.readUInt32BE(0);
            const from = data.subarray(4, 4 + length).toString();
            const toLength = data.readUInt32BE(4 + length);
            const to = data.subarray(8 + length, 8 + length + toLength).toString();
            if (!files.has(from)) return sftp.status(id, status.NO_SUCH_FILE);
            if (options.denyChanges) return sftp.status(id, status.PERMISSION_DENIED);
            files.set(to, files.get(from)!);
            files.delete(from);
            if (options.dropAfterReplace) client.end();
            else sftp.status(id, status.OK);
          });
          sftp.on('OPENDIR', (id, path) => {
            if (path === '/blocked') sftp.status(id, status.PERMISSION_DENIED);
            else if (directories.has(path)) sftp.handle(id, handle(path, true));
            else sftp.status(id, status.NO_SUCH_FILE);
          });
          sftp.on('READDIR', (id, raw) => {
            const entry = handles.get(raw.toString());
            if (!entry || entry.read) return sftp.status(id, status.EOF);
            entry.read = true;
            const paths = [
              ...Array.from(directories).filter(
                (path) => path !== '/' && posix.dirname(path) === entry.path,
              ),
              ...Array.from(symlinks).filter((path) => posix.dirname(path) === entry.path),
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
            const opened = handle(path);
            openedFiles.push(path);
            if (!options.stall?.includes('OPEN')) sftp.handle(id, opened);
          });
          sftp.on('READ', (id, raw, offset, length) => {
            if (options.stall?.includes('READ')) return;
            const entry = handles.get(raw.toString());
            const contents = entry && files.get(entry.path);
            if (!contents) return sftp.status(id, status.FAILURE);
            const respond = () => {
              if (offset >= contents.length) sftp.status(id, status.EOF);
              else {
                const data = Buffer.from(contents.subarray(offset, offset + length));
                if (options.corruptReadback && entry?.path.includes('.part') && data.length)
                  data[0] ^= 1;
                sftp.data(id, data);
              }
            };
            if (options.slow) setTimeout(respond, 20);
            else respond();
          });
          sftp.on('WRITE', (id, raw, offset, data) => {
            if (options.stall?.includes('WRITE')) return;
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
            if (options.stall?.includes('CLOSE')) return;
            sftp.status(id, options.failClose ? status.FAILURE : status.OK);
          });
          sftp.on('REMOVE', (id, path) => {
            if (options.stall?.includes('REMOVE')) return;
            if (options.denyChanges) return sftp.status(id, status.PERMISSION_DENIED);
            if (files.delete(path)) changed(id);
            else sftp.status(id, status.NO_SUCH_FILE);
          });
          sftp.on('MKDIR', (id, path) => {
            if (options.denyChanges) return sftp.status(id, status.PERMISSION_DENIED);
            if (exists(path) || !directories.has(posix.dirname(path)))
              return sftp.status(id, status.FAILURE);
            directories.add(path);
            changed(id);
          });
          sftp.on('RMDIR', (id, path) => {
            if (options.denyChanges) return sftp.status(id, status.PERMISSION_DENIED);
            if (
              path === '/' ||
              !directories.has(path) ||
              [...files.keys(), ...directories, ...symlinks].some((item) =>
                item.startsWith(path + '/'),
              )
            )
              return sftp.status(id, status.FAILURE);
            directories.delete(path);
            changed(id);
          });
          sftp.on('RENAME', (id, from, to) => {
            if (options.denyChanges) return sftp.status(id, status.PERMISSION_DENIED);
            if (!exists(from) || exists(to)) return sftp.status(id, status.FAILURE);
            if (files.has(from)) {
              files.set(to, files.get(from)!);
              files.delete(from);
              afterRename?.(to);
            } else if (directories.has(from)) {
              for (const item of [...directories])
                if (item === from || item.startsWith(from + '/')) {
                  directories.delete(item);
                  directories.add(to + item.slice(from.length));
                }
              for (const [item, contents] of [...files])
                if (item.startsWith(from + '/')) {
                  files.delete(item);
                  files.set(to + item.slice(from.length), contents);
                }
            } else return sftp.status(id, status.FAILURE);
            if (!options.stall?.includes('RENAME')) changed(id);
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
    set afterRename(callback: ((path: string) => void) | undefined) {
      afterRename = callback;
    },
    port: address.port,
    files,
    directories,
    symlinks,
    openedFiles,
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
