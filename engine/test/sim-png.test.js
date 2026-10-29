import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../sim/png.js';
import { encodePng, pngChunk, testImage } from '../sim/png-encode.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

for (const channels of [1, 3, 4]) {
  test(`round-trip ${channels}-channel image through every filter type`, () => {
    const img = testImage(13, 11, channels, channels * 7);
    for (const filter of [0, 1, 2, 3, 4]) {
      const out = decodePng(encodePng(img, { filter: () => filter }));
      assert.deepEqual({ w: out.width, h: out.height, c: out.channels }, { w: 13, h: 11, c: channels });
      assert.ok(out.data.equals(img.data), `filter ${filter}`);
    }
    // Mixed filters per row, a split zlib stream and ancillary chunks.
    const mixed = encodePng(img, {
      idatSplit: 17,
      extraChunks: [pngChunk('tEXt', Buffer.from('Comment\0openmeet test')), pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]))],
    });
    assert.ok(decodePng(mixed).data.equals(img.data));
    assert.ok(decodePng(new Uint8Array(mixed)).data.equals(img.data), 'plain Uint8Array input');
  });
}

for (const [png, raw, channels] of [['im-gray.png', 'im-gray.raw', 1], ['im-rgb.png', 'im-rgb.raw', 3], ['im-rgba.png', 'im-rgba.raw', 4]]) {
  test(`independent fixture ${png} (libpng adaptive filters) matches ImageMagick's own decode`, () => {
    const out = decodePng(fixture(png));
    assert.equal(out.width, 32);
    assert.equal(out.height, 16);
    assert.equal(out.channels, channels);
    assert.ok(out.data.equals(fixture(raw)));
  });
}

test('1x1 image', () => {
  const img = { width: 1, height: 1, channels: 3, data: Buffer.from([1, 2, 3]) };
  assert.deepEqual([...decodePng(encodePng(img)).data], [1, 2, 3]);
});

test('clear errors for unsupported or broken input', () => {
  const img = testImage(4, 3, 3);
  const good = encodePng(img);
  assert.throws(() => decodePng(Buffer.from('hello world!')), /not a PNG/);
  assert.throws(() => decodePng(encodePng(img, { ihdr: { depth: 16 } })), /unsupported bit depth 16 \(only 8\)/);
  assert.throws(() => decodePng(encodePng(img, { ihdr: { colour: 3 } })), /unsupported colour type 3 \(palette\)/);
  assert.throws(() => decodePng(encodePng(img, { ihdr: { colour: 4 } })), /unsupported colour type 4 \(grey\+alpha\)/);
  assert.throws(() => decodePng(encodePng(img, { ihdr: { interlace: 1 } })), /interlaced/);
  assert.throws(() => decodePng(encodePng(img, { filter: () => 5 })), /row 0: unknown filter type 5/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 20)), /truncated|missing IEND/);
  const corrupt = Buffer.from(good);
  corrupt[20] ^= 0xff; // inside IHDR
  assert.throws(() => decodePng(corrupt), /CRC mismatch in IHDR/);
  const vendor = encodePng(img, { extraChunks: [pngChunk('XYZW', Buffer.alloc(1))] });
  assert.throws(() => decodePng(vendor), /unsupported critical chunk XYZW/);
  // Too much pixel data for the header.
  const bomb = Buffer.concat([
    good.subarray(0, 33),
    pngChunk('IDAT', deflateSync(Buffer.alloc(10_000))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodePng(bomb), /decodePng: (zlib|pixel data)/);
});
