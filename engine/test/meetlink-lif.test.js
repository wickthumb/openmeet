import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLif, formatLifTime, formatTimeOfDay, lifName, LIF_STATUS_CONVENTION, thousandthsCeil, writeLifAtomic,
} from '../meetlink/lif.js';
import { encodeWindows1252, parseFields } from '../meetlink/text.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'openmeet-lif-'));

test('thousandths round up, robust to floating-point error', () => {
  assert.equal(formatLifTime(12.3401), '12.341');
  assert.equal(formatLifTime(12.34), '12.340');
  assert.equal(formatLifTime(12.339999999999998), '12.340');
  assert.equal(formatLifTime(0.1 + 0.2), '0.300'); // 0.30000000000000004
  assert.equal(formatLifTime(1.005), '1.005'); // 1004.9999999999999 ms
  assert.equal(formatLifTime(1000.123 - 1000), '0.123'); // 0.12300000000002456
  assert.equal(formatLifTime(10.0001), '10.001');
  assert.equal(thousandthsCeil(9.9991), 10000);
  assert.equal(formatLifTime(9.9991), '10.000');
  assert.equal(formatLifTime(0), '0.000');
  assert.throws(() => formatLifTime(-1), RangeError);
  assert.throws(() => formatLifTime(NaN), RangeError);
});

test('time formats: ss.sss, m:ss.sss, h:mm:ss.sss', () => {
  assert.equal(formatLifTime(9.87), '9.870');
  assert.equal(formatLifTime(59.9994), '1:00.000'); // rounds up across the minute
  assert.equal(formatLifTime(62.345), '1:02.345');
  assert.equal(formatLifTime(605.5), '10:05.500');
  assert.equal(formatLifTime(3599.999), '59:59.999');
  assert.equal(formatLifTime(3600), '1:00:00.000');
  assert.equal(formatLifTime(3723.4567), '1:02:03.457');
});

test('time of day: hh:mm:ss.ssss', () => {
  assert.equal(formatTimeOfDay(15 * 3600 + 30 * 60 + 5.12345), '15:30:05.1235');
  assert.equal(formatTimeOfDay(5.5), '00:00:05.5000');
  assert.equal(formatTimeOfDay(null), '');
  assert.equal(formatTimeOfDay('10:00:00.0000'), '10:00:00.0000');
  assert.equal(formatTimeOfDay(new Date(2026, 9, 28, 9, 5, 7, 250)), '09:05:07.2500');
});

const heat = { event: '3', round: 1, heat: 2, name: "Women's 100m, Final", wind: '+1.2', windUnit: 'm/s', startTimeOfDay: 15 * 3600 + 30 * 60 };

test('buildLif: header, places, ties, deltas, statuses after finishers, CRLF', () => {
  const text = buildLif(heat, [
    { id: '105', lane: 5, last: 'Late', first: 'Lu', affiliation: 'East', time: 12.5 },
    { id: '101', lane: 1, last: 'Ace', first: 'Amy', affiliation: 'St. Mary’s, "Gaels"', time: 11.9001, license: 'L1', reactionTime: 0.145 },
    { id: '104', lane: 4, last: 'Dnf', first: 'Dee', affiliation: 'West', status: 'DNF', time: 13 },
    { id: '102', lane: 2, last: 'Tie', first: 'One', affiliation: 'North', time: 12.0 },
    { id: '103', lane: 3, last: 'Tie', first: 'Two', affiliation: 'South', time: 12.0 },
    { id: '107', lane: 7, last: 'Dq', first: 'Dan', affiliation: 'Hill', status: 'DQ', time: 12.2222 },
    { id: '106', lane: 6, last: 'Dns', first: 'Don', affiliation: 'Vale', status: 'dns' },
    { id: '108', lane: 8, last: 'Dq', first: 'NoTime', affiliation: 'Dale', status: 'DQ' },
  ]);
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every LF is part of CRLF');
  const lines = text.split('\r\n').slice(0, -1);
  assert.equal(lines[0], '3,1,2,"Women\'s 100m, Final",+1.2,m/s,,,,,15:30:00.0000');
  const rows = lines.slice(1).map(parseFields);
  assert.equal(rows.length, 8);
  for (const r of rows) assert.equal(r.length, 15);
  // place, ID, lane, last, first, affiliation, time, license, delta, reaction
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[6], r[8]]), [
    ['1', '101', '11.901', '11.901'],
    ['2', '102', '12.000', '0.099'],
    ['2', '103', '12.000', '0.000'],
    ['4', '105', '12.500', '0.500'],
    ['DNF', '104', '', ''],
    ['DNS', '106', '', ''],
    ['DQ', '107', '12.223', ''],
    ['DQ', '108', '', ''],
  ]);
  assert.equal(rows[0][5], 'St. Mary’s, "Gaels"');
  assert.equal(rows[0][7], 'L1');
  assert.equal(rows[0][9], '0.145');
  assert.match(lines[1], /^1,101,1,Ace,Amy,"St\. Mary’s, ""Gaels""",11\.901,L1,11\.901,0\.145,,,,,$/);
});

test('buildLif rejects unknown statuses and athletes with neither time nor status', () => {
  assert.throws(() => buildLif(heat, [{ lane: 1, status: 'XYZ' }]), /unknown status XYZ/);
  assert.throws(() => buildLif(heat, [{ lane: 1 }]), /neither a time nor a status/);
  assert.equal(buildLif(heat, []).split('\r\n').length, 2, 'header only');
});

test('status convention is one exported constant', () => {
  assert.equal(LIF_STATUS_CONVENTION.placeColumn, 'code');
  assert.deepEqual([...LIF_STATUS_CONVENTION.codes], ['DNS', 'DNF', 'DQ', 'FS', 'SC']);
  assert.ok(Object.isFrozen(LIF_STATUS_CONVENTION));
});

test('lifName', () => {
  assert.equal(lifName('3', 1, 1), '003-1-01.lif');
  assert.equal(lifName(3, 1, 1), '003-1-01.lif');
  assert.equal(lifName('18B', 1, 1), '18B-1-01.lif');
  assert.equal(lifName('1234', 2, 12), '1234-2-12.lif');
  assert.equal(lifName('18/B', 1, 3), '18_B-1-03.lif');
});

test('encodeWindows1252: round-trips every byte TextDecoder produces; unknown -> ?', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  const decoded = new TextDecoder('windows-1252').decode(all);
  assert.deepEqual([...encodeWindows1252(decoded)], [...all]);
  assert.deepEqual([...encodeWindows1252('“A” – € ’')], [0x93, 0x41, 0x94, 0x20, 0x96, 0x20, 0x80, 0x20, 0x92]);
  assert.equal(encodeWindows1252('中\u{1f3c3}x').toString('latin1'), '??x', 'one ? per code point');
  assert.deepEqual([...encodeWindows1252('é')], [0xe9], 'NFC first');
});

test('writeLifAtomic writes windows-1252 bytes via .tmp + rename and replaces older content', async () => {
  const dir = tmp();
  try {
    const name = lifName('3', 1, 2);
    const p = await writeLifAtomic(dir, name, buildLif(heat, [{ id: '1', lane: 1, last: 'O’Brien', time: 10 }]));
    assert.equal(p, join(dir, name));
    const bytes = readFileSync(p);
    assert.ok(bytes.includes(Buffer.from([0x4f, 0x92, 0x42])), 'O’B encoded as 0x4F 0x92 0x42');
    assert.deepEqual(readdirSync(dir), [name], 'no .tmp left behind');

    // Concurrent re-saves are serialised; the last one wins.
    await Promise.all([1, 2, 3].map((n) => writeLifAtomic(dir, name, `v${n}\r\n`)));
    assert.equal(readFileSync(p, 'latin1'), 'v3\r\n');
    assert.deepEqual(readdirSync(dir), [name]);

    await assert.rejects(writeLifAtomic(dir, '../x.lif', 'x'), /not a bare file name/);
    await assert.rejects(writeLifAtomic(dir, 'a\\b.lif', 'x'), /not a bare file name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLifAtomic: a reader polling during rewrites only ever sees a whole file', async () => {
  const dir = tmp();
  try {
    const name = '001-1-01.lif';
    const big = (c) => `${c.repeat(200_000)}\r\n`;
    writeFileSync(join(dir, name), big('a'));
    let stop = false;
    const seen = new Set();
    const reader = (async () => {
      while (!stop) {
        const t = readFileSync(join(dir, name), 'latin1');
        seen.add(t.length === 200_002 && (t === big('a') || t === big('b') || t === big('c')) ? 'whole' : `torn:${t.length}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 20; i++) await writeLifAtomic(dir, name, big(['b', 'c'][i % 2]));
    stop = true;
    await reader;
    assert.deepEqual([...seen], ['whole']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
