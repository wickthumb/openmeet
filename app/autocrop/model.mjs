import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const MODEL_SHA256='8b3895b390fd36f8840c988a97fb9ac354ed3d3f2935ea51041834acd821aac3';
let loaded;
export function loadModel() {
  return loaded ||= Promise.all([readFile(new URL('./model.json',import.meta.url),'utf8'),readFile(new URL('./model.bin',import.meta.url))]).then(([raw,bytes])=>{
    const manifest=JSON.parse(raw);
    if(manifest.format!=='openmeet-autocrop'||manifest.version!==1||manifest.approved!==true||manifest.threshold!==.05||manifest.rows!==32||manifest.weights_sha256!==MODEL_SHA256||createHash('sha256').update(bytes).digest('hex')!==MODEL_SHA256||bytes.length!==11065*4)throw Error('Bundled cropper failed its release integrity check');
    const weights=new Float32Array(bytes.length/4);for(let i=0;i<weights.length;i++)weights[i]=bytes.readFloatLE(i*4);
    return {...manifest,weights};
  }).catch(error=>{loaded=null;throw error;});
}
