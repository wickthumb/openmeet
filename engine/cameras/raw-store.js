import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Exact received bodies are the record. Unknown padding is never materialized.
export const cameraJson = value => JSON.parse(JSON.stringify(value,
  (_key, item) => typeof item === 'bigint' ? item.toString() : item));

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (count === 0) throw Error('Camera recording write made no progress');
    offset += count;
  }
}

export function openRawCameraStore(dir, metadata) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // Refuse an existing recording, even an empty one.
  const fds = [];
  let data, index, events, stream, streamIndex, closed = false, offset = 0, count = 0, streamOffset = 0, streamDirty = false;
  try {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(cameraJson({
      version: 1, ...metadata, captureComplete: false,
      layout: 'blocks.dat: repeated uint32-LE received length followed by exact body bytes',
      streamLayout: 'stream.dat: exact TCP bytes before framing or validation; stream.jsonl records chunk offsets and receipt times.',
      timeEncoding: 'Integer ticks and quanta are decimal strings; camera ticks use 80000 units per second.',
    }), null, 2) + '\n', { flag: 'wx' });
    for (const name of ['blocks.dat', 'blocks.jsonl', 'events.jsonl', 'stream.dat', 'stream.jsonl']) fds.push(fs.openSync(path.join(dir, name), 'wx'));
    [data, index, events, stream, streamIndex] = fds;
  } catch (error) {
    for (const fd of fds) fs.closeSync(fd);
    throw error;
  }
  const line = (fd, value) => writeAll(fd, Buffer.from(JSON.stringify(cameraJson(value)) + '\n'));
  const sync = () => { for (const fd of fds) fs.fsyncSync(fd); };
  return {
    append(blocks, receivedAtMs) {
      if (closed) throw Error('Camera recording is closed');
      const entries = [];
      for (const { body, inspection } of blocks) {
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        writeAll(data, header); writeAll(data, body);
        entries.push({ ordinal: count, offset, length: body.length, receivedAtMs,
          actualIndex: inspection.actualIndex, producerMetadataRaw: inspection.producerMetadataRaw,
          inverseWordRaw: inspection.inverseWordRaw, inverseMatches: inspection.inverseMatches,
          unknownRanges: inspection.unknownRanges, wrapUnverified: inspection.wrapUnverified,
          sha256: createHash('sha256').update(body).digest('hex') });
        offset += 4 + body.length; count++;
      }
      if (blocks.length) {
        // Persist the batch before publishing its index; no per-block fsync loop.
        fs.fsyncSync(data);
        for (const value of entries) line(index, value);
        fs.fsyncSync(index);
      }
      if (streamDirty) { fs.fsyncSync(stream); fs.fsyncSync(streamIndex); streamDirty = false; }
    },
    stream(bytes, receivedAtMs) {
      if (closed) throw Error('Camera recording is closed');
      writeAll(stream, bytes);
      line(streamIndex, { offset: streamOffset, length: bytes.length, receivedAtMs });
      streamOffset += bytes.length;
      streamDirty = true;
    },
    event(value) {
      if (closed) throw Error('Camera recording is closed');
      line(events, value); fs.fsyncSync(events);
    },
    snapshot: () => ({ dir, blocks: count, bytes: offset, streamBytes: streamOffset, captureComplete: false }),
    close(summary) {
      if (closed) return;
      closed = true;
      const errors = [];
      try {
        line(events, { type: 'local-close', ...summary, captureComplete: false });
        sync();
      } catch (error) { errors.push(error); }
      for (const fd of fds) { try { fs.closeSync(fd); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Camera recording could not be finalized');
    },
  };
}
