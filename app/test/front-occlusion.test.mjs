import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frontOverlayAlpha} from '../renderer/front-occlusion.mjs';

const w=80,h=50;
const background=()=>{const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)data.set([100,70,50,255],i*4);return data;};
test('unchanged background and global exposure drift leave the overlay visible',()=>{
  const ref=background(),lit=ref.map((v,i)=>i%4===3?v:v+12);
  assert.ok(frontOverlayAlpha(ref,ref,w,h).every(a=>a===255));
  assert.ok(frontOverlayAlpha(ref,lit,w,h).every(a=>a===255));
});
test('a stationary foreground object stays in front while unrelated noise and background recover',()=>{
  const ref=background(),current=ref.slice();
  for(let y=15;y<40;y++)for(let x=30;x<44;x++)current.set([20,140,180,255],(y*w+x)*4);
  current.set([255,255,255,255],(4*w+4)*4);
  const alpha=frontOverlayAlpha(ref,current,w,h);
  assert.equal(alpha[25*w+35],0);assert.equal(alpha[4*w+4],255);assert.equal(alpha[5*w+65],255);
  assert.deepEqual(frontOverlayAlpha(ref,current,w,h),alpha,'Repeated stationary frames were learned into the reference');
  assert.ok(frontOverlayAlpha(ref,ref,w,h).every(a=>a===255));
  assert.equal(ref[25*w*4+35*4],100,'The reference was modified');
});
