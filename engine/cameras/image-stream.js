import { decodePredictorPixels, decodePackedPixels, workingToRgb } from './pixels.js';
import {reconstructCameraColumn,reconstructedHeight,applyIntensityLookup,applyRecordGain} from './reconstruction.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fineField = word => (word >>> 16) & 127;
export function cameraColumnTime({ first, second = null, companion = 0, secondCompanion = 0,
  remainder = 0, tickScale, fine = false, inheritedFine = false }) {
  for (const value of [first,companion,secondCompanion]) if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('Timestamp words must be uint32');
  if (![5,8].includes(tickScale) || !Number.isInteger(remainder) || remainder < 0 || remainder > 3) throw new TypeError('Explicit supported tick scale and remainder required');
  let ticks = BigInt(first) * BigInt(tickScale), marked = Boolean(inheritedFine), coefficient = 0;
  if (fine && (companion & 0x800000)) { marked = true; coefficient = 2 * fineField(companion); }
  if (remainder) {
    if (!Number.isInteger(second) || second < 0 || second > 0xffffffff) throw fail('ERR_CAMERA_TIME_DEPENDENCY', 'Missing adjacent timestamp for a repeated scan');
    ticks = (BigInt(first) + BigInt(second)) * BigInt(tickScale) / 2n;
    if (fine && marked && (secondCompanion & 0x800000)) coefficient = Math.floor((coefficient + 2 * fineField(secondCompanion)) / 2);
  }
  if (fine) ticks += BigInt(Math.floor(coefficient / 25));
  return { ticks, quantum: fine && marked ? 1n : BigInt(tickScale), fine: marked, valid: ticks !== 0n };
}

export function repairCameraColumnTime({ current, left = null, right = null }) {
  if (!current.valid || current.ticks === 0n) return { ...current, valid: false, repaired: false };
  let ticks = current.ticks, repaired = false;
  if (left?.valid && right?.valid && left.ticks <= right.ticks && (ticks < left.ticks || ticks > right.ticks)) {
    ticks = (left.ticks + right.ticks) / 2n; repaired = true;
  }
  return { ...current, ticks, fine: current.fine || Boolean(left?.fine) || Boolean(left?.valid && right?.fine),
    quantum: current.fine || left?.fine || (left?.valid && right?.fine) ? 1n : current.quantum, repaired };
}

export function createCameraImageDecoder(profile) {
  const p = structuredClone(profile);
  if (!p || ![2,3].includes(p.family) || !Number.isInteger(p.height) || p.height < 16 || p.height > 2560 ||
      ![5,8].includes(p.tickScale) || !Number.isInteger(p.clockOrigin) || p.clockOrigin <= 0 ||
      !Number.isInteger(p.expectedBlockIndex) || p.expectedBlockIndex < 0 || p.expectedBlockIndex > 0xffffffff) throw new TypeError('Explicit image geometry, family, clock and initial index required');
  if (p.family === 3 && p.height % 8) throw new RangeError('Predictor height must be a multiple of eight');
  const outputHeight=p.outputHeight??(p.reconstruction?reconstructedHeight({height:p.height,...p.reconstruction}):p.height);
  if(!Number.isInteger(outputHeight)||outputHeight<1||outputHeight>5120)throw new RangeError('Decoded output height exceeds its supported bound');
  let nextIndex = p.expectedBlockIndex, previousCodes = null, columnsDecoded = 0;
  return {
    decode(input) {
      if (!(input instanceof Uint8Array)) throw new TypeError('Image body must be bytes');
      const body = Buffer.from(input), limit = Math.min(body.length - 12, 15988);
      if (body.length < 20 || body.length > 16000) throw fail('ERR_CAMERA_BODY_LENGTH', 'Invalid image body length');
      const index = body.readUInt32LE(body.length - 8), inverse = body.readUInt32LE(body.length - 4);
      if (index !== nextIndex || inverse !== ((~index) >>> 0)) throw fail('ERR_CAMERA_IMAGE_INDEX', 'Image block index/trailer mismatch');
      const header = body.readUInt32LE(0), flags = header >>> 16, count = header & 65535;
      if(count*outputHeight*7>64*1024*1024)throw fail('ERR_CAMERA_DECODE_BUDGET','Decoded block exceeds the memory budget');
      if (count > 4000) throw fail('ERR_CAMERA_IMAGE_COUNT', 'Image count exceeds its bounded domain');
      const format = flags & 15, depth = flags & 7, A = ((flags >>> 6) & 3) + 1,
        B = ((flags >>> 4) & 3) + 1, multiplicity = ((flags >>> 8) & 3) + 1;
      if (p.family === 3 && (depth < 3 || depth > 7)) throw fail('ERR_CAMERA_CODEC_PROFILE', 'Unsupported block depth');
      const out = [], records = [];
      let cursor = 8, covered = 0, codes = previousCodes;
      while (covered < count) {
        if (cursor + 4 > limit) throw fail('ERR_CAMERA_RECORD_BOUNDS', 'Record header exceeds received content');
        const word = body.readUInt32LE(cursor), length = word & 65535, R = word >>> 16;
        const scans = Math.min(((R >>> 4) & 15) + 1, 10), physicalCount = scans * multiplicity;
        const headerWords = A + B * (scans + (multiplicity > 1 ? 1 : 0));
        const end = cursor + length * 4, payloadStart = cursor + headerWords * 4;
        if (!length || end > limit || payloadStart > end || physicalCount > count - covered || B < 1) throw fail('ERR_CAMERA_RECORD_BOUNDS', 'Record length/count/timing header is contradictory');
        const replication = Math.min(((R >>> 8) & 15) + 1, 12);
        if (replication !== 1) throw fail('ERR_CAMERA_CODEC_PROFILE', 'Vertical replication requires an explicit reconstruction profile');
        const mode = p.family === 3 ? (R & 15) & ~2 : R & 15;
        const channels = p.family === 3 ? ((R & 2) ? 4 : p.grayscale ? 1 : 3) : 3;
        let decoded;
        if (p.family === 3) decoded = decodePredictorPixels(body.subarray(payloadStart, end), { height:p.height, depth, scans, mode, channels });
        else decoded = decodePackedPixels(body.subarray(payloadStart, end), { height:p.height, format, mode, scans, previousCodes:codes, lookupTable:p.lookupTable });
        if (decoded.codes) codes = decoded.codes.at(-1);
        const times = [];
        for (let scan = 0; scan < scans + (multiplicity > 1 ? 1 : 0); scan++) {
          const at = cursor + (A + B * scan) * 4;
          if (at + B * 4 > payloadStart) throw fail('ERR_CAMERA_RECORD_BOUNDS', 'Timestamp lies outside its record header');
          times.push({ first:body.readUInt32LE(at), companion:B >= 2 ? body.readUInt32LE(at + 4) : 0 });
        }
        for (let scan = 0; scan < scans; scan++) for (let sub = 0; sub < multiplicity; sub++) {
          const time = cameraColumnTime({ ...times[scan], second:times[scan + 1]?.first,
            secondCompanion:times[scan + 1]?.companion, remainder:sub, tickScale:p.tickScale, fine:p.fine !== false });
          out.push({ working:decoded.columns[scan], data:workingToRgb(decoded.columns[scan], p),
            time:{ ...time, origin:p.clockOrigin }, recordOffset:cursor, subdivision:sub, sourceScan:scan,rawGain:p.gainEnabled&&B===2?times[scan].companion&65535:256,activeChannels:channels });
        }
        records.push({ offset:cursor, lengthWords:length, scans, physicalCount, mode, channels, meaningfulBits:decoded.meaningfulBits,
          acquisitionFlag:Boolean(word & 0x80000000) });
        covered += physicalCount; cursor = end;
      }
      if (cursor < limit && cursor + 4 <= limit && body.readUInt32LE(cursor) !== 0 && !p.allowTrailingData) throw fail('ERR_CAMERA_RECORD_TRAILING', 'Unexpected data after declared image records');
      if (index === 0xffffffff) throw fail('ERR_CAMERA_IMAGE_WRAP', 'Image index wrap needs an explicit new epoch');
      if(p.reconstruction||p.intensityLookup||p.gainEnabled)for(let i=0;i<out.length;i++){
        let working=out[i].working;
        if(p.reconstruction)working=reconstructCameraColumn(working,{height:p.height,...p.reconstruction,
          subdivision:out[i].subdivision,next:out[i+1]?.working||null});
        if(p.gainEnabled)working=applyRecordGain(working,{rawGain:out[i].rawGain,channels:out[i].activeChannels,profiles:p.gainProfiles??[]});
        if(p.intensityLookup)working=applyIntensityLookup(working,p.intensityLookup);
        if(working.length<outputHeight*4)throw fail('ERR_CAMERA_RECONSTRUCTION_ROWS','Reconstructed output does not cover the declared extent');
        out[i].working=working.subarray(0,outputHeight*4);out[i].data=workingToRgb(out[i].working,p);
      }
      if(p.repairTimes){const original=out.map(column=>column.time);for(let i=0;i<out.length;i++)out[i].time=repairCameraColumnTime({current:original[i],left:original[i-1],right:original[i+1]});}
      // Publish decoder state only after the entire body was validated.
      nextIndex = index + 1; previousCodes = codes; columnsDecoded += out.length;
      return { index, frameEnd:Boolean(header & 0x80000000), columns:out, records, rows:outputHeight,
        channels:3, columnStart:body.readUInt32LE(4), producerMetadataRaw:body.readUInt32LE(body.length - 12) };
    },
    snapshot: () => ({ nextExpectedBlockIndex:nextIndex, columnsDecoded, outputHeight, profile:structuredClone(p) }),
  };
}

export function createAlignmentFrameAssembler({ width, height, epochId, maximumBytes = 32 * 1024 * 1024 }) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 ||
      width * height * 3 > maximumBytes || typeof epochId !== 'string' || !epochId) throw new RangeError('Explicit bounded frame geometry and epoch required');
  let columns = [], lastIndex = null;
  return {
    append(block, epoch) {
      if (epoch !== epochId || (lastIndex !== null && block.index !== lastIndex + 1)) throw fail('ERR_CAMERA_FRAME_EPOCH', 'Preview epoch/index discontinuity');
      if (block.rows !== height || columns.length + block.columns.length > width) throw fail('ERR_CAMERA_FRAME_GEOMETRY', 'Preview dimensions/count mismatch');
      columns.push(...block.columns.map(column => Buffer.from(column.data))); lastIndex = block.index;
      if (!block.frameEnd) return null;
      if (columns.length !== width) throw fail('ERR_CAMERA_FRAME_INCOMPLETE', 'End boundary arrived before the complete preview width');
      const data = Buffer.alloc(width * height * 3);
      for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) columns[x].copy(data, (y * width + x) * 3, y * 3, y * 3 + 3);
      columns = [];
      return { width, height, channels:3, data, epochId, lastBlockIndex:lastIndex };
    },
    snapshot: () => ({ columns:columns.length, width, height, epochId, incomplete:columns.length !== 0 }),
  };
}
