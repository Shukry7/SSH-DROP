import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats as LocalStats } from 'node:fs';
import { link, lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { TransferUpdate } from '../../shared/contracts';
import { transferWait, TransferFailure } from './transfer-wait';
import { droppedFileFingerprint } from './dropped-files';
import type { UploadStage } from './transfer-recovery';

export const transferLimits = { request: 30000, inactivity: 120000, cleanup: 3000 };
export const transferWarning =
  'A transfer was interrupted or needs inspection. A temporary .sshdrop-*.part file, completed destination or partial folder copy may remain in the selected folders. Inspect before retrying; nothing was automatically repeated. This notice contains no filenames and lasts until dismissed or the app closes.';

type Reply<T = void> = (error?: Error | null, value?: T) => void;
const code = (error: unknown) => (error as { code?: number | string })?.code;
const metadata = (stats: Stats | LocalStats) => {
  const modified = 'mtimeMs' in stats ? stats.mtimeMs : stats.mtime;
  if (
    !stats.isFile() ||
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    !Number.isFinite(modified)
  )
    throw new TransferFailure('Only individual files with valid metadata can be transferred.');
  return `${stats.size}:${modified}:${'ctimeMs' in stats ? stats.ctimeMs : stats.mode}`;
};

export async function runTransfer(options: {
  beforePublish?: () => Promise<void>;
  expectedSourceHash?: string;
  uploadCheckpoint?: {
    maxBytes: number;
    load: () => Promise<UploadStage | undefined>;
    save: (stage: UploadStage) => Promise<void>;
  };
  downloadCheckpoint?: {
    maxBytes: number;
    load: () => Promise<Buffer>;
    save: (bytes: AsyncIterable<Buffer>, size: number) => Promise<void>;
  };
  sourceFingerprint?: string;
  sftp: SFTPWrapper;
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  signal: AbortSignal;
  current: () => boolean;
  invalidate: () => void;
  update: TransferUpdate;
  publish: () => void;
  warn: () => void;
  limits?: typeof transferLimits;
}): Promise<void> {
  const { sftp, direction, local, remote, current, update, publish, warn } = options;
  const limits = options.limits ?? transferLimits;
  const abort = new AbortController();
  let invalidated = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sourceLocal: FileHandle | undefined;
  let targetLocal: FileHandle | undefined;
  let sourceRemote: Buffer | undefined;
  let targetRemote: Buffer | undefined;
  let verifyRemote: Buffer | undefined;
  let ownsTemporary = false;
  let unknownRemoteOpen = false;
  let attemptedTemporary = false;
  let publishing = false;
  let recordedUpload = false;
  let lastUpdate = 0;
  let cleanupDeadline = Infinity;
  let position = 0;
  const temporaryName = `.sshdrop-${randomUUID()}.part`;
  let temporary =
    direction === 'upload'
      ? posix.join(posix.dirname(remote), temporaryName)
      : join(dirname(local), temporaryName);
  const uncertain =
    'Transfer result is uncertain. The destination may already exist. Reconnect and inspect the selected folders before retrying.';
  const invalidate = () => {
    if (invalidated) return;
    invalidated = true;
    options.invalidate();
  };
  const fail = (message: string) => {
    if (!abort.signal.aborted) abort.abort(new TransferFailure(message));
    invalidate();
  };
  const lost = () => fail(publishing ? uncertain : 'Transfer interrupted by a connection failure.');
  const cancelled = () => {
    abort.abort(options.signal.reason);
    if (publishing) invalidate();
  };
  options.signal.addEventListener('abort', cancelled, { once: true });
  if (options.signal.aborted) cancelled();
  sftp.on('close', lost);
  sftp.on('error', lost);
  const check = () => {
    abort.signal.throwIfAborted();
    if (!current()) throw new TransferFailure('The connection changed during the transfer.');
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        fail(
          'Transfer stopped after two minutes without progress. Reconnect and inspect the selected folders before retrying.',
        ),
      limits.inactivity,
    );
  };
  const request = async <T>(
    start: (callback: Reply<T>) => void,
    data = false,
    late?: (value: T) => void,
  ) => {
    check();
    return transferWait(start, data ? limits.inactivity : limits.request, abort.signal, late, () =>
      fail(
        publishing
          ? uncertain
          : 'Transfer request timed out. Reconnect and inspect the selected folders before retrying.',
      ),
    );
  };
  const localCall = <T>(start: () => Promise<T>, late?: (value: T) => void) =>
    request<T>(
      (cb) => {
        void start().then(
          (value) => cb(undefined, value),
          (error: Error) => cb(error),
        );
      },
      false,
      late,
    );
  const remoteInfo = (handle: Buffer) => request<Stats>((cb) => sftp.fstat(handle, cb));
  const remoteAbsent = async (path: string) => {
    try {
      await request<Stats>((cb) => sftp.lstat(path, cb));
    } catch (error) {
      if (code(error) === 2) return;
      throw error;
    }
    throw new TransferFailure('Existing files are never overwritten. Choose a new destination.');
  };
  const closeLocalLate = (handle: FileHandle) => {
    void handle.close().catch(() => undefined);
  };
  const openRemote = async (path: string, flags: 'r' | 'wx') => {
    let requested = false;
    try {
      return await request<Buffer>(
        (cb) => {
          requested = true;
          sftp.open(path, flags, 0o600, cb);
        },
        false,
        (handle) => {
          // Never send a late cleanup through a replacement connection.
          if (current()) sftp.close(handle, () => undefined);
        },
      );
    } catch (error) {
      if (
        requested &&
        (abort.signal.aborted ||
          code(error) === undefined ||
          code(error) === 6 ||
          code(error) === 7)
      )
        unknownRemoteOpen = true;
      throw error;
    }
  };
  const stageInfo = (info: Stats, stage: UploadStage) => {
    if (
      !info.isFile() ||
      (info.mode & 0o7777) !== 0o600 ||
      info.uid !== stage.uid ||
      info.gid !== stage.gid ||
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      info.size > update.total
    )
      throw new TransferFailure('The saved upload temporary file is unsafe or has changed.');
    return info;
  };
  const requireStagePath = async (path: string) => {
    const resolved = await request<string>((cb) => sftp.realpath(path, cb));
    if (resolved !== path) throw new TransferFailure('The saved upload temporary file moved.');
  };
  const reader = (handle: Buffer, total: number, start = 0) => {
    let position = start;
    return new Readable({
      highWaterMark: 65536,
      read() {
        const buffer = Buffer.alloc(Math.min(65536, Math.max(1, total + 1 - position)));
        void request<number>(
          (cb) =>
            sftp.read(handle, buffer, 0, buffer.length, position, (error, count) =>
              cb(error, count),
            ),
          true,
        )
          .then((count) => {
            if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length)
              throw new TransferFailure('The server returned an invalid read length.');
            if (!count) {
              this.push(null);
              return;
            }
            touch();
            position += count;
            if (position > total)
              throw new TransferFailure('The source changed size during transfer.');
            this.push(buffer.subarray(0, count));
          })
          .catch((error: Error) => this.destroy(error));
      },
    });
  };
  const closeTarget = async () => {
    if (targetRemote) {
      const handle = targetRemote;
      targetRemote = undefined;
      await request<void>((cb) => sftp.close(handle, cb));
    }
    if (targetLocal) await localCall(() => targetLocal!.sync());
  };
  const cleanup = async (start: (callback: Reply) => void, remoteOperation = false) => {
    if (remoteOperation && (!current() || invalidated)) {
      warn();
      return;
    }
    try {
      await transferWait(
        start,
        Math.max(1, Math.min(limits.cleanup, cleanupDeadline - Date.now())),
        undefined,
        undefined,
        () => {
          if (remoteOperation) invalidate();
        },
      );
    } catch {
      warn();
    }
  };
  try {
    check();
    update.phase = 'preparing';
    publish();
    let initial: string;
    if (direction === 'upload') {
      const fingerprint = options.sourceFingerprint;
      sourceLocal = await localCall(
        () =>
          open(
            local,
            fingerprint || options.uploadCheckpoint
              ? constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
              : 'r',
          ),
        closeLocalLate,
      );
      if (fingerprint) {
        const opened = await localCall(() => sourceLocal!.stat({ bigint: true }));
        if (droppedFileFingerprint(opened) !== fingerprint)
          throw new TransferFailure('A dropped file changed after review. Drop it again.');
      }
      const info = await localCall(() => sourceLocal!.stat());
      if (!info.isFile())
        throw new TransferFailure(
          'Select an individual file. Folder transfers are not available yet.',
        );
      initial = metadata(info);
      update.total = info.size;
      await remoteAbsent(remote);
    } else {
      const info = await request<Stats>((cb) => sftp.lstat(remote, cb));
      if (!info.isFile())
        throw new TransferFailure(
          'Only individual files can be downloaded; symbolic links are refused.',
        );
      sourceRemote = await openRemote(remote, 'r');
      const opened = await remoteInfo(sourceRemote);
      initial = metadata(opened);
      update.total = opened.size;
      if (metadata(info) !== initial)
        throw new TransferFailure('The source changed before transfer started.');
      try {
        await localCall(() => lstat(local));
        throw new TransferFailure(
          'Existing files are never overwritten. Choose a new destination.',
        );
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      // Final publication below is exclusive even if another process creates this path later.
    }
    const prefix =
      options.downloadCheckpoint && direction === 'download'
        ? await options.downloadCheckpoint.load()
        : Buffer.alloc(0);
    if (
      options.downloadCheckpoint &&
      (prefix.length > update.total || update.total > options.downloadCheckpoint.maxBytes)
    )
      throw new TransferFailure('The saved download size changed or exceeds the recovery limit.');
    for (let offset = 0; offset < prefix.length;) {
      const buffer = Buffer.alloc(Math.min(65536, prefix.length - offset));
      const count = await request<number>((cb) =>
        sftp.read(sourceRemote!, buffer, 0, buffer.length, offset, (error, count) =>
          cb(error, count),
        ),
      );
      if (
        !Number.isInteger(count) ||
        count <= 0 ||
        count > buffer.length ||
        !buffer.subarray(0, count).equals(prefix.subarray(offset, offset + count))
      )
        throw new TransferFailure('The saved download prefix no longer matches the remote file.');
      offset += count;
    }
    check();
    const sourceHash = createHash('sha256');
    attemptedTemporary = true;
    let uploadStage: UploadStage | undefined;
    if (direction === 'upload') {
      const checkpoint = options.uploadCheckpoint;
      if (checkpoint) {
        if (update.total > checkpoint.maxBytes)
          throw new TransferFailure('The saved upload exceeds the recovery limit.');
        uploadStage = await checkpoint.load();
        if (uploadStage) {
          const stage = uploadStage;
          const path = posix.join(posix.dirname(remote), stage.name);
          let info: Stats | undefined;
          try {
            info = await request<Stats>((cb) => sftp.lstat(path, cb));
          } catch (error) {
            if (code(error) !== 2) throw error;
          }
          if (info) {
            stageInfo(info, stage);
            await requireStagePath(path);
            targetRemote = await request<Buffer>(
              (cb) => sftp.open(path, 'r+', cb),
              false,
              (handle) => {
                if (current()) sftp.close(handle, () => {});
              },
            );
            const opened = stageInfo(await remoteInfo(targetRemote), stage);
            await requireStagePath(path);
            if (metadata(info) !== metadata(opened))
              throw new TransferFailure(
                'The saved upload temporary file changed while opening it.',
              );
            const size = opened.size;
            for (let offset = 0; offset < size;) {
              const buffer = Buffer.alloc(Math.min(65536, size - offset));
              const count = await request<number>((cb) =>
                sftp.read(targetRemote!, buffer, 0, buffer.length, offset, (error, count) =>
                  cb(error, count),
                ),
              );
              if (!Number.isInteger(count) || count <= 0 || count > buffer.length)
                throw new TransferFailure('Could not read the saved upload prefix.');
              const localBytes = Buffer.alloc(count);
              const { bytesRead } = await localCall(() =>
                sourceLocal!.read(localBytes, 0, count, offset),
              );
              if (bytesRead !== count || !buffer.subarray(0, count).equals(localBytes))
                throw new TransferFailure('The saved upload prefix does not match the local file.');
              sourceHash.update(localBytes);
              offset += count;
            }
            if (metadata(stageInfo(await remoteInfo(targetRemote), stage)) !== metadata(opened))
              throw new TransferFailure('The saved upload temporary file changed during review.');
            temporary = path;
            position = size;
            ownsTemporary = true;
            recordedUpload = true;
          }
        }
      }
      if (!targetRemote) {
        targetRemote = await openRemote(temporary, 'wx');
        ownsTemporary = true;
        if (checkpoint) {
          const info = await remoteInfo(targetRemote);
          uploadStage = { name: temporaryName, uid: info.uid, gid: info.gid };
          if (stageInfo(info, uploadStage).size !== 0)
            throw new TransferFailure('The new upload temporary file is not empty.');
          await checkpoint.save(uploadStage);
          recordedUpload = true;
        }
      }
    } else {
      targetLocal = await localCall(() => open(temporary, 'wx+', 0o600), closeLocalLate);
      ownsTemporary = true;
    }
    check();
    update.transferred = position;
    update.phase = 'transferring';
    publish();
    touch();
    const source =
      direction === 'upload'
        ? createReadStream(local, { fd: sourceLocal!.fd, autoClose: false, start: position })
        : prefix.length
          ? Readable.from(
              (async function* () {
                for (let offset = 0; offset < prefix.length; offset += 65536)
                  yield prefix.subarray(offset, offset + 65536);
                yield* reader(sourceRemote!, update.total, prefix.length);
              })(),
              { objectMode: false },
            )
          : reader(sourceRemote!, update.total);
    let counted = position;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        counted += chunk.length;
        if (counted > update.total) {
          callback(new TransferFailure('The source grew during transfer.'));
          return;
        }
        sourceHash.update(chunk);
        callback(null, chunk);
      },
    });
    const target = new Writable({
      highWaterMark: 65536,
      write(chunk: Buffer, _encoding, callback) {
        const write = async () => {
          if (direction === 'upload')
            await request<void>(
              (cb) => sftp.write(targetRemote!, chunk, 0, chunk.length, position, cb),
              true,
            );
          else {
            let offset = 0;
            while (offset < chunk.length) {
              const result = await localCall(() =>
                targetLocal!.write(chunk, offset, chunk.length - offset, position + offset),
              );
              if (!result.bytesWritten)
                throw new TransferFailure('The local filesystem stopped accepting writes.');
              offset += result.bytesWritten;
            }
          }
          check();
          position += chunk.length;
          update.transferred = position;
          touch();
          if (Date.now() - lastUpdate >= 100) {
            lastUpdate = Date.now();
            publish();
          }
        };
        void write().then(
          () => callback(),
          (error: Error) => callback(error),
        );
      },
    });
    await pipeline(source, meter, target, { signal: abort.signal });
    if (counted !== update.total) throw new TransferFailure('The source shrank during transfer.');
    const after =
      direction === 'upload'
        ? await localCall(() => sourceLocal!.stat())
        : await remoteInfo(sourceRemote!);
    if (metadata(after) !== initial)
      throw new TransferFailure('The source changed during transfer.');
    await closeTarget();
    update.phase = 'verifying';
    publish();
    touch();
    const expected = sourceHash.digest('hex');
    if (options.expectedSourceHash && options.expectedSourceHash !== expected)
      throw new TransferFailure('The saved transfer source changed. Nothing was published.');
    const destinationHash = createHash('sha256');
    let verified = 0;
    let verifiedUploadMetadata: string | undefined;
    let verification: Readable;
    if (direction === 'upload') {
      if (uploadStage) await requireStagePath(temporary);
      verifyRemote = await openRemote(temporary, 'r');
      const info = await remoteInfo(verifyRemote);
      if (uploadStage) verifiedUploadMetadata = metadata(stageInfo(info, uploadStage));
      if (info.size !== update.total) throw new TransferFailure('Destination verification failed.');
      verification = reader(verifyRemote, update.total);
    } else
      verification = createReadStream(temporary, {
        fd: targetLocal!.fd,
        autoClose: false,
        start: 0,
      });
    await pipeline(
      verification,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          verified += chunk.length;
          if (verified > update.total) {
            callback(new TransferFailure('Destination verification failed.'));
            return;
          }
          destinationHash.update(chunk);
          touch();
          callback();
        },
      }),
      { signal: abort.signal },
    );
    if (verified !== update.total || expected !== destinationHash.digest('hex'))
      throw new TransferFailure('Destination SHA-256 verification failed.');
    const finalSource =
      direction === 'upload'
        ? await localCall(() => sourceLocal!.stat())
        : await remoteInfo(sourceRemote!);
    if (metadata(finalSource) !== initial)
      throw new TransferFailure('The source changed during verification.');
    if (verifyRemote) {
      if (
        uploadStage &&
        metadata(stageInfo(await remoteInfo(verifyRemote), uploadStage)) !== verifiedUploadMetadata
      )
        throw new TransferFailure('The upload temporary file changed during verification.');
      const handle = verifyRemote;
      verifyRemote = undefined;
      await request<void>((cb) => sftp.close(handle, cb));
    }
    if (sourceRemote) {
      const handle = sourceRemote;
      sourceRemote = undefined;
      await request<void>((cb) => sftp.close(handle, cb));
    }
    if (targetLocal) {
      const handle = targetLocal;
      targetLocal = undefined;
      await localCall(() => handle.close());
    }
    if (direction === 'upload') await remoteAbsent(remote);
    check();
    update.phase = 'finalizing';
    publish();
    await options.beforePublish?.();
    if (uploadStage) {
      await requireStagePath(temporary);
      const info = stageInfo(await request<Stats>((cb) => sftp.lstat(temporary, cb)), uploadStage);
      if (info.size !== update.total || metadata(info) !== verifiedUploadMetadata)
        throw new TransferFailure('The upload temporary file changed after verification.');
    }
    check();
    publishing = true;
    try {
      if (direction === 'upload') await request<void>((cb) => sftp.rename(temporary, remote, cb));
      else await localCall(() => link(temporary, local));
    } catch (error) {
      // A definite server/OS refusal permits cleanup; missing acknowledgment does not.
      if (
        (typeof code(error) === 'number' && [1, 2, 3, 4, 5, 8].includes(code(error) as number)) ||
        (direction === 'download' &&
          [
            'EEXIST',
            'ENOENT',
            'EPERM',
            'EACCES',
            'ENOTSUP',
            'EOPNOTSUPP',
            'EXDEV',
            'EROFS',
            'ENOSPC',
            'EDQUOT',
            'EMLINK',
            'ENAMETOOLONG',
            'ELOOP',
            'ENOTDIR',
            'EISDIR',
          ].includes(String(code(error))))
      )
        publishing = false;
      throw error;
    }
    publishing = false;
    if (direction === 'upload') ownsTemporary = false;
    update.status = 'completed';
    update.transferred = update.total;
  } catch (error) {
    const userCancelled =
      options.signal.aborted && options.signal.reason?.name === 'AbortError' && !publishing;
    update.status = userCancelled ? 'cancelled' : 'failed';
    update.error = publishing
      ? uncertain
      : abort.signal.reason instanceof TransferFailure
        ? abort.signal.reason.message
        : userCancelled
          ? 'Transfer cancelled.'
          : options.signal.aborted && options.signal.reason?.name !== 'AbortError'
            ? 'Transfer interrupted by disconnection. Inspect the selected folders before retrying.'
            : error instanceof TransferFailure
              ? error.message
              : 'Transfer failed. Existing files are never overwritten; check the source, destination, available space, and permissions.';
    if (publishing || (attemptedTemporary && (!ownsTemporary || !current() || invalidated))) warn();
    if (unknownRemoteOpen || (attemptedTemporary && !ownsTemporary && abort.signal.aborted)) {
      warn();
      invalidate();
    }
    if (publishing) invalidate();
  } finally {
    clearTimeout(idle);
    cleanupDeadline = Date.now() + limits.cleanup;
    options.signal.removeEventListener('abort', cancelled);
    sftp.removeListener('close', lost);
    sftp.removeListener('error', lost);
    if (
      targetLocal &&
      options.downloadCheckpoint &&
      update.status === 'failed' &&
      position > 0 &&
      !publishing &&
      (!current() ||
        invalidated ||
        (options.signal.aborted && options.signal.reason?.name !== 'AbortError'))
    ) {
      const file = targetLocal;
      const size = position;
      const bytes = async function* () {
        for (let offset = 0; offset < size;) {
          const buffer = Buffer.alloc(Math.min(65536, size - offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (bytesRead <= 0) throw new Error('Incomplete download checkpoint.');
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      };
      try {
        await options.downloadCheckpoint.save(bytes(), size);
      } catch {
        warn();
      }
    }
    cleanupDeadline = Date.now() + limits.cleanup;
    for (const handle of [targetRemote, sourceRemote, verifyRemote])
      if (handle) await cleanup((cb) => sftp.close(handle, cb), true);
    for (const handle of [sourceLocal, targetLocal])
      if (handle)
        await cleanup((cb) => {
          void handle.close().then(
            () => cb(),
            (error: Error) => cb(error),
          );
        });
    if (ownsTemporary && !publishing && (!recordedUpload || update.status === 'cancelled')) {
      if (direction === 'upload') await cleanup((cb) => sftp.unlink(temporary, cb), true);
      else
        await cleanup((cb) => {
          void unlink(temporary).then(
            () => cb(),
            (error: Error) => cb(error),
          );
        });
    }
    publish();
  }
  if (update.status === 'failed') throw new Error(update.error);
}
