import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Serialize small engine-owned documents with a same-directory atomic replacement.
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    try {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* Directory fsync is unavailable on some platforms. */ }
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function appendReviewEvent(file, event) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeFileSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
