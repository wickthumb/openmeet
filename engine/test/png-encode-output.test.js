import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodePng,pngChunk,testImage} from '../sim/png-encode.js';
import {decodePng} from '../sim/png.js';
import {encodeReferencePng,referencePngChunk} from './fixtures/png-encode-reference.js';

test('PNG filtering and chunk assembly preserve every encoded byte of the original encoder',()=>{
  for(const [width,height]of [[1,1],[2,3],[3,13],[4,13],[5,13],[13,11],[80,50],[127,33],[512,65]])for(const channels of [1,3,4]) {
    const image=testImage(width,height,channels,width*height+channels),original=image.data.slice();
    for(const filter of [undefined,0,1,2,3,4,5]) {
      const options=filter==null?{}:{filter:()=>filter};
      const encoded=encodePng(image,options),reference=encodeReferencePng(image,options);
      assert.ok(encoded.equals(reference),`${width}×${height}×${channels}, filter ${filter??'mixed'}`);
      if(filter!==5)assert.deepEqual(decodePng(encoded).data,image.data);
    }
    assert.deepEqual(image.data,original,'Encoding mutated the source pixels');
  }
});

test('split IDATs, ancillary chunks and arbitrary chunk labels retain their byte contract',()=>{
  for(const type of ['IHDR','IDAT','IEND','tEXt','','long-label'])for(const size of [0,1,63,4096]) {
    const body=Buffer.alloc(size,17);assert.deepEqual(pngChunk(type,body),referencePngChunk(type,body));
  }
  const image=testImage(79,37,4,1021);
  for(const idatSplit of [1,17,1024]) {
    const options={idatSplit,extraChunks:[pngChunk('tEXt',Buffer.from('Comment\0OpenMeet'))],filter:y=>y%5};
    assert.deepEqual(encodePng(image,options),encodeReferencePng(image,options));
  }
});
