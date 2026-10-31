import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readEventArchive,writeEventArchive} from './archive.js';
import * as weather from './weather.js';
import {createBackendIntegrationService} from './service.js';
import {projectSplits,projectExtendedResult,compatibilityFields,selectSplitSource} from '../meetlink/extended.js';
import {parseTimePrefix,speedValue,paceValue,deltaValue} from '../timing/value-format.js';
import {buildAvi,mediaExportPlan,convertPlanar420,prepareMediaSegments,createMediaFrameCache} from '../capture/media.js';
import {createCaptureColumnMap,renderCaptureTile} from '../capture/coordinates.js';
import {openCaptureStore} from '../capture/store.js';
import {decodePng} from '../sim/png.js';
const vectors=JSON.parse(fs.readFileSync(new URL('./backend-vectors.json',import.meta.url),'utf8'));
const tuple=(ticks,quantum='8')=>({ticks:String(ticks),quantum,origin:'7'});
for(const v of vectors.archives)test('metadata schema roundtrip and truncation: '+v.id,()=>{
  const family={cfg:'TIME_CONFIG',extra:'EXTRA_RESULT',group:'RESULT_GROUP',table:'RESULTS_TABLE',transform:'TRANSFORM'}[v.family],bytes=Buffer.from(v.bytesHex,'hex');
  assert.equal(bytes.length,v.expectedBytes);const data=readEventArchive(bytes,{family});assert.deepEqual(writeEventArchive(data,{family}),bytes);
  for(let n=0;n<bytes.length;n++)assert.throws(()=>readEventArchive(bytes.subarray(0,n),{family}));assert.throws(()=>readEventArchive(Buffer.concat([bytes,Buffer.of(0)]),{family}));
});
for(const v of vectors.wind)test('wind rounding '+v.speed+'/'+v.unit,()=>assert.equal(weather.formatWind({primary:v.speed,unit:v.unit}),v.expectedAppend));
for(const [i,v]of vectors.parser.entries())test('wind parser '+i,()=>{
  const result=weather.parseWind(v.input,{unit:v.suppliedUnit,units:v.unitLabels});assert.equal(result.accepted,v.expected.accepted);assert.equal(result.remaining,v.expected.remainder);
  if(result.accepted){assert.equal(result.primary,v.expected.speed);assert.equal(result.unit,v.expected.unit);}
});
for(const v of vectors.directions)test('wind direction '+v.mode+'/'+v.direction,()=>{
  const state=weather.createWeather();state.unit=2;state.weather[10]=v.direction;
  assert.equal(weather.windDescription(state,{directionMode:v.mode,directions:Array.from({length:16},(_,i)=>'D'+i)}),v.expectedAppend);
});
function windState(v){return {...v,primary:v.speed,delay:v.start,time:{...v.time,version:0x20001}};}
for(const v of vectors.persistence)test('weather serialization '+v.version+'/'+v.swap,()=>{
  const bytes=weather.serializeWeather(windState(v.inputState),{version:v.version,swap:v.swap});assert.deepEqual([...bytes],v.serializedBytes);
  const decoded=weather.deserializeWeather(bytes,windState(v.priorReaderState),{swap:v.swap}),expected=windState(v.expected.state);
  for(const key of ['primary','secondary','unit','time','mode','delay','duration','weather'])assert.deepEqual(decoded[key],expected[key],key);
});
test('weather reset, packet sentinels, shared sample denominator and staged phases',()=>{
  const state=weather.createWeather();state.primary=123;state.weather[10]=44;assert.equal(weather.resetWeather(state).weather[10],44);
  const packet=Buffer.alloc(39,255);packet.writeUInt16LE(0,0);packet.writeInt16LE(32767,2);packet.writeInt16LE(32767,5);packet.writeInt16LE(32767,9);packet.writeInt16LE(32767,37);
  const decoded=weather.decodeWeatherPacket(packet);assert.equal(decoded.primary,25500);assert.equal(decoded.weather[8],weather.MISSING_WEATHER);assert.equal(decoded.weather[11],weather.MISSING_WEATHER);
  let now=0;const gauge=weather.createWeatherAcquisition({clock:()=>now,atan2:Math.atan2});gauge.stage({delay:0,duration:100});gauge.signal();assert.equal(gauge.poll().phase,'start-due');assert.equal(gauge.poll().phase,'sampling');gauge.sample({primary:100,secondary:100});gauge.sample({primary:-4});now=2000;const reading=gauge.poll().reading;assert.equal(reading.primary,48);assert.equal(reading.secondary,50);
  assert.throws(()=>weather.weatherDirection({...state,unit:2,secondary:1}),{code:'ERR_WEATHER_ANGLE_PROVIDER'});
});
test('exact time-prefix grammar, speed, pace and operand-first delta quantization',()=>{
  for(const [text,ticks,q]of [['1:90','12000000','80000'],['1:-2','4640000','80000'],['-1.25','-100000','800'],['1.23459junk','98760','8'],['.5','40000','8000'],['1:2:3:4','7502720000','80000']]){const result=parseTimePrefix(text);assert.equal(result.tuple.ticks,ticks);assert.equal(result.tuple.quantum,q);}
  assert.equal(parseTimePrefix('.').valid,false);assert.equal(parseTimePrefix('+1').valid,false);assert.equal(parseTimePrefix('1:').valid,false);
  assert.equal(speedValue({distance:{numerator:1000,denominator:1},direct:tuple(8000000)}).value,10);
  assert.equal(paceValue({distance:{numerator:1000,denominator:1},target:{numerator:1000,denominator:1},direct:tuple(24000000)}).tuple.ticks,'24000000');
  assert.equal(deltaValue({main:tuple(800799),reference:tuple(800001)}),'0.00');assert.equal(deltaValue({main:tuple(800000),reference:tuple(800800)}),'-0.01');
  assert.equal(deltaValue({main:tuple(100000),reference:tuple(0),representation:1}),'1 1/4');assert.equal(deltaValue({main:tuple(-40000),reference:tuple(0),representation:2}),'0.-4');
});
test('extended exchange preserves blank split positions, cutoffs and logical quoting',()=>{
  assert.equal(selectSplitSource({tableCount:2}),2);assert.equal(selectSplitSource({configured:7}),1);
  const fields=projectSplits({mask:3,lap:[{cumulative:100,interval:100},null,{cumulative:170,interval:70}],multi:[{time:tuple(100)},null,{time:tuple(170)}],formatTime:v=>typeof v==='number'?v:v.ticks,subtract:(a,b)=>tuple(BigInt(a.ticks)-BigInt(b.ticks))});
  assert.deepEqual(fields,['100 (100),,170 (70)','100 (100),,170 (70)']);
  const row=projectExtendedResult({identity:['1','2','3','L','F','A'],time:'10.00',splitFields:fields,extraFields:4});assert.equal(row.length,12);assert.equal(compatibilityFields(['A','','B,C'],{terminator:''}),'A,,"B,C"');
});
test('owned profile persistence and schedule operations use actual event text',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-backend-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const service=createBackendIntegrationService({root});
  service.profiles({operation:'create',name:'Track',configuration:{rate:1000}});service.profiles({operation:'select',name:'Track'});assert.equal(createBackendIntegrationService({root}).profiles({operation:'list'}).selected,'Track');
  assert.throws(()=>service.profiles({operation:'create',name:'../bad'}));
  const source={evtText:'1,1,1,Race one\n,10,1,Last,First,Team\n2,1,1,Race two\n',schText:'2,1,1\n1,1,1\n'};
  const loaded=service.schedule({operation:'loadSchedule',source,input:{cursor:{event:'',round:'',heat:''},messageFlag:true,importFlag:true}});
  assert.deepEqual(loaded.cachedList.map(v=>v.name),['Race two','Race one']);assert.equal(loaded.messageFlag,true);
  const selected=service.schedule({operation:'control',source,input:{action:'Next',windows:[],cursor:{event:'2',round:'1',heat:'1'},existingWindowToken:null,singleEvent:false}});assert.equal(selected.reason,'new-child-imported');assert.equal(selected.windows[0].rows[0].first,'First');
});
test('result adapter composes typed tuples, participants, notifications and cursor effects',()=>{
  const service=createBackendIntegrationService({root:'/tmp/unused-openmeet-result-state'});
  const result=service.assignResult({options:{cursorActive:true,identityMode:2,listOnly:false,closeSetting:-1,contextCount:1,autoAdvance:true,integrationPresent:true},candidate:tuple(800123),rows:[],selectedText:'10',people:['10,Last,First,Team']});
  assert.equal(result.result,'accepted');assert.equal(result.rows[0].time.ticks,800123);assert.equal(result.rows[0].first,'First');assert.ok(result.actions.some(a=>a.type==='cursor-advance'));assert.ok(result.actions.some(a=>a.type==='integration-row'));
  const invalid=service.assignResult({options:{cursorActive:true},candidate:tuple(0,'0'),rows:[]});assert.equal(invalid.result,'unusable-candidate');
});
test('still export renders stored columns without changing the recording',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-still-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'capture'),store=openCaptureStore(dir);
  store.append({type:'hello',model:'test',rows:2,channels:3,columnPeriod:.001});store.append({type:'columns',firstHwTime:0,period:.001,count:2,data:Buffer.from([255,0,0,0,255,0,0,0,255,255,255,255])});store.close();
  const service=createBackendIntegrationService({root,captureResolver:()=>({dir})}),result=service.exportStill({captureId:'c'}),png=decodePng(fs.readFileSync(result.path));assert.equal(png.width,2);assert.deepEqual([...png.data],[255,0,0,0,0,255,0,255,0,255,255,255]);assert.throws(()=>service.exportStill({captureId:'c'}),{code:'EEXIST'});assert.equal(service.exportStill({captureId:'c',format:'targa',bitsPerPixel:16}).bytes,26);
});
test('AVI header, marker adaptation, 4-byte padding and index agree with the byte contract',()=>{
  const jpeg=Buffer.from('ffd8ffe000084a4649460102ffc400040102ffd9','hex'),avi=buildAvi({width:2,height:2,rate:25,plannedCount:3,frames:[{data:jpeg}]});
  assert.equal(avi.toString('ascii',0,4),'RIFF');assert.equal(avi.readUInt32LE(48),1);assert.equal(avi.readUInt32LE(140),1);assert.equal(avi.readUInt32LE(104),64);assert.equal(avi.toString('ascii',232,236),'00dc');assert.equal(avi.readUInt32LE(236)%4,0);assert.ok(avi.includes(Buffer.from('AVI1')));assert.ok(!avi.includes(Buffer.from('ffc4','hex')));
  const index=avi.indexOf(Buffer.from('idx1'));assert.equal(avi.readUInt32LE(index+16),4);assert.equal(avi.readUInt32LE(4),avi.length-8);
  const plan=mediaExportPlan({sourceCodec:2,recompress:0,start:3,end:4,frameCount:5,sourceRate:25,speed:-50,preRoll:2});assert.equal(plan.start,1);assert.equal(plan.count,4);assert.equal(plan.rate,13);assert.equal(plan.reencode,false);
});
test('planar color keeps the two arithmetic-context edge cases explicit',()=>{
  const image={width:2,height:2,y:Buffer.alloc(4,128),u:Buffer.of(28),v:Buffer.of(228)};
  const a=convertPlanar420(image),b=convertPlanar420({...image,context:'binary64-nearest'});assert.equal(a.data[1],92);assert.equal(b.data[1],91);assert.throws(()=>convertPlanar420({...image,width:1}));
});
test('segmented compressed frames and cache continue dependencies outside the retained window',async()=>{
  const records=[0,1,2].map(i=>({blockIndex:i,firstColumn:i,columnCount:1,residual:0,span:1,format:1,preRoll:2,segmentIndex:0,finalSegmentIndex:0,data:Buffer.of(i+1)}));
  const stream=prepareMediaSegments({target:2,resolveFrame:i=>records[i],resolveBlock:i=>records[i]});assert.equal(stream.count,3);
  const cache=createMediaFrameCache({maximumBytes:84});assert.equal(cache.configure(2,1),1);const fed=[];assert.equal(await cache.feed({target:2,count:3,stream,decode:async(data,options)=>{fed.push([data[0],options.destination]);return {accepted:true,data};}}),true);assert.deepEqual(fed,[[1,false],[2,false],[3,true]]);assert.equal(cache.get(2).flags,3);cache.clear();assert.equal(cache.snapshot().capacity,0);
});
test('column removal mappings and render geometry preserve source indices and background',()=>{
  const map=createCaptureColumnMap(10);map.remove(2,4);map.remove(3,3);assert.deepEqual(map.snapshot().segments,[[0,2],[5,6],[7,10]]);assert.equal(map.visibleToOriginal(2),5);assert.equal(map.originalToVisible(4),1);
  const image=renderCaptureTile({width:2,height:1,data:Buffer.from([1,2,3,4,5,6,7,8]),x:-1,tileWidth:3,tileHeight:1});assert.deepEqual([...image.data],[0,0,0,0,1,2,3,4,5,6,7,8]);
});
