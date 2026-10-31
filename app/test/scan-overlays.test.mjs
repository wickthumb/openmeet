import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {scanBoundaries,movedBoundaryRow,scanBackground,writeForegroundMask,foregroundInRows} from '../renderer/scan-overlays.mjs';

const bands=[{lane:1,top:10,bottom:25},{lane:2,top:25,bottom:50},{lane:3,top:50,bottom:80}];

test('foreground range queries agree with individual pixels across byte and column boundaries',()=>{
  let seed=417;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(const height of [1,7,8,9,31,640,2000]){
    const mask=new Uint8Array(Math.ceil(height*5/8));for(let i=0;i<mask.length;i++)mask[i]=random()%9===0?random()&255:0;
    for(let n=0;n<500;n++){
      const column=random()%5,lo=random()%(height+8)-4,hi=lo+random()%(height+8);
      let expected=false;for(let y=Math.max(0,lo);y<=Math.min(height-1,hi);y++){const bit=column*height+y;if(mask[bit>>3]&(1<<(bit&7))){expected=true;break;}}
      assert.equal(foregroundInRows(mask,column,height,lo,hi),expected,`height=${height}, column=${column}, rows=${lo}..${hi}`);
    }
  }
});

test('one shared edge resizes both neighbouring lanes without moving other edges',()=>{
  const original=scanBoundaries(bands,{},100);
  assert.deepEqual(original.map(b=>b.row),[10,25,50,80]);
  const style={boundaries:{'1:2':movedBoundaryRow(original,1,32,100)}};
  const moved=scanBoundaries(bands,style,100);
  assert.deepEqual(moved.map(b=>b.row),[10,32,50,80]);
  assert.deepEqual(moved.map(b=>[b.above,b.below]),[[null,1],[1,2],[2,3],[3,null]]);
  assert.equal(moved[1].row-moved[0].row,22);
  assert.equal(moved[2].row-moved[1].row,18);
});

test('edges cannot cross or leave the image; image order need not equal lane-number order',()=>{
  const edges=scanBoundaries(bands,{},100);
  assert.equal(movedBoundaryRow(edges,1,999,100),49);
  assert.equal(movedBoundaryRow(edges,1,-99,100),11);
  assert.equal(movedBoundaryRow(edges,0,-99,100),0);
  assert.equal(movedBoundaryRow(edges,3,999,100),99);
  const reverse=scanBoundaries(bands.map(b=>({...b,lane:4-b.lane})),{},100);
  assert.deepEqual(reverse.map(b=>b.key),['top:3','3:2','2:1','1:bottom']);
});

test('old independently moved lane bands reconcile into one ordered shared boundary',()=>{
  const style={positions:{1:{top:11,bottom:30},2:{top:34,bottom:54}}};
  assert.deepEqual(scanBoundaries(bands,style,100).map(b=>b.row),[11,32,52,80]);
  const overlap={positions:{1:{top:40,bottom:60},2:{top:0,bottom:1}}};
  const edges=scanBoundaries(bands,overlap,100);
  assert.ok(edges.every((b,i)=>!i||b.row>edges[i-1].row));
});

test('display mask tolerates background noise, hides changed pixels and preserves original bytes',()=>{
  const width=24,height=6,channels=3,data=new Uint8Array(width*height*channels);
  for(let x=0;x<width;x++)for(let y=0;y<height;y++)for(let c=0;c<3;c++)data[(x*height+y)*3+c]=100+(x%3)-1;
  const image={data,width,height,channels},background=scanBackground(image);
  const passing=new Uint8Array(data);for(let x=8;x<=10;x++)for(let y=2;y<=3;y++){passing[(x*height+y)*3]=15;passing[(x*height+y)*3+1]=230;}
  const before=passing.slice(),mask=new Uint8Array(Math.ceil(width*height/8));
  writeForegroundMask(mask,0,{...image,data:passing},background);
  assert.equal(foregroundInRows(mask,8,height,2,3),true);
  assert.equal(foregroundInRows(mask,8,height,0,1),false);
  assert.equal(foregroundInRows(mask,7,height,0,5),false);
  assert.deepEqual(passing,before);
});

test('row-major sample images and streamed columns produce the same mask, including tile offsets',()=>{
  const width=24,height=8,channels=4,columns=new Uint8Array(width*height*channels).fill(80);
  const reference=scanBackground({data:columns,width,height,channels});
  for(let x=7;x<=9;x++)for(let y=1;y<=2;y++)columns[(x*height+y)*channels]=170;
  const rows=new Uint8Array(columns.length);
  for(let x=0;x<width;x++)for(let y=0;y<height;y++)rows.set(columns.subarray((x*height+y)*channels,(x*height+y+1)*channels),(y*width+x)*channels);
  const a=new Uint8Array(Math.ceil((width+3)*height/8)),b=a.slice();
  writeForegroundMask(a,3,{data:columns,width,height,channels},reference);
  writeForegroundMask(b,3,{data:rows,width,height,channels,layout:'rows'},scanBackground({data:new Uint8Array(columns.length).fill(80),width,height,channels}));
  assert.deepEqual(a,b);
  assert.equal(foregroundInRows(a,10,height,2,2),true);
  assert.equal(foregroundInRows(a,7,height,2,2),false);
});

test('background medians and MAD retain baseline bytes across samples, layouts and channel counts',()=>{
  const vectors=JSON.parse(readFileSync(new URL('./fixtures/scan-background-vectors.json',import.meta.url),'utf8'));
  const samples=[-Infinity,-3,-.1,0,.1,.9,1,1.9,2,2.9,3,7,23.9,24,24.9,25,128,Infinity,undefined,NaN];
  for(const {width,height,channels,kind,seed,sha256}of vectors.cases)for(const layout of ['columns','rows']){
    let state=seed>>>0;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
    const data=new Uint8Array(width*height*channels);
    for(let x=0;x<width;x++)for(let y=0;y<height;y++)for(let c=0;c<channels;c++){
      const i=((layout==='rows'?y*width+x:x*height+y)*channels)+c;
      const base=c===3?random()%256:kind==='black'?0:kind==='white'?255:50+(y*7%101)+(c*29%45);let value=base;
      if(c!==3){
        if(kind==='noise')value=base+Math.round(x/width*22)+(random()%17)-8;
        if(kind==='random')value=random()%256;
        if((kind==='black'||kind==='white')&&x>width*.3&&x<width*.65&&y>height*.15&&y<height*.45)value=channels===1?230:[20,190,210][c];
      }
      data[i]=Math.max(0,Math.min(255,value));
    }
    const image={data,width,height,channels,layout},before=data.slice(),hash=createHash('sha256');
    for(const sample of samples){
      if(Number.isNaN(sample)){assert.throws(()=>scanBackground(image,sample),{name:'RangeError',message:'Invalid array length'});hash.update('RangeError:Invalid array length');continue;}
      const result=scanBackground(image,sample);hash.update(result.colors);hash.update(result.tolerance);
    }
    assert.equal(hash.digest('hex'),sha256,`${width}x${height} ${channels}ch ${layout} ${kind}`);assert.deepEqual(data,before);
  }
});

test('background fallback preserves numeric samples, incomplete buffers and invalid sample errors',()=>{
  for(const data of [[3,9,20,42],new Float64Array([3.5,9.25,20.75,42.5])]){
    const result=scanBackground({data,width:4,height:1,channels:1});
    assert.deepEqual([...result.colors],[20,20,20]);assert.deepEqual([...result.tolerance],[64]);
  }
  const incomplete=scanBackground({data:new Uint8Array([100,100,100]),width:4,height:2,channels:3});
  assert.deepEqual([...incomplete.colors],[0,0,0,0,0,0]);assert.deepEqual([...incomplete.tolerance],[0,0]);
  assert.throws(()=>scanBackground({data:new Uint8Array(12),width:1.5,height:2,channels:3}),RangeError);
  assert.throws(()=>scanBackground({data:new Uint8Array(12),width:2,height:2,channels:3},NaN),RangeError);
});

test('zero-height backgrounds keep large sample storage sparse',()=>{
  const sizes=[],maximum=0xffffffff;
  const Bytes=new Proxy(Uint8Array,{construct(target,args){
    sizes.push(args[0]);assert.notEqual(args[0],maximum,'No pixel rows require a dense sample buffer');
    return Reflect.construct(target,args);
  }});
  const code=readFileSync(new URL('../renderer/scan-overlays.mjs',import.meta.url),'utf8').replaceAll('export function','function');
  const background=vm.runInNewContext(code+'\nscanBackground;',{Uint8Array:Bytes,Uint8ClampedArray});
  const result=background({data:new Uint8Array(0),width:maximum,height:0,channels:3},maximum);
  assert.equal(result.colors.length,0);assert.equal(result.tolerance.length,0);assert.deepEqual(sizes,[0,0]);
});
