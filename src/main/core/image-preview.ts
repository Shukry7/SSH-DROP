import sharp from 'sharp';
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { ImagePreview } from '../../shared/image-preview';
import { replacementIO } from './replacement-io';
import { transferWait } from './transfer-wait';

export const imageLimits = { bytes: 10 * 1024 * 1024, pixels: 8 * 1024 * 1024, edge: 8192 };
// Image contents must not remain in libvips' operation cache or spill to disk.
sharp.cache(false);

export async function decodePreview(
  bytes: Buffer,
  signal: AbortSignal,
): Promise<Omit<ImagePreview, 'path' | 'size'>> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > imageLimits.bytes)
    throw new Error('Image preview supports files up to 10 MiB.');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp =
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !gif && !webp)
    throw new Error('Only PNG, JPEG, WebP and GIF images can be previewed. SVG is unsupported.');
  const image = sharp(bytes, {
    limitInputPixels: imageLimits.pixels,
    failOn: 'warning',
    pages: 1,
    animated: false,
    sequentialRead: true,
  }).timeout({ seconds: 10 });
  try {
    const metadata = await image.metadata();
    signal.throwIfAborted();
    const { width, height, format } = metadata;
    if (
      !format ||
      !['png', 'jpeg', 'webp', 'gif'].includes(format) ||
      !width ||
      !height ||
      width > imageLimits.edge ||
      height > imageLimits.edge ||
      width * height > imageLimits.pixels
    )
      throw new Error('bounds');
    const { data, info } = await image.autoOrient().png().toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    if (data.length > 34 * 1024 * 1024 || info.width * info.height > imageLimits.pixels)
      throw new Error('bounds');
    return {
      width: info.width,
      height: info.height,
      format,
      firstFrame: (metadata.pages ?? 1) > 1,
      dataUrl: `data:image/png;base64,${data.toString('base64')}`,
    };
  } catch {
    signal.throwIfAborted();
    throw new Error(
      'The image could not be decoded safely. It may be damaged or exceed the 8 megapixel / 8192-pixel side limit.',
    );
  } finally {
    image.destroy();
  }
}

export async function readImagePreview(
  path: string,
  options: {
    sftp: SFTPWrapper;
    signal: AbortSignal;
    current: () => boolean;
    invalidate: () => void;
  },
): Promise<ImagePreview> {
  const { sftp, signal, current, invalidate } = options;
  const guard = async () => {
    signal.throwIfAborted();
    const parent = posix.dirname(path);
    const canonical = await transferWait<string>(
      (done) => sftp.realpath(parent, done),
      30000,
      signal,
      undefined,
      invalidate,
    );
    signal.throwIfAborted();
    if (canonical !== parent || !current())
      throw new Error('The image folder or connection changed. Refresh and reopen it.');
  };
  await guard();
  const chunks: Buffer[] = [];
  const io = replacementIO(sftp, signal, current, invalidate, imageLimits.bytes);
  for await (const chunk of io.read(path)) chunks.push(chunk);
  if (!chunks.length) throw new Error('The image is empty or no longer exists.');
  await guard();
  const bytes = Buffer.concat(chunks);
  const preview = await decodePreview(bytes, signal);
  await guard();
  return { ...preview, path, size: bytes.length };
}
