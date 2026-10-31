const fail = (code, message) => Object.assign(new Error(message), { code });
const checkHeight = height => {
  if (!Number.isInteger(height) || height < 1 || height > 2560) throw new RangeError('Encoded height must be 1..2560');
};
export function expandSample(value, depth) {
  if (!Number.isInteger(depth) || depth < 3 || depth > 7) throw new RangeError('Pixel depth must be 3..7');
  const q = value & ((1 << depth) - 1);
  let out = q, bits = depth;
  while (bits < 8) { out = (out << depth) | q; bits += depth; }
  return (out >>> (bits - 8)) & 255;
}
export class CameraBitReader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  read(count) {
    if (this.position + count > this.bytes.length * 8) throw fail('ERR_CAMERA_PIXEL_TRUNCATED', 'Pixel token exceeds its record');
    let result = 0;
    for (let i = 0; i < count; i++, this.position++) result |= ((this.bytes[this.position >>> 3] >>> (this.position & 7)) & 1) << i;
    return result;
  }
  finish() {
    if (this.bytes.length !== Math.ceil(this.position / 32) * 4) throw fail('ERR_CAMERA_PIXEL_LENGTH', 'Pixel payload has extra or missing storage words');
    return this.position;
  }
}

export function decodePredictorPixels(payload, { height, depth, scans, mode, channels = 3 }) {
  checkHeight(height);
  if (height % 8 || !Number.isInteger(depth) || depth < 3 || depth > 7 ||
      !Number.isInteger(scans) || scans < 1 || scans > 10 || ![1,3,4].includes(channels) ||
      ![0,1].includes(mode) || (mode === 1 && scans !== 1)) throw fail('ERR_CAMERA_CODEC_PROFILE', 'Unsupported predictor profile');
  const reader = new CameraBitReader(payload), columns = Array.from({ length: scans }, () => Buffer.alloc(height * 4));
  const lanes = channels === 1 ? [0] : channels === 4 ? [2,1,0,3] : [2,1,0];
  const accumulators = new Uint8Array(scans * 4), step = 1 << (8 - depth);
  const smallBits = depth < 5 ? 1 : depth < 7 ? 2 : 3, center = (1 << (smallBits - 1)) * step;
  for (let group = 0; group < height; group += 8) {
    const differences = new Uint8Array(32);
    for (let scan = 0; scan < scans; scan++) for (const lane of lanes) {
      const prefix = mode === 1 ? 'raw' : reader.read(1) ? 'repeat' : reader.read(1) ? 'large' : 'small';
      for (let row = 0; row < 8; row++) {
        const i = row * 4 + lane;
        if (prefix === 'raw') differences[i] = reader.read(depth) * step;
        else if (prefix === 'large') differences[i] += reader.read(depth) * step - center;
        else if (prefix === 'small' && !reader.read(1)) {
          let change = reader.read(smallBits) * step - center;
          if (change >= 0) change += step;
          differences[i] += change;
        }
        const a = scan * 4 + lane;
        accumulators[a] += differences[i];
        columns[scan][(group + row) * 4 + lane] = expandSample(accumulators[a] >>> (8 - depth), depth);
      }
    }
  }
  if (channels === 1) for (const column of columns) for (let row = 0; row < height; row++) {
    column[row * 4 + 1] = column[row * 4 + 2] = column[row * 4];
  }
  return { columns, meaningfulBits: reader.finish(), fourthLane: channels === 4 ? 'encoded' : 'application-zero' };
}

const DELTAS = [3,4,5,7,9,11,13,15,17,19,21,23,25,27,28,29];
function legacyDelta(bits) {
  if (!bits.read(1)) return 0;
  if (!bits.read(1)) return bits.read(1) ? -1 : 1;
  if (!bits.read(1)) return bits.read(1) ? -2 : 2;
  return DELTAS[bits.read(4)];
}
function rgb555(word, target, offset) {
  target[offset] = expandSample(word, 5);
  target[offset + 1] = expandSample(word >>> 5, 5);
  target[offset + 2] = expandSample(word >>> 10, 5);
  target[offset + 3] = 0;
}
export function decodePackedPixels(payload, { height, format, mode, scans, previousCodes = null, lookupTable = null }) {
  checkHeight(height);
  const columns = Array.from({ length: scans }, () => Buffer.alloc(height * 4));
  if (![0,1,2].includes(mode) || !Number.isInteger(scans) || scans < 1 || scans > 2) throw fail('ERR_CAMERA_CODEC_PROFILE', 'Unsupported packed record');
  if ([0,4].includes(format)) {
    const codes = Array.from({ length: scans }, () => new Uint16Array(height));
    if (mode === 1 && scans === 1) {
      if (payload.length !== Math.ceil(height / 2) * 4) throw fail('ERR_CAMERA_PIXEL_LENGTH', 'Packed RGB record size mismatch');
      for (let row = 0; row < height; row++) {
        const code = payload.readUInt16LE(row * 2);
        if (code & 0x8000) throw fail('ERR_CAMERA_PIXEL_CODE', 'Packed color exceeds its 15-bit domain');
        codes[0][row] = code; rgb555(code, columns[0], row * 4);
      }
      return { columns, codes, meaningfulBits: height * 16 };
    }
    if (!(previousCodes instanceof Uint16Array) || previousCodes.length !== height) throw fail('ERR_CAMERA_PIXEL_DEPENDENCY', 'Compressed packed color requires a preceding column');
    const bits = new CameraBitReader(payload);
    if (mode === 2 && scans === 2) {
      for (let row = 0; row < height; row++) {
        const old = previousCodes[row];
        if (!bits.read(1)) codes[0][row] = codes[1][row] = old;
        else for (const shift of [10,5,0]) {
          const first = (((old >>> shift) & 31) + legacyDelta(bits)) & 31;
          const second = (first + legacyDelta(bits)) & 31;
          codes[0][row] |= first << shift; codes[1][row] |= second << shift;
        }
      }
    } else if (mode === 0 && scans === 1) {
      for (let row = 0; row < height; row++) for (const shift of [10,5,0]) {
        let value = (previousCodes[row] >>> shift) & 31;
        if (bits.read(1)) {
          if (!bits.read(1)) value = (value + (bits.read(1) ? -2 : 2)) & 31;
          else value = bits.read(5);
        }
        codes[0][row] |= value << shift;
      }
    } else throw fail('ERR_CAMERA_CODEC_PROFILE', 'Unsupported packed color scan/mode combination');
    for (let scan = 0; scan < scans; scan++) for (let row = 0; row < height; row++) rgb555(codes[scan][row], columns[scan], row * 4);
    return { columns, codes, meaningfulBits: bits.finish() };
  }
  if ([1,3].includes(format) && mode === 1 && scans === 1) {
    if (payload.length !== Math.ceil(height / 4) * 4) throw fail('ERR_CAMERA_PIXEL_LENGTH', 'Packed grayscale record size mismatch');
    if (format === 1 && (!Array.isArray(lookupTable) || lookupTable.length !== 256)) throw fail('ERR_CAMERA_LOOKUP_REQUIRED', 'Format 1 requires its explicit full lookup table');
    for (let row = 0; row < height; row++) {
      const value = payload[row];
      if (format === 3) columns[0].set([value,value,value,0], row * 4);
      else {
        const entry = lookupTable[value];
        if (!Number.isInteger(entry) || entry < 0 || entry > 0xffffffff) throw new TypeError('Lookup entries must be uint32');
        columns[0].writeUInt32LE(entry, row * 4);
      }
    }
    return { columns, codes: null, meaningfulBits: height * 8 };
  }
  throw fail('ERR_CAMERA_CODEC_PROFILE', 'Unsupported packed color format');
}

export function workingToRgb(column, { gainFactors = null, reverseRows = false } = {}) {
  const rows = column.length / 4, output = Buffer.alloc(rows * 3);
  if (!Number.isInteger(rows)) throw new RangeError('Working pixels must have four lanes');
  for (let row = 0; row < rows; row++) {
    const source = (reverseRows ? rows - 1 - row : row) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const value = column[source + 2 - channel], factor = gainFactors?.[2 - channel] ?? 256;
      if (!Number.isInteger(factor) || factor < 0 || factor > 65535) throw new RangeError('Explicit gain factor out of range');
      output[row * 3 + channel] = Math.min(255, Math.floor(value * factor / 256));
    }
  }
  return output;
}
