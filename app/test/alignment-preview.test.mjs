import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignmentCrop,alignmentPlacement} from '../renderer/alignment-preview.mjs';

test('line alignment selects the newest two native columns and never presents a time strip as an area frame',()=>{
  assert.deepEqual(alignmentCrop({width:5000,height:2000,kind:'slit',mode:'slit'}),{x:4998,y:0,width:2,height:2000});
  assert.equal(alignmentCrop({width:5000,height:2000,kind:'slit',mode:'area'}),null);
});
test('area alignment retains the spatial frame and crops its specified aiming column for slit inspection',()=>{
  assert.deepEqual(alignmentCrop({width:128,height:640,kind:'area',mode:'area'}),{x:0,y:0,width:128,height:640});
  assert.deepEqual(alignmentCrop({width:128,height:640,kind:'area',mode:'slit',slitX:40}),{x:39,y:0,width:2,height:640});
  assert.equal(alignmentCrop({width:128,height:640,kind:'area',mode:'slit',slitX:0}).x,0);
});
test('fit height shows every sensor row and widens the two-column slit without adding samples',()=>{
  for(const height of [96,640,2000,5120]){
    const r=alignmentPlacement({width:2,height,viewportWidth:700,viewportHeight:400,mode:'slit'});
    assert.equal(r.y,8);assert.equal(r.height,384);assert.equal(r.width,32);assert.equal(r.x,334);
  }
});
test('zoom and drag remain bounded and horizontal inspection preserves full image height',()=>{
  const args={width:128,height:640,viewportWidth:700,viewportHeight:400,mode:'area'};
  const initial=alignmentPlacement(args),wide=alignmentPlacement({...args,horizontalZoom:4}),zoom=alignmentPlacement({...args,zoom:4,panY:1e9});
  assert.equal(wide.height,initial.height);assert.equal(wide.width,initial.width*4);
  assert.equal(zoom.y,8);assert.equal(zoom.height,1536);
});
