import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Sensor timestamps are only comparable within the same clock domain.
// Journal entries are appended and fsynced before a caller receives acknowledgement.
export function openStartJournal(meetDir) {
  const dir = join(meetDir, 'openmeet');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'starts.jsonl');
  if (existsSync(file)) {
    const bytes = readFileSync(file), end = bytes.lastIndexOf(10) + 1;
    if (end !== bytes.length) truncateSync(file, end); // discard only an interrupted final append
  }
  const events = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  function append(event) {
    const fd = openSync(file, 'a');
    try { appendFileSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    events.push(event);
    return event;
  }
  const triggers = () => events.filter(e => e.type === 'trigger');
  return {
    record({ clockId, timeS, wallTimeMs = Date.now(), source = 'sensor', captureId = null }) {
      if (typeof clockId !== 'string' || !clockId || !Number.isFinite(timeS) || !Number.isFinite(wallTimeMs)) throw new Error('Start trigger needs a clock and finite timestamp');
      return append({ type: 'trigger', id: randomUUID(), clockId, timeS, wallTimeMs, source, captureId });
    },
    assign({ heatKey, triggerId, referenceTriggerId }) {
      const all = triggers(), trigger = all.find(t => t.id === triggerId), reference = all.find(t => t.id === referenceTriggerId);
      if (typeof heatKey !== 'string' || !heatKey || !trigger || !reference) throw new Error('Unknown heat or start trigger');
      if (trigger.clockId !== reference.clockId) throw new Error('Start triggers use different clocks');
      return append({ type: 'assignment', id: randomUUID(), heatKey, triggerId, referenceTriggerId, offsetS: trigger.timeS - reference.timeS, at: Date.now() });
    },
    list() {
      const assignments = {};
      for (const event of events) if (event.type === 'assignment') assignments[event.heatKey] = event;
      return { triggers: triggers(), assignments, history: events.filter(e => e.type === 'assignment') };
    },
  };
}
