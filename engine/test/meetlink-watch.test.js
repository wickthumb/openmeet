import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchMeetFolder, diffHeat } from '../meetlink/watch.js';
import { parseEvt } from '../meetlink/parse.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'openmeet-watch-'));

/** Collects watcher snapshots; next(n) waits until n have arrived. */
function collector() {
  /** @type {any[]} */
  const items = [];
  /** @type {(() => void)[]} */
  let waiters = [];
  const onChange = (s) => {
    items.push(s);
    for (const w of waiters) w();
    waiters = [];
  };
  const next = (n = items.length + 1, ms = 4000) => new Promise((resolve, reject) => {
    const check = () => {
      if (items.length >= n) {
        clearTimeout(timer);
        resolve(items[n - 1]);
        return true;
      }
      return false;
    };
    const timer = setTimeout(() => reject(new Error(`timed out waiting for change #${n} (have ${items.length})`)), ms);
    if (!check()) waiters.push(function again() { if (!check()) waiters.push(again); });
  });
  return { items, onChange, next };
}

const EVT1 = '1,1,1,Men 100\r\n,11,1,A,One\r\n,12,2,B,Two\r\n';
const EVT2 = '1,1,1,Men 100\r\n,11,3,A,One\r\n,13,2,C,Three\r\n';

for (const mode of ['fs.watch', 'polling only']) {
  test(`${mode}: initial emit, change, delete`, async () => {
    const dir = tmp();
    const c = collector();
    const fsWatch = mode === 'fs.watch';
    // fs.watch mode polls rarely so the watch path is what delivers changes.
    const close = watchMeetFolder(dir, c.onChange, { fsWatch, debounceMs: 30, settleMs: 60, pollMs: fsWatch ? 60_000 : 40 });
    try {
      writeFileSync(join(dir, 'lynx.evt'), EVT1);
      writeFileSync(join(dir, 'lynx.sch'), '1,1,1\r\n');
      let s = await c.next(1);
      if (s.changed.length < 2) s = await c.next(2); // the two files may land in separate scans
      assert.deepEqual(s.events, parseEvt(EVT1));
      assert.deepEqual(s.schedule, [{ event: '1', round: 1, heat: 1 }]);
      assert.deepEqual(s.people, []);

      const n = c.items.length;
      writeFileSync(join(dir, 'lynx.evt'), EVT2);
      s = await c.next(n + 1);
      assert.deepEqual(s.changed, ['lynx.evt']);
      assert.deepEqual(s.events, parseEvt(EVT2));
      assert.deepEqual(s.schedule, [{ event: '1', round: 1, heat: 1 }], 'unchanged files keep their data');

      unlinkSync(join(dir, 'lynx.sch'));
      s = await c.next(n + 2);
      assert.deepEqual(s.changed, ['lynx.sch']);
      assert.deepEqual(s.schedule, []);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('files already present at start are emitted; names match case-insensitively', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'LYNX.EVT'), EVT1);
  writeFileSync(join(dir, 'Lynx.Ppl'), '11,A,One,Club\r\n');
  const c = collector();
  const close = watchMeetFolder(dir, c.onChange, { debounceMs: 20, settleMs: 40, pollMs: 40 });
  try {
    let s = await c.next(1);
    if (s.changed.length < 2) s = await c.next(2); // files settle independently
    assert.deepEqual(c.items.flatMap((i) => i.changed).sort(), ['lynx.evt', 'lynx.ppl']);
    assert.equal(s.people[0].affiliation, 'Club');
    assert.equal(s.events[0].entries.length, 2);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mid-write: empty file and unparsable file are not emitted; last good data is kept; retried', async () => {
  const dir = tmp();
  const c = collector();
  /** @type {string[]} */
  const errors = [];
  const close = watchMeetFolder(dir, c.onChange, {
    fsWatch: false, pollMs: 30, settleMs: 40, onError: (e, f) => errors.push(`${f}: ${e.message}`),
  });
  try {
    writeFileSync(join(dir, 'lynx.evt'), EVT1);
    await c.next(1);

    writeFileSync(join(dir, 'lynx.evt'), ''); // truncated by the writer
    await sleep(250);
    writeFileSync(join(dir, 'lynx.evt'), '1,x'); // garbage: round is not an integer
    await sleep(250);
    assert.equal(c.items.length, 1, 'nothing emitted for empty or unparsable content');
    assert.deepEqual(errors, ['lynx.evt: line 1: round "x" is not an integer'], 'error reported once per version');

    writeFileSync(join(dir, 'lynx.evt'), EVT2);
    const s = await c.next(2);
    assert.deepEqual(s.events, parseEvt(EVT2));
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mid-write: a file still growing is not read until it holds still', async () => {
  const dir = tmp();
  const c = collector();
  const close = watchMeetFolder(dir, c.onChange, { fsWatch: false, pollMs: 20, settleMs: 400 });
  try {
    const half = EVT1.slice(0, EVT1.indexOf(',12')); // valid on its own: heat with one entry
    writeFileSync(join(dir, 'lynx.evt'), half);
    await sleep(50);
    appendFileSync(join(dir, 'lynx.evt'), EVT1.slice(half.length));
    const s = await c.next(1);
    assert.equal(s.events[0].entries.length, 2, 'the half-written version was never emitted');
    await sleep(100);
    assert.equal(c.items.length, 1);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('touching a file without changing it does not emit; close() stops emits', async () => {
  const dir = tmp();
  const c = collector();
  const close = watchMeetFolder(dir, c.onChange, { debounceMs: 20, settleMs: 30, pollMs: 30 });
  try {
    writeFileSync(join(dir, 'lynx.evt'), EVT1);
    await c.next(1);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'lynx.evt'), later, later);
    await sleep(250);
    assert.equal(c.items.length, 1, 'same bytes, new mtime: no emit');
    await close();
    writeFileSync(join(dir, 'lynx.evt'), EVT2);
    await sleep(250);
    assert.equal(c.items.length, 1, 'no emits after close');
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same size, same mtime rewrite (coarse timestamps) is caught by the periodic content check', async () => {
  const dir = tmp();
  const c = collector();
  const close = watchMeetFolder(dir, c.onChange, { fsWatch: false, pollMs: 30, settleMs: 30, rereadMs: 150 });
  try {
    const p = join(dir, 'lynx.evt');
    const a = '1,1,1,Men 100\r\n,11,3,A,One\r\n,12,4,B,Two\r\n';
    const b = '1,1,1,Men 100\r\n,11,4,A,One\r\n,12,3,B,Two\r\n'; // lane swap, same length
    writeFileSync(p, a);
    const fixed = new Date('2026-10-28T12:00:00Z');
    utimesSync(p, fixed, fixed);
    await c.next(1);
    writeFileSync(p, b);
    utimesSync(p, fixed, fixed);
    const s = await c.next(2);
    assert.deepEqual(s.events[0].entries.map((e) => [e.id, e.lane]), [['11', 4], ['12', 3]]);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing folder: no crash, picks up once created', async () => {
  const parent = tmp();
  const dir = join(parent, 'meet');
  const c = collector();
  const close = watchMeetFolder(dir, c.onChange, { debounceMs: 20, settleMs: 30, pollMs: 30 });
  try {
    await sleep(80);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    writeFileSync(join(dir, 'lynx.evt'), EVT1);
    const s = await c.next(1);
    assert.equal(s.events.length, 1);
  } finally {
    await close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('diffHeat: added, removed, lane, name, affiliation, status and header changes', () => {
  const [a] = parseEvt('1,1,1,Men 100\n,11,1,A,One,X\n,12,2,B,Two,Y\n,14,4,D,Four,Z\n,0,6,No,Id,Q\n');
  const [b] = parseEvt('1,1,1,Men 100 Final\n,11,3,A,One,X\n,13,2,C,Three,Y\n\\DNS,14,4,Dee,Four,W\n,0,6,No,Name,Q\n');
  const d = diffHeat(a, b);
  assert.equal(d.changed, true);
  assert.deepEqual(d.added.map((e) => e.id), ['13']);
  assert.deepEqual(d.removed.map((e) => e.id), ['12']);
  assert.deepEqual(d.laneChanges, [{ id: '11', last: 'A', first: 'One', from: 1, to: 3 }]);
  assert.deepEqual(d.nameChanges, [
    { id: '14', lane: 4, from: { last: 'D', first: 'Four' }, to: { last: 'Dee', first: 'Four' } },
    { id: null, lane: 6, from: { last: 'No', first: 'Id' }, to: { last: 'No', first: 'Name' } },
  ]);
  assert.deepEqual(d.affiliationChanges, [{ id: '14', lane: 4, from: 'Z', to: 'W' }]);
  assert.deepEqual(d.statusChanges, [{ id: '14', lane: 4, from: null, to: 'DNS' }]);
  assert.deepEqual(d.headerChanges, [{ field: 'name', from: 'Men 100', to: 'Men 100 Final' }]);

  assert.equal(diffHeat(a, a).changed, false);
  assert.equal(diffHeat(null, a).added.length, 4);
  assert.equal(diffHeat(a, undefined).removed.length, 4);
});
