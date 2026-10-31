import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {billboardSettings,billboardCollection,billboardPieces,billboardPoint,moveBillboard,maskBillboard,billboardCacheKey,billboardCacheOffset,reusableBillboardCache,BillboardConsole} from '../renderer/billboard.mjs';
import {columnProjection} from '../renderer/column-map.mjs';
import {billboardPieceInputs} from './fixtures/billboard-piece-inputs.mjs';
const view={period:.01,timeOrigin:10,count:100,width:200,height:80,c0:0,zx:2,r0:20,zy:2,rows:100,flip:false};
const b={enabled:true,time:10.2,duration:.6,row:25,height:20};
test('source time / row geometry survives pan, zoom, flip, framing and hidden time spans',()=>{
  const map=columnProjection([[0,30],[60,100]],100),v={...view,map};
  const pieces=billboardPieces(b,v);assert.equal(pieces.length,2);
  assert.ok(Math.abs(pieces[0].u-2/3)<1e-12);assert.ok(Math.abs(pieces[1].u-2/3)<1e-12);
  assert.ok(Math.abs(pieces[0].uw-1/2)<1e-12);assert.ok(Math.abs(pieces[1].uw-2/3)<1e-12);
  assert.equal(pieces[0].start,0);assert.equal(pieces[1].end,100);
  assert.equal(pieces[0].y,10);assert.equal(pieces[0].h,40);
  const flipped=billboardPieces(b,{...v,flip:true});assert.equal(flipped[0].x,200-pieces[0].x-pieces[0].w);
  const zoom=billboardPieces(b,{...v,c0:10,zx:4,r0:23,zy:3});assert.equal(zoom[0].y,6);
  assert.equal(billboardPoint(80,10,v).time,10.7);assert.equal(billboardPoint(120,10,{...v,flip:true}).time,10.7);
  assert.equal(billboardPoint(80,10,v).row,25);
  assert.deepEqual(billboardPieces({...b,enabled:false},v),[]);assert.deepEqual(billboardPieces(b,{...v,last:0}),[]);
  assert.equal(b.time,10.2);assert.equal(b.row,25);
});
test('a repeating band covers the full capture and long recordings without one object per repeat',()=>{
  const v={...view,count:24_000_000,width:1000,zx:1/24000},pieces=billboardPieces({...b,time:-10,duration:.04},v);
  assert.equal(pieces.length,1);assert.equal(pieces[0].start,0);assert.equal(pieces[0].end,24_000_000);
  assert.ok(pieces[0].uw>1_000_000);
  const live=billboardPieces(b,{...view,last:40});assert.equal(live[0].end,40);
});
test('piece geometry preserves baseline coordinates across sparse captures and viewport boundaries',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/billboard-pieces-vectors.json',import.meta.url),'utf8')),hash=createHash('sha256');let count=0;
  const encode=value=>JSON.stringify(value,(_key,n)=>typeof n==='number'&&!Number.isFinite(n)?String(n):Object.is(n,-0)?'-0':n);
  for(const [billboard,viewport]of billboardPieceInputs()){hash.update(encode(billboardPieces(billboard,viewport))+'\n');count++;}
  assert.equal(count,fixture.count);assert.equal(hash.digest('hex'),fixture.sha256);
});
test('collections preserve multiple independent bands, empty lists, legacy placements and the logo default',()=>{
  const initial=billboardCollection(null,{rows:640});assert.equal(initial.items.length,1);assert.equal(initial.items[0].text,'');assert.equal(initial.items[0].logo,null);assert.equal(initial.items[0].height,51.2);
  const c=billboardCollection({version:2,selected:'b',items:[{id:'a',row:10},{id:'b',row:60,enabled:true}]},{rows:640});assert.equal(c.selected,'b');assert.equal(c.items[0].row,10);assert.equal(c.items[1].row,60);assert.equal(c.items[1].enabled,true);
  assert.deepEqual(billboardCollection({version:2,items:[]}).items,[]);
  assert.equal(billboardCollection({enabled:true,text:'Legacy'}).items[0].text,'Legacy');
});
test('move and resize use native source coordinates with minimum sizes and row bounds',()=>{
  const moved=moveBillboard(b,{time:10,row:20},{time:10.1,row:23},false,view);assert.ok(Math.abs(moved.time-10.3)<1e-10);assert.equal(moved.row,28);
  const sized=moveBillboard(b,{time:10,row:20},{time:8,row:-20},true,view);assert.equal(sized.duration,.04);assert.equal(sized.height,1);
  assert.equal(billboardSettings({height:-10,duration:-1},{rows:100,period:.01}).height,1);
});
test('compositing removes artwork only, preserves foreground and hides unmatched mask columns',()=>{
  const rows=8,bits=new Uint8Array(2);bits[0]=1<<3;const original=bits.slice();
  const image={width:2,height:8,data:new Uint8ClampedArray(2*8*4).fill(255)};
  maskBillboard(image,[{x:0,y:0,w:2,h:8}],x=>x===0?[{mask:bits,column:0}]:[],y=>y,rows);
  assert.equal(image.data[(3*2)*4+3],0);assert.equal(image.data[(7*2)*4+3],255);
  for(let y=0;y<8;y++)assert.equal(image.data[(y*2+1)*4+3],0);
  assert.deepEqual(bits,original);
});

test('follow translates cached art between packets; source, mask and geometry revisions invalidate',()=>{
  const v={...view,revision:['capture-a',32,'simple'],maskLast:32},key=billboardCacheKey(b,v),cache={key,c0:0};
  for(let c0=0;c0<70;c0+=.125){const next={...v,c0,last:30+c0};assert.equal(reusableBillboardCache(cache,billboardCacheKey(b,next),next),true);assert.equal(billboardCacheOffset(cache,next),-c0*2);}
  assert.equal(reusableBillboardCache(cache,key,{...v,c0:80}),false);
  for(const next of [{...v,revision:['capture-b',32,'simple']},{...v,revision:['capture-a',64,'simple']},{...v,revision:['capture-a',32,'learned-request']},{...v,zx:3},{...v,r0:21},{...v,flip:true},{...v,map:columnProjection([[0,20],[40,80]],100)}])assert.notEqual(billboardCacheKey(b,next),key);
});


async function withArtworkLoads(run){
  const saved=Object.getOwnPropertyDescriptor(globalThis,'Image'),reads=[],decoded=[],changes=[],errors=[];
  globalThis.Image=class{constructor(){decoded.push(this);}decode(){return new Promise(resolve=>{this.finish=resolve;});}};
  const console=Object.assign(Object.create(BillboardConsole.prototype),{images:new Map(),imageLoads:new Map(),paintCaches:new Map(),bridge:{call(_method,params){return new Promise((resolve,reject)=>reads.push({params,resolve,reject}));}},changed:()=>changes.push(true),toast:message=>errors.push(message)});
  try{await run({console,reads,decoded,changes,errors,tick:()=>new Promise(r=>setImmediate(r))});}
  finally{if(saved)Object.defineProperty(globalThis,'Image',saved);else delete globalThis.Image;}
}

test('a superseded artwork read cannot overwrite the newer decoded image or allocate a stale decoder',()=>withArtworkLoads(async({console,reads,decoded,changes,errors,tick})=>{
  const older=console.loadImage('art','assets/billboard.svg',true),newer=console.loadImage('art','assets/billboard.svg',true);
  reads[1].resolve({dataUrl:'data:new'});await tick();decoded[0].finish();const expected=await newer;
  reads[0].resolve({dataUrl:'data:old'});assert.equal(await older,expected);
  assert.equal(console.images.get('art/assets/billboard.svg'),expected);assert.equal(expected.src,'data:new');
  assert.equal(decoded.length,1);assert.equal(changes.length,1);assert.deepEqual(errors,[]);assert.equal(console.imageLoads.size,0);
}));

test('a superseded decode cannot replace newer artwork when it completes later',()=>withArtworkLoads(async({console,reads,decoded,changes,tick})=>{
  const older=console.loadImage('art');reads[0].resolve({dataUrl:'data:old'});await tick();
  const newer=console.loadImage('art','assets/billboard.svg',true);reads[1].resolve({dataUrl:'data:new'});await tick();
  decoded[1].finish();const expected=await newer;decoded[0].finish();await older;
  assert.equal(console.images.get('art/assets/billboard.svg'),expected);assert.equal(expected.src,'data:new');assert.equal(changes.length,1);assert.equal(console.imageLoads.size,0);
}));

test('deleted artwork invalidates pending reads and stale failures do not report errors for newer artwork',()=>withArtworkLoads(async({console,reads,decoded,changes,errors,tick})=>{
  const deleted=console.loadImage('gone');console.forgetImages('gone');reads[0].resolve({dataUrl:'data:deleted'});await deleted;
  assert.equal(console.images.has('gone/assets/billboard.svg'),false);assert.equal(decoded.length,0);
  const older=console.loadImage('art'),newer=console.loadImage('art','assets/billboard.svg',true);
  reads[2].resolve({dataUrl:'data:new'});await tick();decoded[0].finish();await newer;
  reads[1].reject(Error('superseded read failed'));await older;
  assert.deepEqual(errors,[]);assert.equal(changes.length,1);assert.equal(console.imageLoads.size,0);
}));
