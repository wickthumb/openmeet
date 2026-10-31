'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { encodeStreamStart, decodeControlReply, createStreamDecoder } = require('../src/index.cjs');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../../requirements/CAMERA-CORE-v1/OFFLINE-FIXTURES-DRAFT.json'), 'utf8').replace(/^\uFEFF/, ''));
const short = Buffer.from(fixture.shortFrame.hex, 'hex');
const payload = Buffer.from(fixture.shortFrame.payloadHex, 'hex');
const opts = { peerAddress: '192.0.2.10', expectedAddress: '192.0.2.10', peerPort: 41925,
  expectedPort: 41925, requestMarker: 270544960, sequence: 7 };
const reply = Buffer.from(fixture.normalReply.hex, 'hex');
function decode(data = reply, changes = {}) { return decodeControlReply(data, { ...opts, ...changes }); }
function altered(offset, value) { const b = Buffer.from(reply); b.writeUInt32LE(value, offset); return b; }
function many(count, status = '01000080') {
  // Independently assembled wire fields, each payload word is the fixed value 0x11223344.
  const countHex = [count % 256, Math.floor(count / 256), 0, 0].map(x => x.toString(16).padStart(2, '0')).join('');
  return Buffer.from('bfcfdfef07000000' + status + countHex + '44332211'.repeat(count), 'hex');
}
test('fixed authored request and explicit unsigned inputs', () => {
  assert.equal(encodeStreamStart({ marker: fixture.streamRequest.marker, blockIndex: fixture.streamRequest.initialIndex }).toString('hex'), fixture.streamRequest.hex);
  for (const value of [undefined, -1, 2 ** 32, 1.5, NaN, '1', null, 1n]) {
    assert.throws(() => encodeStreamStart({ marker: value, blockIndex: 0 }), TypeError);
    assert.throws(() => encodeStreamStart({ marker: 0, blockIndex: value }), TypeError);
  }
  assert.throws(() => encodeStreamStart(), TypeError);
  assert.equal(encodeStreamStart({ marker: 0xffffffff, blockIndex: 0 }).readUInt32LE(0), 0xffffffff);
});
test('fixed reply, immutability and detached payload arrays', () => {
  const before = Buffer.from(reply), out = decode();
  assert.equal(out.decision, 'accepted'); assert.equal(out.success, true);
  assert.deepEqual(out.payload, fixture.normalReply.expected.payload);
  out.delivered[0] = 0; assert.equal(out.payload[0], 0x11223344);
  out.payload[0] = 1; assert.deepEqual(reply, before);
  assert.deepEqual(decode(new Uint8Array(reply)).payload, fixture.normalReply.expected.payload);
});
test('reply correlation and documented validation precedence', () => {
  for (const changes of [{ peerAddress: '192.0.2.11' }, { peerPort: 1 }]) assert.deepEqual(decode(reply, changes), { decision: 'ignore', reason: 'peer' });
  assert.equal(decode(altered(0, 0)).reason, 'marker');
  assert.equal(decode(altered(4, 8)).reason, 'sequence');
  assert.equal(decode(Buffer.alloc(0), { peerPort: 1 }).reason, 'peer');
  assert.equal(decode(altered(0, 0).subarray(0, 15)).reason, 'size');
});
test('reply malformed lengths, statuses and datagram bounds', () => {
  for (const b of [Buffer.alloc(0), reply.subarray(0, 15), Buffer.alloc(65508)]) assert.equal(decode(b).reason, 'size');
  for (const b of [reply.subarray(0, 23), Buffer.concat([reply, Buffer.from([0])]), altered(12, 0xffffffff)]) assert.equal(decode(b).reason, 'length');
  assert.equal(decode(altered(8, 3)).reason, 'status');
  assert.equal(decode(many(16372)).decision, 'accepted'); // 65504 bytes, largest aligned datagram.
  assert.equal(decode(many(16373)).reason, 'size');
});
test('zero counts, success normalization above host receive size, failure unbounded by clamp', () => {
  for (const count of [0, 25, 26, 100]) {
    const success = decode(many(count)); assert.equal(success.payload.length, count);
    assert.equal(success.delivered.length, Math.min(count, 25));
    assert.ok(success.payload.every(x => x === 0x11223344));
    const failure = decode(many(count, '02000080'));
    assert.equal(failure.success, false); assert.equal(failure.reason, 'failure');
    assert.equal(failure.payload.length, count); assert.equal('delivered' in failure, false);
  }
});
test('invalid API types and required reply identity', () => {
  for (const b of [[], '00', null, new ArrayBuffer(4)]) {
    assert.throws(() => decode(b), TypeError);
    const d = createStreamDecoder(); assert.throws(() => d.push(b), TypeError); d.finish();
  }
  for (const change of [{ expectedPort: 1 }, { requestMarker: -1 }, { sequence: 2 ** 32 }, { expectedAddress: '' }, { peerAddress: null }, { peerPort: 65536 }]) assert.throws(() => decode(reply, change), TypeError);
});
test('every split of authored short frame', () => {
  for (let split = 0; split <= short.length; split++) {
    const d = createStreamDecoder();
    const out = [...d.push(short.subarray(0, split)), ...d.push(short.subarray(split))];
    assert.deepEqual(out, [payload]); d.finish();
  }
});
const maxPayload = Buffer.from(Array.from({ length: 16000 }, (_, i) => i % 251));
const maxFrame = Buffer.concat([Buffer.from('f104803e', 'hex'), maxPayload]);
test('every split of maximum frame (16005 split positions)', () => {
  for (let split = 0; split <= maxFrame.length; split++) {
    const d = createStreamDecoder();
    assert.deepEqual([...d.push(maxFrame.subarray(0, split)), ...d.push(maxFrame.subarray(split))], [maxPayload]); d.finish();
  }
});
test('one byte chunks, coalescing, no aliasing and independent instances', () => {
  const d = createStreamDecoder(), other = createStreamDecoder(), out = [];
  const input = Buffer.concat([short, maxFrame, short]), before = Buffer.from(input);
  for (const byte of input) out.push(...d.push(Uint8Array.of(byte)));
  assert.deepEqual(out, [payload, maxPayload, payload]); assert.deepEqual(input, before);
  assert.deepEqual(other.push(Buffer.concat([short, short])), [payload, payload]);
  const copy = Buffer.from(short), result = createStreamDecoder().push(copy);
  copy.fill(0); assert.deepEqual(result, [payload]); result[0].fill(255); assert.deepEqual(short.subarray(4), payload);
  out[0].fill(0); assert.deepEqual(out[2], payload); d.finish(); other.finish();
});
test('all truncated positions fail EOF and stay failed', () => {
  for (const frame of [short, maxFrame]) for (let end = 1; end < frame.length; end++) {
    const d = createStreamDecoder(); d.push(frame.subarray(0, end));
    assert.throws(() => d.finish(), { code: 'ERR_STREAM_FRAME' });
    assert.throws(() => d.push(Buffer.alloc(0)), { code: 'ERR_STREAM_FAILED' });
    assert.throws(() => d.finish(), { code: 'ERR_STREAM_FAILED' });
  }
});
test('corrupt markers and lengths are terminal; coalesced push returns nothing on error', () => {
  for (const hex of ['00041400', 'f1001400', 'f1040000', 'f1041300', 'f104813e', 'f104ffff']) {
    const d = createStreamDecoder();
    assert.throws(() => d.push(Buffer.concat([short, Buffer.from(hex, 'hex')])), { code: 'ERR_STREAM_FRAME' });
    assert.throws(() => d.push(short), { code: 'ERR_STREAM_FAILED' });
    assert.throws(() => d.finish(), { code: 'ERR_STREAM_FAILED' });
  }
  const d = createStreamDecoder(), earlier = d.push(short);
  assert.throws(() => d.push(Buffer.from('00041400', 'hex'))); assert.deepEqual(earlier, [payload]);
});
test('empty chunks and permanently closed finish', () => {
  const d = createStreamDecoder(); assert.deepEqual(d.push(Buffer.alloc(0)), []); assert.equal(d.finish(), undefined);
  assert.throws(() => d.push(Buffer.alloc(0)), { code: 'ERR_STREAM_CLOSED' });
  assert.throws(() => d.finish(), { code: 'ERR_STREAM_CLOSED' });
});
