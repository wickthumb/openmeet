import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanBoundaries,movedBoundaryRow,scanBackground,writeForegroundMask,foregroundInRows} from '../renderer/scan-overlays.mjs';

const bands=[{lane:1,top:10,bottom:25},{lane:2,top:25,bottom:50},{lane:3,top:50,bottom:80}];

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
