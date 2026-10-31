// Read-only configuration interpretation. No capability or configuration writer.
const NIBBLE = [1,0,0,1,1,0,0,1,0,0,0,0,0,1,0,0];
const OFFSETS = [0,1,3,4,6,7,9,10];
const error = (code, message) => Object.assign(new Error(message), { code });
export function validateCameraConfiguration(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Configuration must be bytes');
  const bytes = Buffer.from(input);
  if (bytes.length !== 1024) return { valid: false, reason: 'length', length: bytes.length };
  if (bytes.readUInt32LE(0) !== 0x259845a2) return { valid: false, reason: 'magic' };
  let rolling = 0;
  for (let record = 0; record < 64; record++) {
    for (let word = 0; word < 3; word++) {
      rolling = (rolling + bytes.readUInt32LE(record * 16 + word * 4)) >>> 0;
      switch (rolling & 3) {
        case 0: rolling = (rolling | 0x25893562) >>> 0; break;
        case 1: rolling = (rolling << 13) >>> 0; break;
        case 2: rolling = (rolling ^ 0x14f39865) >>> 0; break;
        case 3: rolling = (rolling & 0x765935be) >>> 0; break;
      }
    }
    if (bytes.readUInt32LE(record * 16 + 12) !== rolling) return { valid: false, reason: 'checksum', record };
  }
  return { valid: true };
}

export function classifyCamera({ family, capabilityWord }) {
  if (!Number.isInteger(family) || !Number.isInteger(capabilityWord) || capabilityWord < 0 || capabilityWord > 0xffffffff) throw new TypeError('Explicit family and capability word required');
  const c = capabilityWord;
  if (family === 1) return 1;
  if (family === 2) return ({ 0:2, 1:3, [0x60001]:4, [0xe0001]:5, [0x80001]:6, [0xa0001]:6, [0x180001]:7, [0x1a0001]:7, [0x1e0001]:8 })[c & 0x1e0001] || 0;
  if (family === 3) {
    if ((c & 0x240000) === 0x240000) {
      const high = (c & 0x78000000) >>> 27;
      let mid = c & 0x180000;
      if (high === 0 && mid === 0) mid = 0x80000;
      return mid === 0x80000 && high <= 2 ? 12 + high : 0;
    }
    return ({ [0x200000]:9, [0x200001]:9, [0x280000]:11, [0x280001]:11, [0x300000]:10, [0x300001]:10 })[c & 0x3c0001] || 0;
  }
  if (family === 4 && (c & 1)) return [15,16,17,19,18,20,21,22,23,24][(c >>> 18) & 15] || 0;
  return 0;
}

export function decodeCameraConfiguration(input, { family } = {}) {
  const validation = validateCameraConfiguration(input);
  if (!validation.valid) throw error('ERR_CAMERA_CONFIGURATION', `Invalid configuration: ${validation.reason}${validation.record == null ? '' : ' at record ' + validation.record}`);
  const bytes = Buffer.from(input);
  function read16(record) {
    if (!Number.isInteger(record) || record < 0 || record > 63) throw new RangeError('Configuration record out of range');
    let result = 0;
    OFFSETS.forEach((offset, i) => {
      const byte = bytes[record * 16 + offset];
      result |= (NIBBLE[byte >>> 4] << (2 * i)) | (NIBBLE[byte & 15] << (2 * i + 1));
    });
    return result;
  }
  const read32 = i => (read16(i) | (read16(i + 1) << 16)) >>> 0;
  const capabilityWord = read32(2), featureWord = read32(15);
  const internalType = classifyCamera({ family, capabilityWord });
  const height = { min: read16(7), max: read16(8) }, rate = { min: read16(9), max: read16(10) };
  const calibrationWord = read16(21);
  return { family, internalType, capabilityWord, featureWord, height, rate, maxTdi: read16(14),
    calibrationRaw: calibrationWord ? calibrationWord + 0x2569c6 : 0,
    orderedBounds: height.min <= height.max && rate.min <= rate.max,
    tcpSupported: Boolean(featureWord & 0x400) || internalType === 14,
    deviceIdentityConfirmed: false, validation };
}

export function deriveCameraDefaults(configuration, previous = {}) {
  const { internalType: type, capabilityWord: c, height, rate, maxTdi } = configuration;
  if (!configuration.orderedBounds) throw error('ERR_CAMERA_BOUNDS', 'Configuration geometry/rate bounds are reversed');
  if (![12,13,14].includes(type) || !(c & 0x280)) throw error('ERR_CAMERA_PROFILE', 'No supported default profile for these capabilities');
  const defaults = {
    12: { height:640, rate:800, rawDefaults:{field204:20,field208:40,field264:60,field268:120}, red:90, green:0, blue:120 },
    13: { height:1024, rate:1250, rawDefaults:{field204:20,field208:40,field264:60,field268:120}, red:90, green:0, blue:60 },
    14: { height:2560, rate:3000, rawDefaults:{field204:5,field208:25,field264:15,field268:75}, red:100, green:0, blue:150 },
  }[type];
  const result = { ...structuredClone(previous), ...defaults,
    pixelFormatRaw: c & 0x200 ? 5 : 14, compression: Boolean(c & (c & 0x200 ? 0x400 : 0x100)),
    gainMethod: c & 0x2000 ? 0 : 1 };
  // These profile fields are returned as evidence, not silently sent as mode words.
  result.height = Math.max(height.min, Math.min(result.height, height.max));
  result.rate = Math.max(rate.min, Math.min(result.rate, rate.max));
  if (c & 0x10) result.gunSensor = result.photoeyes = 2;
  if (type !== 12 && !(c & 4)) result.gamma = 700;
  if (c & 0x2000) {
    result.tdiEnabled = true;
    const p = maxTdi > 0 && maxTdi <= 20 ? maxTdi : 20;
    const count = Math.min(p, type === 14 ? 8 : 4);
    if (count > 1 && (type !== 13 || rate.max <= 6000)) { result.tdiCount = count; result.automaticTdi = true; }
  }
  if (maxTdi > 0 && result.tdiCount != null) result.tdiCount = Math.min(result.tdiCount, maxTdi);
  return result;
}
