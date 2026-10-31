// Disposable Electron workflow: folders, camera round trips, mark nudging and defaults.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replayFixture } from './support/replay-fixture.mjs';
import { sourceId } from '../simulation-sources.mjs';
import { encodePng } from '../../engine/sim/png-encode.js';

const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname);
const root=await mkdtemp('/tmp/openmeet-review-cache-'),{dir,meta}=await replayFixture(root);
const meetDir=path.join(dir,'meet'),profile=path.join(root,'profile'),output=path.join(root,'output'),backup=path.join(root,'backup');
await Promise.all([profile,output,backup].map(p=>mkdir(p)));
await writeFile(path.join(meetDir,'lynx.evt'),'5,1,1,Cache check\n,101,2,Example,Ada,Club\n,102,4,Other,Bo,Club\n5,1,2,Next heat\n,103,2,Third,Cal,Club\n');
const hd=path.join(dir,'heat-1'),frames=path.join(hd,'front');await mkdir(frames);
const width=800,height=120,data=Buffer.alloc(width*height*3,90);
await writeFile(path.join(hd,'primary.png'),encodePng({width,height,channels:3,data}));
await writeFile(path.join(hd,'primary.json'),JSON.stringify({...meta,truth:[]}));
for(let frame=0;frame<24;frame++) {
 const pixels=Buffer.alloc(80*50*3,100);
 if(frame>=6)for(let y=15;y<40;y++)for(let x=10+frame;x<22+frame;x++){const p=(y*80+x)*3;pixels[p]=20;pixels[p+1]=140;pixels[p+2]=180;}
 await writeFile(path.join(frames,String(frame).padStart(4,'0')+'.png'),encodePng({width:80,height:50,channels:3,data:pixels}));
}
const ffmpeg=spawnSync('ffmpeg',['-loglevel','error','-y','-framerate','30','-i',path.join(frames,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p',path.join(hd,'front.mp4')]);if(ffmpeg.status!==0)throw Error(ffmpeg.stderr.toString());
await writeFile(path.join(hd,'front.json'),JSON.stringify({fps:30,first_frame_race_time_s:0,frame_count:24,width:80,height:50}));
await writeFile(path.join(profile,'openmeet-settings.json'),JSON.stringify({simulationSources:[{id:sourceId(dir),type:'real',name:'Cache check',path:dir}],simulationSourceId:sourceId(dir),resultsFor:{[meetDir]:output}}));
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
const child=spawn(path.join(appDir,'node_modules/electron/dist/electron'),[appDir,'--remote-debugging-port=0','--ozone-platform=headless','--user-data-dir='+profile],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,id=0;const pending=new Map(),errors=[];child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,90000);
async function poll(fn,label){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,{resolve,reject,t});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(selector)});e.click();})()`);
const tab=label=>ev(`[...document.querySelectorAll('#tabs button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`);
const key=async(key,code=key,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});};
const gutter=()=>ev(`[...document.querySelectorAll('#laneGutter [data-lane]')].map(e=>({lane:e.dataset.lane,top:parseFloat(e.style.top),height:parseFloat(e.style.height)}))`);
const state=()=>ev(`document.querySelector('.state').textContent`);
const outside=async()=>{for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,x:2,y:2,button:'left',clickCount:1});};
const tool=async name=>ev(`(()=>{let e=document.querySelector('#tools [data-tool="${name}"]');if(!e){document.querySelector('#tools [data-more]').click();e=document.querySelector('.scan-tool-menu [data-tool="${name}"]');}e.click();})()`);
const choose=async index=>{await key(String(index),'Digit'+index,1);await poll(()=>ev(`document.querySelector('#cameraSwitches button:nth-child(${index})')?.getAttribute('aria-pressed')==='true'`),'camera '+index);};
try {
  const port=await poll(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'DevTools');
  const page=await poll(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{}},'page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.t);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await poll(()=>ev(`!!document.querySelector('#quickEvent option[value="5"]')&&!document.querySelector('#quickEvent').disabled`),'meet loaded');
  await ev(`localStorage.setItem('openmeet.autoMark','false')`);await send('Page.reload');
  await poll(()=>ev(`document.querySelector('#list')?.textContent.includes('Ada')&&!document.querySelector('#quickMeet').disabled`),'fixture');
  await ev(`window.__frontJobs=[];window.__maskUrls=0;window.__workerBase=window.Worker;window.Worker=class extends window.__workerBase{constructor(...args){super(...args);this.front=String(args[0]).includes('front-occlusion-worker');}postMessage(data,...args){if(this.front&&data.type==='frame')window.__frontJobs.push(data.stamp);return super.postMessage(data,...args);}};const create=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{if(b.type==='image/png')window.__maskUrls++;return create(b);}`);
  await click('#ctl .go');await poll(async()=>(await state())==='RUNNING','capture');await delay(1200);await click('#ctl .go');await poll(async()=>(await state())==='REVIEW','stop');
  assert.equal(await ev(`window.__frontJobs.length`),0,'Disabled front overlays ran a mask calculation');
  const hover=async fraction=>ev(`(()=>{const c=document.querySelector('#scan'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('mousemove',{clientX:r.x+r.width*${fraction},clientY:r.y+r.height*.5,bubbles:true}));})()`);
  await hover(.02);
  await click('#frontLaneButton');
  for(const k of ['enabled','behindRunners'])await ev(`(()=>{const e=document.querySelector('#overlay-settings-front [data-key="${k}"]');e.checked=true;e.dispatchEvent(new Event('input'));})()`);
  await click('#overlay-settings-front [data-close]');
  await poll(()=>ev(`window.__frontJobs.filter(s=>s.startsWith('frame:')).length===24`),'all front masks precomputed');
  await delay(100);
  const before=await ev(`({jobs:window.__frontJobs.length,urls:window.__maskUrls})`);
  assert.ok(before.urls>0&&before.urls<24,'Empty backgrounds allocated PNGs');
  await ev(`window.__pairFaults=[];window.__watchPairs=setInterval(()=>{const f=document.querySelector('#front'),o=document.querySelector('#frontLaneOverlay');if(f.dataset.frame&&o.dataset.occlusion==='ready'&&(f.dataset.frame!==o.dataset.maskFrame||o.style.visibility==='hidden'))window.__pairFaults.push([f.dataset.frame,o.dataset.maskFrame,o.style.visibility]);},5)`);
  const seen=new Set();
  for(const fraction of [.02,.15,.4,.65,.9,.3,.02,.9,.4,.65,.15]) {
    await hover(fraction);await delay(40);await poll(()=>ev(`(()=>{const f=document.querySelector('#front'),o=document.querySelector('#frontLaneOverlay');return f.dataset.frame===f.dataset.wantedFrame&&o.dataset.maskFrame===f.dataset.frame&&o.dataset.occlusion==='ready';})()`),'matching frame/mask');
    seen.add(await ev(`document.querySelector('#front').dataset.frame`));
  }
  await ev(`clearInterval(window.__watchPairs)`);assert.ok(seen.size>=4);assert.deepEqual(await ev(`window.__pairFaults`),[]);
  assert.equal(await ev(`window.__frontJobs.length`),before.jobs,'Scrubbing re-ran cached mask work');assert.equal(await ev(`window.__maskUrls`),before.urls);
  const capRoot=path.join(meetDir,'openmeet/captures'),cap=path.join(capRoot,(await readdir(capRoot))[0]);
  const review=async()=>JSON.parse(await readFile(path.join(cap,'review.json'),'utf8'));
  const hash=async name=>createHash('sha256').update(await readFile(path.join(cap,name))).digest('hex');
  const originals=await Promise.all(['columns.bin','times.f64'].map(hash));
  await click('#ctl .go');await poll(async()=>(await state())==='SAVED','save entirely pending');
  assert.deepEqual((await review()).pendingLanes,[2,4]);assert.deepEqual((await review()).marks,{});assert.deepEqual((await review()).status,{});
  const lif=path.join(output,'005-1-01.lif');assert.equal((await readFile(lif,'utf8')).trim().split(/\r?\n/).length,1);
  await poll(()=>ev(`document.querySelector('#quickHeat').value==='1'`),'save advances to next heat');
  await ev(`document.querySelector('#quickHeat').value='0';document.querySelector('#quickHeat').dispatchEvent(new Event('change'))`);
  await poll(async()=>(await state())==='SAVED','return to pending heat');
  await hover(.45);
  await ev(`(()=>{const c=document.querySelector('#scan'),r=c.getBoundingClientRect();for(const type of ['mousedown','mouseup'])c.dispatchEvent(new MouseEvent(type,{clientX:r.x+r.width*.45,clientY:r.y+r.height*.5,button:0,bubbles:true}));[...document.querySelectorAll('#list .row')].find(e=>e.querySelector('.lane').textContent.trim()==='2').click();c.focus();})()`);await key('Enter');
  await poll(async()=>(await state())==='REVIEW','late manual mark');await click('#ctl .go');await poll(async()=>(await state())==='SAVED','partial corrected save');
  const late=await review();assert.deepEqual(late.pendingLanes,[4]);assert.ok(late.marks[2]);assert.equal(late.status[4],undefined);
  const text=await readFile(lif,'utf8');assert.equal(text.trim().split(/\r?\n/).length,2);assert.match(text,/Example,Ada/);assert.doesNotMatch(text,/Other,Bo|DNF/);
  assert.deepEqual(await Promise.all(['columns.bin','times.f64'].map(hash)),originals);
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,'review-cache.png'),Buffer.from(screenshot.data,'base64'));
  await ev(`document.querySelector('#quickHeat').value='1';document.querySelector('#quickHeat').dispatchEvent(new Event('change'))`);
  await poll(()=>ev(`document.querySelector('#frontLaneButton').disabled&&document.querySelector('video.frontvid').getAttribute('src')===null`),'front media resources released for a heat without a front camera');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({pass:true,output:root,precomputedFrames:24,uniqueScrubFrames:seen.size,foregroundPngs:before.urls,pendingSave:true,lateReview:true,evidenceUnchanged:true,frontMediaReleased:true}));
}catch(error){console.error(JSON.stringify({logs:logs.slice(-1500),errors,ui:await ev('document.body.innerText').catch(()=>null),front:await ev(`({frame:document.querySelector('#front')?.dataset,overlay:document.querySelector('#frontLaneOverlay')?.dataset,jobs:window.__frontJobs})`).catch(()=>null)}));throw error;}
finally{clearTimeout(timer);ws?.close();stop();for(const p of pending.values())clearTimeout(p.t);}
