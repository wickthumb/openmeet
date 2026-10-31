import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { networkCameraProtocol as wire } from '../integrations/index.js';
import { openStartJournal } from '../timing/starts.js';
import { cameraJson, openRawCameraStore } from './raw-store.js';
import { decodeCameraConfiguration } from './configuration.js';
import { packCameraParameters } from './parameters.js';
import { createCameraImageDecoder, createAlignmentFrameAssembler } from './image-stream.js';
import { openCaptureStore } from '../capture/store.js';
import { encodePng } from '../sim/png-encode.js';
import { inspectNetworkCamera } from './control.js';
import { createClockGroupSender, synchronizeCameraGroup } from './clock-sync.js';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (code, message = code) => Object.assign(new Error(message), { code });
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const errorData = error => ({ code: error.code || 'ERR_NETWORK_CAMERA', message: error.message });

// Construction is inert. Only probe and explicit session commands send packets.
export function createNetworkCameraService({
  transportFactory = wire.createNodeCameraTransport, sessionFactory = wire.createCameraSession,
  storeFactory = openRawCameraStore, journalFactory = openStartJournal,
  nowMs = () => performance.now(), wallTimeMs = () => Date.now(),
  groupSenderFactory = createClockGroupSender,
  onEvent = () => {}, timers = { setInterval, clearInterval },
} = {}) {
  const sessions = new Map(), peers = new Set(), probes = new Set(), groupSenders = new Set();
  let closed = false;
  const publicValue = value => typeof value==='bigint'?String(value):value instanceof Uint8Array?Buffer.from(value):
    Array.isArray(value)?value.map(publicValue):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,publicValue(item)])):value;
  const notify = (event, data) => { try { onEvent(event, publicValue(data)); } catch { /* Recording owns its lifetime. */ } };
  const active = id => {
    const entry = sessions.get(id);
    if (!entry || entry.closing) throw fail('ERR_CAMERA_SESSION', 'Unknown or closing camera session');
    return entry;
  };
  const state = entry => cameraJson({ id: entry.id, cameraKey: entry.profile.cameraKey,
    clockId: entry.clockId, recording: entry.store.snapshot(), session: entry.session.snapshot(),
    image:entry.capture ? { dir:entry.capture.dir, columns:entry.capture.columnCount(),
      rows:entry.imageProfile.outputHeight, channels:3, startHwTime:entry.capture.startHwTime(),
      invalidTimes:entry.invalidTimes, status:entry.imageError ? 'error' : 'decoding',
      error:entry.imageError && errorData(entry.imageError), previewFrames:entry.previewFrames } : null,
    synchronizationEvidence:entry.syncEvidence||null,
    ...(entry.recordingError ? { recordingError: errorData(entry.recordingError) } : {}) });

  function collect(entry) {
    if (entry.recordingError) throw entry.recordingError;
    try {
      const blocks = entry.session.readBlocks();
      entry.store.append(blocks, wallTimeMs());
      if (entry.decoder && !entry.imageError) for (const { body } of blocks) {
        try {
          const decoded = entry.decoder.decode(body), first = entry.capture.columnCount();
          for (const column of decoded.columns) {
            if (!column.time.valid) entry.invalidTimes++;
            entry.capture.append({ type:'columns', firstHwTime:Number(column.time.ticks) / 80000,
              period:entry.imageProfile.columnPeriod, count:1, data:column.data });
          }
          entry.store.event({ type:'decoded-block', index:decoded.index, first,
            times:decoded.columns.map(column => column.time), records:decoded.records });
          notify('camera.network.columns', { id:entry.id, first, count:decoded.columns.length,
            rows:decoded.rows, channels:3, data:Buffer.concat(decoded.columns.map(column => column.data)),
            times:decoded.columns.map(column => column.time) });
          if (entry.frameAssembler) {
            const frame = entry.frameAssembler.append(decoded, entry.profile.epochId);
            if (frame) { entry.lastFrame=frame; entry.previewFrames++; notify('camera.network.preview', { id:entry.id,
              width:frame.width, height:frame.height, frames:entry.previewFrames }); }
          }
        } catch (error) {
          entry.imageError = error;
          entry.store.event({ type:'image-error', ...errorData(error) });
          notify('camera.network.image-error', { id:entry.id, ...errorData(error) });
          break; // Raw recording continues; dependent decoded history is no longer admitted.
        }
      }
    }
    catch (error) { entry.recordingError = error; throw error; }
  }
  function starts(entry) {
    const snapshot = entry.session.snapshot();
    for (const record of snapshot.journal.records) {
      if (record.ordinal < entry.nextStart) continue;
      entry.nextStart = record.ordinal + 1;
      // Ambiguous epochs remain in raw evidence, outside the meet's timed triggers.
      if (snapshot.invalid || !entry.profile.queueEpochTrusted) continue;
      const c = record.candidate;
      const timeS = Number(c.primary.ticks - c.secondary.ticks) / 80000;
      if (entry.capture && record.boundRaceId != null && entry.profile.mode !== 'alignment') {
        entry.capture.append({ type:'start_pulse', hwTime:timeS });
      }
      if (!entry.journal) continue;
      const trigger = entry.journal.record({ clockId: entry.clockId,
        timeS,
        wallTimeMs: wallTimeMs(), source: `network-camera:${c.cameraKey}:${c.sourceKey}`,
        captureId: entry.id });
      entry.store.event({ type: 'start-trigger', trigger, evidence: record });
      notify('camera.network.start', { id: entry.id, trigger, evidence: record });
    }
  }
  function closeEntry(entry) {
    if (entry.closing) return entry.closing;
    // Install the promise before any await so duplicate closes share ownership.
    entry.closing = Promise.resolve().then(async () => {
      timers.clearInterval(entry.timer);
      entry.drainAbort?.abort();
      const errors = [];
      try { collect(entry); } catch (error) { errors.push(error); }
      try {
        const results = await entry.session.close();
        for (const result of results || []) if (result.status === 'rejected') errors.push(result.reason);
      } catch (error) { errors.push(error); }
      try { if (entry.capture) { entry.capture.append({ type:'end' }); entry.capture.close(); } }
      catch (error) { errors.push(error); try { entry.capture?.close(); } catch {} }
      const result = state(entry);
      try { entry.store.close({ at: wallTimeMs(), ...result }); } catch (error) { errors.push(error); }
      sessions.delete(entry.id); peers.delete(entry.peer);
      notify('camera.network.closed', { ...result, errors: errors.map(errorData) });
      if (errors.length) throw new AggregateError(errors, 'Camera closed with recording errors');
      return result;
    });
    return entry.closing;
  }
  return {
    async inspect(params) {
      if(closed)throw fail('ERR_CAMERA_SERVICE_CLOSED');
      const peer=`${params.address}:${params.port||41925}`;
      if(peers.has(peer))throw fail('ERR_CAMERA_OWNED');peers.add(peer);
      try{return await inspectNetworkCamera(params,{transportFactory:options=>{
        const transport=transportFactory(options);probes.add(transport);
        return {exchange:async(...args)=>{if(closed)throw fail('ERR_CAMERA_SERVICE_CLOSED');const result=await transport.exchange(...args);if(closed)throw fail('ERR_CAMERA_SERVICE_CLOSED');return result;},close:async()=>{try{await transport.close();}finally{probes.delete(transport);}}};
      }});}finally{peers.delete(peer);}
    },
    async probe({ address, port = 41925, localAddress = null, marker, sequence = 0, timeoutMs = 1000 }) {
      if (closed) throw fail('ERR_CAMERA_SERVICE_CLOSED');
      if (!wire.hostOK(address) || port !== 41925 || !int(timeoutMs, 1, 2147483647)) throw new TypeError('Explicit unicast address and valid timeout required');
      const packet = wire.encodeCameraCommand({ marker, sequence, operation: 'clockRead', words: [] });
      const peer = `${address}:${port}`;
      if (peers.has(peer)) throw fail('ERR_CAMERA_OWNED', 'This camera already has a local owner');
      peers.add(peer);
      let transport;
      try {
        transport = transportFactory({ host: address, port,localAddress }); probes.add(transport);
        const options = { expectedAddress: address, expectedPort: port, requestMarker: marker, sequence };
        const observation = await transport.exchange(packet, { timeoutMs, accept: value => {
          try { return wire.decodeControlReply(value.bytes, { ...options, peerAddress: value.peerAddress, peerPort: value.peerPort }).decision === 'accepted'; }
          catch { return false; }
        } });
        if (closed) throw fail('ERR_CAMERA_SERVICE_CLOSED');
        const reply = wire.decodeControlReply(observation.bytes, { ...options, peerAddress: observation.peerAddress, peerPort: observation.peerPort });
        if (reply.decision !== 'accepted' || !reply.success || reply.count !== 3 || reply.payload.slice(1).some(v => !int(v, 0, 0xffffff))) {
          throw fail('ERR_CAMERA_PROBE_REPLY', 'Camera clock response was not accepted');
        }
        return { address, port, clockOrigin: reply.payload[0],
          clock128k: String(BigInt(reply.payload[1]) + (BigInt(reply.payload[2]) << 24n)),
          identity: 'unconfirmed', synchronization: 'unconfirmed', deviceValidated: false };
      } finally { try { await transport?.close(); } finally { probes.delete(transport); peers.delete(peer); } }
    },
    open({ profile, recordingDir, meetDir = null, sequenceStart = 0, statusSubIdStart = 0, imageProfile = null,
      parameterSettings = null, previewWidth = null,
      timeoutMs = 1000, clockMaxAgeMs = 1000, maxQueuedBlocks = 128, drainIntervalMs = 20 }) {
      if (closed) throw fail('ERR_CAMERA_SERVICE_CLOSED');
      if (!profile || typeof recordingDir !== 'string' || !recordingDir || !int(drainIntervalMs, 1, 1000)) throw new TypeError('Profile, new recording directory and valid drain interval required');
      const peer = `${profile.address}:${profile.port}`;
      if (peers.has(peer)) throw fail('ERR_CAMERA_OWNED', 'This camera already has a local owner');
      const id = randomUUID(), supplied = structuredClone(profile);
      if (parameterSettings) supplied.parameters = packCameraParameters(parameterSettings).words;
      const image = imageProfile && { ...structuredClone(imageProfile), clockOrigin:supplied.clockOrigin,
        expectedBlockIndex:supplied.expectedBlockIndex };
      const decoder = image && createCameraImageDecoder(image);
      if(image)image.outputHeight=decoder.snapshot().outputHeight;
      if (image && !(Number.isFinite(image.columnPeriod) && image.columnPeriod > 0)) throw new TypeError('Explicit nominal columnPeriod required');
      const frameAssembler = previewWidth == null ? null : createAlignmentFrameAssembler({ width:previewWidth,
        height:image?.outputHeight, epochId:supplied.epochId });
      const transport = transportFactory({ host: supplied.address, port: supplied.port,localAddress:supplied.localAddress });
      let session, store, entry;
      try {
        const recordedTransport = {
          async exchange(packet, options) {
            store.event({ type: 'control-send', hex: Buffer.from(packet).toString('hex'), at: wallTimeMs() });
            const observation = await transport.exchange(packet, options);
            if (!entry.closing) store.event({ type: 'control-reply', hex: Buffer.from(observation.bytes).toString('hex'),
              peerAddress: observation.peerAddress, peerPort: observation.peerPort, at: wallTimeMs() });
            return observation;
          },
          openStream(options) {
            return transport.openStream({ ...options, onData(bytes) {
              if (entry.closing || entry.recordingError) return;
              try { store.stream(bytes, wallTimeMs()); options.onData(bytes); }
              catch (error) {
                entry.recordingError = error; options.onError(error);
                notify('camera.network.error', { id, ...errorData(error) });
                void closeEntry(entry).catch(() => {});
              }
            } });
          },
          close: () => transport.close(),
          async sendDatagram(packet, options) {
            store.event({ type:'control-datagram', hex:Buffer.from(packet).toString('hex'), at:wallTimeMs() });
            return transport.sendDatagram(packet, options);
          },
        };
        session = sessionFactory({ profile: supplied, transport: recordedTransport, sequenceStart, statusSubIdStart,
          timeoutMs, clockMaxAgeMs, maxQueuedBlocks, nowMs });
        const clockId = `network-camera:${supplied.cameraKey}:${supplied.epochId}:${supplied.clockOrigin}:${id}`;
        const journal = meetDir ? journalFactory(meetDir) : null;
        store = storeFactory(path.resolve(recordingDir), { id, clockId, profile: supplied,
          imageProfile:image, previewWidth,
          sequenceStart, statusSubIdStart, timeoutMs, clockMaxAgeMs, maxQueuedBlocks,
          createdAtMs: wallTimeMs(), deviceValidated: false });
        entry = { id, peer, clockId, profile: supplied, session, store, journal, nextStart: 0, closing: null,
          decoder, imageProfile:image, capture:null, invalidTimes:0, imageError:null,
          frameAssembler, previewFrames:0, lastFrame:null };
        if (image) {
          entry.capture = openCaptureStore(path.join(recordingDir, 'image'));
          entry.capture.append({ type:'hello', model:'network-camera', rows:image.outputHeight, channels:3, columnPeriod:image.columnPeriod });
        }
        sessions.set(id, entry); peers.add(peer);
        entry.timer = timers.setInterval(() => {
          if (entry.closing) return;
          try {
            collect(entry);
            if (entry.session.snapshot().invalid) void closeEntry(entry).catch(() => {});
          } catch (error) {
            entry.recordingError = error;
            notify('camera.network.error', { id, ...errorData(error) });
            void closeEntry(entry).catch(() => {});
          }
        }, drainIntervalMs);
        entry.timer.unref?.();
        return state(entry);
      } catch (error) {
        if (entry?.timer) timers.clearInterval(entry.timer);
        // Invalid profiles never get as far as socket allocation.
        void Promise.resolve(session ? session.close() : transport.close()).catch(() => {});
        try { store?.close({ error: errorData(error) }); } catch { /* Preserve the original failure. */ }
        try { entry?.capture?.close(); } catch {}
        sessions.delete(id); peers.delete(peer);
        throw error;
      }
    },
    async command({ id, operation, params }) {
      const entry = active(id);
      if (!['prepare', 'start', 'stop', 'end', 'pollStatus', 'retryStatus', 'refreshClock', 'armRace',
        'readConfiguration','readIdentity','fetchNextBlock','readSyncSample','prepareSyncSample','applySyncSample','setClockRaw'].includes(operation)) throw new TypeError('Unsupported camera operation');
      if (entry.busy) throw fail('ERR_SESSION_BUSY');
      if(operation==='applySyncSample'&&entry.session.snapshot().state!=='bound')throw fail('ERR_CLOCK_INITIALIZATION_ONLY','Apply synchronization before preparing the capture session');
      entry.busy = true;
      try {
        collect(entry);
        entry.store.event({ type: 'command-requested', operation, params, at: wallTimeMs() });
        if (operation === 'applySyncSample' && typeof params?.clock128k === 'string') params = { ...params, clock128k:BigInt(params.clock128k) };
        let result = await entry.session[operation](params);
        if (operation === 'readConfiguration') result = decodeCameraConfiguration(result, { family:entry.profile.modelClass });
        if (entry.closing) throw fail('ERR_CAMERA_SESSION_CLOSED');
        collect(entry); starts(entry);
        entry.store.event({ type: 'command-result', operation, result, at: wallTimeMs() });
        const snapshot = state(entry);
        notify('camera.network.status', snapshot);
        return { result: cameraJson(result), ...snapshot };
      } catch (error) {
        if (!entry.closing) {
          try { collect(entry); entry.store.event({ type: 'command-error', operation, ...errorData(error), at: wallTimeMs() }); }
          catch (writeError) { entry.recordingError = writeError; void closeEntry(entry).catch(() => {}); }
        }
        throw error;
      } finally { entry.busy = false; }
    },
    snapshot({ id } = {}) { return id ? state(active(id)) : [...sessions.values()].map(state); },
    bindStart({id,clockId,timeS}){
      const entry=active(id);if(!entry.capture||clockId!==entry.clockId||!Number.isFinite(timeS))throw fail('ERR_CAMERA_START_CONTEXT');
      entry.capture.append({type:'start_pulse',hwTime:timeS});entry.store.event({type:'manual-start-reference',timeS,clockId,at:wallTimeMs()});return state(entry);
    },
    async drain({id,timeoutMs=5000,intervalMs=25,chunkBytes=1024,requestStop=true}) {
      const entry=active(id);
      if(!int(timeoutMs,1,2147483647)||!int(intervalMs,1,60000)||typeof requestStop!=='boolean')throw new RangeError('Invalid drain deadline/cadence');
      if(entry.busy)throw fail('ERR_SESSION_BUSY');entry.busy=true;entry.drainAbort=new AbortController();
      const deadline=performance.now()+timeoutMs;
      let latest=null;
      try{
        entry.store.event({type:'drain-requested',requestStop,at:wallTimeMs()});
        if(requestStop)await entry.session.stop();
        while(performance.now()<deadline){
          if(entry.closing)throw fail('ERR_CAMERA_SESSION_CLOSED');
          latest=await entry.session.pollStatus();collect(entry);starts(entry);
          if(latest.ambiguous)throw fail('ERR_CAMERA_DRAIN_AMBIGUOUS');
          if(entry.profile.delivery==='udp'){
            for(let n=0;n<1024;n++){
              const result=await entry.session.fetchNextBlock({chunkBytes});collect(entry);
              if(result.decision!=='received')break;
              if(performance.now()>=deadline)break;
            }
          }
          const snapshot=entry.session.snapshot(),d=latest.diagnostics;
          const complete=latest.fresh===true&&!d.moreBlocks&&snapshot.nextExpectedBlockIndex===d.highestPackagedBlock+1&&
            snapshot.queuedBlocks===0&&snapshot.streamFraming.pendingBytes===0&&!snapshot.invalid;
          if(complete){
            const result={transportDrained:true,highestPackagedIndex:d.highestPackagedBlock,
              nextExpectedIndex:snapshot.nextExpectedBlockIndex,captureComplete:false,
              decoded:entry.capture?{columns:entry.capture.columnCount(),invalidTimes:entry.invalidTimes,error:entry.imageError&&errorData(entry.imageError)}:null,
              finalScanBoundaryConfirmed:false};
            entry.store.event({type:'drain-observation',...result,at:wallTimeMs()});return result;
          }
          await delay(Math.min(intervalMs,Math.max(1,deadline-performance.now())),undefined,{signal:entry.drainAbort.signal});
        }
        const result={transportDrained:false,reason:'deadline',captureComplete:false,lastStatus:latest};
        entry.store.event({type:'drain-observation',...result,at:wallTimeMs()});return cameraJson(result);
      }finally{entry.busy=false;entry.drainAbort=null;}
    },
    async synchronize({origin,generation,members,interfaceAddress,subnetMask,marker,timeoutMs=1000}) {
      if(closed)throw fail('ERR_CAMERA_SERVICE_CLOSED');
      if(!Array.isArray(members)||new Set(members.map(m=>m.id)).size!==members.length)throw new TypeError('Unique member sessions required');
      const entries=members.map(member=>active(member.id));
      for(const entry of entries)if(entry.busy||entry.profile.clockOrigin!==origin||entry.profile.marker!==marker)throw fail('ERR_CLOCK_MEMBER_CONTEXT');
      for(const entry of entries)if(entry.session.snapshot().state!=='bound')throw fail('ERR_CLOCK_INITIALIZATION_ONLY','Synchronize before preparing capture sessions');
      const sender=groupSenderFactory({interfaceAddress,subnetMask,marker,timeoutMs});groupSenders.add(sender);
      for(const entry of entries)entry.busy=true;
      try{
        const result=await synchronizeCameraGroup({origin,generation,members,
          prepare:()=>sender.send('samplePrepare',[origin,generation]),
          query:(member,params)=>active(member.id).session.readSyncSample(params),
          apply:sample=>{if(closed)throw fail('ERR_CAMERA_SERVICE_CLOSED');return sender.send('sampleApply',[
            origin,generation,Number(sample.clock128k&0xffffffn),Number(sample.clock128k>>24n),sample.referenceDescriptor]);},
        });
        for(const entry of entries){entry.syncEvidence=result;entry.store.event({type:'clock-sync-cycle',...result,at:wallTimeMs()});}
        return result;
      }finally{sender.close();groupSenders.delete(sender);for(const entry of entries)entry.busy=false;}
    },
    image({ id, from = 0, to = null, preview = false, png = true }) {
      const entry = active(id); collect(entry);
      if (preview) {
        if (!entry.lastFrame) return { ready:false, frame:entry.frameAssembler?.snapshot() || null };
        const frame = entry.lastFrame;
        return { ready:true, width:frame.width, height:frame.height, channels:3,
          ...(png ? { png:encodePng(frame) } : { data:Buffer.from(frame.data) }), frames:entry.previewFrames };
      }
      if (!entry.capture) throw fail('ERR_CAMERA_IMAGE_PROFILE', 'Configure imageProfile before recording decoded images');
      const count=entry.capture.columnCount(), end=to==null?count:to, height=entry.imageProfile.outputHeight;
      if (!Number.isInteger(from)||!Number.isInteger(end)||from<0||end<from||end>count||(end-from)*height*3>64*1024*1024) throw new RangeError('Invalid or oversized image range');
      if (end===from) return { ready:false, columns:count };
      const columns=entry.capture.readColumns(from,end),width=end-from,data=Buffer.alloc(columns.length);
      for(let x=0;x<width;x++)for(let y=0;y<height;y++)columns.copy(data,(y*width+x)*3,(x*height+y)*3,(x*height+y)*3+3);
      return { ready:true, width, height, channels:3, from, clockId:entry.clockId,
        invalidTimes:entry.invalidTimes, times:Array.from(entry.capture.timesOf(from,end)),
        ...(png?{png:encodePng({width,height,channels:3,data})}:{data}),
        ...(entry.imageError?{error:errorData(entry.imageError)}:{}) };
    },
    close({ id }) {
      const entry = sessions.get(id);
      return entry ? closeEntry(entry) : Promise.resolve(null);
    },
    async closeAll() {
      closed = true;
      const results = await Promise.allSettled([
        ...[...probes].map(transport => Promise.resolve().then(() => transport.close())),
        ...[...groupSenders].map(sender => Promise.resolve().then(() => sender.close())),
        ...[...sessions.values()].map(closeEntry),
      ]);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(r => r.reason), 'Camera service closed with errors');
    },
  };
}
