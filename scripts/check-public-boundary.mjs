// Public release boundary: proprietary inference stays in separately deployed services.
import { execFileSync } from 'node:child_process';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding:'utf8' }).split('\0').filter(Boolean);
const artifacts = /\.(pt|pth|ckpt|safetensors|onnx|tflite|mlmodel|mlpackage|gguf|h5|hdf5|pkl|pickle|joblib|npy|npz)$/i;
const privatePaths = /(^|\/)(models|weights|checkpoints|datasets|training|private-models|proprietary|recordings)(\/|$)/i;
const bad=paths.filter(p=>artifacts.test(p)||privatePaths.test(p));
if(bad.length) { console.error('Private model or race assets cannot ship in OpenMeet:\n'+bad.join('\n')); process.exitCode=1; }
else console.log(`Public boundary checked: ${paths.length} tracked files; no model artifacts or private model directories.`);
