// Run real Electron against disposable local folders. Optional recorded input is copied
// into /tmp; original footage, private workers and source settings are never modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replayFixture } from './support/replay-fixture.mjs';
import { sourceId, readReplayFolder } from '../simulation-sources.mjs';
import { parseEvt, decodePng, openCaptureStore } from '../../engine/index.js';
import { columnsOf } from '../../engine/sim/replay.js';

const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname);
const actualDir=process.argv[3];
const root=await mkdtemp(path.join(tmpdir(),'openmeet-replay-ui-'));
console.log('Local check output:',root);
const settingsDir=path.join(root,'settings');await mkdir(settingsDir);
let realDir;
if(actualDir){realDir=path.join(root,'real');await cp(path.resolve(actualDir),realDir,{recursive:true,filter:src=>path.basename(src)!=='openmeet'});}
else realDir=(await replayFixture(root)).dir;
const ttpRoot=path.join(root,'ttp');await mkdir(ttpRoot);
const ttpDir=(await replayFixture(ttpRoot,'ttp-simulator')).dir;
const readMeet=async dir=>({dir,files:{},parsed:{events:parseEvt(await readFile(path.join(dir,'lynx.evt'),'utf8'))}});
const real=await readReplayFolder(realDir,readMeet,'real');
await writeFile(path.join(settingsDir,'openmeet-settings.json'),JSON.stringify({simulationSources:[
  {id:sourceId(ttpDir),type:'ttp',name:'Configured TTP',path:ttpDir},
  {id:sourceId(realDir),type:'real',name:real.name,path:realDir}],simulationSourceId:'builtin'}));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
// This check concerns replay, and never sends images to an inherited private service.
for(const key of ['OPENMEET_OCCLUSION_COMMAND','OPENMEET_OCCLUSION_URL','OPENMEET_CROP_COMMAND','OPENMEET_CROP_URL'])delete env[key];
const child=spawn(path.join(appDir,'node_modules/electron/dist/electron'),[appDir,'--ozone-platform=headless',`--remote-debugging-port=${port}`,`--user-data-dir=${settingsDir}`],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,serial=0;const requests=new Map(),errors=[];
child.stdout.on('data',b=>logs=(logs+b).slice(-8000));child.stderr.on('data',b=>logs=(logs+b).slice(-8000));
async function poll(fn,label,timeout=12000){const until=Date.now()+timeout;while(Date.now()<until){const result=await fn();if(result)return result;await delay(70);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{requests.delete(id);reject(Error('CDP timeout '+method));},10000);requests.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled control '+${JSON.stringify(selector)});e.click();})()`);
const tab=name=>ev(`(()=>{const e=[...document.querySelectorAll('#tabs button')].find(e=>e.textContent===${JSON.stringify(name)});if(!e)throw Error('Missing tab');e.click();})()`);
const choose=async id=>{await tab('Run');await poll(()=>ev(`!document.querySelector('#setupDialog').open`),'close setup');await ev(`(()=>{const e=document.querySelector('#quickMeet');if(e.disabled)throw Error('Meet selector disabled');e.value='source:'+${JSON.stringify(id)};e.dispatchEvent(new Event('change'));})()`);await poll(()=>ev(`document.querySelector('#quickMeet')?.value===${JSON.stringify('source:')}+${JSON.stringify(id)}&&!document.querySelector('#quickMeet').disabled`),'selected source');await tab('Settings');};
const captureDirs=async()=>{try{return(await readdir(path.join(real.meet.dir,'openmeet/captures'),{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(real.meet.dir,'openmeet/captures',e.name));}catch{return[];}};
try{
  const page=await poll(async()=>{try{return(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{return null;}},'renderer',30000);
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=requests.get(m.id);if(p){requests.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||JSON.stringify(m.params));});
  await send('Runtime.enable');await send('Page.enable');
  await poll(()=>ev(`!!window.openmeet&&!!document.querySelector('#ctl .go')`),'app ready');
  await tab('Settings');await poll(()=>ev(`document.querySelector('#simulationSource')?.options.length===1&&!document.querySelector('#simulationSource').disabled`),'catalog');
  assert.equal(await ev(`document.querySelector('#simulationSource').value`),sourceId(ttpDir));assert.equal(await ev(`document.querySelector('#simulationSource').selectedOptions[0].textContent`),'OpenMeet demo');assert.equal(await ev(`document.querySelector('#simulationSource option[value="builtin"]')`),null);
  await choose(sourceId(ttpDir));assert.match(await ev(`document.querySelector('#simulationSource').selectedOptions[0].textContent`),/OpenMeet demo/);
  await choose(sourceId(realDir));
  assert.match(await ev(`document.querySelector('#simulationSources').textContent`),/Real-recorded still timing source/);
  // Open every supplied recording through the visible Meet navigation and check its roster.
  for(const h of real.heats){
    await click('#browseEvents');
    const index=real.meet.parsed.events.filter(e=>e.entries.some(x=>x.lane)).findIndex(e=>String(e.event)===String(h.event)&&e.round===h.round&&e.heat===h.heat);
    await click(`[data-meet-heat="${index}"]`);
    const entry=real.meet.parsed.events[index].entries.find(e=>e.lane);
    assert.match(await ev(`document.querySelector('#list').textContent`),new RegExp(entry.last.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(await ev(`document.querySelector('#frontLaneButton').disabled`),!h.front);
    assert.equal(await ev(`document.querySelector('#comparisonCameraPicker').disabled`),!h.backup);
  }
  let verifiedReferences=0,verifiedEntries=0;
  for(const h of real.heats){
    const events=real.meet.parsed.events.filter(e=>e.entries.some(x=>x.lane));
    const index=events.findIndex(e=>String(e.event)===String(h.event)&&e.round===h.round&&e.heat===h.heat),event=events[index];
    await click('#browseEvents');await click(`[data-meet-heat="${index}"]`);
    for(const entry of event.entries){
      const text=await ev(`document.querySelector('#list').textContent`);
      assert.ok(text.includes(entry.last)&&text.includes(entry.first)&&text.includes(entry.affiliation));verifiedEntries++;
    }
    if(event.entries.every(e=>e.id==null))assert.equal(await ev(`document.querySelectorAll('#list .athlete-id').length`),0,'missing bibs must stay blank');
    assert.match(await ev(`document.querySelector('#acc').textContent`),/real-recorded replay/);
    if(!h.front)assert.match(await ev(`document.querySelector('#acc').textContent`),/Front cameraabsent/);
    const before=new Set(await captureDirs());
    await click('#ctl .go');await poll(async()=> (await captureDirs()).some(d=>!before.has(d)),'capture store');
    const capDir=(await captureDirs()).find(d=>!before.has(d));
    const rawMeta=JSON.parse(await readFile(path.join(h.dir,'primary.json'),'utf8')),meta=h.primaryMeta,img=decodePng(await readFile(h.primary));
    const nPre=Math.max(0,Math.round(meta.first_column_race_time_s/meta.column_period_s));
    const waitMs=Math.max(400,(meta.first_column_race_time_s+img.width*meta.column_period_s+.3)*1000);
    if(waitMs>45000)throw Error('Choose a continuous recording shorter than 45 seconds for this bounded check');
    await delay(waitMs);
    assert.match(await ev(`document.querySelector('#ctl .go').textContent`),/Stop capture/,'recording ended without manual stop');
    if(rawMeta.truth?.length){
      await poll(()=>ev(`document.querySelector('#apiState').textContent.includes('RECORDED RESULTS')&&document.querySelectorAll('#props tr').length===${rawMeta.truth.length}`),'recorded references appear while capture remains live');
      assert.match(await ev(`document.querySelector('#ctl .go').textContent`),/Stop capture/);
    }
    await tab('Settings');assert.equal(await ev(`document.querySelector('#simulationSource').disabled`),true);
    assert.equal(await ev(`document.querySelector('#importTtpSource').disabled`),true);
    const rejected=await ev(`window.openmeet.call('demo.load',{id:'builtin'}).then(()=>false,e=>e.message)`);assert.match(rejected,/Stop capture/);
    await tab('Run');await click('#ctl .go');await poll(()=>ev(`document.querySelector('#ev .state').textContent==='REVIEW'`),'manual stop');
    const store=openCaptureStore(capDir,{readOnly:true});
    try{
      assert.ok(store.columnCount()>nPre+img.width);
      assert.deepEqual(store.readColumns(nPre,nPre+img.width),columnsOf(img,0,img.width));
      for(let x=0;x<img.width;x++)assert.ok(Math.abs(store.raceTimeOf(nPre+x)-(meta.first_column_race_time_s+x*meta.column_period_s))<1e-9);
    }finally{store.close();}
    if(!h.front)await assert.rejects(readFile(path.join(capDir,'front.mp4')),/ENOENT/);
    if(rawMeta.truth?.length){
      await poll(()=>ev(`document.querySelector('#apiState').textContent.includes('RECORDED RESULTS')&&document.querySelectorAll('#props tr').length===${rawMeta.truth.length}`),'recorded results in tile');
      const params={captureId:path.basename(capDir),heat:{event:h.event,round:h.round,heat:h.heat},startList:event.entries.map(e=>({lane:e.lane,id:e.id??0}))};
      const output=await ev(`window.openmeet.call('autotiming.predict',${JSON.stringify(params)})`);
      assert.equal(output.reference,true);assert.equal(output.sourceRef.kind,'recorded-results');
      assert.equal(output.predictions.length,rawMeta.truth.length);
      for(const point of rawMeta.truth){
        const pred=output.predictions.find(p=>p.lane===point.lane);
        if(point.image_column!=null)assert.equal(pred.column,nPre+point.image_column);
        assert.equal(pred.source_column,point.source_column);
        assert.equal(pred.confidence,undefined,'reference playback must not invent model confidence');
        if(point.official_seconds!=null)assert.equal(Math.ceil(pred.race_time_s*100-1e-7)/100,point.official_seconds);
        verifiedReferences++;
      }
      for(const entry of event.entries.filter(e=>!rawMeta.truth.some(p=>p.lane===e.lane))){
        const result=await ev(`(()=>{const r=[...document.querySelectorAll('#list .row')].find(r=>Number(r.querySelector('.lane').textContent)===${entry.lane});return r.querySelector('.res').textContent;})()`);
        assert.match(result,/no time/);assert.doesNotMatch(result,/DNS|DNF|DQ|FS/);
      }
    }
    const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,`heat-${h.heat}.png`),Buffer.from(shot.data,'base64'));
    console.log(`PASS: E${h.event} R${h.round} H${h.heat}, ${event.entries.length} roster entries, ${rawMeta.truth?.length||0} exact recorded references, unchanged pixels/times, manual stop`);
  }
  console.log('Verified references:',verifiedReferences,'roster entries:',verifiedEntries);
  await choose(sourceId(ttpDir));await choose(sourceId(realDir));
  await send('Page.reload');await poll(()=>ev(`document.querySelector('#scanCameraLabel')?.textContent.includes('Recorded')||document.querySelector('#ctl .tag')?.textContent==='REPLAY'`),'source restored');
  await tab('Settings');assert.equal(await ev(`document.querySelector('#simulationSource').value`),'');assert.equal(await ev(`document.querySelector('#quickMeet').value`),'source:'+sourceId(realDir));
  assert.deepEqual(errors,[]);
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,'sources.png'),Buffer.from(screenshot.data,'base64'));
  console.log('PASS: source choices, all recorded rosters, absent cameras, capture lock, manual tail, exact pixels/times and reload');
}catch(error){console.error(logs);throw error;}
finally{ws?.close();try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([new Promise(r=>child.once('exit',r)),delay(1000)]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
