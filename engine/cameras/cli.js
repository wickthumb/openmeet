import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNetworkCameraService } from './network.js';
import { networkCameraProtocol } from '../integrations/index.js';
import { cameraJson } from './raw-store.js';
import {buildAlignmentReset} from './control.js';
import {decodeCameraRecording} from './replay-recording.js';

export function cameraProfileTemplate() {
  return {
    profile: { id: 'host13-ec8l', cameraKey: 'finish-a', address: null, port: 41925,
      marker: null, modelClass: 3, clockOrigin: null, epochId: null, queueEpochTrusted: false,
      parameters: null, reset: null, history: 'fresh', expectedBlockIndex: 1,
      sources: [], wired: { enabled: false, offsetMs: 0 }, statusFlags: 0, displayState: 0 },
    imageProfile:null,
    sequenceStart: 0, statusSubIdStart: 0, timeoutMs: 1000,
    clockMaxAgeMs: 1000, maxQueuedBlocks: 128, drainIntervalMs: 20,
  };
}

export async function runCameraCli(args, { output = value => process.stdout.write(JSON.stringify(cameraJson(value), null, 2) + '\n'),
  serviceFactory = createNetworkCameraService, signal } = {}) {
  const [action, configFile, recordingDir, duration = '10'] = args;
  if (action === 'template') { output(cameraProfileTemplate()); return; }
  if(action==='decode'&&configFile&&recordingDir&&args[3]&&args.length===4){
    const config=JSON.parse(await fs.readFile(recordingDir,'utf8'));
    output(decodeCameraRecording({recordingDir:configFile,imageProfile:config.imageProfile,outputDir:args[3],startTimeS:config.startTimeS??null}));return;
  }
  if (action === 'inspect' && configFile && args.length === 2) {
    const stat = await fs.stat(configFile);
    if (stat.size > 64 * 1024 * 1024) throw Error('Capture file exceeds the 64 MiB inspection limit');
    const result = networkCameraProtocol.readCaptureUdp(await fs.readFile(configFile));
    output({ ...result, observations: result.observations.map(({ bytes, ...info }) => ({ ...info, hex: bytes.toString('hex') })) });
    return;
  }
  if (!['probe','inspect-device','record','preview'].includes(action) || !configFile ||
      (['probe','inspect-device'].includes(action) && args.length !== 2) ||
      (['record','preview'].includes(action) && (!recordingDir || args.length > 4 || !Number.isFinite(Number(duration)) || Number(duration) <= 0))) {
    throw Error('Usage: node engine/cameras/cli.js template | probe PROFILE.json | inspect-device PROFILE.json | record PROFILE.json NEW_DIRECTORY [SECONDS] | preview PROFILE.json NEW_DIRECTORY [SECONDS] | decode RECORDING PROFILE.json NEW_DIRECTORY | inspect CAPTURE.pcap');
  }
  const config = JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  const service = serviceFactory();
  const close = () => { void service.closeAll().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  let opened;
  try {
    if (signal?.aborted) return;
    if (action === 'probe') {
      const p = config.profile;
      output(await service.probe({ address: p?.address, port: p?.port, marker: p?.marker,
        sequence: config.sequenceStart, timeoutMs: config.timeoutMs }));
      return;
    }
    if(action==='inspect-device'){
      const p=config.profile;output(await service.inspect({address:p?.address,port:p?.port,marker:p?.marker,
        sequence:config.sequenceStart,timeoutMs:config.timeoutMs,family:config.imageProfile?.family??p?.modelClass}));return;
    }
    if(action==='preview'){
      const reset=buildAlignmentReset(config.alignment);
      config.profile={...config.profile,reset:reset.words,delivery:'udp',mode:'alignment',history:'fresh',expectedBlockIndex:1};
      config.previewWidth=reset.effectiveWidth;
      if(!config.imageProfile)throw Error('Alignment preview requires an explicit imageProfile');
    }
    opened = service.open({ ...config, recordingDir: path.resolve(recordingDir) });
    await service.command({ id: opened.id, operation: 'prepare' });
    if(action!=='preview')await service.command({ id: opened.id, operation: 'start' });
    const deadline = performance.now() + Number(duration) * 1000;
    while (!signal?.aborted && performance.now() < deadline) {
      await service.command({ id: opened.id, operation: 'pollStatus' });
      if(config.profile.delivery==='udp')for(let i=0;i<1024;i++){
        const block=await service.command({id:opened.id,operation:'fetchNextBlock',params:{chunkBytes:config.chunkBytes??1024}});
        if(block.result.decision!=='received')break;
      }
      await delay(100, undefined, { signal });
    }
    if (!signal?.aborted) {
      if(action!=='preview')output(await service.drain({id:opened.id,timeoutMs:config.drainTimeoutMs??5000}));
      await service.command({ id: opened.id, operation: 'end' });
    }
    if(action==='preview'&&!signal?.aborted){const frame=service.image({id:opened.id,preview:true});if(frame.ready)await fs.writeFile(path.join(recordingDir,'preview.png'),frame.png,{flag:'wx'});}
    output(await service.close({ id: opened.id }));
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', close);
    await service.closeAll();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  runCameraCli(process.argv.slice(2), { signal: controller.signal }).catch(error => {
    process.stderr.write(`${error.code || 'ERR_CAMERA'}: ${error.message}\n`); process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); });
}
