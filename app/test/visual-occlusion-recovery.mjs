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
if(!process.env.OPENMEET_OCCLUSION_COMMAND)throw Error('Configure a private occlusion command for this regression');
const realCommand=JSON.parse(process.env.OPENMEET_OCCLUSION_COMMAND),proxy=outDir+'/flaky-health.mjs',counter=outDir+'/health-count';
writeFileSync(proxy,`import fs from 'node:fs';import {spawn} from 'node:child_process';let raw='';for await(const d of process.stdin)raw+=d;const p=JSON.parse(raw),counter=${JSON.stringify(counter)};if(p.operation==='health'){const n=fs.existsSync(counter)?+fs.readFileSync(counter,'utf8')+1:1;fs.writeFileSync(counter,String(n));if(n<=3){process.stdout.write(JSON.stringify({ready:false}));process.exit(0);}}const command=${JSON.stringify(realCommand)},child=spawn(command[0],command.slice(1),{stdio:['pipe','inherit','inherit']});child.stdin.end(raw);child.on('exit',c=>process.exit(c||0));`);
const proc = spawn(`${appDir}/node_modules/electron/dist/electron`, args, { env:{...process.env,OPENMEET_OCCLUSION_COMMAND:JSON.stringify([process.execPath,proxy])},stdio: ['ignore', 'pipe', 'pipe'] });
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
const openHeat=async(event,heat)=>{await ev(`document.querySelector('#browseEvents').click()`);await ev(`(()=>{const s=document.querySelector('#meetSearch');s.value='';s.dispatchEvent(new Event('input'));const f=document.querySelector('#meetFilter');f.value='all';f.dispatchEvent(new Event('change'));const section=[...document.querySelectorAll('.meet-event')].find(e=>e.querySelector('h3').textContent.startsWith('E${event} ·'));const b=[...section.querySelectorAll('button')].find(b=>b.querySelector('b').textContent==='Heat ${heat}');b.click();})()`);await sleep(100);};
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
 await sleep(1800);
 // Mimic an older saved camera profile; changing the default must preserve its geometry.
 await ev(`(()=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':scan:primary')&&!k.includes(':sample:'));localStorage.setItem(key,JSON.stringify({enabled:true,behindRunners:true,occlusionMethod:'simple',boundaries:{'top:1':375}}));})()`);
 await send('Page.navigate',{url:page.url+'?speed=4'});await sleep(1600);
 assert(await ev(`Object.entries(localStorage).filter(([k])=>k.endsWith(':scan:primary')&&!k.includes(':sample:')).every(([,v])=>{const o=JSON.parse(v);return o.occlusionMethod==='learned'&&o.maskDefaultVersion===1&&o.boundaries['top:1']===375;})`),'Default migration lost settings or left Simple selected');
 await click('Start ');await sleep(3900);await click('Stop capture');await waitFor(`document.querySelector('.state').textContent==='REVIEW'`,'review');await sleep(450);
 const capture=newestCapture(),sha=name=>createHash('sha256').update(readFileSync(capture+'/'+name)).digest('hex'),pixels=sha('columns.bin'),times=sha('times.f64');
 await settings();await ev(`document.querySelector('[data-settings-group="advanced"]').open=true`);
 assert(await ev(`document.querySelector('[data-occlusion]').value==='learned'`),'Learned was not selected by default');
 await waitFor(`document.querySelector('[data-occlusion-status]').textContent==='Learned preview ready'`,'failed startup health recovers on opening settings',1200);
 assert(+readFileSync(counter,'utf8')>=4,'Settings reused the failed startup result');
 assert(existsSync(capture+'/occlusion-primary.png'),'Default model did not produce the display mask');assert(sha('columns.bin')===pixels&&sha('times.f64')===times,'Mask changed original evidence');
 await shot('01-recovered-model-default');await closeSettings();
 const clock=await ev(`document.querySelector('#tod').textContent`);
 await ev(`(()=>{const original=CanvasRenderingContext2D.prototype.drawImage;window.__paintFault=false;CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='scan'){CanvasRenderingContext2D.prototype.drawImage=original;window.__paintFault=true;throw Error('OPENMEET_TEST_TRANSIENT_DRAW');}return original.apply(this,args);};const c=document.querySelector('#scan'),r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+r.width/2,clientY:r.y+50,deltaY:-30,bubbles:true,cancelable:true}));})()`);
 await waitFor(`window.__paintFault&&document.querySelector('#tod').textContent!==${JSON.stringify(clock)}`,'display resumes after a transient draw failure',40);
 const injected=errors.findIndex(e=>e.includes('OPENMEET_TEST_TRANSIENT_DRAW'));assert(injected>=0,'The paint-failure recovery test did not execute');errors.splice(injected,1);
 await settings();await option('behindRunners',false);await ev(`document.querySelector('[data-settings-group="advanced"]').open=true`);
 assert((await ev(`document.querySelector('[data-occlusion-status]').textContent`))!=='Private service unavailable','Disabled display effect was reported as an offline service');
 await ev(`(()=>{const e=document.querySelector('[data-occlusion]');e.value='simple';e.dispatchEvent(new Event('change'));})()`);await closeSettings();await send('Page.reload');await sleep(1500);await settings();assert(await ev(`document.querySelector('[data-occlusion]').value==='simple'`),'Explicit Simple choice did not persist');
 console.log('PASS Learned default migration, failed startup/menu refresh recovery, actual private mask generation, draw-failure recovery, explicit Simple persistence and byte preservation');console.log('ERRORS',JSON.stringify(errors));assert(!errors.length,'Runtime errors');
}finally{await shot('last-state');ws.close();proc.kill();}
