// Native cropper and chosen toolbar defaults in disposable source/packaged Electron.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replayFixture } from './support/replay-fixture.mjs';
import { encodePng } from '../../engine/sim/png-encode.js';

const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname);
const root=await mkdtemp('/tmp/openmeet-native-crop-ui-'),{dir,meta}=await replayFixture(root),meetDir=path.join(dir,'meet'),profile=path.join(root,'profile');await mkdir(profile);
const width=768,height=96,data=Buffer.alloc(width*height*3,90);
for(let y=32;y<84;y++)for(let x=256;x<320;x++)data.set([20,190,200],(y*width+x)*3);
await writeFile(path.join(dir,'heat-1/primary.png'),encodePng({width,height,channels:3,data}));
await writeFile(path.join(dir,'heat-1/primary.json'),JSON.stringify({...meta,first_column_race_time_s:0,truth:[]}));
await writeFile(path.join(profile,'openmeet-settings.json'),JSON.stringify({demoDir:dir}));
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
const child=spawn(process.argv[3]||path.join(appDir,'node_modules/electron/dist/electron'),[...(process.argv[3]?[]:[appDir]),'--remote-debugging-port=0','--ozone-platform=headless','--user-data-dir='+profile],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,id=0;const pending=new Map(),errors=[];child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,90000);
async function poll(fn,label){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,{resolve,reject,t});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(selector)});e.click();})()`);
const state=()=>ev(`document.querySelector('.state').textContent`);
try {
  const port=await poll(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'DevTools');
  const page=await poll(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{}},'page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.t);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await poll(()=>ev(`!!document.querySelector('#quickEvent option[value="5"]')&&!document.querySelector('#quickEvent').disabled`),'meet loaded');
  await ev(`localStorage.setItem('openmeet.autoMark','false')`);await send('Page.reload');
  await poll(()=>ev(`document.querySelector('#list')?.textContent.includes('Ada')&&!document.querySelector('#quickMeet').disabled`),'fixture');
  const info=await ev(`window.openmeet.call('autocrop.info')`);assert.equal(info.provider,'native');assert.equal(info.ready,true);
  await click('#tools [data-more]');await ev(`[...document.querySelectorAll('.scan-tool-menu button')].find(e=>e.textContent.includes('Customize toolbar')).click()`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.scan-toolbar-dialog input:checked')].map(e=>e.getAttribute('aria-label'))`),['Pin Follow live','Pin Zoom','Pin Unzoom','Pin Lanes','Pin Hide empty spans']);await click('.scan-toolbar-dialog [aria-label="Close"]');
  await click('#ctl .go');await poll(async()=>(await state())==='RUNNING','capture');await delay(1200);await click('#ctl .go');await poll(async()=>(await state())==='REVIEW','stop');
  await poll(()=>ev(`!!document.querySelector('#tools [data-tool="hideEmpty"]')`),'pinned native crop tool');
  const capRoot=path.join(meetDir,'openmeet/captures'),cap=path.join(capRoot,(await readdir(capRoot))[0]);
  const hash=async name=>createHash('sha256').update(await readFile(path.join(cap,name))).digest('hex'),before=await Promise.all(['columns.bin','times.f64'].map(hash));
  await click('#tools [data-tool="hideEmpty"]');await poll(()=>ev(`document.querySelector('#tools [data-tool="hideEmpty"]')?.textContent==='Show all columns'`),'native hidden spans');
  const cropFile=path.join(cap,'autocrop.json'),bytes=await readFile(cropFile),result=JSON.parse(bytes);
  assert.equal(result.runtime,'native-cpu');assert.equal(result.result.approved,true);
  const kept=result.result.modes['storage-display'].cropped_to_original;assert.ok(kept.length>0&&kept.length<result.result.original_width);
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,'native-empty-spans.png'),Buffer.from(screenshot.data,'base64'));
  for(let i=0;i<3;i++){await click('#tools [data-tool="hideEmpty"]');assert.equal(await ev(`document.querySelector('#tools [data-tool="hideEmpty"]').textContent`),'Hide empty spans');await click('#tools [data-tool="hideEmpty"]');await poll(()=>ev(`document.querySelector('#tools [data-tool="hideEmpty"]')?.textContent==='Show all columns'`),'reuse cached ranges');}
  assert.deepEqual(await readFile(cropFile),bytes,'Toggling reran analysis');assert.deepEqual(await Promise.all(['columns.bin','times.f64'].map(hash)),before);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({pass:true,output:root,provider:'native',columns:result.result.original_width,kept:kept.length,defaultPins:5,cachedToggles:3,evidenceUnchanged:true,packaged:!!process.argv[3]}));
}catch(error){console.error(JSON.stringify({logs:logs.slice(-1500),errors,ui:await ev('document.body.innerText').catch(()=>null)}));throw error;}
finally{clearTimeout(timer);ws?.close();stop();for(const p of pending.values())clearTimeout(p.t);}
