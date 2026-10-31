// Disposable Electron workflow for lane alignment and the Meet overview.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { replayFixture } from './support/replay-fixture.mjs';
import { sourceId } from '../simulation-sources.mjs';
import { encodePng } from '../../engine/sim/png-encode.js';

const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname);
const root=await mkdtemp('/tmp/openmeet-roster-alignment-'),{dir,meta}=await replayFixture(root);
const meetDir=path.join(dir,'meet'),profile=path.join(root,'profile');await mkdir(profile);
const athletes=Array.from({length:9},(_,i)=>`,${101+i},${i+1},Runner${i+1},Athlete${i+1},Track Club\n`).join('');
await writeFile(path.join(meetDir,'lynx.evt'),`5,1,1,Nine lane race\n${athletes}6,1,1,Other event\n,201,1,Other,One,Club\n,202,4,Other,Four,Club\n,203,8,Other,Eight,Club\n5,2,1,Nine lane final\n${athletes}`);
for(const [name,scale,reverse] of [['primary',1,false],['backup',2,true]]) {
  const width=800,height=880*scale,data=Buffer.alloc(width*height*3),heights=[90,100,80,110,90,100,80,100,90];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;data[i]=35+Math.floor(y/(90*scale))%2*35;data[i+1]=45+x%45;data[i+2]=65;}
  await writeFile(path.join(dir,'heat-1',name+'.png'),encodePng({width,height,channels:3,data}));
  let row=20;const lane_rows=heights.map((h,i)=>{const top=row;row+=h;return {lane:reverse?9-i:i+1,top_row:top*scale,bottom_row:row*scale};});
  await writeFile(path.join(dir,'heat-1',name+'.json'),JSON.stringify({...meta,camera_name:name==='primary'?'Camera A':'Camera B',lane_rows,truth:[.2,.3,.4,.5,.505,.65,.75,.85,.95].map((time_s,i)=>({lane:i+1,time_s,image_column:Math.round((time_s-meta.first_column_race_time_s)/meta.column_period_s)}))}));
}
await writeFile(path.join(profile,'openmeet-settings.json'),JSON.stringify({simulationSources:[{id:sourceId(dir),type:'real',name:'Alignment test meet',path:dir}],simulationSourceId:sourceId(dir)}));
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
const executable=process.argv[3]||path.join(appDir,'node_modules/electron/dist/electron');
const child=spawn(executable,[...(process.argv[3]?[]:[appDir]),'--remote-debugging-port=0','--ozone-platform=headless','--user-data-dir='+profile],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,id=0;const pending=new Map(),errors=[];child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,90000);
async function poll(fn,label){for(let i=0;i<200;i++){try{const value=await fn();if(value)return value;}catch(error){if(!/Execution context was destroyed|Cannot find context/.test(error.message))throw error;}await delay(50);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,{resolve,reject,t});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{let r;try{r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});}catch(error){error.message+=' while evaluating '+expression.slice(0,160);throw error;}if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
const frame=()=>poll(()=>ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`),'rendered frame');
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(selector)});e.click();})()`);
const key=async(key,code=key,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});};
const aligned=()=>ev(`document.querySelector('#list').classList.contains('lane-aligned')`);
const geometry=()=>ev(`[...document.querySelectorAll('#list .row')].map(row=>{const a=row.getBoundingClientRect(),b=document.querySelector('#laneGutter [data-lane="'+row.dataset.lane+'"]').getBoundingClientRect();return {lane:row.dataset.lane,topError:a.top-b.top,bottomError:a.bottom-b.bottom,height:a.height};})`);
const check=async label=>{await frame();await poll(aligned,label);const rows=await geometry();assert.equal(rows.length,9);for(const r of rows){assert.ok(Math.abs(r.topError)<1,JSON.stringify(r));assert.ok(Math.abs(r.bottomError)<1,JSON.stringify(r));assert.ok(r.height>=33);}return rows;};
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,name+'.png'),Buffer.from(r.data,'base64'));};
const resize=async height=>{await send('Emulation.setDeviceMetricsOverride',{width:1600,height,deviceScaleFactor:1,mobile:false});await frame();};
const choose=async index=>{await click('#cameraSwitches button:nth-child('+index+')');await poll(()=>ev(`document.querySelector('#cameraSwitches button:nth-child(${index})')?.getAttribute('aria-pressed')==='true'`),'camera '+index);await frame();};
try {
  const port=await poll(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'DevTools');
  const page=await poll(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{}},'page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.t);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);};
  await send('Runtime.enable');await send('Page.enable');await poll(()=>ev(`document.readyState==='complete'`),'initial page');await resize(1400);
  await poll(()=>ev(`!!document.querySelector('#quickEvent option[value="5"]')&&!document.querySelector('#quickEvent').disabled`),'meet loaded');
  await ev(`localStorage.setItem('openmeet.workspaceSplit','0.28');localStorage.setItem('openmeet.alignRosterToLanes','false')`);await send('Page.reload');
  await poll(()=>ev(`!!document.querySelector('#list .row')&&!document.querySelector('#quickEvent').disabled`),'reloaded');
  await ev(`document.querySelector('#quickEvent').value='5';document.querySelector('#quickEvent').dispatchEvent(new Event('change'));document.querySelector('#quickRound').value='1';document.querySelector('#quickRound').dispatchEvent(new Event('change'))`);
  await poll(()=>ev(`document.querySelectorAll('#list .row').length===9&&document.querySelectorAll('#cameraSwitches button').length===2`),'nine lanes');
  await check('automatic alignment ignores obsolete opt-out');assert.equal(await ev(`!!document.querySelector('#alignRoster,#rosterAlignmentStatus')`),false);
  await ev(`(()=>{const list=document.querySelector('#list'),rows=new Map([...list.children].map(row=>[row.dataset.lane,row])),audit=window.rosterAudit={samples:0,detached:0,unaligned:0,maxError:0};const sample=()=>{audit.samples++;if(!list.classList.contains('lane-aligned'))audit.unaligned++;for(const [lane,row]of rows){if(!row.isConnected||list.querySelector('[data-lane="'+lane+'"]')!==row)audit.detached++;const gutter=document.querySelector('#laneGutter [data-lane="'+lane+'"]');if(gutter){const a=row.getBoundingClientRect(),b=gutter.getBoundingClientRect();audit.maxError=Math.max(audit.maxError,Math.abs(a.top-b.top),Math.abs(a.bottom-b.bottom));}}};window.rosterObserver=new MutationObserver(sample);window.rosterObserver.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});sample();})()`);
  await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='RUNNING'`),'capture');await delay(1200);await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='REVIEW'`),'review');
  await poll(()=>ev(`document.querySelectorAll('#list .res .tag.review').length===2&&document.querySelectorAll('#list .result-source').length===7`),'mixed results and review badges');await check('recorded alignment');
  const liveAudit=await ev(`window.rosterObserver.disconnect();window.rosterAudit`);assert.ok(liveAudit.samples>=3);assert.equal(liveAudit.detached,0);assert.equal(liveAudit.unaligned,0);assert.ok(liveAudit.maxError<1,JSON.stringify(liveAudit));
  await shot('aligned-rows');
  await click('#list [data-lane="4"]');await check('selected athlete fits');
  assert.equal(await ev(`!!document.querySelector('#list [data-lane="4"] .athlete-status')`),true);
  assert.equal(await ev(`(()=>{const row=document.querySelector('#list .sel').getBoundingClientRect(),c=document.querySelector('#list .sel .rowctl').getBoundingClientRect();return c.top>=row.top&&c.bottom<=row.bottom;})()`),true);
  await ev(`window.keptStatus=document.querySelector('#list .sel .athlete-status');window.keptStatus.focus()`);await click('[data-order="lane"]');assert.equal(await ev(`document.querySelector('#list .sel .athlete-status')===window.keptStatus&&document.activeElement===window.keptStatus`),true);
  await ev(`document.querySelector('#scan').focus()`);await key('Escape');await key('Escape');
  await resize(1000);await ev(`document.querySelector('#workspaceSplit').focus()`);await key('ArrowDown','ArrowDown',8);await key('ArrowDown','ArrowDown',8);await check('compact unselected rows fit');
  await click('#list [data-lane="3"]');await frame();await poll(async()=>!await aligned(),'expanded controls need more room');
  assert.equal(await ev(`document.querySelector('#list .sel .athlete-status').getBoundingClientRect().height>0`),true);
  await ev(`document.querySelector('#scan').focus()`);await key('Escape');await key('Escape');await resize(1400);await check('deselection restores alignment');
  await ev(`document.querySelector('#laneGutter [data-boundary="1:2"]').focus()`);await key('ArrowDown','ArrowDown',8);await check('adjusted boundary');
  for(let i=0;i<3;i++){await choose(2);await check('reversed camera');await choose(1);await check('original camera');}
  await resize(700);await poll(async()=>!await aligned(),'short bands fall back');assert.equal(await ev(`document.querySelectorAll('#list .row').length`),9);
  await resize(1400);await check('alignment resumes');
  const rect=await ev(`(()=>{const r=document.querySelector('#scan').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height-22};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x+100,y:rect.y+rect.h*.2,button:'left',clickCount:1,modifiers:8});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+500,y:rect.y+rect.h*.6,button:'left',buttons:1,modifiers:8});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+500,y:rect.y+rect.h*.6,button:'left',clickCount:1,modifiers:8});
  await poll(async()=>!await aligned(),'cropped lanes fall back');
  await ev(`document.querySelector('#scan').focus()`);await key('Escape');await check('fit restores alignment');
  await click('[data-order="finish"]');assert.equal(await aligned(),false);
  await click('[data-order="lane"]');await check('lane order aligns');await send('Page.reload');
  await poll(()=>ev(`!!document.querySelector('#list .row')&&!document.querySelector('#quickEvent').disabled`),'persistent preference');await check('persisted alignment');
  // Reproduce the user's view: a large unused background above compact but
  // readable lane bands. No fixed pixel cutoff may veto the actual text fit.
  await ev(`(()=>{const key='openmeet.overlay:'+${JSON.stringify(meetDir)}+':scan:primary',saved=JSON.parse(localStorage.getItem(key)||'{}'),nativeHeight=(saved.boundaries?.['1:2']??110)-(saved.boundaries?.['top:1']??20),scale=parseFloat(document.querySelector('#laneGutter [data-lane="1"]').style.height)/nativeHeight;let row=80/scale;const edges={'top:1':row};for(const [i,height]of [34.5,39,42,45,49,52,60,65,80].entries()){row+=height/scale;edges[i===8?'9:bottom':(i+1)+':'+(i+2)]=row;}localStorage.setItem(key,JSON.stringify({...saved,resolutionRows:880,boundaries:edges}));document.querySelector('[data-order="lane"]').click();})()`);
  await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='RUNNING'`),'compact capture');await delay(1200);await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='REVIEW'&&document.querySelectorAll('#list .res .tag.review').length===2&&document.querySelectorAll('#list .result-source').length===7`),'compact mixed results');
  const compact=await check('compact demo lanes with mixed result heights align');assert.ok(compact[0].height<44);assert.ok(compact[0].height>=34);
  assert.equal(await ev(`(()=>{const row=document.querySelector('#list [data-lane="1"]').getBoundingClientRect();return [...document.querySelectorAll('#list [data-lane="1"] .who,#list [data-lane="1"] .res')].every(e=>{const r=e.getBoundingClientRect();return r.top>=row.top-.5&&r.bottom<=row.bottom+.5;});})()`),true);
  await shot('compact-aligned-rows');
  const bandHashes=()=>ev(`(()=>{const cv=document.querySelector('#scan'),rect=cv.getBoundingClientRect(),scale=cv.height/rect.height,g=cv.getContext('2d'),x=Math.floor(cv.width*.15),width=Math.floor(cv.width*.7);return [...document.querySelectorAll('#laneGutter [data-lane]')].map(row=>{const r=row.getBoundingClientRect(),top=Math.ceil((r.top-rect.top)*scale)+2,bottom=Math.floor((r.bottom-rect.top)*scale)-2,data=g.getImageData(x,top,width,bottom-top).data;let hash=2166136261;for(const value of data)hash=Math.imul(hash^value,16777619);return hash>>>0;});})()`);
  const normalPixels=await bandHashes();await frame();assert.deepEqual(await bandHashes(),normalPixels);
  const hoverRect=await ev(`(()=>{const r=document.querySelector('#list [data-lane="3"]').getBoundingClientRect();return {x:r.x+100,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverRect});await poll(()=>ev(`document.querySelector('#laneGutter [data-lane="3"]').classList.contains('hovered')`),'matching lane hover');
  await frame();
  const hoveredPixels=await bandHashes();assert.notEqual(hoveredPixels[2],normalPixels[2]);for(let i=0;i<9;i++)if(i!==2)assert.equal(hoveredPixels[i],normalPixels[i],'hover changed lane '+(i+1));assert.equal(await ev(`document.querySelectorAll('#list .sel').length`),0);
  await shot('athlete-lane-hover');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});await frame();assert.deepEqual(await bandHashes(),normalPixels);assert.equal(await ev(`document.querySelectorAll('#laneGutter .hovered').length`),0);
  await click('[data-order="finish"]');await resize(700);await click('#list [data-lane="3"]');
  const normalScroll=await ev(`document.querySelector('#scan').focus();const list=document.querySelector('#list');list.scrollTop=60;window.keptScrollRow=list.querySelector('[data-lane="3"]');list.scrollTop`);assert.ok(normalScroll>0);
  await key('ArrowRight');assert.equal(await ev(`document.querySelector('#list').scrollTop`),normalScroll);assert.equal(await ev(`document.querySelector('#list [data-lane="3"]')===window.keptScrollRow`),true);
  await resize(1400);await click('[data-order="lane"]');
  assert.equal(await ev(`!!document.querySelector('#alignRoster,#rosterAlignmentStatus')`),false);
  await ev(`[...document.querySelectorAll('#tabs button')].find(b=>b.textContent==='Meet').click()`);
  assert.equal(await ev(`document.querySelector('#setupDialog').open`),true);
  assert.match(await ev(`document.querySelector('.meet-overview').textContent`),/2 events · 3 rounds · 3 heats · 21 athlete entries/);
  assert.equal(await ev(`document.querySelectorAll('.meet-folder-row').length`),3);
  const order=await ev(`[...document.querySelectorAll('#meetSchedule [data-meet-heat]')].map(b=>Number(b.dataset.meetHeat))`);
  assert.deepEqual(order,[0,1,2]);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#meetSchedule .meet-heat-order')].map(b=>b.textContent)`),['1.','2.','3.']);
  await shot('meet-overview');
  await ev(`const input=document.querySelector('#meetSearch');input.value='Other';input.dispatchEvent(new Event('input'))`);
  assert.equal(await ev(`document.querySelectorAll('#meetSchedule [data-meet-heat]').length`),1);
  assert.equal(await ev(`document.querySelectorAll('.meet-folder-row').length`),3);
  await click('#meetSchedule [data-meet-heat]');await poll(()=>ev(`!document.querySelector('#setupDialog').open`),'heat opens');assert.equal(await ev(`document.querySelector('.ev-name').textContent`),'Other event');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({pass:true,output:root,lanes:9,cameras:2,alignedPixelError:'<1px',automatic:true,noAlignmentControl:true,compactLaneHeight:compact[0].height,mixedResultRows:true,liveRosterStable:liveAudit,hoverMatchesLane:true,normalScrollPreserved:true,resizeAndCropFallback:true,meetOverview:true,meetOrder:order}));
}catch(error){console.error(JSON.stringify({logs:logs.slice(-1500),errors,ui:await ev('document.body.innerText').catch(()=>null)}));throw error;}
finally{clearTimeout(timer);ws?.close();stop();for(const p of pending.values())clearTimeout(p.t);}
