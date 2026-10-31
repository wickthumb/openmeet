import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { networkFixture, cameraFrame, cameraReply } from '../../engine/cameras/testing/network-fixture.js';

test('engine RPC uses real UDP/TCP sockets, saves raw data and journals starts; disconnect closes the session', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmeet-camera-host-'));
  const vectors=JSON.parse(await readFile(new URL('../../engine/cameras/testing/handoff-vectors.json',import.meta.url),'utf8'));
  const imageBody=Buffer.from(vectors.images.find(v=>v.name==='nonzero-mode1').bodyHex,'hex');imageBody.writeUInt32LE(1,imageBody.length-8);imageBody.writeUInt32LE(0xfffffffe,imageBody.length-4);
  const imageFrame=Buffer.alloc(imageBody.length+4);imageFrame.set([241,4]);imageFrame.writeUInt16LE(imageBody.length,2);imageBody.copy(imageFrame,4);
  let modelRequest;const model=createHttpServer(async(req,res)=>{const chunks=[];for await(const bytes of req)chunks.push(bytes);modelRequest=JSON.parse(Buffer.concat(chunks));res.setHeader('content-type','application/json');res.end(JSON.stringify({request_id:modelRequest.request_id,model:'test-external',predictions:[{lane:1,column:0,race_time_s:999,decision:'auto',reason:'fixture',confidence:1}],warnings:[]}));});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>model.close(resolve)));
  const udp = createSocket('udp4'), peers = new Set(), selectors = [];
  let stream = null, event = false;
  const tcp = createServer(socket => {
    stream = socket; peers.add(socket); socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket)); socket.on('data', () => {});
  });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
    try { udp.close(); } catch { /* A failed bind has no open socket. */ }
    await rm(root, { recursive: true, force: true });
  });
  udp.on('message', (packet, peer) => {
    const op = packet.readUInt16LE(8); selectors.push(op);
    let payload = [];
    if (op === 14) payload = [7, 1280, 0];
    if (op === 3) {
      payload = Array(21).fill(0); payload[0] = packet.readUInt32LE(16);
      payload[2] = event ? 250 : 200; payload[3] = event ? 1 : 0; payload[4] = event ? 225 : 0;
    }
    udp.send(cameraReply(packet, payload).bytes, peer.port, peer.address);
    if (op === 7) stream.write(imageFrame);
  });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(41925, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(41925, '127.0.0.1', resolve); });
  const child = fork(new URL('./support/engine-process.mjs', import.meta.url), [root],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
  const pending = new Map(); let nextId = 0, stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', message => {
    const p = pending.get(message.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
  });
  t.after(() => { child.kill(); for (const p of pending.values()) clearTimeout(p.timer); });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error(`RPC timeout: ${method}; ${stderr}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); child.send({ id, method, params });
    });
  }
  assert.equal((await call('camera.network.probe', { address: '127.0.0.1', marker: 0x11223344 })).clock128k, '1280');
  const config = networkFixture().config;
  const opened = await call('camera.network.open', { ...config,imageProfile:{family:3,height:32,tickScale:8,columnPeriod:.0001}, meetDir: root, recordingDir: root });
  assert.notEqual(opened.recording.dir, root, 'RPC accepted a caller-controlled recording destination');
  await call('camera.network.command', { id: opened.id, operation: 'prepare' });
  await call('camera.network.command', { id: opened.id, operation: 'armRace', params: { raceId: '5-1-1', sourceKey: 'wired' } });
  await call('camera.network.command', { id: opened.id, operation: 'start' });
  event = true;
  await call('camera.network.command', { id: opened.id, operation: 'pollStatus' });
  let status;
  for (let i = 0; i < 40; i++) {
    status = await call('camera.network.status', { id: opened.id });
    if (status.recording.blocks === 1) break;
    await delay(10);
  }
  assert.equal(status.recording.blocks, 1);
  assert.deepEqual(await readFile(path.join(opened.recording.dir, 'stream.dat')), imageFrame);
  const starts = await call('starts.list', { dir: root });
  assert.equal(starts.triggers.length, 1); assert.equal(starts.triggers[0].timeS, 0.0195);
  const image=await call('camera.network.image',{id:opened.id});assert.equal(image.ready,true);assert.equal(image.width,1);assert.equal(image.height,32);
  await call('backend.profiles',{operation:'create',name:'Camera test',configuration:{address:'127.0.0.1'}});
  assert.equal((await call('backend.profiles',{operation:'list'})).profiles.length,1);
  assert.equal((await call('backend.still.export',{captureId:opened.id})).width,1);
  const time=await call('backend.time',{operation:'parseTimePrefix',input:{text:'1:90'}});assert.equal(time.tuple.ticks,'12000000');
  const native=await call('backend.archive',{operation:'write',family:'TIME',value:{version:0x20001,ticks:'-1',quantum:'8',origin:7}});assert.equal((await call('backend.archive',{operation:'read',family:'TIME',bytes:native})).ticks,'-1');
  await call('settings.set',{patch:{autotiming:{baseUrl:`http://127.0.0.1:${model.address().port}`}}});
  const prediction=await call('autotiming.predict',{captureId:opened.id,heat:{event:'5',round:1,heat:1},startList:[{lane:1,id:'one'}]});
  assert.equal(modelRequest.timebase.column_race_times_s.length,1);assert.equal(prediction.predictions[0].race_time_s,image.times[0]-starts.triggers[0].timeS);assert.notEqual(prediction.predictions[0].race_time_s,999);
  const remote=await call('remote.listen',{id:'test-remote',port:0,kind:'binary',context:{captureId:opened.id,clockOrigin:7}});assert.ok(remote.address.port>0);assert.equal((await call('remote.list')).length,1);await call('remote.close',{id:'test-remote'});
  await call('camera.network.command', { id: opened.id, operation: 'stop' });
  await call('camera.network.command', { id: opened.id, operation: 'end' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.disconnect();
  assert.notEqual(await Promise.race([exited, delay(3000, undefined, { ref: false }).then(() => 'timeout')]), 'timeout', 'Host retained a camera socket after IPC disconnect');
  const events = (await readFile(path.join(opened.recording.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'local-close'); assert.equal(events.at(-1).captureComplete, false);
  assert.deepEqual(selectors, [14, 14, 5, 6, 3, 7, 3, 8, 24]);
});
