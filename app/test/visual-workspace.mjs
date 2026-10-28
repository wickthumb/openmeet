// Manual UI regression against the current eight-lane simulator demo.
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
try {
 await sleep(1600);await send('Page.navigate',{url:page.url+'?speed=4'});await sleep(1300);
 await settings();await option('enabled',true);await option('edit',false);await closeSettings();await sleep(100);
 // The compact settings panel keeps its origin after toolbar redraws and disclosure expansion.
 await settings();const menuOrigin=await bounds('.overlay-settings');
 const wordCount=await ev(String.raw`document.querySelector('.overlay-settings').innerText.trim().split(/\s+/).length`);assert(wordCount<40,'Settings still show too much helper copy');
 assert(!await ev(`!!document.querySelector('.overlay-settings [data-key="fontSize"]')`),'Scan still requires a manual font size');
 await shot('compact-lane-settings');await send('Emulation.setDeviceMetricsOverride',{width:1450,height:900,deviceScaleFactor:1,mobile:false});await sleep(80);await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await sleep(80);
 for(const group of ['advanced','appearance','placement']){await ev(`document.querySelector('[data-settings-group="${group}"]').open=true`);await sleep(70);const r=await bounds('.overlay-settings');assert(Math.abs(r.x-menuOrigin.x)<1&&Math.abs(r.y-menuOrigin.y)<1,'Expanding '+group+' moved the settings panel');if(group==='advanced'){const control=await bounds('[data-key="modelInput"]');assert(control.y+control.h<=r.y+r.h,'Expanded advanced control is hidden below panel');await shot('advanced-settings-fixed-position');}}
 await shot('expanded-settings-stay-anchored');
 await send('Emulation.setDeviceMetricsOverride',{width:1080,height:680,deviceScaleFactor:1,mobile:false});await sleep(80);const smallMenu=await bounds('.overlay-settings');assert(smallMenu.x>=8&&smallMenu.y>=8&&smallMenu.x+smallMenu.w<=1073&&smallMenu.y+smallMenu.h<=673,'Settings overflow the smaller viewport');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await sleep(80);await closeSettings();
 await ev(`document.querySelector('.pnl[data-p="front"] .ph button.btn').click()`);assert(await ev(`!!document.querySelector('.overlay-settings [data-key="fontSize"]')`),'Front camera lost its label size control');await closeSettings();
 const normalizedEdges=()=>ev(`(()=>{const height=document.querySelector('#scan').clientHeight-22;return [...document.querySelectorAll('.lane-divider')].map(e=>({key:e.dataset.boundary,fraction:(parseFloat(e.style.top)+6)/height}));})()`);
 const emptyBefore=await normalizedEdges();
 await click('Camera alignment');await sleep(500);await click('Stop preview');await sleep(100);
 await ev(`document.querySelector('#workspaceSplit').focus()`);await key('Home');await sleep(100);await click('Return to race');await sleep(100);
 const emptyAfter=await normalizedEdges();console.log('EMPTY_CAMERA_GEOMETRY',JSON.stringify({before:emptyBefore,after:emptyAfter}));
 assert(emptyBefore.length===emptyAfter.length&&emptyBefore.every((e,i)=>Math.abs(e.fraction-emptyAfter[i].fraction)<.002),'Empty camera geometry changed after preview/resize; race start required to repair it');
 await ev(`document.querySelector('#workspaceSplit').focus()`);await key('Enter');
 // Remember native rows before a race and preserve the same layout across a resolution mode change.
 assert(await ev(`JSON.parse(localStorage.getItem('openmeet.camera-geometry:'+${JSON.stringify(meetDir+'/meet')}+':primary')).rows`)===640,'Camera resolution was not remembered');
 const pixelGuide=await ev(`(()=>{const c=document.querySelector('#scan'),g=c.getContext('2d'),y=parseFloat(document.querySelector('.lane-divider').style.top)+6;for(let row=Math.floor(y)-2;row<=Math.ceil(y)+2;row++)if(g.getImageData(8,row,1,1).data[2]>40)return true;return false;})()`);assert(pixelGuide,'Lane guides disappeared when no columns were present');
 const nativeProfile=await normalizedEdges();
 unlinkSync(meetDir+'/heat-1/primary.png');copyFileSync(meetDir+'/heat-1/scan-tower.png',meetDir+'/heat-1/primary.png');
 const changedMeta={...original,rows:2000,column_period_s:.002,lane_rows:original.lane_rows.map(b=>({...b,top_row:b.top_row*2000/original.rows,bottom_row:b.bottom_row*2000/original.rows,...(b.standing_head_row_1p80m!=null?{standing_head_row_1p80m:b.standing_head_row_1p80m*2000/original.rows}:{})}))};
 unlinkSync(meetDir+'/heat-1/primary.json');writeFileSync(meetDir+'/heat-1/primary.json',JSON.stringify(changedMeta));
 await send('Page.reload');await sleep(1700);const modeChanged=await normalizedEdges();assert(nativeProfile.length===modeChanged.length&&nativeProfile.every((e,i)=>Math.abs(e.fraction-modeChanged[i].fraction)<.002),'Resolution change shifted saved lane layout');
 assert(await ev(`JSON.parse(localStorage.getItem('openmeet.camera-geometry:'+${JSON.stringify(meetDir+'/meet')}+':primary')).rows`)===2000,'New camera resolution was not retained');
 for(const name of ['primary.png','primary.json']){unlinkSync(meetDir+'/heat-1/'+name);copyFileSync(demoDir+'/heat-1/'+name,meetDir+'/heat-1/'+name);}
 await send('Page.reload');await sleep(1700);const reloaded=await normalizedEdges();assert(nativeProfile.length===reloaded.length&&nativeProfile.every((e,i)=>Math.abs(e.fraction-reloaded[i].fraction)<.002),'Reload changed idle lane positions');
 await shot('remembered-camera-geometry-without-capture');
 assert(await click('Start ')==='ok','start');await sleep(4000);await click('Stop capture');await waitFor(`document.querySelector('.state').textContent==='REVIEW'`,'review');await sleep(700);
 const before=await results();
 const capRoot=meetDir+'/meet/openmeet/captures',capDir=capRoot+'/'+readdirSync(capRoot).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)))[0];
 const digest=name=>createHash('sha256').update(readFileSync(capDir+'/'+name)).digest('hex'),pixelsBefore=digest('columns.bin'),clocksBefore=digest('times.f64');
 assert(!await ev(`[...document.querySelectorAll('#tools button')].some(b=>b.textContent==='Crop'||b.textContent==='Unzoom')`),'Fit view has wrong zoom tools');
 await settings();await option('enabled',true);await option('edit',false);await option('needsFinish',true);await closeSettings();await sleep(120);
 const image=await bounds('#scan'),gutter=await bounds('#laneGutter');assert(gutter.w>=38&&gutter.x+gutter.w<=image.x+1,'Gutter overlaps image');
 assert(await ev(`document.querySelectorAll('#laneGutter .lane-row').length`)===8,'Wrong lane row count');
 // Removing a marked finish highlights its lane; a status resolves it.
 await selectLane(1);await ev(`document.querySelector('#list .row.selected .clear-athlete')?.click() || document.querySelector('#list .row.sel .clear-athlete')?.click()`);await sleep(80);
 // Toolbar deletion is an explicit fallback, independent of row styling.
 await click('Delete mark');await sleep(80);assert((await pending()).includes(1),'Unmarked lane not highlighted');
 for(const status of ['DNS','DNF','DQ','FS']){
  await ev(`(()=>{const row=[...document.querySelectorAll('#list .row')].find(r=>r.querySelector('.lane').textContent.trim()==='1');const s=row.querySelector('select');s.value='${status}';s.dispatchEvent(new Event('change'));})()`);await sleep(50);assert(!(await pending()).includes(1),status+' did not resolve lane');
 }
 await ev(`(()=>{const row=[...document.querySelectorAll('#list .row')].find(r=>r.querySelector('.lane').textContent.trim()==='1');const s=row.querySelector('select');s.value='';s.dispatchEvent(new Event('change'));})()`);await sleep(60);assert((await pending()).includes(1),'Cleared status did not restore highlight');
 // Accepted and pending finish markers use matching positions and styles on both scans.
 await ev(String.raw`(()=>{window.markerProbe={};for(const id of ['scan','backup']){const c=document.querySelector('#'+id),g=c.getContext('2d'),fill=g.fillRect,text=g.fillText,stroke=g.stroke,draw=g.drawImage;g.fillRect=function(...a){if(a[0]===0&&a[1]===0&&a[2]===c.clientWidth&&a[3]===c.clientHeight)window.markerProbe[id]={labels:[],dashed:0};return fill.apply(this,a);};g.fillText=function(...a){if(/^\d+$/.test(String(a[0]))&&a[2]<=30)window.markerProbe[id]?.labels.push({lane:Number(a[0]),fraction:a[1]/c.clientWidth});return text.apply(this,a);};g.stroke=function(...a){if(this.getLineDash()[0]===5)window.markerProbe[id].dashed++;return stroke.apply(this,a);};if(id==='scan')g.drawImage=function(...a){if(a.length===3&&a[0] instanceof HTMLCanvasElement&&a[0].width===c.clientWidth&&a[0].height===c.clientHeight-22){window.reviewHighlight=a[0];window.reviewHighlightOpacity=this.globalAlpha;}return draw.apply(this,a);};}})()`);
 await selectLane(4);await sleep(100);
 for(const flip of [false,true]){if(flip)await click('Flip');await sleep(100);const markers=await ev(`window.markerProbe`);assert(markers.backup.dashed>=2,'Backup is missing pending review hairlines');assert(markers.scan.labels.length>=3,'No scan lane labels were checked');assert(markers.scan.labels.length===markers.backup.labels.length,'Backup lane labels differ from main');for(const label of markers.scan.labels){const other=markers.backup.labels.find(l=>l.lane===label.lane);assert(other&&Math.abs(label.fraction-other.fraction)<.01,'Backup finish time is misplaced');}}
 await click('Flip');await sleep(80);await shot('review-marks-on-both-scans');
 const highlight=await ev(`(()=>{const c=window.reviewHighlight;if(!c)return null;const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data,rows=[...document.querySelectorAll('#laneGutter .pending')].map(e=>({top:parseFloat(e.style.top),height:parseFloat(e.style.height)}));let clear=0,painted=0;for(const row of rows)for(let y=Math.ceil(row.top)+1;y<Math.min(c.height,Math.floor(row.top+row.height)-1);y++)for(let x=2;x<c.width-2;x++){const alpha=pixels[(y*c.width+x)*4+3];if(alpha===0)clear++;if(alpha===255)painted++;}return{clear,painted,opacity:window.reviewHighlightOpacity};})()`);assert(highlight?.clear>50&&highlight.painted>1000,'Highlight does not preserve foreground holes and painted background');assert(highlight.opacity>=.27,'Review highlight is still too faint');console.log('REVIEW_HIGHLIGHT',JSON.stringify(highlight));
 await shot('lane-gutter-awaiting-finish');
 // Gutter dividers work with image editing off and move only one shared edge.
 const edges=()=>ev(`[...document.querySelectorAll('.lane-divider')].map(e=>({key:e.dataset.boundary,y:parseFloat(e.style.top)}))`);
 const edgeBefore=await edges(),edge=edgeBefore[3],r=await bounds(`[data-boundary="${edge.key}"]`);
 assert(await ev(`document.querySelectorAll('#laneGutter .lane-divider:disabled').length`)===0,'Gutter still requires edit mode');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+r.w/2,y:r.y+r.h/2,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+r.w/2,y:r.y+r.h/2+8,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+r.w/2,y:r.y+r.h/2+8,button:'left',clickCount:1});await sleep(100);
 const edgeAfter=await edges();assert(edgeAfter.filter((e,i)=>Math.abs(e.y-edgeBefore[i].y)>.1).length===1,'Gutter drag changed multiple boundaries');
 await settings();await option('thickness',2);await ev(`document.querySelector('.overlay-settings [data-defaults]').click()`);await closeSettings();assert(JSON.stringify(await edges())===JSON.stringify(edgeAfter),'Appearance reset moved boundaries');
 // Splitter changes only heights and preserves full scan width. Both limits work.
 const labelSize=()=>ev(`[...document.querySelectorAll('#laneGutter .lane-row')].map(e=>({lane:e.dataset.lane,size:parseFloat(e.style.fontSize),height:parseFloat(e.style.height)}))`);
 const labelBefore=await labelSize();
 const scanWidth=(await bounds('.scan')).w,bar=await bounds('#workspaceSplit');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:bar.x+bar.w/2,y:bar.y+4,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:bar.x+bar.w/2,y:bar.y-100,button:'left',buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:bar.x+bar.w/2,y:bar.y-100,button:'left',clickCount:1});await sleep(100);
 assert((await bounds('#workspaceSplit')).y<bar.y-90,'Splitter did not move');assert((await bounds('.scan')).w===scanWidth,'Scan lost full width');
 await ev(`document.querySelector('#workspaceSplit').focus()`);await key('Home');assert((await bounds('#work')).h>=139,'Workspace below minimum');const largerLabels=await labelSize();assert(largerLabels.some(e=>e.size>labelBefore.find(b=>b.lane===e.lane).size),'Gutter labels did not grow with their lane rows');assert(largerLabels.every(e=>e.size<=e.height&&e.size<=28),'Automatic labels overflow their rows');await key('End');assert((await bounds('.scan')).h>=219,'Scan below minimum');await key('Enter');await shot('workspace-height-splitter');
 // View switching preserves roster results and recording identity; independent camera styles.
 const changed=await results();await source('main','Line-scan B');assert((await ev(`document.querySelector('#scanCameraLabel').textContent`)).includes('Line-scan B'),'Main label not switched');assert(JSON.stringify(await results())===JSON.stringify(changed),'Camera switch changed results');
 await settings();assert(await ev(`document.querySelector('[data-key="modelInput"]').disabled`),'Alternate view changes recorded model input');await closeSettings();
 await source('comparison','Tower test camera');await shot('camera-b-with-tower-comparison');await source('main','Tower test camera');await shot('tower-camera-main');
 await source('main','Line-scan A');await source('comparison','Line-scan B');assert(JSON.stringify(await results())===JSON.stringify(changed),'Returning to A changed results');
 // A mark made on the 2 ms source retains its native sample and canonical timestamp.
 await selectLane(1);await source('main','Tower test camera');const nativeRect=await bounds('#scan');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',x:nativeRect.x+nativeRect.w*.6,y:nativeRect.y+nativeRect.h*.4,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:nativeRect.x+nativeRect.w*.6,y:nativeRect.y+nativeRect.h*.4,button:'left',clickCount:1});await key('ArrowRight');await key('Enter');
 for(const lane of [4,5]){await selectLane(lane);await click('Accept time');}await click('Save results');await waitFor(`document.querySelector('.state').textContent!=='REVIEW'`,'saved results');
 const evidence=JSON.parse(readFileSync(capDir+'/review.json'));assert(evidence.cameraId==='primary','Review relabelled original source');const mark=evidence.marks['1'],nativeMeta=JSON.parse(readFileSync(meetDir+'/heat-1/scan-tower.json'));assert(mark.cameraId==='scan-tower','Native mark source missing');assert(Math.abs(mark.cameraColumn-Math.round(mark.cameraColumn))<1e-6,'Native mark is between samples');
 const markedTime=evidence.timeOrigin+(mark.col+.5)*evidence.columnPeriod,sourceTime=nativeMeta.first_column_race_time_s+(mark.cameraColumn+.5)*nativeMeta.column_period_s;assert(Math.abs(markedTime-sourceTime)<1e-9,'Native timestamp changed during conversion');assert(digest('columns.bin')===pixelsBefore&&digest('times.f64')===clocksBefore,'Review rewrote original pixels or clocks');assert(existsSync(capDir+'/views/scan-tower.png')&&existsSync(capDir+'/views/backup.png'),'Viewed evidence was not retained');
 console.log('NATIVE_MARK_EVIDENCE',JSON.stringify({mark,markedTime,sourceTime,originalUnchanged:true}));
 // Return to the previous attempt for the remaining view-only checks.
 await ev(`document.querySelector('#ctl button[title="Previous heat"]').click()`);await sleep(100);

 // Zoom is a view tool and Unzoom only appears after use.
 await click('Unzoom');const sr=await bounds('#scan');await send('Input.dispatchMouseEvent',{type:'mousePressed',x:sr.x+sr.w*.3,y:sr.y+sr.h*.55,button:'left',clickCount:1,modifiers:8});await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:sr.x+sr.w*.7,y:sr.y+sr.h*.85,button:'left',buttons:1,modifiers:8});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:sr.x+sr.w*.7,y:sr.y+sr.h*.85,button:'left',clickCount:1,modifiers:8});assert(await ev(`[...document.querySelectorAll('#tools button')].some(b=>b.textContent==='Unzoom')`),'Missing Unzoom after box zoom');await click('Unzoom');assert(!await ev(`[...document.querySelectorAll('#tools button')].some(b=>b.textContent==='Unzoom')`),'Unzoom remains after fit');
 await settings();await ev(`document.querySelector('[data-settings-group="appearance"]').open=true`);await shot('organized-lane-settings');await key('Escape');assert(!await ev(`!!document.querySelector('.overlay-settings')`),'Escape did not dismiss settings');
 console.log('PASS gutter, shared edges, race status checks, settings resets, splitter, camera selectors, preserved results and zoom');console.log('ERRORS',JSON.stringify(errors));assert(!errors.length,'Runtime errors');
} finally {console.log('FINAL_ERRORS',JSON.stringify(errors));await shot('workspace-final');ws.close();proc.kill();}
