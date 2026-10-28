import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { libraryRoot, containedPath, validateName } from './paths.js';
import { snapshot, restore, templateMetadata } from './templates.js';
import { SCOREBOARD_DATA_CONTRACT } from './state.js';

/**
 * Muse Code (Meta) 1.4.14: `muse exec` is headless with tool approval and the OS sandbox ON by default, plus an
 * LLM approval judge. Never add --yolo / --disable-approval / --disable-sandbox here.
 */
export const AGENT_PRESETS = Object.freeze({
  muse: Object.freeze({ command: 'muse', args: Object.freeze(['exec', '--workspace', '{dir}', '--disable-web-tools', '--user-input-auto-resolve', '{prompt}']) }),
  codex: Object.freeze({ command: 'codex', args: Object.freeze(['exec', '--approve-for-me', '-C', '{dir}', '{prompt}']) }),
  grok: Object.freeze({ command: 'grok', args: Object.freeze(['-p', '{prompt}', '--permission-mode', 'auto', '--cwd', '{dir}']) }),
});

const active = new Set();

/** @param {string} dir @returns {Promise<string[]>} */
async function assetFiles(dir) {
  const files = [];
  async function walk(relative) {
    let folder;
    try { folder = await containedPath(dir, relative); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const rel = relative + '/' + entry.name;
      await containedPath(dir, rel); // reject links before inspecting entries
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  await walk('assets');
  return files.sort();
}

/** @param {string} dir @param {string} request */
async function composePrompt(dir, request) {
  let contract;
  try { contract = await readFile(new URL('../../docs/scoreboard-v1.md', import.meta.url), 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; contract = SCOREBOARD_DATA_CONTRACT; }
  const meta = await templateMetadata(dir), assets = await assetFiles(dir);
  return `Build this OpenMeet scoreboard for the operator.

Operator request:
${request}

Requirements:
- Edit only files inside this template folder: ${dir}. Never edit .history/.
- index.html must load <script src="/scoreboard/runtime.js"></script>.
- Render meet, race and results data only from OpenMeetScoreboard.onData(state => { ... }).
- Use OpenMeetScoreboard.raceTime(state) with requestAnimationFrame for the smooth clock.
- No network requests except the provided runtime's local live feed. No external fonts, URLs, libraries, or frameworks. All assets must be local.
- Logos and images are in assets/. Use their template-relative paths.
- Target canvas size: ${meta.size.w} x ${meta.size.h} pixels. Scale cleanly to the window.
- Preserve a working index.html. Treat all athlete and meet strings as text, never HTML.

Existing assets:
${assets.length ? assets.map(file => '- ' + file).join('\n') : '(none)'}

Data contract and integration documentation (docs/scoreboard-v1.md):
${contract}`;
}

/**
 * Run an operator-configured local coding CLI. cwd and prompt are not a sandbox:
 * the installed CLI retains its own permissions and approval policy.
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.name
 * @param {string} options.request
 * @param {{command: string, args: readonly string[]}} options.agent
 * @param {(output: {stream: 'stdout'|'stderr', line: string}) => void} [options.onOutput]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{code: number, snapshotId: string, restored: boolean, aborted: boolean, error?: string}>}
 */
export async function runScoreboardAgent({ root, name, request, agent, onOutput = () => {}, signal }) {
  validateName(name);
  if (typeof request !== 'string' || !request.trim()) throw new Error('An agent request is required');
  if (!agent || typeof agent.command !== 'string' || !agent.command || !Array.isArray(agent.args) || agent.args.some(arg => typeof arg !== 'string')) throw new Error('Invalid coding agent configuration');
  const library = await libraryRoot(root), dir = await containedPath(library, name);
  if (active.has(dir)) throw new Error('A scoreboard agent is already editing this template');
  active.add(dir);
  try {
    const snapshotId = await snapshot(library, name);
    const prompt = await composePrompt(dir, request);
    // Replace placeholders in the original args only; placeholder-looking text
    // inside an operator request or directory is never interpreted a second time.
    const args = agent.args.map(arg => arg.replace(/\{(prompt|dir)\}/g, (_, token) => token === 'prompt' ? prompt : dir));
    let aborted = signal?.aborted ?? false, error;
    const output = (stream, line) => {
      try { onOutput({ stream, line }); } catch { /* observer cannot interrupt recovery */ }
    };
    const code = aborted ? 130 : await new Promise(resolve => {
      let child, killTimer;
      const group = process.platform !== 'win32';
      const kill = type => {
        try { if (group) process.kill(-child.pid, type); else child.kill(type); } catch { /* exited */ }
      };
      const abort = () => {
        aborted = true;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      };
      try { child = spawn(agent.command, args, { cwd: dir, shell: false, detached: group, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (err) { error = err.message; resolve(-1); return; }
      for (const stream of ['stdout', 'stderr']) {
        const lines = createInterface({ input: child[stream], crlfDelay: Infinity });
        lines.on('line', line => output(stream, line));
      }
      child.on('error', err => { error = err.message; output('stderr', err.message); });
      child.on('close', (exitCode, exitSignal) => {
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (exitSignal && !aborted) error = `Agent exited on ${exitSignal}`;
        resolve(aborted ? 130 : error ? -1 : exitCode ?? -1);
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    let restored = false;
    try {
      const index = await containedPath(dir, 'index.html');
      if (!(await lstat(index)).isFile()) throw new Error('index.html is not a regular file');
      const html = await readFile(index, 'utf8');
      if (!/<script\b[^>]*\bsrc\s*=\s*(["'])\/scoreboard\/runtime\.js\1[^>]*>/i.test(html)) throw new Error('index.html must load /scoreboard/runtime.js');
    } catch (err) {
      await restore(library, name, snapshotId);
      restored = true;
      error = `Template validation failed; snapshot restored: ${err.message}`;
      output('stderr', error);
    }
    return { code, snapshotId, restored, aborted, ...(error ? { error } : {}) };
  } finally { active.delete(dir); }
}
