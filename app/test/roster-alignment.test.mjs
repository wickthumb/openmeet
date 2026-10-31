import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterLaneLayout } from '../renderer/roster-alignment.mjs';

const boundaries = (heights, lanes = heights.map((_, i) => i + 1)) => {
  let row = 20;
  return [...heights.map((height, i) => {
    const edge = { row, below: lanes[i] };row += height;return edge;
  }), { row, below: null }];
};
const view = (overrides = {}) => ({ athletes: Array.from({length:8},(_,i)=>({lane:i+1})),
  boundaries: boundaries([60,70,80,90,100,110,120,130]), rowOrigin:0,rowScale:1,
  scanHeight:800,scanTop:300,listTop:200,listHeight:950,rowHeights:new Map(Array.from({length:8},(_,i)=>[i+1,44])),...overrides });

test('eight unequal lane heights align with their actual screen boundaries', () => {
  const layout=rosterLaneLayout(view());
  assert.equal(layout.aligned,true);
  assert.deepEqual(layout.rows,[60,70,80,90,100,110,120,130].map((height,i,all)=>({lane:i+1,top:120+all.slice(0,i).reduce((a,b)=>a+b,0),height})));
});

test('nine lanes and sparse entries retain empty-lane gaps in either camera order', () => {
  const lanes=[9,8,7,6,5,4,3,2,1],edges=boundaries(Array(9).fill(70),lanes);
  const layout=rosterLaneLayout(view({athletes:[{lane:1},{lane:5},{lane:9}],boundaries:edges}));
  assert.equal(layout.aligned,true);
  assert.deepEqual(layout.rows,[{lane:1,top:680,height:70},{lane:5,top:400,height:70},{lane:9,top:120,height:70}]);
});

test('pan and scale use the same projection as the lane gutter', () => {
  const layout=rosterLaneLayout(view({rowOrigin:20,rowScale:.8,scanHeight:650}));
  assert.equal(layout.aligned,true);
  assert.equal(layout.rows[0].top,100);
  assert.equal(layout.rows[0].height,48);
  assert.equal(layout.rows[7].top,604);
});

test('an empty lane does not impose a text height on an occupied lane', () => {
  const layout=rosterLaneLayout(view({athletes:[{lane:1}],boundaries:boundaries([70,43])}));
  assert.equal(layout.aligned,true);
  assert.deepEqual(layout.rows,[{lane:1,top:120,height:70}]);
});

test('cropped lanes or race controls overlapping the first athlete fall back without dropping entries', () => {
  for(const overrides of [{rowOrigin:21},{scanHeight:779},{listTop:321},{listHeight:879}]){
    const layout=rosterLaneLayout(view(overrides));
    assert.equal(layout.aligned,false,JSON.stringify(overrides));
    assert.deepEqual(layout.rows,[]);
  }
});

test('expanded athlete controls must fit their own band', () => {
  assert.equal(rosterLaneLayout(view({rowHeights:new Map([[1,70]])})).aligned,false);
  assert.equal(rosterLaneLayout(view({rowHeights:new Map([[2,70]])})).aligned,true);
});

test('compact demo-sized lanes align when the actual two-line text fits', () => {
  const heights=[23,27,27,30,34,34,39,52],scale=1.5;
  const edges=boundaries(heights).map(edge=>({...edge,row:edge.row+353}));
  const layout=rosterLaneLayout(view({boundaries:edges,rowScale:scale,rowOrigin:200,
    scanHeight:850,rowHeights:new Map(heights.map((_,i)=>[i+1,33.40625]))}));
  assert.equal(layout.aligned,true);
  assert.equal(layout.rows[0].height,34.5);
  assert.equal(layout.rows[7].height,78);
});

test('review badges in taller lanes never disqualify a smaller auto-result row', () => {
  const heights=[34.5,40.5,40.5,45,51,51,58.5,78];
  const rowHeights=new Map(heights.map((_,i)=>[i+1,[4,5].includes(i+1)?37:33.40625]));
  const layout=rosterLaneLayout(view({boundaries:boundaries(heights),rowHeights}));
  assert.equal(layout.aligned,true);
  assert.equal(layout.rows[0].height,34.5);
  assert.equal(layout.rows[3].height,45);
  assert.equal(rosterLaneLayout(view({boundaries:boundaries(heights),rowHeights:new Map([...rowHeights,[1,37]])})).aligned,false);
});

test('subpixel boundaries allow rounding tolerance but still reject overflowing text', () => {
  const config=view({athletes:[{lane:1}],boundaries:boundaries([33.2]),rowHeights:new Map([[1,33.40625]])});
  assert.equal(rosterLaneLayout(config).aligned,true);
  assert.equal(rosterLaneLayout({...config,rowHeights:new Map([[1,34]])}).aligned,false);
});

test('unlaned, duplicate, missing or malformed assignments never align', () => {
  for(const overrides of [{unlaned:true},{athletes:[]},{athletes:[{lane:1},{lane:1}]},
    {athletes:[{lane:10}]},{boundaries:[]},{boundaries:boundaries([60,70],[1,1])},
    {boundaries:[{row:NaN,below:1},{row:100,below:null}]},{rowScale:0},{rowScale:Infinity}]) {
    assert.equal(rosterLaneLayout(view(overrides)).aligned,false,JSON.stringify(overrides));
  }
});
