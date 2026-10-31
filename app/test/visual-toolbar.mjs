// Manual toolbar UX check: no official race starts, source writes or uploads.
// Writes screenshots locally. No uploads, official starts or race capture files.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
const [,, appDir, meetDir, outDir, extra = ''] = process.argv;
if (!appDir || !meetDir || !outDir) throw new Error('Usage: node app/test/visual-toolbar.mjs <absolute-app-dir> <demo-dir> <output-dir>');
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
const ids=()=>ev(`[...document.querySelectorAll('#tools [data-tool]')].map(b=>b.dataset.tool)`);
const openMore=()=>ev(`document.querySelector('#tools [data-more]').click()`);
const closeDialog=()=>ev(`document.querySelector('.scan-toolbar-dialog [aria-label="Close"]').click()`);
const pin=async(id,value)=>{await ev(`(()=>{const e=document.querySelector('.scan-toolbar-dialog [aria-label="Pin ${id}"]');if(e.checked!==${value})e.click();})()`);};
try {
 await sleep(1800);
 assert(JSON.stringify(await ids())===JSON.stringify(['zoom','lanes']),'Default toolbar is too crowded or missing core actions');
 await shot('01-default-toolbar');
 await openMore();assert(await ev(`!!document.querySelector('.scan-tool-menu [data-tool="flip"]')`),'Flip is not available in More');
 assert(await ev(`!!document.querySelector('.scan-tool-menu [data-tool="clear"]')`),'Recovery tools disappeared');await shot('02-grouped-more-menu');
 await click('Customize toolbar');assert(await ev(`!!document.querySelector('.scan-toolbar-dialog[open]')`),'Customize dialog missing');
 assert(JSON.stringify(await ev(`[...document.querySelectorAll('.scan-toolbar-dialog input:checked')].map(e=>e.getAttribute('aria-label'))`))===JSON.stringify(['Pin Follow live','Pin Zoom','Pin Unzoom','Pin Lanes','Pin Hide empty spans']),'Default pins do not match the chosen toolbar');await pin('Flip',true);await pin('Mark',false);
 for(let n=0;n<5;n++)await ev(`document.querySelector('[aria-label="Move Flip earlier"]').click()`);
 await click('Done');let pinned=await ids();assert(pinned[0]==='flip'&&!pinned.includes('mark'),'Pin and order changes did not apply together');
 await send('Page.reload');await sleep(1500);pinned=await ids();assert(pinned[0]==='flip'&&!pinned.includes('mark'),'Customization did not survive reload');await shot('03-custom-toolbar');
 await openMore();await click('Customize toolbar');
 await ev(`document.querySelectorAll('.scan-toolbar-dialog input[type=checkbox]').forEach(e=>{if(!e.checked)e.click();})`);await click('Done');
 await send('Emulation.setDeviceMetricsOverride',{width:1080,height:680,deviceScaleFactor:1,mobile:false});await sleep(120);
 const fit=await ev(`(()=>{const bar=document.querySelector('.scanbar').getBoundingClientRect(),more=document.querySelector('#tools [data-more]').getBoundingClientRect(),clock=document.querySelector('#ts').getBoundingClientRect(),buttons=[...document.querySelectorAll('#tools [data-tool]')].map(b=>b.getBoundingClientRect());return{viewport:{innerWidth,scrollX,body:document.body.clientWidth,root:document.documentElement.clientWidth,visual:window.visualViewport.width,main:document.querySelector('.main').getBoundingClientRect().width,grid:getComputedStyle(document.querySelector('.app')).gridTemplateColumns},fits:bar.right<=innerWidth+1&&more.right<=bar.right&&clock.left>=bar.left&&buttons.every(r=>r.left>=clock.right&&r.right<=more.left),count:buttons.length,bar:{x:bar.x,right:bar.right},more:{x:more.x,right:more.right},bounds:buttons.map(r=>({x:r.x,right:r.right})),clockRect:{x:clock.x,right:clock.right},clock:document.querySelector('#ts').textContent};})()`);
 console.log('NARROW_TOOLBAR',JSON.stringify({width:fit.viewport.innerWidth,count:fit.count,fits:fit.fits}));await shot('narrow-debug');assert(fit.fits&&fit.count<9,'Pinned tools clip the clock or overflow the narrow toolbar');await shot('04-responsive-overflow');
 await openMore();assert(await ev(`document.querySelectorAll('.scan-tool-menu [data-tool]').length>0`),'Overflowed controls are inaccessible');
 await click('Customize toolbar');await click('Reset toolbar');await click('Done');
 await openMore();await click('Controls & shortcuts');assert(await ev(`document.querySelector('.scan-toolbar-dialog').innerText.includes('Select a column')&&document.querySelector('.scan-toolbar-dialog').innerText.includes('Enter')`),'Help omits the main timing workflow');await shot('05-controls-and-shortcuts');
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'4',code:'Digit4'});assert(await ev(`document.querySelector('#entryNumber').hidden`),'Help keypress leaked into finish entry');await closeDialog();
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await sleep(100);
 await openMore();await ev(`document.querySelector('.scan-tool-menu [data-tool="auto"]').click()`);assert(await ev(`!!document.querySelector('[data-auto-toggle]')`),'Auto timing menu missing');
 await ev(`document.querySelector('[data-auto-toggle]').click()`);assert(await ev(`!JSON.parse(localStorage.getItem('openmeet.autoMark'))`),'Auto timing toggle did not save');
 await ev(`document.querySelector('[data-auto-toggle]').click()`);await shot('06-auto-timing-controls');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
 assert(!await ev(`!!document.querySelector('.scan-tool-menu')`),'Escape did not close Auto timing');
 // All tools may be unpinned; More and its customization/help entry points remain available.
 await openMore();await click('Customize toolbar');await ev(`document.querySelectorAll('.scan-toolbar-dialog input[type=checkbox]').forEach(e=>{if(e.checked)e.click();})`);await click('Done');assert((await ids()).length===0,'Unpin-all was ignored');
 await openMore();await click('Customize toolbar');await click('Reset toolbar');await click('Done');
 console.log('PASS default hierarchy, grouped overflow, persistent pin/order changes, narrow viewport, help, auto timing and reset');
 console.log('ERRORS',JSON.stringify(errors));assert(!errors.length,'Runtime errors');
}finally{ws.close();proc.kill();}
