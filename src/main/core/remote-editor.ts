import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import {
  editorLimit,
  editorTabLimit,
  type EditorDocument,
  type EditorComparison,
} from '../../shared/editor';
import { Replacements, equalFile, type ReplacementApproval } from './replacement';
import { replacementIO } from './replacement-io';
import type { FileSnapshot, RecoveryStore, ServerIdentity } from './recovery-store';
import { transferWait } from './transfer-wait';

interface OpenDocument {
  path: string;
  snapshot: FileSnapshot;
  crlf: boolean;
  bom: boolean;
  review?: {
    token: string;
    snapshot: FileSnapshot;
    crlf: boolean;
    bom: boolean;
    text: string;
  };
}

export class RemoteEditor {
  private readonly documents = new Map<string, OpenDocument>();
  clear() {
    this.documents.clear();
  }
  close(token: string) {
    this.documents.delete(token);
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
  private async read(
    path: string,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
  ) {
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
    return {
      path,
      snapshot,
      crlf,
      bom,
      text: (bom ? text.slice(1) : text).replaceAll('\r\n', '\n'),
    };
  }
  async open(
    path: string,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
  ): Promise<EditorDocument> {
    const previous = [...this.documents].find(([, document]) => document.path === path);
    if (!previous && this.documents.size >= editorTabLimit)
      throw new Error('Close an editor tab before opening another file.');
    const { text, ...file } = await this.read(path, io, guard);
    const token = randomUUID();
    if (previous) this.close(previous[0]);
    this.documents.set(token, file);
    return { token, path, text };
  }
  private current(token: string) {
    const document = this.documents.get(token);
    if (!document)
      throw new Error(
        'The editor tab was closed or belongs to an old session. Copy the draft and reopen the file.',
      );
    return document;
  }
  async compare(
    token: string,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
  ): Promise<EditorComparison> {
    const document = this.current(token);
    const file = await this.read(document.path, io, guard);
    if (this.current(token) !== document) throw new Error('The editor session changed.');
    document.review = { token: randomUUID(), ...file };
    return {
      reviewToken: document.review.token,
      text: file.text,
      changed:
        !equalFile(file.snapshot, document.snapshot) ||
        file.snapshot.modified !== document.snapshot.modified,
      lineEndings: file.crlf ? 'CRLF' : 'LF',
      bom: file.bom,
    };
  }
  async accept(
    token: string,
    reviewToken: string,
    keepDraft: boolean,
    io: ReturnType<typeof replacementIO>,
    guard: (path: string) => Promise<void>,
    confirm: (approval: ReplacementApproval) => Promise<number>,
  ): Promise<EditorDocument | null> {
    const document = this.current(token);
    const review = document.review;
    if (!review || review.token !== reviewToken)
      throw new Error('This comparison is no longer current. Compare with the server again.');
    const approval = await confirm({
      title: 'Use reviewed remote version',
      buttons: ['Cancel', 'Use reviewed version'],
      detail: `${document.path}\n\n${keepDraft ? 'Keep your draft and use the reviewed server version as the baseline for your next save. Saving can replace changes made by other users.' : 'Replace your draft with the reviewed server text. Your unsaved edits will be discarded.'} This step updates the editor only. Saving still requires its own confirmation.`,
    });
    if (approval !== 1) return null;
    await guard(document.path);
    const latest = await io.snapshot(document.path);
    if (!equalFile(latest, review.snapshot) || latest?.modified !== review.snapshot.modified)
      throw new Error(
        'The server changed again after the comparison. Refresh the comparison before continuing.',
      );
    if (this.current(token) !== document || document.review !== review)
      throw new Error('The editor session changed.');
    const nextToken = randomUUID();
    this.close(token);
    this.documents.set(nextToken, {
      path: document.path,
      snapshot: review.snapshot,
      crlf: review.crlf,
      bom: review.bom,
    });
    return { token: nextToken, path: document.path, text: review.text };
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
    const document = this.current(token);
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
      if (this.current(token) !== document) throw new Error('The editor session changed.');
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
      document.review = undefined;
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
