import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// A real blank 2,000 x 8 grayscale PNG; the stand-in itself never decodes pixels.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
export function makeStripBytes(columns = 2000, rows = 8, level = 6) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(columns, 0);
  header.writeUInt32BE(rows, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(rows * (columns + 1)), { level })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
export const stripBytes = makeStripBytes();
export const stripHash = createHash('sha256').update(stripBytes).digest('hex');

export function makeRequest() {
  return {
    request_id: randomUUID(),
    heat: { event: 3, round: 1, heat: 1, race_type: 'laned_sprint' },
    strip: { encoding: 'png', data_base64: stripBytes.toString('base64'),
      rows: 8, columns: 2000, channels: 1, orientation: 'native' },
    timebase: { first_column_race_time_s: 10, column_period_s: 0.001 },
    start_list: [{ lane: 1, id: 'a' }, { lane: 2, id: 'b' }, { lane: 3, id: 'c' }],
  };
}

export function makeResponse(req = makeRequest()) {
  return { request_id: req.request_id, model: 'test-model', warnings: [],
    predictions: [{ lane: 1, column: 100, race_time_s: 10.1,
      decision: 'auto', reason: 'detected', confidence: 0.99 }] };
}

/** Bind an in-process server to a random loopback port and always close it. */
export async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

export async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
