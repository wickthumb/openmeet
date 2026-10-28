// Shared containment rules. Reject all descendant symlinks, even links within the
// library, so copying, serving, restoring and agent cwd use the same boundary.
import { lstat, mkdir, realpath, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

/** @param {string} message */
export function forbidden(message = 'Path is outside the scoreboard library') {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

/** @param {string} name */
export function validateName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(name)) throw forbidden('Invalid template name');
  return name;
}

/** @param {string} root @param {boolean} [create] */
export async function libraryRoot(root, create = false) {
  if (typeof root !== 'string' || !root) throw new Error('A scoreboard library root is required');
  const dir = path.resolve(root);
  if (create) await mkdir(dir, { recursive: true });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw forbidden('Library root must be a directory, not a symlink');
  return realpath(dir);
}

/** Resolve a relative path, checking every existing component before use.
 * @param {string} root Canonical root.
 * @param {string} relative
 * @param {boolean} [allowMissing]
 */
export async function containedPath(root, relative, allowMissing = false) {
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[\\:\u0000]/.test(p))) throw forbidden();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw forbidden('Symlinks are not allowed in templates');
    } catch (err) {
      if (allowMissing && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return current;
}

/** Copy regular files/directories only, never symlinks or nested histories.
 * @param {string} source @param {string} target
 */
export async function copyTree(source, target) {
  const st = await lstat(source);
  if (st.isSymbolicLink()) throw forbidden('Cannot copy a symlink');
  if (st.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry !== '.history') await copyTree(path.join(source, entry), path.join(target, entry));
    }
  } else if (st.isFile()) {
    await copyFile(source, target, /* COPYFILE_EXCL */ 1);
  } else throw forbidden('Templates may contain only regular files and directories');
}
