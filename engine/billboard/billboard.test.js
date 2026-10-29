import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createBillboard,readBillboard,listBillboards,runBillboardAgent,restoreBillboard,validateBillboardSvg,AGENT_PRESETS,importBillboardSvg} from './index.js';
import {AGENT_PRESETS as scoreboardPresets} from '../scoreboard/agent.js';
async function fixture(t,body=''){
 const root=await mkdtemp(path.join(os.tmpdir(),'openmeet-billboard-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await createBillboard(root,'art');const fake=path.join(root,'fake.cjs');await writeFile(fake,body);
 return {root,agent:{command:process.execPath,args:[fake,'{prompt}','{dir}']}};
}
test('separate library creates, copies and reads only contained image paths',async t=>{
 const {root}=await fixture(t);await createBillboard(root,'copy',{from:'art'});
 assert.deepEqual((await listBillboards(root)).map(b=>b.name),['art','copy']);
 assert.match((await readBillboard(root,'art')).dataUrl,/^data:image\/svg\+xml;base64,/);
 await assert.rejects(readBillboard(root,'art','../index.html'));await assert.rejects(createBillboard(root,'../escape'));
 await assert.rejects(createBillboard(root,'art'));
});
test('fake CLI edits SVG, receives billboard contract, streams and can undo; approval flags unchanged',async t=>{
 const {root,agent}=await fixture(t,`const fs=require('node:fs');fs.writeFileSync('prompt.txt',process.argv[2]);fs.writeFileSync('cwd.txt',process.cwd());let svg=fs.readFileSync('assets/billboard.svg','utf8');fs.writeFileSync('assets/billboard.svg',svg.replace('OpenMeet','Test artwork'));fs.writeSync(1,'fake edit\\n');`);
 const original=await readFile(path.join(root,'art/assets/billboard.svg'),'utf8'),output=[];
 const result=await runBillboardAgent({root,name:'art',request:'Blue sponsor logo',agent,onOutput:d=>output.push(d)});
 assert.equal(result.code,0);assert.equal(result.restored,false);assert.ok(output.some(d=>d.line==='fake edit'));
 assert.match(await readFile(path.join(root,'art/prompt.txt'),'utf8'),/STATIC LINE-SCAN BILLBOARD/);
 assert.match(await readFile(path.join(root,'art/prompt.txt'),'utf8'),/Edit ONLY assets\/billboard.svg/);
 assert.equal(await readFile(path.join(root,'art/cwd.txt'),'utf8'),path.join(root,'art'));
 await restoreBillboard(root,'art',result.snapshotId);assert.equal(await readFile(path.join(root,'art/assets/billboard.svg'),'utf8'),original);
 assert.deepEqual(AGENT_PRESETS,scoreboardPresets);
});
test('invalid asset or modified wrapper automatically rolls back; valid nonzero edits remain reviewable',async t=>{
 for(const body of [`fs.writeFileSync('assets/billboard.svg','<html>oops</html>')`,`fs.writeFileSync('assets/billboard.svg','<svg><script>alert(1)</script></svg>')`,`fs.appendFileSync('index.html','changed')`,`fs.unlinkSync('index.html')`]){
  const {root,agent}=await fixture(t,`const fs=require('node:fs');${body}`);
  const before=(await readBillboard(root,'art')).dataUrl;
  const result=await runBillboardAgent({root,name:'art',request:'Change artwork',agent});assert.equal(result.restored,true);assert.match(result.error,/snapshot restored/);
  assert.equal((await readBillboard(root,'art')).dataUrl,before);
 }
 const {root,agent}=await fixture(t,`process.exitCode=2`);const result=await runBillboardAgent({root,name:'art',request:'x',agent});assert.equal(result.code,2);assert.equal(result.restored,false);
});
test('SVG resource validation accepts gradients and rejects network and active content',()=>{
 assert.doesNotThrow(()=>validateBillboardSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#gradient)"/></svg>'));
 for(const value of ['<svg><image href="https://example.org/a.png"/></svg>','<svg><foreignObject/></svg>','<svg onload="x()"></svg>','<svg><style>@import "x";</style></svg>'])assert.throws(()=>validateBillboardSvg(value));
});
test('JS-only packaged layout resolves reused helpers and fake CLI without docs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'openmeet-billboard-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const engine=path.join(root,'engine');await mkdir(engine);
 for(const name of ['billboard','scoreboard'])await cp(fileURLToPath(new URL('../'+name,import.meta.url)),path.join(engine,name),{recursive:true,filter:file=>!file.endsWith('.test.js')&&!file.includes('/fixtures')});
 await writeFile(path.join(engine,'package.json'),'{"type":"module"}');
 const api=await import(pathToFileURL(path.join(engine,'billboard/index.js')).href),library=path.join(root,'library');await api.createBillboard(library,'packaged');
 const fake=path.join(root,'fake.cjs');await writeFile(fake,"console.log('packaged fake');");
 const result=await api.runBillboardAgent({root:library,name:'packaged',request:'Test',agent:{command:process.execPath,args:[fake]}});assert.equal(result.code,0);assert.equal(result.restored,false);
});

test('local SVG import is previewable and undoable without a coding CLI',async t=>{
 const {root}=await fixture(t),before=(await readBillboard(root,'art')).dataUrl,file=path.join(root,'local.svg');
 await writeFile(file,'<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10" fill="red"/></svg>');
 const result=await importBillboardSvg(root,'art',file);assert.notEqual((await readBillboard(root,'art')).dataUrl,before);
 await restoreBillboard(root,'art',result.snapshotId);assert.equal((await readBillboard(root,'art')).dataUrl,before);
 await writeFile(file,'<svg><script>bad()</script></svg>');await assert.rejects(importBillboardSvg(root,'art',file));assert.equal((await readBillboard(root,'art')).dataUrl,before);
});
