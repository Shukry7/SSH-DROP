import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { editorLimit, type EditorDocument } from '../../shared/editor';
import { Replacements, equalFile, type ReplacementApproval } from './replacement';
import { replacementIO } from './replacement-io';
import type { FileSnapshot, RecoveryStore, ServerIdentity } from './recovery-store';
import { transferWait } from './transfer-wait';

export class RemoteEditor {
  private document?: {
    token: string;
    path: string;
    snapshot: FileSnapshot;
    crlf: boolean;
    bom: boolean;
  };
  clear() {
    this.document = undefined;
  }
  async operate<T>(
    options: {
      sftp: SFTPWrapper;
      signal: AbortSignal;
      current: () => boolean;
      invalidate: () => void;
    },
    operation: (
      io: ReturnType<typeof replacementIO>,
      guard: (path: string) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const { sftp, signal, current, invalidate } = options;
    const io = replacementIO(sftp, signal, current, invalidate, editorLimit);
    const guard = async (path: string) => {
      const directory = posix.dirname(path);
      const canonical = await transferWait<string>(
        (done) => sftp.realpath(directory, done),
        30000,
        signal,
        undefined,
        invalidate,
      );
      if (canonical !== directory || !current())
        throw new Error(
          'The editor folder changed or contains an alias. Refresh and reopen the file.',
        );
      signal.throwIfAborted();
    };
    return operation(io, guard);
  }
  async open(
    path: string,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
  ): Promise<EditorDocument> {
    await guard(path);
    const source = io.read(path);
    const chunks: Buffer[] = [];
    let snapshot: FileSnapshot | undefined;
    for (;;) {
      const item = await source.next();
      if (item.done) {
        snapshot = item.value;
        break;
      }
      chunks.push(item.value);
    }
    if (!snapshot) throw new Error('The remote file no longer exists.');
    const bytes = Buffer.concat(chunks);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('The editor supports valid UTF-8 text files only.');
    }
    validateText(text);
    const crlf = text.includes('\r\n');
    if (
      text.replaceAll('\r\n', '').includes('\r') ||
      (crlf && text.replaceAll('\r\n', '').includes('\n'))
    )
      throw new Error('Use a file with consistent LF or CRLF line endings.');
    const bom = text.startsWith('\ufeff');
    await guard(path);
    const token = randomUUID();
    this.document = { token, path, snapshot, crlf, bom };
    return { token, path, text: (bom ? text.slice(1) : text).replaceAll('\r\n', '\n') };
  }
  async save(
    token: string,
    text: string,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
    recovery: {
      store: RecoveryStore;
      identity: ServerIdentity;
      check: () => void;
      confirm: (approval: ReplacementApproval) => Promise<number>;
    },
  ): Promise<boolean> {
    const document = this.document;
    if (!document || document.token !== token)
      throw new Error('The editor belongs to an old session. Copy the draft and reopen the file.');
    validateText(text);
    if (text.includes('\r')) throw new Error('Editor input must use LF line endings.');
    const encoded = `${document.bom ? '\ufeff' : ''}${document.crlf ? text.replaceAll('\n', '\r\n') : text}`;
    validateText(encoded);
    const bytes = Buffer.from(encoded, 'utf8');
    const incoming = {
      ...document.snapshot,
      size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    };
    const check = () => {
      recovery.check();
      if (this.document !== document) throw new Error('The editor session changed.');
    };
    const verifyOriginal = async () => {
      check();
      await guard(document.path);
      const latest = await io.snapshot(document.path);
      if (!equalFile(latest, document.snapshot) || latest?.modified !== document.snapshot.modified)
        throw new Error('The remote file changed. The draft has not replaced it.');
      check();
    };
    const replacement = new Replacements({
      ...recovery,
      check,
      localIO: io,
      remoteIO: io,
      beforePublish: verifyOriginal,
      transfer: async (_direction, _local, remote) => {
        await verifyOriginal();
        await io.write(
          remote,
          (async function* () {
            yield bytes;
          })(),
          incoming,
          verifyOriginal,
        );
      },
    });
    const saved = await replacement.saveEditedFile(document.path, document.snapshot, incoming);
    if (saved) {
      const snapshot = await io.snapshot(document.path);
      if (!equalFile(snapshot, incoming))
        throw new Error(
          'The saved file changed during verification. Inspect it before saving again.',
        );
      check();
      document.snapshot = snapshot!;
    }
    return saved;
  }
}

function validateText(text: string) {
  if (Buffer.byteLength(text) > editorLimit)
    throw new Error('The editor file limit is 1 MiB of UTF-8 text.');
  if (
    /\p{Surrogate}/u.test(text) ||
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  )
    throw new Error('The file contains binary data or unsupported control characters.');
}
