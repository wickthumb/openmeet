// Manual visual regression: real Electron, every demo heat, both camera roles, flip and zoom.
// Writes screenshots locally. No uploads, official starts or race capture files.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
const [,, appDir, meetDir, outDir, extra = ''] = process.argv;
if (!appDir || !meetDir || !outDir) throw new Error('Usage: node app/test/visual-cameras.mjs <absolute-app-dir> <demo-dir> <output-dir>');
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

try {
 await sleep(1800);
 await send('Page.reload');await sleep(1400);
 const findings=[];
 const heatCount=readdirSync(meetDir).filter(name=>/^heat-\d+$/.test(name)).length;
 for(let heat=1;heat<=heatCount;heat++){
  for(const camera of ['primary','backup']){
   await click('Camera alignment');await sleep(150);
   if(!await ev(`!!document.querySelector('select[aria-label="Main line-scan"]')`))throw Error('Demo cameras were not restored after reopening');
   const current=await ev(`document.querySelector('select[aria-label="Main line-scan"]').value`);
   if(current!==camera)await ev(`(()=>{const s=document.querySelector('select[aria-label="Main line-scan"]');s.value=${JSON.stringify(camera)};s.dispatchEvent(new Event('change'));})()`);
   await sleep(3000);await click('Overlays');await click('Stop preview');await sleep(150);
   await ev(`(()=>{[...document.querySelectorAll('#tools button')].find(b=>/Lanes/.test(b.textContent)).click();const m=document.querySelector('.overlay-settings');for(const k of ['enabled','behindRunners']){const e=m.querySelector('[data-key='+k+']');if(!e.checked)e.click();}for(const[k,value]of[['lineColor','#00ff00'],['opacity',1],['thickness',1]]){const e=m.querySelector('[data-key='+k+']');e.value=value;e.dispatchEvent(new Event('input'));}m.querySelector('[data-close]').click();})()`);await sleep(100);
   await shot(`mask-heat-${heat}-${camera}`);
   await click('Flip');await sleep(80);await shot(`mask-heat-${heat}-${camera}-flipped`);await click('Flip');
   // Zoom should stay responsive while guide paths are cached between pointer movements.
   const r=await ev(`(()=>{const r=document.querySelector('#scan').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()`);
   await ev(`(()=>{const c=document.querySelector('#scan');c.dispatchEvent(new WheelEvent('wheel',{clientX:${r.x+r.w*.6},clientY:${r.y+r.h*.5},deltaY:-250,ctrlKey:true,bubbles:true,cancelable:true}));})()`);await sleep(80);await shot(`mask-heat-${heat}-${camera}-zoom`);
   const label=await ev(`document.querySelector('#scanCameraLabel').textContent`);
   findings.push({heat,camera,label});
   await click('Run');await sleep(100);
  }
  if(heat<heatCount)await ev(`document.querySelector('#ctl button[title="Next heat"]').click()`);
 }
 console.log('VISUAL_MATRIX',JSON.stringify(findings));
 console.log('ERRORS',JSON.stringify(errors));if(errors.length)throw Error('Matrix page errors');
}finally{ws.close();proc.kill();}
