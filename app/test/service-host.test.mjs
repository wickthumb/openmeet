import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {replayFixture} from './support/replay-fixture.mjs';
import {createMeetBackup} from '../meet-backup.mjs';

function host(userData,t){
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_CROP_'))delete env[key];
  const child=fork(new URL('./support/service-audit-process.mjs',import.meta.url),[userData],{env,stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
  const pending=new Map();let id=0;
  child.on('message',m=>{const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
  t.after(()=>{child.kill();for(const p of pending.values())clearTimeout(p.timer);});
  return {child,call(method,params={}){return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('Timed out: '+method));},10000);pending.set(key,{resolve,reject,timer});child.send({id:key,method,params});});}};
}
async function captured(t){
  const root=await mkdtemp('/tmp/openmeet-service-audit-');t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=await replayFixture(root,'ttp-simulator'),engine=host(path.join(root,'settings'),t);
  const source=await engine.call('demo.import',{dir:fixture.dir,type:'ttp'}),replay=await engine.call('demo.load',{id:source.id});
  const cap=await engine.call('capture.start',{key:'5-1-1',png:replay.heats[0].primary,meetDir:replay.meet.dir,speed:10});
  await delay(80);await engine.call('capture.stop');return {engine,cap};
}
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');

test('a failed backup status observer cannot reject or stall later backup jobs',async t=>{
  const root=await mkdtemp('/tmp/openmeet-backup-observer-');t.after(()=>rm(root,{recursive:true,force:true}));
  const meetDir=path.join(root,'meet'),backupDir=path.join(root,'backup');await mkdir(meetDir);await mkdir(backupDir);
  await writeFile(path.join(meetDir,'lynx.evt'),'5,1,1,Test heat\n');
  const backup=createMeetBackup({onStatus(){throw Error('Observer disconnected');},writeAtomic:async(dir,name,text)=>{const file=path.join(dir,name);await writeFile(file+'.tmp',text);await rename(file+'.tmp',file);}});
  const first=await backup.run({meetDir,backupDir,name:'005-1-01.lif',text:'first'});
  assert.equal(first.state,'complete');assert.equal(await readFile(path.join(first.target,'results/005-1-01.lif'),'utf8'),'first');
  const second=await backup.run({meetDir,backupDir,name:'005-1-01.lif',text:'second'});
  assert.equal(second.state,'complete');assert.equal(await readFile(path.join(second.target,'results/005-1-01.lif'),'utf8'),'second');
});

test('concurrent cold timing requests share one stand-in server and shutdown releases it',async t=>{
  const {engine,cap}=await captured(t);
  const params={captureId:cap.id,heat:{event:'5',round:1,heat:1},startList:[{lane:2,id:0}]};
  const outputs=await Promise.all(Array.from({length:12},()=>engine.call('autotiming.predict',params)));
  assert.ok(outputs.every(result=>result.stub&&result.model==='stub-truth-0'));
  assert.equal((await engine.call('audit.metrics')).listeningServers,1);
  const closed=new Promise(resolve=>engine.child.once('exit',resolve));engine.child.disconnect();
  assert.notEqual(await Promise.race([closed.then(()=>true),delay(2000).then(()=>false)]),false,'Disconnected host retained a service listener or file watcher');
});

test('concurrent crop requests share one strip read and identical output without rewriting evidence',async t=>{
  const {engine,cap}=await captured(t),files=['columns.bin','times.f64'].map(file=>path.join(cap.dir,file));
  const hashes=await Promise.all(files.map(hash)),before=await engine.call('audit.metrics');
  const results=await Promise.all(Array.from({length:16},()=>engine.call('autocrop.run',{captureId:cap.id})));
  const after=await engine.call('audit.metrics');assert.equal(after.columnStoreOpens-before.columnStoreOpens,1);
  for(const result of results)assert.deepEqual(result,results[0]);assert.equal(results[0].runtime,'native-cpu');
  assert.deepEqual(await Promise.all(files.map(hash)),hashes);
});

test('external crop response byte bounds cancel oversize bodies and failed jobs can retry',async t=>{
  const {engine,cap}=await captured(t);let mode='declared',requestCount=0;
  const server=createServer(async(req,res)=>{
    if(req.url==='/health'){
      if(mode==='stream'){
        res.setHeader('Content-Type','application/json');res.write('{"ready":true,"padding":"');
        for(let i=0;i<30&&!res.destroyed;i++){res.write('x'.repeat(8192));await delay(2);}if(!res.destroyed)res.end('"}');
      }else res.end(JSON.stringify({ready:true,contract:'autocrop-ranges-v2'}));
      return;
    }
    requestCount++;let raw='';for await(const chunk of req)raw+=chunk;
    if(mode==='declared'){res.writeHead(200,{'Content-Length':64*1024*1024+1});res.write('{');return;}
    const p=JSON.parse(raw),width=Buffer.from(p.image.data_base64,'base64').readUInt32BE(16),columns=Array.from({length:width},(_,i)=>i);
    const modes=Object.fromEntries([['storage-display',8,0],['inference-safe',160,320]].map(([name,padding,gap])=>[name,{mode:name,padding,merge_gap_lt:gap,ranges:[[0,width]],cropped_to_original:columns}]));
    res.end(JSON.stringify({request_id:p.request_id,image_sha256:p.image_sha256,result:{schema:'autocrop-ranges-v2',original_width:width,approved:true,modes}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  await engine.call('settings.set',{patch:{cropServiceUrl:`http://127.0.0.1:${server.address().port}`}});
  await assert.rejects(engine.call('autocrop.run',{captureId:cap.id}),/byte limit/);
  mode='stream';assert.equal((await engine.call('autocrop.info')).ready,false,'Unbounded health response was accepted');
  mode='valid';const info=await engine.call('autocrop.info');assert.equal(info.ready,true);
  const result=await engine.call('autocrop.run',{captureId:cap.id});assert.equal(result.result.approved,true);assert.equal(requestCount,2);
});
