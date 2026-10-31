'use strict';

function uint(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new TypeError(`${name} must be an unsigned 32-bit integer`);
  return value;
}
function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('bytes must be Buffer or Uint8Array');
  return Buffer.from(value);
}
function encodeStreamStart({ marker, blockIndex } = {}) {
  const words = [uint(marker, 'marker'), 0, 0x00030009, 3,
    uint(blockIndex, 'blockIndex'), 0x80000000, 16000];
  const out = Buffer.alloc(28);
  words.forEach((word, index) => out.writeUInt32LE(word, index * 4));
  return out;
}
function decodeControlReply(input, options = {}) {
  const data = bytes(input);
  const { peerAddress, peerPort, expectedAddress, expectedPort, requestMarker, sequence } = options;
  uint(requestMarker, 'requestMarker'); uint(sequence, 'sequence');
  if (typeof expectedAddress !== 'string' || !expectedAddress.length ||
      typeof peerAddress !== 'string' || !peerAddress.length ||
      !Number.isInteger(peerPort) || peerPort < 0 || peerPort > 65535 || expectedPort !== 41925)
    throw new TypeError('explicit addresses, valid peerPort and expectedPort 41925 required');
  const decision = (decision, reason) => ({ decision, reason });
  if (peerAddress !== expectedAddress || peerPort !== expectedPort) return decision('ignore', 'peer');
  if (data.length < 16 || data.length > 65507) return decision('reject', 'size');
  if (data.readUInt32LE(0) !== ((~requestMarker) >>> 0)) return decision('ignore', 'marker');
  if (data.readUInt32LE(4) !== sequence) return decision('ignore', 'sequence');
  const status = data.readUInt32LE(8), count = data.readUInt32LE(12);
  if (data.length !== 16 + 4 * count) return decision('reject', 'length');
  if (status !== 0x80000001 && status !== 0x80000002) return decision('reject', 'status');
  const payload = Array.from({ length: count }, (_, i) => data.readUInt32LE(16 + i * 4));
  const success = status === 0x80000001;
  return { decision: 'accepted', reason: success ? 'success' : 'failure', success, status, count,
    payload, ...(success ? { delivered: payload.slice(0, 25) } : {}) };
}
function createStreamDecoder() {
  let state = 'open', used = 0, target = 4;
  let partial = Buffer.alloc(16004);
  function check() {
    if (state !== 'open') {
      const error = new Error(`decoder ${state}`);
      error.code = state === 'closed' ? 'ERR_STREAM_CLOSED' : 'ERR_STREAM_FAILED';
      throw error;
    }
  }
  function fail(reason) {
    state = 'failed'; partial = null;
    const error = new Error(reason); error.code = 'ERR_STREAM_FRAME'; throw error;
  }
  return {
    snapshot() { return { state, pendingBytes: used, targetBytes: target }; },
    push(input) {
      check();
      const chunk = bytes(input), output = [];
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(target - used, chunk.length - offset);
        chunk.copy(partial, used, offset, offset + size); used += size; offset += size;
        if (used !== target) continue;
        if (target === 4) {
          if (partial[0] !== 0xf1 || partial[1] !== 4) fail('invalid marker');
          const length = partial.readUInt16LE(2);
          if (length < 20 || length > 16000) fail('invalid length');
          target = 4 + length;
        } else {
          output.push(Buffer.from(partial.subarray(4, target))); used = 0; target = 4;
        }
      }
      return output;
    },
    finish() {
      check();
      if (used !== 0) fail('incomplete frame at EOF');
      state = 'closed'; partial = null;
    }
  };
}
module.exports = { encodeStreamStart, decodeControlReply, createStreamDecoder };
