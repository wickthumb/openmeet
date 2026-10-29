import { readdir, readFile, writeFile, mkdir, rm, rename, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { libraryRoot, containedPath, validateName, copyTree, forbidden } from './paths.js';
import classic from './builtin/classic.js';
import ticker from './builtin/results-ticker.js';

const builtins = { classic, 'results-ticker': ticker };

// Upgrade only an exact previous stock Classic; operator edits remain authoritative.
const previousClassicHashes=new Set(['d5bd065e73a5eb33167e9d0280b22de4960427f3dd8492f1017d7a24e5a9857b']);
export async function refreshBuiltinTemplate(root,name='classic') {
  if(name!=='classic')return {updated:false};
  const library=await libraryRoot(root),dir=await containedPath(library,name),index=await containedPath(dir,'index.html');
  const previous=await readFile(index,'utf8');
  if(!previousClassicHashes.has(createHash('sha256').update(previous).digest('hex')))return {updated:false};
  const snapshotId=await snapshot(root,name),temporary=path.join(dir,`.builtin-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary,classic.html,{flag:'wx'});
    if(await readFile(index,'utf8')!==previous)return {updated:false};
    await rename(temporary,index);return {updated:true,snapshotId};
  } finally {await rm(temporary,{force:true});}
}

/** @param {string} dir */
export async function templateMetadata(dir) {
  let meta = {};
  try {
    const file = await containedPath(dir, 'template.json');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value && typeof value === 'object') meta = value;
  } catch (err) { if (!['ENOENT', 'EACCES'].includes(err.code) && !(err instanceof SyntaxError)) throw err; }
  const dimension = (n, fallback) => Number.isInteger(n) && n > 0 && n <= 16384 ? n : fallback;
  return {
    name: typeof meta.name === 'string' ? meta.name : path.basename(dir),
    description: typeof meta.description === 'string' ? meta.description : '',
    size: { w: dimension(meta.size?.w, 1920), h: dimension(meta.size?.h, 1080) },
  };
}

/** @param {string} root @returns {Promise<Array<{name: string, description: string, size: {w: number, h: number}, title: string}>>} */
export async function listTemplates(root) {
  let dir;
  try { dir = await libraryRoot(root); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const items = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9-]{1,40}$/.test(entry.name)) continue;
    const folder = await containedPath(dir, entry.name);
    try {
      const index = await containedPath(folder, 'index.html');
      if (!(await lstat(index)).isFile()) continue;
      const meta = await templateMetadata(folder);
      items.push({ ...meta, title: meta.name, name: entry.name });
    } catch (err) { if (!['ENOENT', 'EACCES'].includes(err.code)) throw err; }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Existing templates take precedence over built-ins; use builtin:classic to force one.
 * @param {string} root @param {string} name @param {{from?: string}} [options]
 */
export async function createTemplate(root, name, { from = 'classic' } = {}) {
  validateName(name);
  const dir = await libraryRoot(root, true);
  const dest = await containedPath(dir, name, true);
  // An exclusive directory creation prevents overwriting an existing template.
  await mkdir(dest);
  try {
    const forceBuiltin = typeof from === 'string' && from.startsWith('builtin:');
    const sourceName = validateName(forceBuiltin ? from.slice(8) : from);
    let source;
    if (!forceBuiltin) {
      try {
        source = await containedPath(dir, sourceName);
        if (source === dest) source = null; // first-run classic copies its built-in
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    if (source) await copyTree(source, dest);
    else {
      const builtin = builtins[sourceName];
      if (!builtin) throw new Error(`Unknown source template: ${from}`);
      await writeFile(path.join(dest, 'index.html'), builtin.html, { flag: 'wx' });
      await writeFile(path.join(dest, 'template.json'), JSON.stringify({ name: builtin.name, description: builtin.description, size: builtin.size }, null, 2), { flag: 'wx' });
    }
    await mkdir(await containedPath(dest, 'assets', true), { recursive: true });
    const meta = await templateMetadata(dest);
    return { ...meta, title: meta.name, name };
  } catch (err) { await rm(dest, { recursive: true, force: true }); throw err; }
}

/** @param {string} root @param {string} name */
export async function deleteTemplate(root, name) {
  const dir = await libraryRoot(root);
  await rm(await containedPath(dir, validateName(name)), { recursive: true });
}

/** Copy a supported local image using an exclusive, sanitized filename.
 * @param {string} root @param {string} name @param {string} srcPath
 * @returns {Promise<string>} Template-relative asset path.
 */
export async function addAsset(root, name, srcPath) {
  const dir = await containedPath(await libraryRoot(root), validateName(name));
  const assets = await containedPath(dir, 'assets', true);
  await mkdir(assets, { recursive: true });
  const ext = path.extname(srcPath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp'].includes(ext)) throw new Error('Unsupported image extension');
  const source = await lstat(srcPath);
  if (!source.isFile() || source.isSymbolicLink()) throw forbidden('Image source must be a regular file');
  const stem = path.basename(srcPath, path.extname(srcPath)).normalize('NFKD')
    .replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'image';
  const filename = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
  const target = await open(path.join(assets, filename), 'wx');
  try { await target.writeFile(await readFile(srcPath)); } finally { await target.close(); }
  return `assets/${filename}`;
}

/** Snapshot IDs sort chronologically and are safe path segments. */
function validateSnapshotId(id) {
  if (typeof id !== 'string' || !/^\d{13,}-[a-f0-9]{8}$/.test(id)) throw forbidden('Invalid snapshot ID');
  return id;
}

/** @param {string} root @param {string} name @returns {Promise<string>} */
export async function snapshot(root, name) {
  const dir = await containedPath(await libraryRoot(root), validateName(name));
  const history = await containedPath(dir, '.history', true);
  await mkdir(history, { recursive: true });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dest = path.join(history, id);
  try { await copyTree(dir, dest); } catch (err) { await rm(dest, { recursive: true, force: true }); throw err; }
  return id;
}

/** Stage a complete checked copy before replacing current files; keep all history.
 * @param {string} root @param {string} name @param {string} snapshotId
 */
export async function restore(root, name, snapshotId) {
  const library = await libraryRoot(root);
  const dir = await containedPath(library, validateName(name));
  const source = await containedPath(dir, `.history/${validateSnapshotId(snapshotId)}`);
  const stage = path.join(library, `.restore-${randomUUID()}`);
  try {
    await copyTree(source, stage);
    for (const entry of await readdir(dir)) {
      if (entry !== '.history') await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    for (const entry of await readdir(stage)) await rename(path.join(stage, entry), path.join(dir, entry));
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { name, snapshotId, restored: true };
}
