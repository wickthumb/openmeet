import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCaptureStore } from '../capture/store.js';

function littleEndianBytes(values) {
  const bytes = Buffer.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  return endianness() === 'LE' ? bytes : bytes.swap64();
}

test('reopening preserves every timestamp bit and independent snapshots at small and bulk sizes', () => {
  const root = mkdtempSync(join(tmpdir(), 'openmeet-time-bits-'));
  try {
    for (const count of [1, 255, 256, 257, 4096]) {
      const dir = join(root, String(count));
      const writer = openCaptureStore(dir, { now: () => 42 });
      writer.append({ type: 'hello', model: 'timestamp-bits', rows: 1, channels: 1, columnPeriod: 0.001 });
      writer.close();
      const raw = Buffer.alloc(count * 8 + 3);
      const special = [0x7ff0000000000001n, 0x7ff8000000000021n, 0xfff0000000000001n,
        0x8000000000000000n, 0x7ff0000000000000n, 0xfff0000000000000n, 1n, 0x7fefffffffffffffn];
      let bits = 19n;
      for (let i = 0; i < count; i++) {
        bits = BigInt.asUintN(64, bits * 6364136223846793005n + 1442695040888963407n);
        raw.writeBigUInt64LE(special[i] ?? bits, i * 8);
      }
      raw.set([0x41, 0x42, 0x43], count * 8);
      writeFileSync(join(dir, 'columns.bin'), Buffer.alloc(count, 17));
      writeFileSync(join(dir, 'times.f64'), raw);
      const beforeEvents = readFileSync(join(dir, 'events.jsonl'));
      const reader = openCaptureStore(dir, { readOnly: true });
      const snapshot = reader.timesOf(0, count);
      assert.ok(littleEndianBytes(snapshot).equals(raw.subarray(0, count * 8)));
      assert.equal(reader.recovery.timesBytesCut, 3);
      const untouched = reader.timeOf(0);
      snapshot[0] = 87;
      assert.ok(Object.is(reader.timeOf(0), untouched));
      assert.notEqual(reader.timesOf(0, count).buffer, snapshot.buffer);
      reader.close();
      assert.ok(readFileSync(join(dir, 'times.f64')).equals(raw), 'read-only open must retain the torn tail');
      assert.ok(readFileSync(join(dir, 'events.jsonl')).equals(beforeEvents));
      const recovered = openCaptureStore(dir, { now: () => 73 });
      assert.ok(littleEndianBytes(recovered.timesOf(0, count)).equals(raw.subarray(0, count * 8)));
      recovered.close();
      assert.ok(readFileSync(join(dir, 'times.f64')).equals(raw.subarray(0, count * 8)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
