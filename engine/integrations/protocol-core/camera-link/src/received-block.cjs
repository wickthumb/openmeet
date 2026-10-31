'use strict';
// Independent implementation of the reviewed source-informed offline release.
function inspectReceivedBlock(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be Buffer or Uint8Array');
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      !Number.isInteger(options.expectedIndex) || options.expectedIndex < 0 || options.expectedIndex > 0xffffffff) {
    throw new TypeError('explicit unsigned32 expectedIndex required');
  }
  const expectedIndex = options.expectedIndex;
  const input = Buffer.from(bytes);
  const receivedLength = input.length;
  const common = {receivedLength, captureCompleteNotEstablished:true};
  if (receivedLength < 20 || receivedLength > 16000)
    return {decision:'reject', reason:'length', ...common, expectedIndex};
  const trailer = Buffer.from(input.subarray(receivedLength - 12));
  const producerMetadataRaw = trailer.readUInt32LE(0);
  const actualIndex = trailer.readUInt32LE(4);
  const inverseWordRaw = trailer.readUInt32LE(8);
  if (actualIndex !== expectedIndex)
    return {decision:'reject', reason:'index', ...common, actualIndex, expectedIndex};
  const zeroWrite = receivedLength < 16000 && receivedLength <= 15996
    ? {offset:receivedLength - 12, length:4} : null;
  if (zeroWrite) input.fill(0, zeroWrite.offset, zeroWrite.offset + 4);
  let knownSegments, unknownRanges;
  if (receivedLength < 15988) {
    knownSegments = [{offset:0, bytes:input}, {offset:15988, bytes:trailer}];
    unknownRanges = [{offset:receivedLength, length:15988-receivedLength}];
  } else {
    const normalized = Buffer.alloc(16000);
    input.copy(normalized);
    trailer.copy(normalized,15988);
    knownSegments = [{offset:0, bytes:normalized}];
    unknownRanges = [];
  }
  return {decision:'matched-index', ...common, actualIndex, producerMetadataRaw,
    inverseWordRaw, inverseMatches:inverseWordRaw === (actualIndex ^ 0xffffffff) >>> 0,
    nextIndex:(actualIndex + 1) >>> 0, wrapUnverified:actualIndex === 0xffffffff,
    zeroWrite, knownSegments, unknownRanges};
}
module.exports = {inspectReceivedBlock};
