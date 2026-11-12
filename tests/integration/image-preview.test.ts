import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/main/core/session';
import { decodePreview, imageLimits } from '../../src/main/core/image-preview';
import { openImageSchema, imageRequestSchema } from '../../src/shared/image-preview';
import { sshFixture } from '../fixtures/ssh-server';

const signal = () => new AbortController().signal;
const sample = () =>
  sharp({ create: { width: 6, height: 4, channels: 4, background: '#3388aacc' } });

describe('bounded image decoding', () => {
  it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
    'normalizes %s to a read-only PNG payload',
    async (format) => {
      const bytes = await sample().toFormat(format).toBuffer();
      const preview = await decodePreview(bytes, signal());
      expect(preview).toMatchObject({ width: 6, height: 4, format, firstFrame: false });
      expect(preview.dataUrl).toMatch(/^data:image\/png;base64,/);
      const metadata = await sharp(Buffer.from(preview.dataUrl.split(',')[1], 'base64')).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.exif).toBeUndefined();
    },
  );
  it('keeps GIF animation to a still first frame', async () => {
    const frames = Buffer.alloc(6 * 8 * 3);
    frames.fill(255, 0, frames.length / 2);
    const bytes = await sharp(frames, {
      raw: { width: 6, height: 8, pageHeight: 4, channels: 3 },
    })
      .gif()
      .toBuffer();
    expect(await decodePreview(bytes, signal())).toMatchObject({
      width: 6,
      height: 4,
      firstFrame: true,
    });
  });
  it('applies EXIF orientation without exposing the original metadata', async () => {
    const bytes = await sample().jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const preview = await decodePreview(bytes, signal());
    expect(preview).toMatchObject({ width: 4, height: 6 });
    const metadata = await sharp(Buffer.from(preview.dataUrl.split(',')[1], 'base64')).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });
  it.each([
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/private"/></svg>',
    ),
    Buffer.from('<script>alert(1)</script>'),
    Buffer.from('not an image'),
  ])('refuses active or unsupported contents before decoding', async (bytes) => {
    await expect(decodePreview(bytes, signal())).rejects.toThrow('Only PNG');
  });
  it('refuses empty, oversized, damaged and truncated files', async () => {
    await expect(decodePreview(Buffer.alloc(0), signal())).rejects.toThrow('10 MiB');
    await expect(decodePreview(Buffer.alloc(imageLimits.bytes + 1), signal())).rejects.toThrow(
      '10 MiB',
    );
    const png = await sample().png().toBuffer();
    await expect(decodePreview(png.subarray(0, 30), signal())).rejects.toThrow('decoded safely');
  });
  it('refuses extreme dimensions and compressed pixel bombs', async () => {
    const wide = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(decodePreview(wide, signal())).rejects.toThrow('decoded safely');
    const large = await sharp({
      create: { width: 4096, height: 2049, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(decodePreview(large, signal())).rejects.toThrow('decoded safely');
  });
  it('does not decode or return pixels for an aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(decodePreview(await sample().png().toBuffer(), controller.signal)).rejects.toThrow(
      'cancelled',
    );
  });
  it('rejects unsafe IPC paths, malformed cancellation IDs and extra fields', () => {
    const input = { directory: '/', name: 'sample.png', requestId: randomUUID() };
    expect(openImageSchema.parse(input)).toEqual(input);
    for (const name of ['../sample.png', '/sample.png', 'a/b.png', 'a\u0000.png'])
      expect(openImageSchema.safeParse({ ...input, name }).success).toBe(false);
    expect(openImageSchema.safeParse({ ...input, path: '/private' }).success).toBe(false);
    expect(imageRequestSchema.safeParse('all').success).toBe(false);
  });
});

describe('read-only image preview over SSH', () => {
  let fixture: Awaited<ReturnType<typeof sshFixture>>;
  let session: Session;
  const connect = () =>
    session.connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      password: 'test-password',
    });
  beforeEach(async () => {
    fixture = await sshFixture();
    session = new Session({ verify: async () => true }, () => {});
    await connect();
    fixture.files.set('/sample.png', await sample().png().toBuffer());
  });
  afterEach(async () => {
    session.disconnect();
    await fixture.close();
  });
  it('reads a stable regular file without creating, replacing or backing up anything', async () => {
    const snapshot = () =>
      Array.from(fixture.files, ([path, bytes]) => [
        path,
        createHash('sha256').update(bytes).digest('hex'),
      ]);
    const before = snapshot();
    expect(await session.previewImage('/sample.png', randomUUID())).toMatchObject({
      path: '/sample.png',
      width: 6,
      height: 4,
    });
    expect(snapshot()).toEqual(before);
  });
  it('refuses symlinks, missing files and oversized sources before reading pixels', async () => {
    fixture.symlinks.add('/sample.png');
    await expect(session.previewImage('/sample.png', randomUUID())).rejects.toThrow(
      'regular files',
    );
    fixture.symlinks.delete('/sample.png');
    await expect(session.previewImage('/missing.png', randomUUID())).rejects.toThrow(
      'no longer exists',
    );
    fixture.files.set('/large.png', Buffer.alloc(imageLimits.bytes + 1));
    await expect(session.previewImage('/large.png', randomUUID())).rejects.toThrow('size limit');
    expect(fixture.openedFiles).not.toContain('/large.png');
  });
  it('cancels only its matching request and refuses concurrent operations', async () => {
    session.disconnect();
    await fixture.close();
    fixture = await sshFixture({ stall: ['READ'] });
    await connect();
    fixture.files.set('/sample.png', await sample().png().toBuffer());
    const id = randomUUID();
    const pending = session.previewImage('/sample.png', id);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(fixture.openedFiles).toContain('/sample.png'));
    session.cancelImage(randomUUID());
    await expect(session.previewImage('/sample.png', randomUUID())).rejects.toThrow(
      'active operation',
    );
    session.cancelImage(id);
    await rejected;
    expect((await session.list('/')).entries.some((entry) => entry.name === 'sample.png')).toBe(
      true,
    );
  });
  it('never returns a preview from a lost or replaced session', async () => {
    session.disconnect();
    await fixture.close();
    fixture = await sshFixture({ stall: ['READ'] });
    await connect();
    fixture.files.set('/sample.png', await sample().png().toBuffer());
    const pending = session.previewImage('/sample.png', randomUUID());
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fixture.openedFiles).toContain('/sample.png'));
    session.disconnect();
    await rejected;
    await connect();
    expect((await session.list('/')).path).toBe('/');
  });
});
