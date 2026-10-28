import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runScoreboardAgent, AGENT_PRESETS } from './agent.js';
import { createTemplate, restore } from './templates.js';

async function setup(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createTemplate(root, 'board');
  const cli = path.join(root, 'fake-cli.cjs'); await writeFile(cli, source);
  return { root, agent: { command: process.execPath, args: [cli, '{dir}', '{prompt}'] } };
}

test('fake coding CLI gets cwd, full contract, assets, target size and literal prompt substitution', async t => {
  const { root, agent } = await setup(t, `const fs=require('node:fs');
fs.writeFileSync('arguments.json',JSON.stringify({cwd:process.cwd(),dir:process.argv[2],prompt:process.argv[3]}));
fs.appendFileSync('index.html','<!-- edited by fake agent -->');
fs.writeSync(1,'first\\nlast');fs.writeSync(2,'diagnostic\\r\\n');`);
  await writeFile(path.join(root, 'board/assets/central.svg'), '<svg/>');
  await writeFile(path.join(root, 'board/template.json'), JSON.stringify({ size: { w: 1280, h: 720 } }));
  const output = [];
  const result = await runScoreboardAgent({ root, name: 'board', request: 'Add stars, retain literal {dir} and {prompt}', agent, onOutput: chunk => output.push(chunk) });
  assert.equal(result.code, 0); assert.equal(result.restored, false);
  const args = JSON.parse(await readFile(path.join(root, 'board/arguments.json'), 'utf8'));
  assert.equal(args.cwd, path.join(root, 'board')); assert.equal(args.dir, args.cwd);
  for (const pattern of [/Add stars, retain literal \{dir\} and \{prompt\}/, /assets\/central.svg/, /1280 x 720/,
    /Live data contract/, /startedAtMs/, /onData/, /No network requests/, /Edit only files inside/]) assert.match(args.prompt, pattern);
  assert.deepEqual(output.filter(v => v.stream === 'stdout').map(v => v.line), ['first', 'last']);
  assert.deepEqual(output.filter(v => v.stream === 'stderr').map(v => v.line), ['diagnostic']);
  assert.match(await readFile(path.join(root, 'board/index.html'), 'utf8'), /edited by fake agent/);
  await restore(root, 'board', result.snapshotId);
  assert.doesNotMatch(await readFile(path.join(root, 'board/index.html'), 'utf8'), /edited by fake agent/);
});

test('deleted index or missing runtime automatically restores snapshot and reports the failure', async t => {
  for (const body of ["fs.unlinkSync('index.html')", "fs.writeFileSync('index.html','<h1>oops</h1>')"]) {
    const { root, agent } = await setup(t, `const fs=require('node:fs');${body}`);
    const original = await readFile(path.join(root, 'board/index.html'), 'utf8'), output = [];
    const result = await runScoreboardAgent({ root, name: 'board', request: 'Change it', agent, onOutput: value => output.push(value) });
    assert.equal(result.code, 0); assert.equal(result.restored, true);
    assert.match(result.error, /snapshot restored/);
    assert.ok(output.some(v => /snapshot restored/.test(v.line)));
    assert.equal(await readFile(path.join(root, 'board/index.html'), 'utf8'), original);
  }
});

test('agent abort terminates a running CLI and reports code 130', { timeout: 6000 }, async t => {
  const { root, agent } = await setup(t, `require('node:fs').writeSync(1,'ready\\n');setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const result = await runScoreboardAgent({ root, name: 'board', request: 'Change it', agent, signal: controller.signal,
    onOutput: chunk => { if (chunk.line === 'ready') controller.abort(); } });
  assert.equal(result.code, 130); assert.equal(result.aborted, true); assert.equal(result.restored, false);
});

test('missing executable reports spawn failure and preserves undo snapshot', async t => {
  const { root } = await setup(t, '');
  const result = await runScoreboardAgent({ root, name: 'board', request: 'Change it', agent: { command: path.join(root, 'no-cli'), args: [] } });
  assert.equal(result.code, -1); assert.match(result.error, /ENOENT/); assert.ok(result.snapshotId);
});

test('presets match requested argv without approval or sandbox bypass flags', () => {
  assert.deepEqual(AGENT_PRESETS.muse.args, ['exec', '--workspace', '{dir}', '--disable-web-tools', '--user-input-auto-resolve', '{prompt}']);
  assert.deepEqual(AGENT_PRESETS.codex.args, ['exec', '--approve-for-me', '-C', '{dir}', '{prompt}']);
  assert.deepEqual(AGENT_PRESETS.grok.args, ['-p', '{prompt}', '--permission-mode', 'auto', '--cwd', '{dir}']);
  for (const preset of Object.values(AGENT_PRESETS)) assert.doesNotMatch(preset.args.join(' '), /yolo|bypass|dangerously|skip-permissions|disable-approval|disable-sandbox/);
});
