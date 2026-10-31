import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCameraImageDecoder} from './image-stream.js';
import {openCaptureStore} from '../capture/store.js';

function readExact(fd,bytes,position){
  let at=0;while(at<bytes.length){const n=fs.readSync(fd,bytes,at,bytes.length-at,position+at);if(!n)return at;at+=n;}return at;
}
export function* readRecordingJsonLines(file,{maximumLineBytes=1024*1024}={}){
  const fd=fs.openSync(file,'r'),chunk=Buffer.alloc(65536);let pending=Buffer.alloc(0),position=0;
  try{
    for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,position);if(!n)break;position+=n;pending=Buffer.concat([pending,chunk.subarray(0,n)]);
      let end;while((end=pending.indexOf(10))>=0){if(end>maximumLineBytes)throw Error('Recording JSON line exceeds limit');const line=pending.subarray(0,end);pending=pending.subarray(end+1);if(line.length)yield JSON.parse(line.toString('utf8'));}
      if(pending.length>maximumLineBytes)throw Error('Recording JSON line exceeds limit');
    }
    if(pending.length)throw Object.assign(Error('Incomplete recording JSON tail'),{code:'ERR_CAMERA_RECORDING_TAIL'});
  }finally{fs.closeSync(fd);}
}
export function* readRawCameraBlocks(recordingDir){
  const fd=fs.openSync(path.join(recordingDir,'blocks.dat'),'r'),indexFile=path.join(recordingDir,'blocks.jsonl');
  const indexes=fs.existsSync(indexFile)?readRecordingJsonLines(indexFile):null;
  let offset=0,ordinal=0;
  try{
    for(;;){
      const header=Buffer.alloc(4),n=readExact(fd,header,offset);if(!n)break;
      if(n!==4)throw Object.assign(Error('Incomplete raw block length'),{code:'ERR_CAMERA_RECORDING_TAIL',offset});
      const length=header.readUInt32LE(0);
      if(length<20||length>16000)throw Object.assign(Error('Invalid raw block length'),{code:'ERR_CAMERA_RECORDING_BLOCK',offset});
      const body=Buffer.alloc(length);
      if(readExact(fd,body,offset+4)!==length)throw Object.assign(Error('Incomplete raw block body'),{code:'ERR_CAMERA_RECORDING_TAIL',offset});
      if(indexes){
        const entry=indexes.next();
        if(entry.done||entry.value.offset!==offset||entry.value.length!==length||entry.value.ordinal!==ordinal||
            createHash('sha256').update(body).digest('hex')!==entry.value.sha256)throw Object.assign(Error('Raw block and index disagree'),{code:'ERR_CAMERA_RECORDING_HASH',offset});
      }
      yield {body,offset,ordinal};offset+=4+length;ordinal++;
    }
    if(indexes&&!indexes.next().done)throw Object.assign(Error('Index contains unrecorded blocks'),{code:'ERR_CAMERA_RECORDING_HASH',offset});
  }finally{indexes?.return();fs.closeSync(fd);}
}

export function decodeCameraRecording({recordingDir,outputDir,imageProfile=null,startTimeS=null}){
  const metadata=JSON.parse(fs.readFileSync(path.join(recordingDir,'session.json'),'utf8'));
  const profile={...(imageProfile||metadata.imageProfile),clockOrigin:metadata.profile.clockOrigin,
    expectedBlockIndex:metadata.profile.expectedBlockIndex};
  if(!Number.isFinite(profile.columnPeriod)||profile.columnPeriod<=0)throw new TypeError('Image profile needs a nominal column period');
  const decoder=createCameraImageDecoder(profile);
  fs.mkdirSync(path.dirname(path.resolve(outputDir)),{recursive:true});fs.mkdirSync(outputDir);
  const store=openCaptureStore(outputDir),errors=[];let blocks=0,invalidTimes=0;
  try{
    store.append({type:'hello',model:'network-camera-recording',rows:decoder.snapshot().outputHeight,channels:3,columnPeriod:profile.columnPeriod});
    if(startTimeS==null){
      const events=path.join(recordingDir,'events.jsonl');
      if(fs.existsSync(events))try{for(const e of readRecordingJsonLines(events)){
        if(e.type==='start-trigger'&&e.evidence?.boundRaceId!=null)startTimeS=e.trigger.timeS;
        else if(e.type==='manual-start-reference')startTimeS=e.timeS;
      }}catch(error){errors.push({code:error.code||'ERR_CAMERA_RECORDING_EVENTS',message:error.message});}
    }
    if(startTimeS==null){const nativeEvents=path.join(recordingDir,'image','events.jsonl');if(fs.existsSync(nativeEvents))try{for(const event of readRecordingJsonLines(nativeEvents))if(event.type==='start_pulse')startTimeS=event.hwTime;}catch(error){errors.push({code:error.code||'ERR_CAMERA_RECORDING_EVENTS',message:error.message});}}
    if(startTimeS!=null){if(!Number.isFinite(startTimeS))throw new TypeError('Finite start reference required');store.append({type:'start_pulse',hwTime:startTimeS});}
    try{
      for(const {body} of readRawCameraBlocks(recordingDir)){
        const decoded=decoder.decode(body);
        for(const column of decoded.columns){
          if(!column.time.valid)invalidTimes++;
          store.append({type:'columns',firstHwTime:Number(column.time.ticks)/80000,period:profile.columnPeriod,count:1,data:column.data});
        }
        blocks++;
      }
    }catch(error){errors.push({code:error.code||'ERR_CAMERA_DECODE',message:error.message,offset:error.offset});}
    store.append({type:'end'});
    const report={version:1,source:recordingDir,outputDir,clockId:metadata.clockId,blocks,columns:store.columnCount(),invalidTimes,
      recordingDecoded:errors.length===0,captureComplete:false,errors};
    fs.writeFileSync(path.join(outputDir,'decode-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
  }finally{store.close();}
}
