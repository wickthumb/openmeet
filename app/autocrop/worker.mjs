import {parentPort,workerData} from 'node:worker_threads';
import {loadModel} from './model.mjs';
import {cropImage} from './network.mjs';
try {
  const model=await loadModel(),result=cropImage(workerData.image,model);
  parentPort.postMessage({result,model:{id:model.id,sha256:model.weights_sha256},runtime:'native-cpu'});
}catch(error){parentPort.postMessage({error:error.message});}
