import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderLaneGuides} from '../capture/lane-guides.js';
test('guide rendering copies pixels, preserves coordinates, and changes only specified rows',()=>{
 const image={width:5,height:6,channels:3,data:new Uint8Array(90).fill(37)},before=image.data.slice();
 assert.equal(renderLaneGuides(image,{enabled:false}),image);
 const derived=renderLaneGuides(image,{enabled:true,rows:[2],thickness:1,color:'#ff0000'});
 assert.notEqual(derived.data,image.data);assert.deepEqual(image.data,before);
 assert.equal(derived.width,image.width);assert.equal(derived.height,image.height);
 for(let y=0;y<6;y++)for(let x=0;x<5;x++)assert.deepEqual([...derived.data.slice((y*5+x)*3,(y*5+x+1)*3)],y===2?[255,0,0]:[37,37,37]);
});
