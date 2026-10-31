'use strict';

function observation(value, name) {
  if (!value || typeof value !== 'object' || !(value.bytes instanceof Uint8Array))
    throw new TypeError(`${name} requires Buffer or Uint8Array bytes`);
  for (const field of ['sourceAddress', 'destinationAddress'])
    if (typeof value[field] !== 'string' || value[field].length === 0)
      throw new TypeError(`${name}.${field} must be a nonempty string`);
  for (const field of ['sourcePort', 'destinationPort'])
    if (!Number.isInteger(value[field]) || value[field] < 1 || value[field] > 65535)
      throw new TypeError(`${name}.${field} must be an integer port 1..65535`);
  return { bytes: Buffer.from(value.bytes), sourceAddress: value.sourceAddress,
    destinationAddress: value.destinationAddress, sourcePort: value.sourcePort,
    destinationPort: value.destinationPort };
}

function decodeIdentityPair(input) {
  if (!input || typeof input !== 'object') throw new TypeError('pair required');
  const request = observation(input.request, 'request');
  const response = observation(input.response, 'response');
  const no = reason => ({ decision: 'not-matched', reason });
  if (request.destinationPort !== 41925 || response.sourcePort !== 41925 ||
      request.destinationAddress !== response.sourceAddress ||
      request.sourceAddress !== response.destinationAddress ||
      request.sourcePort !== response.destinationPort) return no('endpoints');
  const q = request.bytes, r = response.bytes;
  if (q.length !== 20) return no('request-length');
  if (q.readUInt32LE(0) !== 0x4b69726b) return no('request-marker');
  if (q.readUInt32LE(8) !== 0x0003001a) return no('request-command');
  if (q.readUInt32LE(12) !== 1) return no('request-count');
  if (r.length !== 48) return no('response-length');
  if (r.readUInt32LE(0) !== 0xb4968d94) return no('response-marker');
  const sequence = q.readUInt32LE(4);
  if (r.readUInt32LE(4) !== sequence) return no('sequence');
  const status = r.readUInt32LE(8);
  if (status === 0x80000002) return no('failure');
  if (status !== 0x80000001) return no('response-status');
  if (r.readUInt32LE(12) !== 8) return no('response-count');
  const payload = Array.from({ length: 8 }, (_, i) => r.readUInt32LE(16 + i * 4));
  if ((payload[2] & 1) === 0) return no('capability');
  if (payload[4] > 0xffff) return no('mac-fragment');
  const octets = [payload[4] >>> 8, payload[4] & 255, payload[3] >>> 24,
    (payload[3] >>> 16) & 255, (payload[3] >>> 8) & 255, payload[3] & 255];
  return { decision: 'matched', reason: 'supported-pair', sequence, payload,
    serialNumberRaw: payload[0], memoryStatusRaw: payload[1], capabilityWord: payload[2],
    macAddress: octets.map(v => v.toString(16).padStart(2, '0')).join(':'),
    cpuSpeedRaw: payload[5], romVersionRaw: payload[6], cpuTypeRaw: payload[7],
    observedTimerSyncWord: q.readUInt32LE(16), modelConfirmed: false, runtimeConfirmed: false };
}
module.exports = { decodeIdentityPair };
