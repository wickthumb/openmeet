import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {encodeCompressedMedia,decodeCompressedMedia,runMediaCodec} from './media-codec.js';
import {buildAvi} from './media.js';
const executable='/usr/bin/ffmpeg';
test('optional open codec encodes JPEG and MP4; the authored AVI plays through a separate decoder',{skip:!fs.existsSync(executable)},async()=>{
  const rgb=Buffer.alloc(16*16*3);for(let at=0;at<rgb.length;at+=3)rgb[at]=255;
  const jpeg=await encodeCompressedMedia({executable,codec:'mjpeg',width:16,height:16,frames:[rgb]});assert.equal(jpeg.data.subarray(0,2).toString('hex'),'ffd8');
  const decoded=await decodeCompressedMedia({executable,codec:'mjpeg',frames:[jpeg.data],width:16,height:16});assert.equal(decoded.frames.length,1);assert.ok(decoded.frames[0][0]>240);
  const avi=buildAvi({width:16,height:16,rate:25,plannedCount:1,frames:[{data:jpeg.data}],stripTables:false});
  const played=await runMediaCodec({executable,args:['-v','error','-f','avi','-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],input:avi});assert.equal(played.length,rgb.length);
  const mp4=await encodeCompressedMedia({executable,codec:'mp4',width:16,height:16,frames:[rgb]});assert.equal(mp4.data.toString('ascii',4,8),'ftyp');assert.equal(mp4.nativeCodecEquivalent,false);
});
test('codec process failure is bounded and does not become a success result',async()=>{
  await assert.rejects(runMediaCodec({executable:path.join(os.tmpdir(),'openmeet-definitely-missing-codec'),args:[],timeoutMs:1000}),{code:'ENOENT'});
  await assert.rejects(runMediaCodec({executable:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],input:Buffer.alloc(4096),maximumBytes:10}),/budget/);
  const controller=new AbortController();controller.abort(Error('cancelled'));await assert.rejects(runMediaCodec({executable:process.execPath,args:[],signal:controller.signal}),/cancelled/);
});
