// The user-authorized empty-span model ships locally. Other model assets remain private.
import { execFileSync } from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding:'utf8' }).split('\0').filter(Boolean);
const artifacts = /\.(bin|pt|pth|ckpt|safetensors|onnx|tflite|mlmodel|mlpackage|gguf|h5|hdf5|pkl|pickle|joblib|npy|npz)$/i;
const privatePaths = /(^|\/)(models|weights|checkpoints|datasets|training|private-models|proprietary|recordings)(\/|$)/i;
const cropper='app/autocrop/model.bin',cropperHash='8b3895b390fd36f8840c988a97fb9ac354ed3d3f2935ea51041834acd821aac3';
if(createHash('sha256').update(readFileSync(cropper)).digest('hex')!==cropperHash)throw Error('Bundled cropper differs from the approved export');
const manifest=JSON.parse(readFileSync('app/autocrop/model.json','utf8'));
if(manifest.approved!==true||manifest.weights_sha256!==cropperHash)throw Error('Bundled cropper release manifest is invalid');
const bad=paths.filter(p=>p!==cropper&&(artifacts.test(p)||privatePaths.test(p)));
if(bad.length) { console.error('Private model or race assets cannot ship in OpenMeet:\n'+bad.join('\n')); process.exitCode=1; }
else console.log(`Public boundary checked: ${paths.length} tracked files; approved local cropper verified; no other model artifacts or private model directories.`);
