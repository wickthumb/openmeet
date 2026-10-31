// Disposable front-camera workflow: delayed live masks and delayed PNG decoding.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {replayFixture} from './support/replay-fixture.mjs';
import {sourceId} from '../simulation-sources.mjs';
import {encodePng} from '../../engine/sim/png-encode.js';

const appDir=path.resolve(process.argv[2]||new URL('..',import.meta.url).pathname);
const packaged=!!process.argv[3],executable=packaged?path.resolve(process.argv[3]):path.join(appDir,'node_modules/electron/dist/electron');
const root=await mkdtemp('/tmp/openmeet-front-flicker-'),{dir,meta}=await replayFixture(root);
const meetDir=path.join(dir,'meet'),profile=path.join(root,'profile'),output=path.join(root,'output');
await Promise.all([profile,output].map(p=>mkdir(p)));
await writeFile(path.join(meetDir,'lynx.evt'),'5,1,1,Front flicker check\n,101,2,Example,Ada,Club\n,102,4,Other,Bo,Club\n');
const hd=path.join(dir,'heat-1'),frames=path.join(hd,'front');await mkdir(frames);
const width=4000,height=120,data=Buffer.alloc(width*height*3,90);
await writeFile(path.join(hd,'primary.png'),encodePng({width,height,channels:3,data}));
await writeFile(path.join(hd,'primary.json'),JSON.stringify({...meta,truth:[]}));
for(let frame=0;frame<120;frame++){
  const pixels=Buffer.alloc(80*50*3,100);
  if(frame>=90)for(let y=15;y<40;y++)for(let x=20+frame%10;x<32+frame%10;x++)pixels.set([20,140,180],(y*80+x)*3);
  await writeFile(path.join(frames,String(frame).padStart(4,'0')+'.png'),encodePng({width:80,height:50,channels:3,data:pixels}));
}
const ffmpeg=spawnSync('ffmpeg',['-loglevel','error','-y','-framerate','30','-i',path.join(frames,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p',path.join(hd,'front.mp4')]);
if(ffmpeg.status!==0)throw Error(ffmpeg.stderr.toString());
await writeFile(path.join(hd,'front.json'),JSON.stringify({fps:30,first_frame_race_time_s:0,frame_count:120,width:80,height:50}));
await writeFile(path.join(profile,'openmeet-settings.json'),JSON.stringify({simulationSources:[{id:sourceId(dir),type:'real',name:'Front flicker check',path:dir}],simulationSourceId:sourceId(dir),resultsFor:{[meetDir]:output}}));
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('OPENMEET_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];
const child=spawn(executable,[...(packaged?[]:[appDir]),'--remote-debugging-port=0','--ozone-platform=headless','--user-data-dir='+profile],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,id=0;const pending=new Map(),errors=[];child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,90000);
async function poll(fn,label){for(let i=0;i<200;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,{resolve,reject,t});ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
const click=selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled '+${JSON.stringify(selector)});e.click();})()`);
const state=()=>ev(`document.querySelector('.state').textContent`);
const hover=fraction=>ev(`(()=>{const c=document.querySelector('#scan'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('mousemove',{clientX:r.x+r.width*${fraction},clientY:r.y+r.height*.5,bubbles:true}));})()`);
const snapshot=()=>ev(`({front:{...document.querySelector('#front').dataset},overlay:{...document.querySelector('#frontLaneOverlay').dataset},visibility:document.querySelector('#frontLaneOverlay').style.visibility,mask:document.querySelector('#frontLaneOverlay').style.maskImage,liveSamples:window.__liveSamples,liveWaiting:window.__liveWaiting,liveFaults:window.__liveFaults,decodeFaults:window.__decodeFaults,blobDecodes:window.__blobDecodes?.map(({url,ready,held})=>({url,ready,held}))})`);
try{
  const port=await poll(()=>logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'DevTools');
  const page=await poll(async()=>{try{return(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{}},'page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.t);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description);};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await poll(()=>ev(`!!document.querySelector('#quickEvent option[value="5"]')&&!document.querySelector('#quickEvent').disabled`),'meet loaded');
  await ev(`localStorage.setItem('openmeet.autoMark','false')`);await send('Page.reload');
  await poll(()=>ev(`document.querySelector('#list')?.textContent.includes('Ada')&&!document.querySelector('#quickMeet').disabled`),'fixture');
  await ev(`(()=>{
    window.__frontPosts=[];window.__clearLiveResults=[];window.__liveSamples=0;window.__liveWaiting=0;window.__liveFaults=[];window.__decodeFaults=[];window.__blobDecodes=[];window.__holdMaskDecodes=false;window.__phase='setup';
    const Base=window.Worker;window.Worker=class extends Base{
      constructor(...args){super(...args);this.front=String(args[0]).includes('front-occlusion-worker');if(this.front)this.addEventListener('message',({data})=>{if(data.clear===true&&data.stamp?.startsWith('video:'))window.__clearLiveResults.push(data.stamp);});}
      postMessage(data,...args){if(!this.front||data.type!=='frame')return super.postMessage(data,...args);window.__frontPosts.push(data.stamp);setTimeout(()=>super.postMessage(data,...args),80);}
    };
    const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=function(...args){
      if(!this.src.startsWith('blob:'))return decode.apply(this,args);
      const entry={url:this.src,ready:false,held:window.__holdMaskDecodes};window.__blobDecodes.push(entry);
      const gate=entry.held?new Promise(resolve=>{entry.release=resolve;}):Promise.resolve();
      return Promise.all([decode.apply(this,args),gate]).then(()=>{entry.ready=true;});
    };
    window.__watchFront=true;const watch=()=>{
      if(!window.__watchFront)return;const front=document.querySelector('#front'),layer=document.querySelector('#frontLaneOverlay'),video=document.querySelector('video.frontvid');
      if(window.__phase==='live'&&window.__clearLiveResults.length&&video?.style.display==='block'&&!video.paused&&!video.seeking){window.__liveSamples++;if(layer.dataset.occlusion==='waiting-frame')window.__liveWaiting++;if(getComputedStyle(layer).visibility==='hidden')window.__liveFaults.push({state:layer.dataset.occlusion,time:video.currentTime});}
      for(const entry of window.__blobDecodes)if(!entry.ready&&layer.style.maskImage.includes(entry.url))window.__decodeFaults.push({url:entry.url,frame:front.dataset.frame});
      requestAnimationFrame(watch);
    };requestAnimationFrame(watch);
  })()`);
  await click('#frontLaneButton');
  for(const key of ['enabled','behindRunners'])await ev(`(()=>{const e=document.querySelector('#overlay-settings-front [data-key="${key}"]');e.checked=true;e.dispatchEvent(new Event('input'));})()`);
  await click('#overlay-settings-front [data-close]');await ev(`window.__phase='live'`);
  await click('#ctl .go');await poll(async()=>(await state())==='RUNNING','capture');
  await poll(()=>ev(`window.__clearLiveResults.length>0`),'first completed live clear mask');
  await delay(1400);await ev(`window.__phase='review'`);
  const live=await snapshot();assert.ok(live.liveSamples>=30,JSON.stringify(live));assert.ok(live.liveWaiting>=10,'No delayed clear-mask gap was exercised');assert.deepEqual(live.liveFaults,[],'Clear live masks blinked between worker results');
  await hover(.01);await delay(1800);await click('#ctl .go');await poll(async()=>(await state())==='REVIEW','stop');
  await poll(()=>ev(`(()=>{const f=document.querySelector('#front'),o=document.querySelector('#frontLaneOverlay');return f.dataset.frame===f.dataset.wantedFrame&&o.dataset.occlusion==='ready'&&o.dataset.maskKind==='clear';})()`),'presented clear review frame');
  const capRoot=path.join(meetDir,'openmeet/captures'),capture=path.join(capRoot,(await readdir(capRoot))[0]);
  const hash=async name=>createHash('sha256').update(await readFile(path.join(capture,name))).digest('hex');
  const originals=await Promise.all(['columns.bin','times.f64'].map(hash));
  const previous=await ev(`document.querySelector('#front').dataset.frame`);
  const previousBadge=await ev(`document.querySelector('.frametag').textContent`);
  await ev(`window.__tagMutations=0;window.__tagObserver=new MutationObserver(records=>{window.__tagMutations+=records.length;});window.__tagObserver.observe(document.querySelector('.frametag'),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['style']})`);
  for(let i=0;i<5;i++){await click('[data-order="lane"]');await ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);}
  const timestampWrites=await ev(`window.__tagObserver.disconnect();window.__tagMutations`);assert.equal(timestampWrites,0,'Unchanged frame badge was hidden or rewritten on unrelated redraws');

  await ev(`window.__holdMaskDecodes=true`);await hover(.99);
  await poll(()=>ev(`window.__blobDecodes.some(entry=>entry.held&&!entry.ready)`),'foreground-mask resource decode');
  await delay(120);
  const held=await snapshot();assert.equal(held.front.frame,previous,'Bitmap advanced before its mask PNG was decoded');assert.notEqual(held.front.wantedFrame,previous,'Foreground target was not selected');assert.notEqual(held.visibility,'hidden','Previous ready pair disappeared while decoding');assert.deepEqual(held.decodeFaults,[],'An undecoded PNG was assigned as the visible CSS mask');assert.equal(await ev(`document.querySelector('.frametag').textContent`),previousBadge,'Timestamp stopped matching the held frame');assert.equal(await ev(`document.querySelector('.frametag').style.display`),'block');
  await ev(`window.__holdMaskDecodes=false;for(const entry of window.__blobDecodes)entry.release?.()`);
  await poll(()=>ev(`(()=>{const f=document.querySelector('#front'),o=document.querySelector('#frontLaneOverlay');return f.dataset.frame===f.dataset.wantedFrame&&o.dataset.maskFrame===f.dataset.frame&&o.dataset.occlusion==='ready'&&o.dataset.maskKind==='foreground';})()`),'decoded matching foreground frame and mask');
  const final=await snapshot();assert.deepEqual(final.decodeFaults,[]);assert.notEqual(final.front.frame,previous);assert.deepEqual(await Promise.all(['columns.bin','times.f64'].map(hash)),originals);
  await ev(`window.__watchFront=false`);assert.deepEqual(errors,[]);
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,'front-flicker.png'),Buffer.from(screenshot.data,'base64'));
  const result={pass:true,output:root,packaged,workerDelayMs:80,liveSamples:live.liveSamples,liveWaitingSamples:live.liveWaiting,liveClearResults:await ev(`window.__clearLiveResults.length`),heldPreviousFrame:previous,presentedFrame:final.front.frame,blobDecodes:final.blobDecodes.length,timestampWrites,heldFrameBadge:true,evidenceUnchanged:true};
  await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({logs:logs.slice(-2000),errors,front:await snapshot().catch(()=>null),ui:await ev('document.body.innerText').catch(()=>null)}));throw error;}
finally{clearTimeout(timer);ws?.close();stop();for(const p of pending.values())clearTimeout(p.t);}
