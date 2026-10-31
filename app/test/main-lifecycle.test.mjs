import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source=readFileSync(new URL('../main.mjs',import.meta.url),'utf8')
  // Exercise Windows checkout line endings on every host, including Linux CI.
  .replace(/\r?\n/g,'\r\n')
  .replace(/^import .*?;\r?\n/gm,'').replace('import.meta.url',JSON.stringify(new URL('../main.mjs',import.meta.url).href))
  .replace('  const boards = new Map();','  const boards = globalThis.__boards = new Map();');

async function fixture() {
  const app=new EventEmitter(),handlers=new Map(),children=[],windows=[],timers=new Map();let nextTimer=0;
  app.whenReady=()=>Promise.resolve();app.getPath=()=>'/test/profile';app.quit=()=>{};
  class BrowserWindow extends EventEmitter {
    constructor(){super();this.webContents=new EventEmitter();this.webContents.send=()=>{};this.destroyed=false;this.reloads=0;windows.push(this);}
    loadFile(){} loadURL(url){this.url=url;} focus(){} reload(){this.reloads++;} isDestroyed(){return this.destroyed;}
    close(){this.destroyed=true;this.emit('closed');}
    static getAllWindows(){return windows.filter(w=>!w.destroyed);}
  }
  const utilityProcess={fork(){const child=new EventEmitter();child.sent=[];child.postMessage=message=>child.sent.push(message);child.kill=()=>child.emit('exit',0);children.push(child);return child;}};
  const context={app,BrowserWindow,utilityProcess,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},dialog:{},protocol:{registerSchemesAsPrivileged(){},handle(){}},
    fileURLToPath,Readable,fs,path,URL,Response,process:{platform:'linux'},
    setTimeout:callback=>{const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(source+'\nglobalThis.__audit={callEngine,startEngine,createWindow,pending,engine:()=>engine,window:()=>win};',context);
  await new Promise(resolve=>setImmediate(resolve));
  return {app,children,windows,timers,handlers,state:context.__audit,boards:context.__boards};
}

test('failed IPC sends release pending requests and valid replies remain unchanged',async()=>{
  const f=await fixture(),child=f.children[0];child.postMessage=()=>{throw Error('closed channel');};
  for(let i=0;i<1000;i++)await assert.rejects(f.state.callEngine('ping'),/closed channel/);
  assert.equal(f.state.pending.size,0);
  child.postMessage=message=>child.sent.push(message);const call=f.state.callEngine('ping',{x:1});
  child.emit('message',{id:child.sent[0].id,result:{ok:true}});assert.equal((await call).ok,true);assert.equal(f.state.pending.size,0);
});

test('engine exit clears its pointer and pending work; shutdown cancels a queued restart',async()=>{
  const f=await fixture(),old=f.children[0],pending=f.state.callEngine('slow');
  old.emit('exit',1);await assert.rejects(pending,/engine restarted/);assert.equal(f.state.pending.size,0);assert.equal(f.state.engine(),null);
  await assert.rejects(f.state.callEngine('ping'),/engine not running/);assert.equal(f.timers.size,1);
  f.app.emit('before-quit');assert.equal(f.timers.size,0);f.state.startEngine();assert.equal(f.children.length,1);
});

test('closed scoreboard windows leave no registry entries and cannot remove a newer window',async()=>{
  const f=await fixture(),open=f.handlers.get('om:openBoard');
  for(let i=0;i<1000;i++){open(null,`http://127.0.0.1:9000/scoreboard/board-${i}/`);f.windows.at(-1).close();}
  assert.equal(f.boards.size,0);
  open(null,'http://127.0.0.1:9000/scoreboard/same/');const old=f.windows.at(-1);old.destroyed=true;
  open(null,'http://127.0.0.1:9000/scoreboard/same/');const fresh=f.windows.at(-1);old.emit('closed');
  assert.strictEqual(f.boards.get('/scoreboard/same/'),fresh);fresh.close();assert.equal(f.boards.size,0);
});

test('a late old-window close/crash callback cannot clear or reload a replacement console',async()=>{
  const f=await fixture(),old=f.windows[0];old.webContents.emit('render-process-gone');
  f.state.createWindow();const fresh=f.windows.at(-1);old.close();
  for(const callback of f.timers.values())callback();
  assert.strictEqual(f.state.window(),fresh);assert.equal(fresh.reloads,0);
});
