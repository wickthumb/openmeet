// Minimal PNG decoder (node:zlib only): 8-bit depth, colour types 0 (grey),
// 2 (RGB) and 6 (RGBA), non-interlaced, all five row filters.

import { crc32, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** @type {Record<number, number>} */
const CHANNELS = { 0: 1, 2: 3, 6: 4 };
const COLOUR_NAMES = ['grey', '?', 'RGB', 'palette', 'grey+alpha', '?', 'RGBA'];
/** Refuse images bigger than this many bytes of pixels (decompression-bomb guard). */
const MAX_PIXEL_BYTES = 1 << 30;

/**
 * @typedef {object} DecodedImage
 * @property {number} width
 * @property {number} height
 * @property {number} channels  1, 3 or 4
 * @property {Buffer} data      Row-major, top row first, channels interleaved.
 */

/** @param {string} msg */
const fail = (msg) => new Error(`decodePng: ${msg}`);

/**
 * Decode a PNG. Throws a clear error for anything outside the supported subset.
 * @param {Uint8Array} input
 * @returns {DecodedImage}
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw fail('not a PNG (bad signature)');

  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawIhdr = false;
  let sawIend = false;
  /** @type {Buffer[]} */
  const idat = [];
  while (off < buf.length) {
    if (off + 12 > buf.length) throw fail('truncated chunk header');
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw fail(`truncated ${type} chunk`);
    const body = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw fail(`CRC mismatch in ${type} chunk`);
    off += 12 + len;

    if (!sawIhdr && type !== 'IHDR') throw fail('first chunk is not IHDR');
    if (type === 'IHDR') {
      if (len !== 13) throw fail('bad IHDR length');
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (width === 0 || height === 0) throw fail('zero width or height');
      if (depth !== 8) throw fail(`unsupported bit depth ${depth} (only 8)`);
      if (!(colour in CHANNELS)) {
        throw fail(`unsupported colour type ${colour} (${COLOUR_NAMES[colour] ?? 'unknown'}); only 0 grey, 2 RGB, 6 RGBA`);
      }
      if (body[10] !== 0) throw fail(`unknown compression method ${body[10]}`);
      if (body[11] !== 0) throw fail(`unknown filter method ${body[11]}`);
      if (body[12] !== 0) throw fail('interlaced PNGs are not supported');
      channels = CHANNELS[colour];
      if (width * height * channels > MAX_PIXEL_BYTES) throw fail(`image too large (${width}x${height})`);
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    } else if ((type.charCodeAt(0) & 0x20) === 0 && type !== 'PLTE') {
      // Uppercase first letter = critical; PLTE is an optional hint for types 2/6.
      throw fail(`unsupported critical chunk ${type}`);
    }
  }
  if (!sawIhdr) throw fail('missing IHDR');
  if (!sawIend) throw fail('missing IEND (truncated file)');
  if (idat.length === 0) throw fail('no IDAT data');

  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    throw fail(`zlib: ${/** @type {Error} */ (err).message}`);
  }
  if (raw.length !== expected) throw fail(`pixel data is ${raw.length} bytes; expected ${expected}`);

  const out = Buffer.alloc(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride; // previous output row; only read when y > 0
    switch (filter) {
      case 0:
        raw.copy(out, dst, src, src + stride);
        break;
      case 1:
        for (let i = 0; i < stride; i++) {
          out[dst + i] = (raw[src + i] + (i >= bpp ? out[dst + i - bpp] : 0)) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < stride; i++) {
          out[dst + i] = (raw[src + i] + (y > 0 ? out[up + i] : 0)) & 0xff;
        }
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[up + i] : 0;
          out[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[up + i] : 0;
          const c = i >= bpp && y > 0 ? out[up + i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          out[dst + i] = (raw[src + i] + pred) & 0xff;
        }
        break;
      default:
        throw fail(`row ${y}: unknown filter type ${filter}`);
    }
  }
  return { width, height, channels, data: out };
}
