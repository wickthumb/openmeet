const int = (v, name) => {
  if (!Number.isInteger(v) || v < -2147483648 || v > 0xffffffff) throw new TypeError(`Explicit 32-bit ${name} required`);
  return v;
};
const byte = v => v & 255, low = v => v & 65535;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

export function packCameraParameters({ values, hostType, callerFlags, gates, extra }) {
  const names = ['frameMode','frameOffset','height','rate','compression','quality','gainMethod','gain',
    'brightness','rawTone','frequency','orientation','red','green','blue','gamma','gunSensor','gunDebounce',
    'photoeyes','photoeyeDebounce','eyeTrigger','eyeSize','maximumGain','gunLight','motionTrigger',
    'motionLeader','motionTrailer','primaryPort','motionBackTrigger','eyeTop','eyeBottom','motionTop',
    'motionBottom','motionSize','motionMinimumTime','syncMode','syncMaximumError','tdiCount','secondaryPort',
    'rawSplitMode','irisMode','filter','automaticTdi','currentTdi','blackLevel','switchGroup'];
  const v = {};
  for (const name of names) v[name] = int(values?.[name], name);
  int(hostType, 'hostType'); int(callerFlags, 'callerFlags');
  for (const key of ['whiteBalanceZero','blackLevelSupported','serialRouting','externalSync','extraFlag4']) {
    if (typeof gates?.[key] !== 'boolean') throw new TypeError(`Explicit ${key} gate required`);
  }
  for (const key of ['irisOverride','irisInitial','digitalGainMinimum','analogGain','pixelFloor']) int(extra?.[key], key);
  const w = Array(19).fill(0);
  w[0] = v.frameMode;
  let tdi = 1, currentTdi = v.currentTdi;
  if (hostType >= 11 && hostType <= 14) {
    if (!(callerFlags & 0x4000)) {
      tdi = v.gainMethod === 0 && v.automaticTdi === 1 ? Math.max(1, Math.min(v.currentTdi, v.tdiCount)) : v.tdiCount;
      currentTdi = tdi;
    }
    w[0] |= byte(tdi) << 8;
  }
  w[1] = v.frameOffset;
  if (hostType >= 12 && hostType <= 14) {
    w[1] |= hostType === 14 ? ((v.irisMode & 15) << 16) | ((extra.irisOverride & 15) << 20) : v.irisMode << 16;
    if (v.irisMode === 1) w[1] |= extra.irisInitial << 24;
  }
  w[2] = v.height; w[3] = v.rate;
  w[4] = byte(v.compression) | (byte(v.quality) << 8);
  w[5] = byte(v.gainMethod) | (byte(v.gainMethod === 0 ? v.maximumGain : v.gain) << 8);
  if (hostType === 14) w[5] |= (clamp(extra.digitalGainMinimum, 0, 16383) << 16) | (clamp(extra.analogGain, 0, 3) << 30);
  w[6] = byte(v.brightness) | (byte(v.rawTone) << 8) | (byte(v.frequency) << 16);
  w[7] = gates.whiteBalanceZero ? 0 : byte(v.red) | (byte(v.green) << 8) | (byte(v.blue) << 16);
  w[8] = byte(v.gunSensor === 3 ? 0 : v.gunSensor) | (byte(v.gunLight) << 8);
  w[9] = v.gunDebounce;
  w[10] = byte(v.photoeyes);
  if (gates.serialRouting) {
    if (v.primaryPort > 0) w[10] |= 1 << (16 + 2 * (v.primaryPort - 1));
    if (v.secondaryPort > 0 && v.secondaryPort !== v.primaryPort) w[10] |= 2 << (16 + 2 * (v.secondaryPort - 1));
    if (v.primaryPort === 5) w[10] |= (v.switchGroup & 15) << 12;
  }
  w[11] = v.photoeyeDebounce;
  w[12] = gates.externalSync ? byte(v.syncMode) | ((v.syncMaximumError & 0xffffff) << 8) : 0;
  w[13] = (v.orientation !== 0 ? 1 : 0) | (callerFlags & 0x2000 ? 2 : 0) |
    (v.frameMode === 4 && v.rawSplitMode === 2 ? 4 : 0) |
    (hostType >= 12 && hostType <= 14 && v.filter === 1 ? 8 : 0) | (gates.extraFlag4 ? 16 : 0);
  w[14] = low(v.gamma) | (gates.blackLevelSupported ? byte(v.blackLevel) << 16 : 0) | (hostType === 14 ? clamp(extra.pixelFloor, 0, 31) << 24 : 0);
  w[15] = byte(v.motionTrigger) | (byte(v.motionBackTrigger) << 8) | (byte(v.motionLeader) << 16) | (byte(v.motionTrailer) << 24);
  w[16] = byte(v.eyeTrigger) | (byte(v.eyeSize) << 8) | (byte(v.eyeTop) << 16) | (byte(v.eyeBottom) << 24);
  w[17] = byte(v.motionSize) | (byte(v.motionTop) << 8) | (byte(v.motionBottom) << 16);
  w[18] = low(v.motionMinimumTime);
  const words = w.map(x => x >>> 0), bytes = Buffer.alloc(76);
  words.forEach((x, i) => bytes.writeUInt32LE(x, 4 * i));
  return { words, bytes, currentTdi };
}

export function normalizeCameraGeometry({ mode, height, offset, rate, minimumHeight, maximumHeight, minimumRate, maximumRate, doubled = false }) {
  for (const [key, value] of Object.entries({mode,height,offset,rate,minimumHeight,maximumHeight,minimumRate,maximumRate})) int(value,key);
  if (mode < 0 || mode > 4 || minimumHeight > maximumHeight || minimumRate > maximumRate) throw new RangeError('Unsupported mode or unordered bounds');
  height = clamp(height, minimumHeight, maximumHeight); rate = Math.min(clamp(rate, minimumRate, maximumRate), 20000);
  if (mode === 4) { offset = Math.trunc(offset / 2); height = Math.trunc((height + 1) / 2); if (doubled) rate = Math.trunc(rate / 2); }
  const capacity = [2560,512,336,256,2560][mode];
  offset = Math.floor(offset / 8) * 8;
  height = Math.max(16, Math.min(Math.ceil(height / 8) * 8, capacity));
  if (offset + height > capacity) offset = 0;
  return { mode, height, offset, rate };
}
