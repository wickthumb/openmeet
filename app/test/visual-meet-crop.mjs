// Meet navigation, column keyboard control and optional private-cropper integration.
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
const openHeat=async(event,heat)=>{await ev(`document.querySelector('#browseEvents').click()`);await ev(`(()=>{const s=document.querySelector('#meetSearch');s.value='';s.dispatchEvent(new Event('input'));const f=document.querySelector('#meetFilter');f.value='all';f.dispatchEvent(new Event('change'));const section=[...document.querySelectorAll('.meet-event')].find(e=>e.querySelector('h3').textContent.startsWith('E${event} ·'));const b=[...section.querySelectorAll('button')].find(b=>b.querySelector('b').textContent==='Heat ${heat}');b.click();})()`);await sleep(100);};
const readReview=dir=>JSON.parse(readFileSync(dir+'/review.json','utf8'));
const press=async(key,shift=false)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,modifiers:shift?8:0});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,modifiers:shift?8:0});};
const saveReview=async dir=>{await click('Save');await waitFor(`document.querySelector('.state').textContent==='SAVED'`,'saved review');return readReview(dir);};
try {
 await sleep(1600);await send('Page.navigate',{url:page.url+'?speed=4'});await sleep(1400);
 await click('Start ');await sleep(3900);await click('Stop capture');await waitFor(`document.querySelector('.state').textContent==='REVIEW'`,'first review');await sleep(650);
 for(const lane of [4,5]){await selectLane(lane);await click('Accept time');}
 const first=newestCapture();await click('Save results');await sleep(1100);await openHeat(3,1);
 const hash=name=>createHash('sha256').update(readFileSync(first+'/'+name)).digest('hex');const pixels=hash('columns.bin'),times=hash('times.f64');
 const before=readReview(first),beforeRows=await results();
 if(privateCropConfigured){
   await click('Hide empty spans');await waitFor(`![...document.querySelectorAll('#tools button')].some(b=>b.textContent.includes('Finding empty'))`,'cropper idle');
   for(let i=0;i<120&&!existsSync(first+'/autocrop.json');i++)await sleep(1000);
   assert(existsSync(first+'/autocrop.json'),'Private cropper produced no capture result');
   assert(await click('Show all columns')==='ok','Cropper did not enable the hide view');
   await click('Hide empty spans');await selectLane(4);await sleep(120);await shot('01-nondestructive-hidden-spans');
   const cropped=JSON.parse(readFileSync(first+'/autocrop.json'));const kept=cropped.result.modes['storage-display'].cropped_to_original;
   for(const mark of Object.values(before.marks))assert(kept.includes(Math.floor(mark.col)),'A known finish was hidden');
   console.log('PRIVATE_CROP',JSON.stringify({width:cropped.result.original_width,kept:kept.length,ranges:cropped.result.modes['storage-display'].ranges}));
   assert(hash('columns.bin')===pixels&&hash('times.f64')===times,'Hiding rewrote original columns or timestamps');
 }
 // A canvas click must take focus away from the status dropdown before fine column control.
 await selectLane(4);await ev(`document.querySelector('#list .sel select').focus()`);
 const canvas=await bounds('#scan'),cx=canvas.x+canvas.w/2,cy=canvas.y+45;
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:cx,y:cy,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:cx,y:cy,button:'left',clickCount:1});
 assert(await ev(`document.activeElement.id==='scan'`),'Scan click left focus in the status selector');
 await press('Enter');let review=await saveReview(first),column=review.marks['4'].col;
 await press('ArrowRight');await press('Enter');review=await saveReview(first);assert(Math.abs(review.marks['4'].col-column-1)<1e-7,'Right arrow did not move one original column');column=review.marks['4'].col;
 await press('ArrowRight',true);await press('Enter');review=await saveReview(first);assert(Math.abs(review.marks['4'].col-column-10)<1e-7,'Shift-right did not move ten original columns');column=review.marks['4'].col;
 await click('Flip');await ev(`document.querySelector('#scan').focus()`);await press('ArrowRight');await press('Enter');review=await saveReview(first);assert(Math.abs(review.marks['4'].col-column+1)<1e-7,'Flipped right arrow did not move toward the left in original time');await click('Flip');
 await openHeat(3,2);await click('Start ');await sleep(700);const second=newestCapture(),sizeBefore=readFileSync(second+'/columns.bin').length;
 await openHeat(3,1);assert(await ev(`!!document.querySelector('.background-capture')`),'Review hides the active recording indicator');await selectLane(4);await ev(`document.querySelector('#scan').focus()`);await press('ArrowRight');await press('Enter');await saveReview(first);await sleep(800);const sizeAfter=readFileSync(second+'/columns.bin').length;assert(sizeAfter>sizeBefore,'Capture stopped while reviewing an older heat');
 // Reorder the meet-manager schedule in this disposable fixture; the selected review stays selected.
 const schedule=readFileSync(meetDir+'/meet/lynx.sch','utf8');console.log('SCHEDULE_INPUT',JSON.stringify(schedule));const lines=schedule.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith(';'));writeFileSync(meetDir+'/meet/lynx.sch',lines.reverse().join('\n')+'\n');await sleep(1600);
 assert(await ev(`document.querySelector('#quickHeat').selectedOptions[0].textContent.startsWith('1')`),'Schedule change switched away from the selected review');
 await ev(`document.querySelector('#browseEvents').click()`);await shot('02-meet-navigator');assert(await ev(`document.querySelector('.meet-event h3').textContent.startsWith('E4 ·')`),'Meet did not follow updated event order');
 await ev(`document.querySelector('#meetSearch').value='Hendricks';document.querySelector('#meetSearch').dispatchEvent(new Event('input'))`);assert(await ev(`document.querySelectorAll('[data-meet-heat]').length>0`),'Athlete search found no matching heats');
 await ev(`document.querySelector('#meetNavSummary button').click()`);await click('Stop capture');await waitFor(`document.querySelector('.state').textContent==='REVIEW'`,'live capture stopped explicitly');await sleep(500);
 await settings();await option('enabled',true);await closeSettings();await sleep(80);assert(await ev(`document.querySelector('#laneGutter [data-lane="2"]').textContent.includes('DNS')`),'DNS is missing from the lane overlay');assert(await ev(`document.querySelector('#laneGutter [data-lane="2"]').classList.contains('empty-lane')`),'DNS lane is not visually distinct');assert(await ev(`document.querySelector('#laneGutter [data-lane="8"]').disabled&&document.querySelector('#laneGutter [data-lane="8"]').textContent.includes('Empty')`),'Unentered lane is not marked empty');await shot('03-dns-lane-overlay');
 const pixelsOf=()=>ev(`(()=>{const canvas=document.querySelector('#scan'),ctx=canvas.getContext('2d'),samples={};for(const lane of [2,8]){const row=document.querySelector('#laneGutter [data-lane="'+lane+'"]'),y=Math.round((parseFloat(row.style.top)+parseFloat(row.style.height)/2)*canvas.height/canvas.clientHeight);samples[lane]=[.2,.4,.6,.8].map(x=>[...ctx.getImageData(Math.round(canvas.width*x),y,1,1).data]);}return samples;})()`);
 await settings();await ev(`document.querySelector('[data-settings-group="appearance"]').open=true`);await option('inactiveColor','#6f7b8a');await option('inactiveOpacity',.45);await option('shadeInactive',true);await closeSettings();await sleep(100);const shaded=await pixelsOf();
 await settings();await option('shadeInactive',false);await closeSettings();await sleep(100);const plain=await pixelsOf();assert(JSON.stringify(shaded[2])!==JSON.stringify(plain[2])&&JSON.stringify(shaded[8])!==JSON.stringify(plain[8]),'DNS and empty lane shading did not change the track pixels');
 await settings();await option('shadeInactive',true);await closeSettings();await source('main','Line-scan B');await settings();assert(await ev(`document.querySelector('[data-key="inactiveColor"]').value==='#98a0ab'`),'Inactive color leaked to another camera');await closeSettings();await source('main','Line-scan A');await settings();assert(await ev(`document.querySelector('[data-key="inactiveColor"]').value==='#6f7b8a'&&document.querySelector('[data-key="inactiveOpacity"]').value==='0.45'`),'Inactive appearance was not saved per camera');await closeSettings();await sleep(80);await shot('04-custom-inactive-lane-overlay');
 assert(hash('columns.bin')===pixels&&hash('times.f64')===times,'Status shading modified original pixels or clocks');
 console.log('PASS '+(privateCropConfigured?'private crop integration and original byte preservation; ':'private crop skipped (not configured); ')+'keyboard columns, live review, schedule reorder, athlete search and DNS overlay');console.log('ERRORS',JSON.stringify(errors));assert(!errors.length,'Runtime errors');
}finally{console.log('FINAL_ERRORS',JSON.stringify(errors));await shot('last-state');ws.close();proc.kill();}
