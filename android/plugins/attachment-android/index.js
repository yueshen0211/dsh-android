/**
 * Android attachment provider for the DSH engine.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shipped provider is `@deepseek-ai/dsh-attachment-local`, which uses sharp.
 * sharp has no android-arm64 build (its native binaries cover
 * linux/darwin/win32), and because the plugin tree loads every row eagerly, the
 * failed import aborts the whole boot:
 *
 *   Could not load the "sharp" module using the android-arm64 runtime
 *   - Add WebAssembly-based dependencies: npm install sharp @img/sharp-wasm32
 *
 * Deriving from `@deepseek-ai/dsh-attachment`'s AttachmentStore instead keeps the
 * `attachments` service present, which is what the rest of the engine actually
 * depends on: `dsh-client-file-upload` needs admitEncodedFile / saveFileStream /
 * isAttachmentError, and `dsh-api-session-controller` needs imageLimits /
 * admitPromptContent / readImage.
 *
 * WHAT IT DOES
 * ------------
 *   * Verbatim, content-addressed file storage (sha256), streamed in and out with
 *     backpressure -- the same contract the shipped provider honours.
 *   * Content-addressed image storage with full admission validation: declared
 *     media type checked against the decoded bytes, intrinsic dimensions parsed
 *     from the container header, and every configured limit enforced.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not transcode. sharp's role was normalizing images (EXIF orientation,
 * downscaling, re-encoding). Here the original bytes are stored and served, and
 * `readImageRequest` passes them through unchanged.
 *
 * Consequences, stated plainly so nothing is silently wrong:
 *   * `width`/`height` are the intrinsic encoded dimensions, and
 *     `originalDimensions` is never set, because no EXIF rotation is applied.
 *   * A photo straight from a phone camera is sent at full resolution rather than
 *     being downscaled to the model's image budget, which costs tokens. The
 *     shell's import path is expected to downscale before upload (planned for M3,
 *     using Android's ImageDecoder) -- that is also the design the project chose
 *     over shipping a second image pipeline in WebAssembly.
 *   * `variantId` is derived from content and policy only, since no encoder
 *     parameters exist to cover.
 *
 * A JPEG lives at an arbitrary offset inside EXIF-laden files, so orientation is
 * left to the consumer rather than guessed at here.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { AttachmentStore, AttachmentError } from '@deepseek-ai/dsh-attachment';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

/** Magic-number signatures for the raster types the wire accepts. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * Detect an image media type from its leading bytes.
 * @param {Uint8Array} data - decoded upload bytes.
 * @returns {string | null} the detected media type, or null when unrecognized.
 */
function sniffMediaType(data) {
  if (data.length >= 8
      && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
      && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6
      && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
      && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
    return 'image/gif';
  }
  if (data.length >= 12
      && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * Read intrinsic dimensions from an image container header.
 * @param {Uint8Array} data - decoded upload bytes.
 * @param {string} mediaType - detected media type.
 * @returns {{ width: number, height: number } | null} dimensions when parseable.
 */
function readDimensions(data, mediaType) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mediaType === 'image/png') {
    // IHDR is the first chunk: width and height are big-endian uint32 at 16 and 20.
    if (data.length < 24) return null;
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
  }
  if (mediaType === 'image/gif') {
    if (data.length < 10) return null;
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mediaType === 'image/webp') {
    if (data.length < 30) return null;
    const fourCC = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (fourCC === 'VP8X') {
      // 24-bit little-endian, stored as value minus one.
      const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
      const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
      return { width, height };
    }
    if (fourCC === 'VP8 ') {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (fourCC === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  if (mediaType === 'image/jpeg') {
    // Walk the marker segments to a start-of-frame, which carries the dimensions.
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const marker = data[offset + 1];
      // Standalone markers carry no length payload.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2, false);
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) };
      }
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Filename sanitation: the display name is never interpreted as a path. */
function sanitizeName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'attachment';
  const leaf = name.split(/[\\/]/).pop() ?? 'attachment';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '');
  return cleaned.length === 0 ? 'attachment' : cleaned.slice(0, 200);
}

export class AndroidAttachmentStore extends AttachmentStore {
  /**
   * No `inject` on purpose: the home directory comes from a plain function
   * (`resolveDshHome`), not a cordis service, so declaring a dependency here
   * would leave this row permanently pending.
   */
  imageLimits = Object.freeze({
    maxImageBytes: 20 * 1024 * 1024,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 60 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 16_384,
    mediaTypes: IMAGE_MEDIA_TYPES,
  });

  constructor(ctx, config = {}) {
    super(ctx);
    this.config = config;
    // Same resolution order as the shipped provider: explicit config, then the
    // DSH_HOME environment the shell sets at launch.
    this.root = null;
    this.home = resolveDshHome(config.dshHome);
  }

  /** Resolve and create the content-addressed store root on first use. */
  async ensureRoot() {
    if (this.root !== null) return this.root;
    const root = resolve(join(this.home, 'attachments', 'android-v1'));
    await mkdir(join(root, 'files'), { recursive: true });
    await mkdir(join(root, 'images'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    this.root = root;
    return root;
  }

  /** Object path for one content digest, sharded to keep directories small. */
  objectPath(kind, digest) {
    return join(this.root, kind, digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  /**
   * Commit bytes atomically: write to a temp file, then rename into place.
   * A content-addressed object is immutable, so an existing object is reused.
   */
  async commit(kind, data) {
    await this.ensureRoot();
    const digest = createHash('sha256').update(data).digest('hex');
    const target = this.objectPath(kind, digest);
    try {
      await stat(target);
      return digest;
    } catch {
      // Not present yet: fall through and write it.
    }
    await mkdir(join(target, '..'), { recursive: true });
    const temp = join(this.root, 'tmp', `${randomBytes(12).toString('hex')}.part`);
    await writeFile(temp, data);
    try {
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      // A concurrent writer may have won the race; that is success, not failure.
      try {
        await stat(target);
        return digest;
      } catch {
        throw new AttachmentError(`attachment write failed: ${error?.message ?? error}`, 'ATTACHMENT_WRITE_FAILED');
      }
    }
    return digest;
  }

  async validateImage(input) {
    const { data, mediaType } = input;
    if (data.byteLength === 0) {
      throw new AttachmentError('Image upload is empty.', 'INVALID_IMAGE');
    }
    if (data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE');
    }
    const detected = sniffMediaType(data);
    if (detected === null) {
      throw new AttachmentError('Image bytes are not a recognized raster format.', 'INVALID_IMAGE');
    }
    if (detected !== mediaType) {
      throw new AttachmentError(
        `Declared image type ${mediaType} does not match the decoded bytes (${detected}).`,
        'IMAGE_TYPE_MISMATCH');
    }
    const dimensions = readDimensions(data, detected);
    if (dimensions === null || dimensions.width <= 0 || dimensions.height <= 0) {
      throw new AttachmentError('Image dimensions could not be read from the container header.', 'INVALID_IMAGE');
    }
    if (dimensions.width > this.imageLimits.maxImageDimension
        || dimensions.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError('Image exceeds the configured dimension limit.', 'IMAGE_DIMENSION_TOO_LARGE');
    }
    if (dimensions.width * dimensions.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError('Image exceeds the configured pixel limit.', 'IMAGE_TOO_MANY_PIXELS');
    }
  }

  async saveImage(input) {
    await this.validateImage(input);
    const dimensions = readDimensions(input.data, input.mediaType);
    const digest = await this.commit('images', input.data);
    return {
      attachmentId: digest,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: dimensions.width,
      height: dimensions.height,
      ...(input.name === undefined ? {} : { name: sanitizeName(input.name) }),
    };
  }

  async readImage(ref, signal) {
    signal?.throwIfAborted();
    const digest = String(ref?.attachmentId ?? '');
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new AttachmentError('Attachment reference is not a content digest.', 'INVALID_ATTACHMENT_REF');
    }
    await this.ensureRoot();
    let data;
    try {
      data = await readFile(this.objectPath('images', digest));
    } catch {
      throw new AttachmentError('Stored image is missing.', 'ATTACHMENT_NOT_FOUND');
    }
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== digest) {
      throw new AttachmentError('Stored image does not match its reference.', 'ATTACHMENT_CORRUPT');
    }
    return { ref, data: new Uint8Array(data) };
  }

  imageHostPath(ref) {
    const digest = String(ref?.attachmentId ?? '');
    if (this.root === null || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
    return this.objectPath('images', digest);
  }

  async saveFile(input) {
    const name = sanitizeName(input.name);
    const digest = await this.commit('files', input.data);
    return { attachmentId: digest, name, bytes: input.data.byteLength };
  }

  /**
   * Stream a file in without buffering it whole. The digest is computed while
   * writing, so the object can only be named once the stream completes; the
   * temporary file is renamed into its content-addressed home at the end.
   */
  async saveFileStream(input) {
    await this.ensureRoot();
    const name = sanitizeName(input.name);
    const temp = join(this.root, 'tmp', `${randomBytes(12).toString('hex')}.part`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const sink = createWriteStream(temp);
      for await (const chunk of input.data) {
        input.signal?.throwIfAborted();
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        hash.update(buffer);
        if (!sink.write(buffer)) {
          await new Promise((resolve) => sink.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => {
        sink.end((error) => (error ? reject(error) : resolve()));
      });
      const digest = hash.digest('hex');
      const target = this.objectPath('files', digest);
      await mkdir(join(target, '..'), { recursive: true });
      await rename(temp, target);
      return { attachmentId: digest, name, bytes };
    } catch (error) {
      await rm(temp, { force: true });
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(`attachment stream failed: ${error?.message ?? error}`, 'ATTACHMENT_WRITE_FAILED');
    }
  }

  async readFile(ref, signal) {
    signal?.throwIfAborted();
    const digest = String(ref?.attachmentId ?? '');
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new AttachmentError('File reference is not a content digest.', 'INVALID_ATTACHMENT_REF');
    }
    await this.ensureRoot();
    const path = this.objectPath('files', digest);
    try {
      await stat(path);
    } catch {
      throw new AttachmentError('Stored file is missing.', 'ATTACHMENT_NOT_FOUND');
    }
    return new Uint8Array(await readFile(path));
  }

  async *readFileStream(ref, signal) {
    signal?.throwIfAborted();
    const digest = String(ref?.attachmentId ?? '');
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new AttachmentError('File reference is not a content digest.', 'INVALID_ATTACHMENT_REF');
    }
    await this.ensureRoot();
    const path = this.objectPath('files', digest);
    const source = createReadStream(path);
    for await (const chunk of source) {
      signal?.throwIfAborted();
      yield new Uint8Array(chunk);
    }
  }

  fileHostPath(ref) {
    const digest = String(ref?.attachmentId ?? '');
    if (this.root === null || !/^[0-9a-f]{64}$/.test(digest)) return undefined;
    return this.objectPath('files', digest);
  }

  /**
   * Serve the stored image for a model request.
   *
   * No transcoding happens, so the "request version" is the stored object itself:
   * the same bytes are returned regardless of policy. The variant id still folds
   * in the policy so a caller's cache key stays correct if transcoding is added
   * later (the M3 native path), rather than silently colliding across policies.
   */
  async readImageRequest(ref, policy, signal) {
    const stored = await this.readImage(ref, signal);
    const variantId = createHash('sha256')
      .update(`${ref.attachmentId}|${policy.maxPixels}|${policy.maxBytes}|passthrough`)
      .digest('hex')
      .slice(0, 32);
    return {
      variantId,
      attachment: stored.ref,
      data: stored.data,
      mediaType: stored.ref.mediaType,
      bytes: stored.data.byteLength,
      width: stored.ref.width,
      height: stored.ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: stored.ref.mediaType === 'image/png' || stored.ref.mediaType === 'image/gif',
    };
  }
}

export default AndroidAttachmentStore;
