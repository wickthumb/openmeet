import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

// Inject real filesystem failures in a separate process so builtin ESM mocks
// cannot affect other capture/recorder tests running concurrently.
test('partial capture-store initialization and failed close release every descriptor',async()=>{
  const moduleUrl=new URL('../capture/store.js',import.meta.url).href;
  const code=`
    import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
    import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';
    import {createHash} from 'node:crypto';
    const {openCaptureStore}=await import(${JSON.stringify(moduleUrl)});
    const original={openSync:fs.openSync,closeSync:fs.closeSync,fsyncSync:fs.fsyncSync};
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-capture-fds-')),held=new Map();
    let failOpen=null,failSync=false,failClose=false;
    fs.openSync=(file,flags,...rest)=>{
      if(failOpen&&failOpen.name===path.basename(String(file))&&failOpen.flags===flags)throw Error('injected open failure');
      const fd=original.openSync(file,flags,...rest);held.set(fd,{file:String(file),flags});return fd;
    };
    fs.closeSync=fd=>{
      original.closeSync(fd);held.delete(fd);
      if(failClose){failClose=false;throw Error('injected close failure');}
    };
    fs.fsyncSync=fd=>{if(failSync)throw Error('injected sync failure');return original.fsyncSync(fd);};
    syncBuiltinESMExports();
    const hello={type:'hello',model:'resource-test',rows:1,channels:1,columnPeriod:.001};
    try {
      for(const failure of [{name:'times.f64',flags:'a'},{name:'events.jsonl',flags:'a'},{name:'columns.bin',flags:'r'}]) {
        failOpen=failure;
        assert.throws(()=>openCaptureStore(path.join(root,'open-'+failure.name+'-'+failure.flags)),/injected open failure/);
        assert.equal(held.size,0,'Failed initialization retained open descriptors: '+JSON.stringify([...held]));
      }
      failOpen=null;
      for(const mode of ['sync','close','both']) {
        const dir=path.join(root,mode),store=openCaptureStore(dir);
        store.append(hello);store.append({type:'start_pulse',hwTime:1000});
        store.append({type:'columns',firstHwTime:1000,period:.001,count:4,data:new Uint8Array([7,8,9,10])});
        const hash=name=>createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex');
        const before=[hash('columns.bin'),hash('times.f64')];assert.equal(held.size,4);
        failSync=mode!=='close';failClose=mode!=='sync';
        assert.throws(()=>store.close(),mode==='close'?/injected close failure/:/injected sync failure/);
        assert.equal(held.size,0,'A close error prevented later descriptors from closing');
        failSync=false;failClose=false;
        store.close();assert.throws(()=>store.timeOf(0),/closed/);assert.equal(store.columnCount(),4);
        assert.deepEqual([hash('columns.bin'),hash('times.f64')],before);
        const reopened=openCaptureStore(dir,{readOnly:true});
        assert.deepEqual([...reopened.readColumns(0,4)],[7,8,9,10]);
        assert.deepEqual([...reopened.timesOf(0,4)],[1000,1000.001,1000.002,1000.003]);
        reopened.close();assert.equal(held.size,0);
      }
      // Opening a torn capture logs its recovery before returning. If that fsync
      // fails, every descriptor opened for the recovery must still be closed.
      const dir=path.join(root,'recovery'),store=openCaptureStore(dir);store.append(hello);store.close();
      fs.appendFileSync(path.join(dir,'columns.bin'),Buffer.from([1]));failSync=true;
      assert.throws(()=>openCaptureStore(dir),/injected sync failure/);assert.equal(held.size,0);
    }finally{Object.assign(fs,original);syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
  `;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.code,0,output||JSON.stringify(result));
});

test('file-backed continuous replay releases its completed decoded image and keeps exact tail output',async()=>{
  const replayUrl=new URL('../sim/replay.js',import.meta.url).href,encoderUrl=new URL('../sim/png-encode.js',import.meta.url).href;
  const code=`
    import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
    import {simReplay} from ${JSON.stringify(replayUrl)};import {encodePng} from ${JSON.stringify(encoderUrl)};
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-replay-memory-')),file=path.join(root,'source.png');
    const width=6000,height=640,bytes=width*height*3;
    function fixture(){fs.writeFileSync(file,encodePng({width,height,channels:3,data:Buffer.alloc(bytes,91)}));}
    const collect=async()=>{for(let i=0;i<3;i++){await new Promise(r=>setImmediate(r));global.gc();}};
    const controller=new AbortController();let gen;
    try {
      fixture();await collect();const initial=process.memoryUsage().arrayBuffers;
      gen=simReplay({png:file,sidecar:{first_column_race_time_s:0,column_period_s:.00125},holdOpen:true,signal:controller.signal});
      assert.equal((await gen.next()).value.type,'hello');assert.equal((await gen.next()).value.type,'start_pulse');
      for(let i=0;i<Math.ceil(width/64);i++)await gen.next();
      for(let i=0;i<3;i++){
        const tail=(await gen.next()).value;
        assert.equal(tail.type,'columns');assert.equal(tail.count,64);
        assert.equal(tail.firstHwTime,1000+(width+i*64)*.00125);
        assert.ok(tail.data.every(value=>value===91));
      }
      await collect();const retained=process.memoryUsage().arrayBuffers-initial;
      assert.ok(retained<bytes/2,'Continuous tail retained the completed '+bytes+'-byte image: '+retained);
      controller.abort();assert.equal((await gen.next()).value.type,'end');assert.equal((await gen.next()).done,true);
    }finally{controller.abort();await gen?.return();fs.rmSync(root,{recursive:true,force:true});}
  `;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--expose-gc','--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(result.code,0,output||JSON.stringify(result));
});
