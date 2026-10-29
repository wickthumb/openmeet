// Disposable synthetic fixture + fake local CLI/mask only. Never touches app 9502.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {replayFixture} from './support/replay-fixture.mjs';
import {sourceId} from '../simulation-sources.mjs';
import {encodePng} from '../../engine/sim/png-encode.js';
const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname),root=await mkdtemp('/tmp/openmeet-billboard-ui-');
const {dir,meta}=await replayFixture(root);const width=400,height=120,data=Buffer.alloc(width*height*3,60);
// Solid empty scene and one unmistakable synthetic runner.
for(let y=30;y<90;y++)for(let x=170;x<200;x++){const i=(y*width+x)*3;data[i]=240;data[i+1]=30;data[i+2]=30;}
meta.truth=[{lane:2,image_column:185,time_s:.241925}];meta.lane_rows=[{lane:2,top_row:0,bottom_row:120}];
await writeFile(path.join(dir,'heat-1/primary.png'),encodePng({width,height,channels:3,data}));await writeFile(path.join(dir,'heat-1/primary.json'),JSON.stringify(meta));
const profile=path.join(root,'profile'),bin=path.join(root,'bin');await mkdir(profile);await mkdir(bin);
await writeFile(path.join(profile,'openmeet-settings.json'),JSON.stringify({simulationSources:[{id:sourceId(dir),type:'real',name:'Synthetic billboard test',path:dir}],simulationSourceId:sourceId(dir)}));
// Muse preset still receives its unchanged flags. This fake is the only coding CLI run.
await writeFile(path.join(bin,'muse'),`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('assets/billboard.svg','<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240"><rect width="1200" height="240" fill="#2255aa"/><text x="60" y="160" fill="white" font-size="90">FAKE ART</text></svg>');fs.writeSync(1,'fake billboard build\\n');`,{mode:0o755});
const fake=path.join(root,'fake-mask.mjs'),input=path.join(root,'mask-input.png');
await writeFile(fake,`import fs from 'node:fs';import {encodePng} from ${JSON.stringify(new URL('../../engine/sim/png-encode.js',import.meta.url).href)};let raw='';for await(const d of process.stdin)raw+=d;const p=JSON.parse(raw),model={id:'synthetic-test-only',validation:'experimental'};let result;if(p.operation==='health')result={ready:true,contract:p.contract,foreground:'white',model};else{fs.writeFileSync(${JSON.stringify(input)},Buffer.from(p.image.data_base64,'base64'));const data=Buffer.alloc(p.width*p.height);for(let y=30;y<90;y++)for(let x=178;x<208;x++)data[y*p.width+x]=255;result={request_id:p.request_id,image_sha256:p.image_sha256,width:p.width,height:p.height,foreground:'white',model,mask_png_base64:encodePng({width:p.width,height:p.height,channels:1,data}).toString('base64')};}fs.writeSync(1,JSON.stringify(result));`);
const crop=path.join(root,'fake-crop.mjs');
await writeFile(crop,`import fs from 'node:fs';let raw='';for await(const d of process.stdin)raw+=d;const p=JSON.parse(raw);let out;if(p.operation==='health')out={ready:true};else{const bytes=Buffer.from(p.image.data_base64,'base64'),w=bytes.readUInt32BE(16),ranges=[[0,100],[150,w]],columns=ranges.flatMap(([a,b])=>Array.from({length:b-a},(_,i)=>a+i));out={request_id:p.request_id,image_sha256:p.image_sha256,result:{schema:'autocrop-ranges-v2',original_width:w,approved:true,modes:{'storage-display':{mode:'storage-display',padding:8,merge_gap_lt:0,ranges,cropped_to_original:columns},'inference-safe':{mode:'inference-safe',padding:160,merge_gap_lt:320,ranges:[[0,w]],cropped_to_original:Array.from({length:w},(_,i)=>i)}}}};}fs.writeSync(1,JSON.stringify(out));`);
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
env.OPENMEET_CROP_COMMAND=JSON.stringify([process.execPath,crop]);env.OPENMEET_OCCLUSION_COMMAND=JSON.stringify([process.execPath,fake]);env.PATH=bin+path.delimiter+env.PATH;
const child=spawn(path.join(appDir,'node_modules/electron/dist/electron'),[appDir,'--remote-debugging-port=0','--ozone-platform=headless','--user-data-dir='+profile],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,id=0;const pending=new Map(),errors=[];child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,55000);
async function poll(fn,label){for(let i=0;i<150;i++){const r=await fn();if(r)return r;await delay(60);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,{resolve,reject,t});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(selector)});e.click();})()`);
const tab=label=>ev(`[...document.querySelectorAll('#tabs button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`);
const set=async(id,value)=>ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event(${id==='billboard-text'?'"input"':'"change"'}));})()`);
const tool=async name=>ev(`(()=>{let e=document.querySelector('#tools [data-tool="${name}"]');if(!e){document.querySelector('#tools [data-more]').click();e=document.querySelector('.scan-tool-menu [data-tool="${name}"]');}if(!e)throw Error('Missing tool ${name}');e.click();})()`);
const collection=()=>ev(`JSON.parse(localStorage[Object.keys(localStorage).find(k=>k.startsWith('openmeet.billboard:'))])`);
const config=async()=>{const c=await collection();return c.items.find(b=>b.id===c.selected);};
const panel=()=>tool('billboard');
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,name+'.png'),Buffer.from(r.data,'base64'));};
const pixels=()=>ev(`(()=>{const c=document.querySelector('#scan'),g=c.getContext('2d'),a=g.getImageData(0,0,c.width,c.height).data;return Array.from(a);})()`);
const drag=async(selector,dx,dy)=>{const r=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+dx,y:r.y+dy,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+dx,y:r.y+dy,button:'left',clickCount:1});await delay(150);};
try{
 const port=await poll(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'DevTools');
 const page=await poll(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{}},'app page');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.t);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);};
 await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
 await poll(()=>ev(`document.querySelector('#ctl .go')?.textContent.includes('Start')&&document.querySelector('#list').textContent.includes('Ada')`),'fixture');
 // Turn lanes off explicitly. Enable the billboard before capture to exercise live Simple.
 await ev(`(()=>{for(const key of Object.keys(localStorage).filter(k=>k.includes(':scan:'))){const o=JSON.parse(localStorage[key]);o.enabled=false;o.behindRunners=false;localStorage[key]=JSON.stringify(o);}})()`);
 const savedLanePrefs=()=>ev(`Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.includes(':scan:')).map(([k,v])=>{const {resolutionRows,...preferences}=JSON.parse(v);return [k,preferences];}))`);
 const lanePrefs=await savedLanePrefs();
 assert.equal(await ev(`[...document.querySelectorAll('#tabs button')].some(b=>b.textContent==='Billboards')`),false);assert.equal(await ev(`[...document.querySelectorAll('#tabs button')].some(b=>b.textContent==='Camera setup')`),true);
 await tool('billboard');await shot('00-simple-editor');await set('billboard-enabled',true);await set('billboard-text','TEST BILLBOARD');await set('billboard-time',0);await set('billboard-duration',.3);await set('billboard-row',0);await set('billboard-height',120);
 await ev(`(()=>{window.__liveMetrics={frames:0,builds:0,first:performance.now()};const orig=CanvasRenderingContext2D.prototype.getImageData;window.__restoreBillboardMetrics=()=>CanvasRenderingContext2D.prototype.getImageData=orig;CanvasRenderingContext2D.prototype.getImageData=function(...args){if(this.canvas.dataset.billboardMask)window.__liveMetrics.builds++;return orig.apply(this,args);};let count=0;function tick(){window.__liveMetrics.frames++;if(count++<160)requestAnimationFrame(tick);}requestAnimationFrame(tick);})()`);
 await tab('Run');await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='RUNNING'`),'running');await delay(2300);
 const liveMetrics=await ev(`(()=>{window.__restoreBillboardMetrics();const m=window.__liveMetrics;return {...m,fps:m.frames*1000/(performance.now()-m.first)};})()`);assert.ok(liveMetrics.frames>30);assert.ok(liveMetrics.builds<liveMetrics.frames*.7,JSON.stringify(liveMetrics));
 await panel();assert.equal(await ev(`document.querySelector('#billboardMaskStatus').textContent`),'Simple while recording');await tab('Run');await shot('01-live-simple');
 await click('#ctl .go');await poll(()=>ev(`document.querySelector('.state').textContent==='REVIEW'`),'review');
 await panel();await poll(()=>ev(`document.querySelector('#billboardMaskStatus').textContent==='Learned preview ready'`),'fake learned mask with lanes off');
 const captures=path.join(dir,'meet/openmeet/captures'),capture=path.join(captures,(await readdir(captures))[0]),hash=async n=>createHash('sha256').update(await readFile(path.join(capture,n))).digest('hex');
 const before=await Promise.all(['columns.bin','times.f64'].map(hash));const modelInputBefore=createHash('sha256').update(await readFile(input)).digest('hex');
 const marks=await ev(`document.querySelector('#list').innerText`);
 await set('billboard-enabled',false);await tab('Run');await delay(150);const original=await pixels();await shot('02-original');
 await panel();await set('billboard-enabled',true);await tab('Run');await delay(150);const decorated=await pixels();assert.notDeepEqual(decorated,original);
 // Check runner centre stays original, and many clear-track pixels receive artwork.
 const info=await ev(`(()=>{const c=document.querySelector('#scan');return {width:c.width,height:c.height,dpr:devicePixelRatio};})()`);
 let changed=0,protectedRed=0;for(let i=0;i<original.length;i+=4){if(original[i]===240&&original[i+1]===30&&original[i+2]===30){assert.deepEqual(decorated.slice(i,i+4),original.slice(i,i+4));protectedRed++;}if(original[i]!==decorated[i]||original[i+1]!==decorated[i+1])changed++;}
 assert.ok(changed>1000);assert.ok(protectedRed>50);await shot('03-masked-lanes-off');
 await panel();await set('billboard-enabled',false);await tab('Run');await delay(100);assert.deepEqual(await pixels(),original);
 // Position handles are independent of timing-marker drag handlers.
 await panel();await set('billboard-enabled',true);await set('billboard-time',.06);await set('billboard-duration',.2);await set('billboard-row',25);await set('billboard-height',40);await click('#billboard-place');await poll(()=>ev(`!document.querySelector('#setupDialog').open`),'placement outside dialog');await delay(100);assert.equal(await ev(`!!document.querySelector('#billboard-edit')`),false);
 let a=await config();await drag('.billboard-placement.direct-drag',35,10);let z=await config();assert.ok(z.time>a.time);assert.ok(z.row>a.row);
 await ev(`document.querySelector('.billboard-move').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);await delay(80);assert.ok((await config()).row>z.row);
 a=await config();await drag('.billboard-resize',30,10);z=await config();assert.ok(z.duration>a.duration);assert.ok(z.height>a.height);
 // Flip and zoom reproject placement while the saved source coordinates stay fixed.
 const saved=await config();await tab('Run');await tool('flip');await delay(100);assert.deepEqual(await config(),saved);
 await ev(`(()=>{const c=document.querySelector('#scan'),r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width/2,clientY:r.y+20,deltaY:-90,ctrlKey:true,bubbles:true,cancelable:true}));})()`);await delay(100);assert.deepEqual(await config(),saved);await shot('04-flip-zoom-placement');
 // Smooth horizontal pan uses cached masks across RAFs. No per-frame readback.
 const panStats=await ev(`new Promise(resolve=>{const orig=CanvasRenderingContext2D.prototype.getImageData;let builds=0,frames=0;CanvasRenderingContext2D.prototype.getImageData=function(...args){if(this.canvas.dataset.billboardMask)builds++;return orig.apply(this,args);};const c=document.querySelector('#scan'),r=c.getBoundingClientRect();function tick(){c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width/2,clientY:r.y+20,deltaY:1,bubbles:true,cancelable:true}));if(++frames<45)requestAnimationFrame(tick);else requestAnimationFrame(()=>{CanvasRenderingContext2D.prototype.getImageData=orig;resolve({frames,maskBuilds:builds});});}requestAnimationFrame(tick);})`);
 assert.ok(panStats.maskBuilds<8,JSON.stringify(panStats));
 // Height framing changes the viewport, and hidden breaks preserve source placement.
 const stable=await config();await tool('height');await ev(`(()=>{const e=document.querySelector('#scanHeightEditor [data-edge="top"]');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`);await click('[data-height-done]');assert.deepEqual(await config(),stable);
 await tool('hideEmpty');await poll(()=>ev(`document.querySelector('#toast').textContent.includes('Empty spans hidden')`),'fake hidden columns');assert.deepEqual(await config(),stable);await shot('05-hidden-breaks');
 // Several independent bands can coexist; removal and undo preserve the others.
 await panel();const first=await config();await click('#billboard-new');assert.equal((await collection()).items.length,2);
 await set('billboard-row',92);await set('billboard-height',12);const second=await config();assert.notEqual(second.id,first.id);
 await ev(`document.querySelector('[data-billboard="${first.id}"] .billboard-select').click()`);assert.equal((await config()).row,first.row);
 await ev(`document.querySelector('[data-billboard="${second.id}"] .billboard-select').click()`);assert.equal((await config()).row,92);
 await ev(`document.querySelector('[data-billboard="${second.id}"] [aria-label^="Remove"]').click()`);assert.equal((await collection()).items.length,1);assert.deepEqual(await config(),first);
 await click('#billboard-undo-remove');assert.equal((await collection()).items.length,2);
 await ev(`document.querySelector('[data-billboard="${second.id}"] [aria-label^="Remove"]').click()`);assert.equal((await collection()).items.length,1);
 // Create and build through the actual bridge, then undo through the UI.
 await panel();assert.equal(await ev(`document.querySelector('#billboard-ai').open`),false);assert.equal(await ev(`!!document.querySelector('#billboard-new-art')||!!document.querySelector('#billboard-new-ai')`),false);
 await click('#billboard-ai summary');await set('billboard-prompt','Make a blue sponsor panel');await click('#billboard-build');await poll(()=>ev(`document.querySelector('#billboardLog').textContent.includes('Exit 0')`),'fake build');
 const name=(await config()).name,asset=path.join(profile,'billboards',name,'assets/billboard.svg');assert.match(await readFile(asset,'utf8'),/FAKE ART/);await shot('05-builder');
 await click('#billboard-undo');await poll(async()=>!((await readFile(asset,'utf8')).includes('FAKE ART')),'undo');assert.match(await readFile(asset,'utf8'),/OpenMeet/);
 await ev(`window.openmeet.call('occlusion.predict',{captureId:${JSON.stringify(path.basename(capture))}})`);
 assert.deepEqual(await Promise.all(['columns.bin','times.f64'].map(hash)),before);assert.equal(createHash('sha256').update(await readFile(input)).digest('hex'),modelInputBefore);
 await ev(`document.querySelector('#billboard-ai').open=true`);await click('#billboard-delete-art');await click('#billboard-delete-art');await poll(async()=>(await config()).name==='','artwork deletion');
 const final=await config();await ev(`document.querySelector('[data-billboard="${final.id}"] [aria-label^="Remove"]').click()`);assert.equal((await collection()).items.length,0);await tab('Run');await panel();assert.equal((await collection()).items.length,0);
 await tab('Camera setup');await click('#openAlignment');await poll(()=>ev(`document.querySelector('#ctl').textContent.includes('Stop preview')`),'camera setup preview');await ev(`[...document.querySelectorAll('.setup-modes button')].find(b=>b.textContent==='Billboards').click()`);assert.equal(await ev(`document.querySelector('#drawer').classList.contains('open')`),true);assert.equal((await collection()).items.length,0);await click('#drawerClose');await tab('Run');assert.equal((await readdir(captures)).length,1);assert.equal(await ev(`document.querySelector('.state').textContent`),'REVIEW');
 assert.deepEqual(await savedLanePrefs(),lanePrefs);
 assert.equal(await ev(`document.querySelector('#list').innerText`),marks);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({pass:true,output:root,changedPixels:changed,protectedRunnerPixels:protectedRed,sourcePixelsTimesAndModelInputUnchanged:true,actualProvidersUsed:false,canvas:info,panStats,liveMetrics}));
}catch(error){console.error(logs.slice(-5000));throw error;}
finally{clearTimeout(timer);ws?.close();stop();for(const p of pending.values())clearTimeout(p.t);}
