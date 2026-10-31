import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconstructCameraColumn,createIntensityLookup,applyIntensityLookup,enhanceIntensityBase,applyRecordGain,applyDisplayProfiles} from './reconstruction.js';
import {renderCaptureTile} from '../capture/coordinates.js';
test('staggered four-lane reconstruction preserves scratch bytes and its floor averages',()=>{
  const input=Buffer.from([1,2,3,4,11,12,13,14,21,22,23,24]),destination=Buffer.alloc(24,99);
  const mode4=reconstructCameraColumn(input,{height:3,nominalHeight:6,type:12,subtype:4,mode:4,destination});assert.deepEqual([...mode4.subarray(8,16)],[16,13,8,99,16,18,18,99]);assert.deepEqual([...mode4.subarray(0,8)],[1,2,3,4,1,4,3,4]);assert.deepEqual(destination,Buffer.alloc(24,99));
  const a=Buffer.alloc(32,10),b=Buffer.alloc(32,20),scratch=Buffer.alloc(32,77),type11=reconstructCameraColumn(a,{height:8,type:11,subtype:4,subdivision:1,next:b,destination:scratch});assert.deepEqual([...type11.subarray(8,12)],[10,15,20,77]);assert.ok(type11.subarray(0,8).every(v=>v===0));
});
test('type9 phased thirds and nominal geometry retain explicit opaque fourth bytes',()=>{
  const input=Buffer.from([0,3,6,9,30,33,36,39,60,63,66,69,90,93,96,99,120,123,126,129,150,153,156,159,180,183,186,189,210,213,216,219]);
  const result=reconstructCameraColumn(input,{height:8,type:9,subtype:5});assert.equal(result.length,(3*8-2)*4);assert.deepEqual([...result.subarray(0,4)],[0,3,16,9]);assert.equal(result[7],9);
});
test('intensity coefficients use signed kind2 clipping and preserve the fourth lane',()=>{
  const base=Array(94).fill(93),lookup=createIntensityLookup({kind:2,baseTable:base});assert.equal(lookup.table[1],992);base.fill(-1);assert.equal(createIntensityLookup({kind:2,baseTable:base}).table[2],65520);
  const color=createIntensityLookup({kind:3,baseTable:Array.from({length:766},(_,i)=>Math.min(765,i*2))});assert.deepEqual([...applyIntensityLookup(Buffer.of(25,30,40,7),color)],[50,60,80,7]);
  const enhanced=enhanceIntensityBase(Buffer.from([0,0,0,1,100,100,100,2,255,255,255,3]));assert.equal(enhanced[300],255);assert.equal(enhanced[765],765);
});
test('record gain and display profiles use different exclusive/inclusive boundaries',()=>{
  const input=Buffer.alloc(8*4,10),gain=applyRecordGain(input,{rawGain:512,channels:4,profiles:[{numerator:3,denominator:4,gain:-10000}]});assert.equal(gain[5*4],10);assert.equal(gain[6*4],20);
  const lookup={table:Array(766).fill(512)},display=applyDisplayProfiles(input,{profiles:[{numerator:3,denominator:4,brightness:1,contrast:0,gamma:10000,lookup}]});assert.equal(display[6*4],20);assert.equal(display[7*4],10);assert.equal(display[3],10);
});
test('filtered resize preserves the destination fourth lane instead of inventing alpha',()=>{
  const result=renderCaptureTile({width:2,height:1,data:Buffer.from([0,0,0,10,1,3,5,127]),xNumerator:1,xDenominator:2,x:1,tileWidth:1,tileHeight:1,filter:true,destination:Buffer.from([0,0,0,127])});assert.deepEqual([...result.data],[1,2,3,127]);
});
