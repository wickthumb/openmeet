import{test}from'node:test';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import assert from'node:assert/strict';
import{validateCropResult,columnProjection,displayCoordinate,originalCoordinate,visibleColumnPieces}from'../renderer/column-map.mjs';
const payload=()=>({schema:'autocrop-ranges-v2',approved:true,original_width:20,modes:{'storage-display':{mode:'storage-display',padding:8,merge_gap_lt:0,ranges:[[2,5],[12,16]],cropped_to_original:[2,3,4,12,13,14,15]}}});
test('strict crop maps reject shifted, duplicate, mismatched, out-of-bounds or unapproved results',()=>{
 assert.deepEqual(validateCropResult(payload(),20),[[2,5],[12,16]]);
 for(const mutate of [r=>r.approved=false,r=>r.original_width=21,r=>r.modes['storage-display'].cropped_to_original[3]=5,r=>r.modes['storage-display'].ranges[1]=[4,9],r=>r.modes['storage-display'].padding=160]){const r=payload();mutate(r);assert.throws(()=>validateCropResult(r,20));}
});
test('hidden spans preserve original column centers and the true time jump at a break',()=>{
 const map=columnProjection([[2,5],[12,16]],20);assert.equal(map.length,7);
 for(const original of [2,3,4,12,13,14,15]){const display=displayCoordinate(map,original+.5);assert.equal(originalCoordinate(map,display),original+.5);}
 assert.equal(originalCoordinate(map,2.5),4.5);assert.equal(originalCoordinate(map,3.5),12.5);
 assert.equal(displayCoordinate(map,8.5),null);assert.equal(displayCoordinate(map,12.5),3.5);
 assert.deepEqual(visibleColumnPieces(map,2,5),[{start:4,end:5,displayStart:2,displayEnd:3},{start:12,end:14,displayStart:3,displayEnd:5}]);
});
test('empty results and viewport edges are safe without changing the source width',()=>{
 const map=columnProjection([],20);assert.equal(map.width,20);assert.equal(map.length,0);assert.equal(originalCoordinate(map,0),null);
 assert.deepEqual(visibleColumnPieces(null,3,8,20),[{start:3,end:8,displayStart:3,displayEnd:8}]);
 assert.throws(()=>columnProjection([[5,4]],20));assert.throws(()=>columnProjection([[1,7],[6,10]],20));
});

// Frozen results from the pre-optimization implementation, including viewports
// crossing time breaks, exact boundaries, reversed/empty intervals and overscan.
test('visible pieces preserve baseline coordinates across sparse short and long recordings',()=>{
 const vectors=JSON.parse(readFileSync(new URL('./fixtures/visible-column-pieces-vectors.json',import.meta.url),'utf8'));
 for(const fixture of vectors.cases){
  const ranges=Array.from({length:fixture.count},(_,i)=>[i*67,i*67+20+i%20]),map=columnProjection(ranges,fixture.width),hash=createHash('sha256');
  const queries=[[-100,-1],[0,0],[-100,map.length+100],[map.length,map.length+100],[100,20]];let seed=1763+fixture.count;
  for(let i=0;i<150;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const start=(seed/2**32)*(map.length+200)-100;queries.push([start,start+[17,300,map.length][i%3]]);}
  for(const span of map.spans.slice(0,5))for(const delta of [-1e-7,0,1e-7])queries.push([span.displayStart+delta,span.displayEnd+delta]);
  for(const query of queries)hash.update(JSON.stringify(visibleColumnPieces(map,...query))+'\n');
  assert.equal(hash.digest('hex'),fixture.sha256,'Changed pieces for '+fixture.count+' spans');
 }
 for(const [start,end]of [[NaN,4],[0,NaN],[Infinity,Infinity],[-Infinity,-Infinity]])assert.deepEqual(visibleColumnPieces(columnProjection([[2,5]],8),start,end),[]);
});
