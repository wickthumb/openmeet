import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listTemplates, createTemplate, deleteTemplate, addAsset, snapshot, restore } from './templates.js';

async function temp(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-templates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('create, list, copy, image import, snapshot and restore round-trip', async t => {
  const root = await temp(t);
  assert.deepEqual(await listTemplates(path.join(root, 'missing')), []);
  const created = await createTemplate(root, 'classic');
  assert.equal(created.title, 'Classic');
  assert.deepEqual(created.size, { w: 1920, h: 1080 });
  const original = await readFile(path.join(root, 'classic/index.html'), 'utf8');
  assert.match(original, /src="\/scoreboard\/runtime.js"/);
  const source = path.join(root, 'Team Logo (2026).PNG');
  await writeFile(source, Buffer.from([137, 80, 78, 71]));
  const asset = await addAsset(root, 'classic', source);
  assert.match(asset, /^assets\/team-logo-2026-[a-f0-9]{8}\.png$/);
  assert.deepEqual(await readFile(path.join(root, 'classic', asset)), await readFile(source));
  assert.notEqual(await addAsset(root, 'classic', source), asset);
  const id = await snapshot(root, 'classic');
  await writeFile(path.join(root, 'classic/index.html'), 'changed');
  await writeFile(path.join(root, 'classic/extra.txt'), 'remove me');
  await restore(root, 'classic', id);
  assert.equal(await readFile(path.join(root, 'classic/index.html'), 'utf8'), original);
  await assert.rejects(readFile(path.join(root, 'classic/extra.txt')), { code: 'ENOENT' });
  const id2 = await snapshot(root, 'classic');
  assert.notEqual(id, id2);
  assert.equal((await readdir(path.join(root, 'classic/.history', id))).includes('.history'), false);
  await createTemplate(root, 'copy', { from: 'classic' });
  assert.equal(await readFile(path.join(root, 'copy/index.html'), 'utf8'), original);
  await assert.rejects(readFile(path.join(root, 'copy/.history', id, 'index.html')), { code: 'ENOENT' });
  await createTemplate(root, 'overlay', { from: 'results-ticker' });
  assert.match(await readFile(path.join(root, 'overlay/index.html'), 'utf8'), /background:transparent/);
  assert.deepEqual((await listTemplates(root)).map(v => v.name), ['classic', 'copy', 'overlay']);
  await assert.rejects(createTemplate(root, 'classic'), { code: 'EEXIST' });
  await deleteTemplate(root, 'copy');
  assert.deepEqual((await listTemplates(root)).map(v => v.name), ['classic', 'overlay']);
});

test('template operations reject traversal and symlinks without changing outside files', async t => {
  const root = await temp(t), outside = await temp(t);
  await createTemplate(root, 'classic');
  await writeFile(path.join(outside, 'secret'), 'keep');
  await symlink(outside, path.join(root, 'escape'));
  for (const name of ['../escape', '', 'UPPER', 'a/b', 'a'.repeat(41)]) {
    await assert.rejects(createTemplate(root, name));
    await assert.rejects(deleteTemplate(root, name));
  }
  await assert.rejects(createTemplate(root, 'copy', { from: 'escape' }), { code: 'EACCES' });
  await assert.rejects(deleteTemplate(root, 'escape'), { code: 'EACCES' });
  await assert.rejects(restore(root, 'classic', '../../escape'), { code: 'EACCES' });
  await symlink(outside, path.join(root, 'classic/assets/link'));
  await assert.rejects(snapshot(root, 'classic'), { code: 'EACCES' });
  await assert.rejects(createTemplate(root, 'copy', { from: 'classic' }), { code: 'EACCES' });
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'keep');
  await rm(path.join(root, 'classic/assets'), { recursive: true });
  await symlink(outside, path.join(root, 'classic/assets'));
  const image = path.join(root, 'logo.png'); await writeFile(image, 'image');
  await assert.rejects(addAsset(root, 'classic', image), { code: 'EACCES' });
  assert.deepEqual(await readdir(outside), ['secret']);
});

test('restore safely removes an agent-created symlink and malformed metadata gets defaults', async t => {
  const root = await temp(t), outside = await temp(t);
  await createTemplate(root, 'classic');
  const id = await snapshot(root, 'classic');
  await symlink(outside, path.join(root, 'classic/bad-link'));
  await restore(root, 'classic', id);
  await writeFile(path.join(root, 'classic/template.json'), '{bad json');
  assert.equal((await listTemplates(root))[0].title, 'classic');
  await writeFile(path.join(root, 'classic/template.json'), JSON.stringify({ size: { w: -1, h: 'bad' } }));
  assert.deepEqual((await listTemplates(root))[0].size, { w: 1920, h: 1080 });
  await mkdir(path.join(root, 'empty'));
  assert.equal((await listTemplates(root)).length, 1);
});
