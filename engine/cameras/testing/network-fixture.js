export function cameraReply(packet, payload = [], { address = '127.0.0.1', success = true } = {}) {
  const bytes = Buffer.alloc(16 + payload.length * 4);
  bytes.writeUInt32LE((~packet.readUInt32LE(0)) >>> 0);
  bytes.writeUInt32LE(packet.readUInt32LE(4), 4);
  bytes.writeUInt32LE(success ? 0x80000001 : 0x80000002, 8);
  bytes.writeUInt32LE(payload.length, 12);
  payload.forEach((word, i) => bytes.writeUInt32LE(word, 16 + i * 4));
  return { bytes, peerAddress: address, peerPort: 41925 };
}

export function cameraFrame(index = 1, length = 20) {
  const body = Buffer.alloc(length, 0x39);
  body.writeUInt32LE(17, length - 12);
  body.writeUInt32LE(index, length - 8);
  body.writeUInt32LE((~index) >>> 0, length - 4);
  const frame = Buffer.alloc(4 + length);
  frame.set([0xf1, 4]); frame.writeUInt16LE(length, 2); body.copy(frame, 4);
  return { frame, body };
}

export function networkFixture() {
  const f = { sent: [], streams: [], transports: [], now: 0, current: 200, event: 0,
    descriptor: 0, full: 1280n, jobs: new Set(), published: [] };
  f.config = { profile: { id: 'host13-ec8l', cameraKey: 'camera-a', address: '127.0.0.1',
    port: 41925, marker: 0x11223344, modelClass: 3, clockOrigin: 7, epochId: 'test-epoch',
    queueEpochTrusted: true, parameters: Array.from({ length: 19 }, (_, i) => i),
    reset: [12, 0, 0, 0, 0, 0], history: 'fresh', expectedBlockIndex: 1,
    sources: [{ id: 5, enabled: true, mode: 'start', offsetMs: 0 }],
    wired: { enabled: true, offsetMs: 3 }, statusFlags: 0, displayState: 0 },
  sequenceStart: 10, statusSubIdStart: 100, timeoutMs: 100, clockMaxAgeMs: 1000 };
  f.timers = { setInterval(fn) { f.jobs.add(fn); return fn; }, clearInterval(fn) { f.jobs.delete(fn); } };
  f.transportFactory = () => {
    const t = {
      closed: false,
      async exchange(packet, options) {
        f.sent.push(Buffer.from(packet));
        if (f.exchangeHook) return f.exchangeHook(packet, options);
        const op = packet.readUInt16LE(8);
        let payload = [];
        if (op === 14) payload = [7, Number(f.full & 0xffffffn), Number(f.full >> 24n)];
        if (op === 3) {
          payload = Array(21).fill(0); payload[0] = packet.readUInt32LE(16);
          payload[2] = f.current; payload[3] = f.descriptor; payload[4] = f.event;
        }
        const reply = cameraReply(packet, payload);
        if (!options.accept(reply)) throw Error('Test peer was rejected');
        return reply;
      },
      async openStream(options) {
        f.streams.push(options);
        return { async write(bytes) { f.handshake = Buffer.from(bytes); }, close() { t.streamClosed = true; } };
      },
      close() { t.closed = true; },
    };
    f.transports.push(t); return t;
  };
  f.options = { transportFactory: f.transportFactory, timers: f.timers,
    nowMs: () => f.now, wallTimeMs: () => 123456,
    onEvent: (event, data) => f.published.push({ event, data }) };
  return f;
}
