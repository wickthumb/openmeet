import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../renderer/console.js',import.meta.url),'utf8');
const start=code.indexOf('function syncFront(h,g,W,Hf) {'),end=code.indexOf('function drawFront()',start);
const tagStart=code.indexOf('function updateFrontTag(');
assert.ok(tagStart>=0&&start>tagStart&&end>start);
function fixture(key,{sampleAvailable=false}={}) {
  let disposed=0,loads=0,cacheDisposed=0;
  const video={style:{},paused:true,dataset:{src:'previous-recording.mp4'},removeAttribute(name){assert.equal(name,'src');},load(){loads++;}};
  const context={OM:null,frontVideo:()=>video,vidTag:{style:{}},frontCache:{dispose(){cacheDisposed++;}},frontCacheKey:'recording',lastFrontFrame:{},wantedVideoTime:1,frontVideoFrame:4,frontWarmKey:'warm',
    frontOcclusion:{key,reference:{},loading:false,dispose(){disposed++;this.key=null;this.reference=null;}},replayCameras:()=>({front:sampleAvailable})};
  const sync=vm.runInNewContext(code.slice(tagStart,end)+'\nsyncFront;',context);
  return {sync,video,context,state:()=>({disposed,loads,cacheDisposed})};
}
test('a heat without a front recording releases the old decoder, frame cache and mask once',()=>{
  const f=fixture('/previous/front.png');assert.equal(f.sync({},null,640,360),false);
  assert.deepEqual(f.state(),{disposed:1,loads:1,cacheDisposed:1});assert.equal(f.video.dataset.src,undefined);
  f.sync({},null,640,360);assert.deepEqual(f.state(),{disposed:1,loads:1,cacheDisposed:1});
});
test('the synthetic camera keeps its fixed background between redraws and releases it when absent',()=>{
  const f=fixture('sample:meet:640:360',{sampleAvailable:true});f.sync({},null,640,360);f.sync({},null,640,360);
  assert.equal(f.state().disposed,0);assert.ok(f.context.frontOcclusion.reference);
  f.context.replayCameras=()=>({front:false});f.sync({},null,640,360);assert.equal(f.state().disposed,1);
});

test('a stable front timestamp retains its text node and visibility across redraws',()=>{
  let text='',display='',textWrites=0,displayWrites=0;
  const tag={get textContent(){return text;},set textContent(value){text=value;textWrites++;},style:{get display(){return display;},set display(value){display=value;displayWrites++;}}};
  const update=vm.runInNewContext(code.slice(tagStart,start)+'\nupdateFrontTag;',{vidTag:tag});
  update('12.601 s · frame 127');
  for(let i=0;i<100;i++)update('12.601 s · frame 127');
  assert.equal(textWrites,1);assert.equal(displayWrites,1);
  update('12.634 s · frame 128');assert.equal(textWrites,2);assert.equal(displayWrites,1);
  update();update();assert.equal(displayWrites,2);assert.equal(textWrites,2);
});
