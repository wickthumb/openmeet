import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../sim/png.js';
import { encodePng, pngChunk, testImage } from '../sim/png-encode.js';

test('PNG rows decode exactly through every filter, channel count and IDAT layout', () => {
  for (const [width, height] of [[1, 1], [1, 13], [2, 3], [13, 11], [127, 33]]) {
    for (const channels of [1, 3, 4]) {
      const image = testImage(width, height, channels, width * height + channels);
      for (const filter of [undefined, 0, 1, 2, 3, 4]) {
        for (const idatSplit of [undefined, 17]) {
          const png = encodePng(image, { filter: filter == null ? undefined : () => filter, idatSplit });
          const padded = Buffer.alloc(png.length + 37, 0x91);
          padded.set(png, 19);
          const unchanged = Buffer.from(padded);
          const input = new Uint8Array(padded.buffer, padded.byteOffset + 19, png.length);
          const decoded = decodePng(input);
          assert.deepEqual(decoded, image, `${width}x${height}x${channels}, filter ${filter ?? 'mixed'}, split ${idatSplit}`);
          assert.deepEqual(padded, unchanged, 'decoding must not mutate the input or its backing buffer');
          decoded.data.fill(0);
          assert.deepEqual(padded, unchanged, 'decoded pixels must not alias the encoded input');
        }
      }
    }
  }
});

test('empty IDATs and streams split at individual bytes still decode exactly', () => {
  const image = testImage(79, 37, 4, 191);
  const png = encodePng(image, { idatSplit: 1 });
  const withEmptyIdats = Buffer.concat([
    png.subarray(0, 33),
    pngChunk('IDAT', Buffer.alloc(0)),
    png.subarray(33, png.length - 12),
    pngChunk('IDAT', Buffer.alloc(0)),
    png.subarray(png.length - 12),
  ]);
  assert.deepEqual(decodePng(withEmptyIdats), image);
});

test('PNG validation keeps its diagnostic messages and ordering', () => {
  const image = testImage(4, 3, 3);
  const good = encodePng(image);
  const signature = good.subarray(0, 8), ihdr = good.subarray(8, 33), end = good.subarray(good.length - 12);
  const file = (...chunks) => Buffer.concat([signature, ...chunks]);
  const header = Buffer.from(good.subarray(16, 29));
  const changedHeader = (offset, value) => {
    const body = Buffer.from(header);
    body[offset] = value;
    return file(pngChunk('IHDR', body), good.subarray(33));
  };
  const badCrc = Buffer.from(good);
  badCrc[20] ^= 1;
  const cases = [
    [Buffer.from('hello world'), 'not a PNG (bad signature)'],
    [signature, 'missing IHDR'],
    [file(Buffer.from([0])), 'truncated chunk header'],
    [good.subarray(0, 20), 'truncated IHDR chunk'],
    [badCrc, 'CRC mismatch in IHDR chunk'],
    [file(end), 'first chunk is not IHDR'],
    [file(pngChunk('IHDR', Buffer.alloc(12))), 'bad IHDR length'],
    [file(ihdr), 'missing IEND (truncated file)'],
    [file(ihdr, end), 'no IDAT data'],
    [changedHeader(8, 16), 'unsupported bit depth 16 (only 8)'],
    [changedHeader(9, 3), 'unsupported colour type 3 (palette); only 0 grey, 2 RGB, 6 RGBA'],
    [changedHeader(10, 1), 'unknown compression method 1'],
    [changedHeader(11, 1), 'unknown filter method 1'],
    [changedHeader(12, 1), 'interlaced PNGs are not supported'],
    [file(ihdr, pngChunk('ABCD', Buffer.alloc(0)), end), 'unsupported critical chunk ABCD'],
    [encodePng(image, { filter: () => 255 }), 'row 0: unknown filter type 255'],
    [file(ihdr, pngChunk('IDAT', deflateSync(Buffer.alloc(0))), end), 'pixel data is 0 bytes; expected 39'],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => decodePng(input), { name: 'Error', message: `decodePng: ${message}` });
  }
});
