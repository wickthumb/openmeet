// Test-only minimal PNG encoder: zlib deflate + CRC32. Lets tests build
// PNGs with a chosen filter per row, split IDATs and extra chunks.
import { crc32, deflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR = { 1: 0, 3: 2, 4: 6 };

/** @param {string} type @param {Buffer} body */
export function pngChunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {{width: number, height: number, channels: 1|3|4, data: Uint8Array}} img  Row-major pixels.
 * @param {object} [o]
 * @param {(y: number) => number} [o.filter]   Filter type per row (default: y % 5, all five).
 * @param {number} [o.idatSplit]   Split the zlib stream into IDAT chunks of this many bytes.
 * @param {Buffer[]} [o.extraChunks]  Inserted before the first IDAT.
 * @param {Partial<{depth: number, colour: number, interlace: number}>} [o.ihdr]  Overrides (for error tests).
 */
export function encodePng(img, o = {}) {
  const { width: w, height: h, channels: ch, data } = img;
  const filterOf = o.filter ?? ((y) => y % 5);
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  const px = (x, y) => (x < 0 || y < 0 ? 0 : data[y * stride + x]);
  for (let y = 0; y < h; y++) {
    const f = filterOf(y);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i];
      const a = px(i - ch, y);
      const b = px(i, y - 1);
      const c = px(i - ch, y - 1);
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = Math.floor((a + b) / 2);
      else if (f === 4) pred = paeth(a, b, c);
      raw[y * (stride + 1) + 1 + i] = (v - pred + 256) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = o.ihdr?.depth ?? 8;
  ihdr[9] = o.ihdr?.colour ?? COLOUR[ch];
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = o.ihdr?.interlace ?? 0;
  const z = deflateSync(raw);
  const split = o.idatSplit ?? z.length;
  const idats = [];
  for (let i = 0; i < z.length; i += split) idats.push(pngChunk('IDAT', z.subarray(i, i + split)));
  return Buffer.concat([SIG, pngChunk('IHDR', ihdr), ...(o.extraChunks ?? []), ...idats, pngChunk('IEND', Buffer.alloc(0))]);
}

/** Deterministic test image. */
export function testImage(width, height, channels, seed = 1) {
  const data = Buffer.alloc(width * height * channels);
  let s = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    // Mix smooth gradients with noise so every filter has real work to do.
    const x = Math.floor(i / channels) % width;
    const y = Math.floor(i / channels / width);
    data[i] = ((x * 9 + y * 5 + (i % channels) * 40) + ((s >>> 24) & 0x0f)) & 0xff;
  }
  return { width, height, channels, data };
}
