import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

// Completed captures are copied off the acquisition path. A failed secondary
// destination never turns a successfully written result into an unsaved race.
export function createMeetBackup({ writeAtomic, onStatus = () => {} }) {
  const queues = new Map(), statuses = new Map();
  const publish = status => {
    statuses.set(status.meetDir, status);
    try { onStatus(status); } catch { /* a status observer cannot interrupt the backup */ }
    return status;
  };
  async function copy({ meetDir, backupDir, captureDir, captureId, name, text, review }) {
    const input = await fs.realpath(meetDir), backup = await fs.realpath(backupDir);
    const label = path.basename(input).replace(/[^\w-]/g, '_') || 'meet';
    const key = label + '-' + createHash('sha256').update(input).digest('hex').slice(0, 12);
    const root = path.join(backup, 'openmeet-backup', key);
    const source = captureDir ? await fs.realpath(captureDir) : null;
    if (source && within(source, root)) throw Error('Backup folder cannot be inside a recording');
    await fs.mkdir(root, { recursive: true });
    if (captureDir) {
      const target = path.join(root, 'captures', captureId);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try { await fs.access(path.join(target, 'backup-complete.json')); }
      catch {
        const stage = target + '.tmp-' + randomUUID();
        try {
          await fs.cp(source, stage, { recursive: true, dereference: false, errorOnExist: true, force: false });
          await writeAtomic(stage, 'backup-complete.json', JSON.stringify({ captureId, copiedAt: new Date().toISOString() }));
          await fs.rename(stage, target);
        } finally { await fs.rm(stage, { recursive: true, force: true }); }
      }
      if (name) await writeAtomic(target, name, text);
      if (review) await writeAtomic(target, 'review.json', Buffer.from(JSON.stringify(review, null, 2)));
    }
    await fs.mkdir(path.join(root, 'inputs'), { recursive: true });
    for (const file of ['lynx.evt', 'lynx.ppl', 'lynx.sch']) {
      try { await writeAtomic(path.join(root, 'inputs'), file, await fs.readFile(path.join(input, file))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const file of ['starts.jsonl', 'camera-setup.json']) {
      try { await writeAtomic(root, file, await fs.readFile(path.join(input, 'openmeet', file))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (name) {
      await fs.mkdir(path.join(root, 'results'), { recursive: true });
      await writeAtomic(path.join(root, 'results'), name, text);
    }
    return root;
  }
  return {
    status: meetDir => statuses.get(meetDir) || null,
    run(params) {
      const { meetDir, backupDir, captureId } = params;
      if (!backupDir) return Promise.resolve(null);
      const queueKey = `${meetDir}\0${backupDir}`;
      const job = (queues.get(queueKey) || Promise.resolve()).then(async () => {
        publish({ meetDir, backupDir, captureId, state: 'copying' });
        try {
          const target = await copy(params);
          return publish({ meetDir, backupDir, captureId, state: 'complete', target, at: new Date().toISOString() });
        } catch (error) {
          return publish({ meetDir, backupDir, captureId, state: 'error', message: error.message });
        }
      });
      queues.set(queueKey, job);
      const cleanup=()=>{if(queues.get(queueKey)===job)queues.delete(queueKey);};
      job.then(cleanup,cleanup);
      return job;
    },
  };
}
