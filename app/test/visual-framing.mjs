// Display framing and optional front-camera occlusion, using a disposable simulator fixture.
// Uses a disposable local fixture: no writes to the supplied demo, uploads or private models.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, linkSync, symlinkSync, copyFileSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [,, appDir, demoDir, outDir, extra = ''] = process.argv;
if(!appDir||!demoDir||!outDir)throw Error('Usage: node app/test/visual-workspace.mjs <absolute-app-dir> <simulator-demo-dir> <output-dir>');
const meetDir=outDir+'/fixture-'+Date.now();mkdirSync(meetDir,{recursive:true});
function shareFiles(from,to){mkdirSync(to,{recursive:true});for(const e of readdirSync(from,{withFileTypes:true})){if(/^scan-tower\.(png|json)$/.test(e.name))continue;if(e.isDirectory())shareFiles(from+'/'+e.name,to+'/'+e.name);else if(e.isFile()){try{linkSync(from+'/'+e.name,to+'/'+e.name);}catch{try{symlinkSync(from+'/'+e.name,to+'/'+e.name);}catch{copyFileSync(from+'/'+e.name,to+'/'+e.name);}}}}}
for(const name of readdirSync(demoDir).filter(n=>/^heat-\d+$/.test(n)))shareFiles(demoDir+'/'+name,meetDir+'/'+name);
mkdirSync(meetDir+'/meet');for(const name of readdirSync(demoDir+'/meet').filter(n=>/^lynx\./.test(n)))copyFileSync(demoDir+'/meet/'+name,meetDir+'/meet/'+name);
const {encodePng}=await import(pathToFileURL(appDir+'/../engine/sim/png-encode.js').href);
const original=JSON.parse(readFileSync(meetDir+'/heat-1/primary.json')),height=2000,width=1200,data=Buffer.alloc(width*height*3);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;data[i]=Math.floor(x/80)%2?70:20;data[i+1]=40+(y%100);data[i+2]=70;}
writeFileSync(meetDir+'/heat-1/scan-tower.png',encodePng({width,height,channels:3,data}));
writeFileSync(meetDir+'/heat-1/scan-tower.json',JSON.stringify({column_period_s:.002,first_column_race_time_s:original.first_column_race_time_s,rows:height,columns:width,camera_name:'Tower test camera',truth:[],lane_rows:original.lane_rows.map(b=>({lane:b.lane,top_row:b.top_row*height/original.rows,bottom_row:b.bottom_row*height/original.rows}))}));
const port = 9600 + Math.floor(Math.random() * 300);
const userData = `${outDir}/userdata-${Date.now()}`;
mkdirSync(userData, { recursive: true });
writeFileSync(`${userData}/openmeet-settings.json`, JSON.stringify({ demoDir: meetDir }));
const args = [appDir, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--ozone-platform=headless', ...extra.split(' ').filter(Boolean)];
const proc = spawn(`${appDir}/node_modules/electron/dist/electron`, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let plog = '';
proc.stdout.on('data', d => { plog += d; }); proc.stderr.on('data', d => { plog += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let page;
for (let i = 0; i < 60; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = l.find(t => t.type === 'page' && /index\.html/.test(t.url)); if (page) break; } catch {}
  await sleep(250);
}
if (!page) { console.log('NO PAGE. process log:\n' + plog.slice(-3000)); proc.kill(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const errors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails)).slice(0, 500));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push('CONSOLE ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) errors.push('EVAL ' + expr.slice(0, 80) + ' :: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300)); return r.result.result && r.result.result.value; };
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result) writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const click = async txt => {
  const find=()=>ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(txt)})&&!b.disabled&&b.offsetParent);if(!b)return false;b.click();return true;})()`);
  if(await find())return 'ok';
  const opened=await ev(`(()=>{const b=document.querySelector('#tools [data-more]');if(!b)return false;b.click();return true;})()`);
  return opened&&await find()?'ok':'NOBTN '+txt;
};
const state = () => ev(`document.querySelector('.state').textContent`);

const assert=(value,message)=>{if(!value)throw Error(message);};
const waitFor=async(expression,description,limit=80)=>{for(let i=0;i<limit;i++){if(await ev(expression))return;await sleep(100);}throw Error('Timed out: '+description);};
const bounds=selector=>ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()`);
const key=async(key,code=key)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code});};
const source=async(role,label)=>{await ev(`document.querySelector(${JSON.stringify(role==='main'?'#scanCameraLabel':'#comparisonCameraPicker')}).click()`);assert(await ev(`(()=>{const b=[...document.querySelectorAll('.camera-source-menu button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`),'Missing source '+label);await waitFor(`document.querySelector('#scanCameraLabel').disabled===false`,'source load');await sleep(150);};
const settings=async()=>{await ev(`[...document.querySelectorAll('#tools button')].find(b=>b.textContent.includes('Lanes')).click()`);};
const option=(k,v)=>ev(`(()=>{const e=document.querySelector('.overlay-settings [data-key="${k}"]');${typeof v==='boolean'?`e.checked=${v};`:`e.value=${JSON.stringify(v)};`}e.dispatchEvent(new Event('input'));})()`);
const closeSettings=()=>ev(`document.querySelector('.overlay-settings [data-close]').click()`);
const selectLane=lane=>ev(`(()=>{const r=[...document.querySelectorAll('#list .row')].find(r=>Number(r.querySelector('.lane').textContent)===${lane});r.click();})()`);
const pending=()=>ev(`[...document.querySelectorAll('#laneGutter .pending')].map(e=>Number(e.dataset.lane))`);
const results=()=>ev(`[...document.querySelectorAll('#list .row')].map(r=>r.innerText)`);

const privateCropConfigured=!!(process.env.OPENMEET_CROP_COMMAND||process.env.OPENMEET_CROP_URL);
const capturesRoot=meetDir+'/meet/openmeet/captures';
const newestCapture=()=>capturesRoot+'/'+readdirSync(capturesRoot).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
const openHeat=async(event,heat)=>{await click('Meet');await ev(`(()=>{const s=document.querySelector('#meetSearch');s.value='';s.dispatchEvent(new Event('input'));const f=document.querySelector('#meetFilter');f.value='all';f.dispatchEvent(new Event('change'));const section=[...document.querySelectorAll('.meet-event')].find(e=>e.querySelector('h3').textContent.startsWith('E${event} ·'));const b=[...section.querySelectorAll('button')].find(b=>b.querySelector('b').textContent==='Heat ${heat}');b.click();})()`);await sleep(100);};
const readReview=dir=>JSON.parse(readFileSync(dir+'/review.json','utf8'));
const press=async(key,shift=false)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,modifiers:shift?8:0});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,modifiers:shift?8:0});};
const saveReview=async dir=>{await click('Save');await waitFor(`document.querySelector('.state').textContent==='SAVED'`,'saved review');return readReview(dir);};
const showHeight=async()=>{assert(await click('Frame height')==='ok','Frame height unavailable');await sleep(100);assert(await ev(`!document.querySelector('#scanHeightEditor').hidden`),'Height editor did not open');};
const frameValues=()=>ev(`Object.fromEntries([...document.querySelectorAll('#scanHeightEditor [data-edge]')].map(e=>[e.dataset.edge,+e.getAttribute('aria-valuenow')]))`);
const dragHeight=async(edge,fraction)=>{const r=await bounds('#scanHeightEditor'),b=await bounds('#scanHeightEditor [data-edge="'+edge+'"]'),x=b.x+45,y=b.y+b.h/2;await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:y+fraction*r.h,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y:y+fraction*r.h,button:'left',clickCount:1});await sleep(100);};
const laneHeight=()=>ev(`parseFloat(document.querySelector('#laneGutter [data-lane="5"]').style.height)`);
const frontSettings=()=>ev(`document.querySelector('#frontLaneButton').click()`);
const frontOption=(key,value)=>ev(`(()=>{const e=document.querySelector('#overlay-settings-front [data-key="${key}"]');${typeof value==='boolean'?`e.checked=${value}`:`e.value=${JSON.stringify(value)}`};e.dispatchEvent(new Event('input'));})()`);
try {
 await sleep(1600);await send('Page.navigate',{url:page.url+'?speed=4'});await sleep(1400);
 // Reopening an old tile-based profile must wait until the video dimensions arrive.
 await ev(`(()=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':front')&&!k.includes(':sample:'));localStorage.setItem(key,JSON.stringify({enabled:true,positions:{1:{x:.5,y:.5}},fontSize:28}));})()`);await send('Page.reload');await sleep(1600);
 assert(await ev(`(()=>{const r=document.querySelector('#front').getBoundingClientRect(),p=document.querySelector('#frontLaneOverlay [data-lane="1"]').getBoundingClientRect();return Math.abs(p.x+p.width/2-r.x-r.width*.5)<1&&Math.abs(p.y+p.height/2-r.y-r.height*.5)<1;})()`),'Legacy profile migrated before the real image aspect ratio was known');

 await settings();await option('enabled',true);await closeSettings();await sleep(100);const baseline=await laneHeight();
 await showHeight();await dragHeight('top',.25);await dragHeight('bottom',-.05);
 const trimmed=await frameValues();assert(Math.abs(trimmed.top-original.rows*.25)<2&&Math.abs(trimmed.bottom-original.rows*.95)<2,'Pointer framing bounds are wrong');await shot('01-adjust-height');await click('Done');await sleep(100);
 const framed=await laneHeight();assert(Math.abs(framed/baseline-1/.7)<.02,'Idle scan does not use the framed sensor rows');
 await click('Start ');await sleep(3900);assert(Math.abs(await laneHeight()-framed)<1,'Live following reset the height framing');await click('Stop capture');await waitFor(`document.querySelector('.state').textContent==='REVIEW'`,'capture stopped');await sleep(700);
 const capture=newestCapture(),hash=name=>createHash('sha256').update(readFileSync(capture+'/'+name)).digest('hex'),pixels=hash('columns.bin'),times=hash('times.f64');await shot('02-framed-capture');
 await showHeight();await dragHeight('top',.05);await click('Done');await showHeight();await click('Full height');await click('Done');await sleep(80);assert(Math.abs(await laneHeight()-baseline)<1,'Full height did not restore the original rows');
 await showHeight();await dragHeight('top',.2);await click('Done');
 await source('main','Tower test camera');await showHeight();let values=await frameValues();assert(values.top===0&&values.bottom===2000,'A different-height camera inherited the first camera framing');await dragHeight('top',.1);await dragHeight('bottom',-.1);await click('Done');
 await source('main','Line-scan A');await showHeight();values=await frameValues();assert(Math.abs(values.top-original.rows*.2)<2&&values.bottom===original.rows,'Primary camera framing was lost on source switch');
 await ev(`document.querySelector('#scanHeightEditor [data-edge="top"]').focus()`);await press('End');await sleep(80);values=await frameValues();assert(values.bottom-values.top>=original.rows*.05-1,'Frame edges crossed');await click('Full height');await click('Done');
 assert(hash('columns.bin')===pixels&&hash('times.f64')===times,'Display framing rewrote source pixels or clocks');

 if(process.env.OPENMEET_OCCLUSION_COMMAND||process.env.OPENMEET_OCCLUSION_URL){
   await waitFor(`window.openmeet.call('occlusion.info').then(i=>i.ready)`,'private learned worker ready');await settings();await ev(`(()=>{const d=document.querySelector('[data-settings-group="advanced"]');d.open=true;const e=document.querySelector('[data-occlusion]');e.value='learned';e.dispatchEvent(new Event('change'));})()`);
   await waitFor(`document.querySelector('[data-occlusion-status]').textContent==='Learned preview ready'`,'learned mask reaches overlay',1200);
   assert(existsSync(capture+'/occlusion-primary.png')&&existsSync(capture+'/occlusion-primary.json'),'Model display mask was not retained beside the capture');const metadata=JSON.parse(readFileSync(capture+'/occlusion-primary.json'));assert(metadata.displayOnly&&metadata.width>0&&metadata.height===original.rows&&metadata.model.validation==='experimental','Model provenance or experimental status missing');
   assert(hash('columns.bin')===pixels&&hash('times.f64')===times,'Learned mask modified original evidence');console.log('PRIVATE_LEARNED_MASK',JSON.stringify({width:metadata.width,height:metadata.height,validation:metadata.model.validation}));await closeSettings();await shot('02b-private-learned-mask');
   await settings();await ev(`(()=>{const e=document.querySelector('[data-occlusion]');e.value='simple';e.dispatchEvent(new Event('change'));})()`);await closeSettings();
 }
 await selectLane(4);await sleep(800);await frontSettings();await frontOption('enabled',true);await frontOption('fontSize',64);await frontOption('opacity',1);await frontOption('edit',true);await ev(`(()=>{const e=document.querySelector('#overlay-settings-front [data-placement]');e.value='individual';e.dispatchEvent(new Event('change'));})()`);await closeSettings();
 const imageBefore=await bounds('.front-image-overlays'),labelBefore=await bounds('#frontLaneOverlay [data-lane="1"]');
 const target={x:imageBefore.x+imageBefore.w*.7,y:imageBefore.y+imageBefore.h*.65};await send('Input.dispatchMouseEvent',{type:'mousePressed',x:labelBefore.x+labelBefore.w/2,y:labelBefore.y+labelBefore.h/2,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',...target,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...target,button:'left',clickCount:1});await sleep(100);
 const overlayGeometry=()=>ev(`(()=>{const c=document.querySelector('.front-image-overlays').getBoundingClientRect(),l=document.querySelector('#frontLaneOverlay [data-lane="1"]'),r=l.getBoundingClientRect();return{x:(r.x+r.width/2-c.x)/c.width,y:(r.y+r.height/2-c.y)/c.height,font:parseFloat(l.style.fontSize)/c.height,aspect:c.width/c.height,h:c.height};})()`);
 const normal=await overlayGeometry();assert(Math.abs(normal.x-.7)<.01&&Math.abs(normal.y-.65)<.01,'Dragging stores tile coordinates instead of image coordinates');
 await ev(`document.querySelector('[data-p="front"] .ph').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(150);const large=await overlayGeometry();assert(Math.abs(large.aspect-16/9)<.001&&Math.abs(large.x-normal.x)<.001&&Math.abs(large.y-normal.y)<.001&&Math.abs(large.font-normal.font)<.001&&Math.abs(large.h-normal.h)>10,'Resizing changes front-overlay position or relative type size');await shot('03a-image-relative-resize');await ev(`document.querySelector('[data-p="front"] .ph').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await sleep(100);
 await frontSettings();await frontOption('behindRunners',true);await closeSettings();
 await waitFor(`document.querySelector('#frontLaneOverlay').style.maskImage.startsWith('url(')`,'front camera foreground mask',100);
 const maskStats=await ev(`(async()=>{const layer=document.querySelector('#frontLaneOverlay'),url=layer.style.maskImage.slice(5,-2),image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const g=c.getContext('2d');g.drawImage(image,0,0);const d=g.getImageData(0,0,c.width,c.height).data;let hidden=0,minx=c.width,miny=c.height,maxx=0,maxy=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(d[(y*c.width+x)*4+3]===0){hidden++;minx=Math.min(minx,x);miny=Math.min(miny,y);maxx=Math.max(maxx,x);maxy=Math.max(maxy,y);}return{width:c.width,height:c.height,hidden,total:c.width*c.height,bounds:[minx,miny,maxx,maxy],frame:document.querySelector('#front').dataset.frame};})()`);
 console.log('FRONT_MASK',JSON.stringify(maskStats));assert(maskStats.hidden>maskStats.total*.005&&maskStats.hidden<maskStats.total*.4,'Mask is empty or hides too much background');await shot('03-front-numbers-behind-runners');
 const initialMask=await ev(`document.querySelector('#frontLaneOverlay').style.maskImage`);await selectLane(1);await sleep(600);assert((await ev(`document.querySelector('#frontLaneOverlay').style.maskImage`))!==initialMask,'Scrubbing kept the previous frame mask');
 const r=await bounds('#front');await ev(`document.querySelector('#front').parentNode.dispatchEvent(new WheelEvent('wheel',{clientX:${r.x+r.w/2},clientY:${r.y+r.h/2},deltaY:-200,bubbles:true,cancelable:true}))`);await sleep(80);assert(await ev(`document.querySelector('#frontLaneOverlay').style.transform===document.querySelector('#front').style.transform`),'Zoom detached the overlay mask from the camera');await shot('04-front-zoom-alignment');
 await frontSettings();await frontOption('behindRunners',false);await closeSettings();assert(await ev(`document.querySelector('#frontLaneOverlay').style.maskImage==='none'`),'Turning the effect off left runner holes');
 // Save framing, reload, and verify the idle camera retains the view without a race.
 await showHeight();await dragHeight('top',.2);await click('Done');await send('Page.reload');await sleep(1800);await showHeight();values=await frameValues();assert(Math.abs(values.top-original.rows*.2)<2,'Framing did not survive reload');await click('Done');
 console.log('PASS live and idle height framing, independent 640/2000-row cameras, bounded edges, full reset, original byte preservation, front-camera occlusion, scrub/zoom alignment, toggle off and reload');
 console.log('ERRORS',JSON.stringify(errors));assert(!errors.length,'Runtime errors');
}finally{console.log('FINAL_ERRORS',JSON.stringify(errors));await shot('last-state');ws.close();proc.kill();}
