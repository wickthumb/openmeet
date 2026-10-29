import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraProfileToken,cameraViewLabel,heatCameraKey,sameFinish} from '../renderer/camera-state.mjs';
const config={locations:[{id:'home',name:'Home'},{id:'back',name:'Backstraight'}],setups:{a:{revision:1,label:'A',locationId:'home',side:'outside',direction:'normal'},b:{revision:2,label:'B',locationId:'back',side:'inside',direction:'reverse'}}};
test('moving a device creates a new calibration namespace while old evidence keeps its setup',()=>{
  const heat={cameraSetups:{b:{revision:1,label:'Original B',locationId:'home',side:'inside',direction:'normal'}},cameraLocations:config.locations};
  assert.equal(cameraProfileToken(config,null,'b'),'b@2');assert.equal(cameraProfileToken(config,heat,'b'),'b');
  assert.equal(cameraProfileToken(config,null,'a'),'a');assert.equal(sameFinish(config,null,'a','b'),false);assert.equal(sameFinish(config,heat,'a','b'),true);
  assert.equal(cameraViewLabel(config,heat,{id:'b'}),'Original B · Home · inside');
});
test('a different direction is not a synchronized finish comparison; heat assignment keys are stable',()=>{
  assert.equal(sameFinish({...config,setups:{...config.setups,b:{...config.setups.b,locationId:'home'}}},null,'a','b'),false);
  assert.equal(heatCameraKey({ev:3,rd:1,ht:2}),'3-1-2');
});
