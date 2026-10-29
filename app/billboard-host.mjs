// Separate from the scoreboard service and library; no timing-state publication.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
export async function registerBillboards({methods,userData,emit,port,enginePath}) {
  const api=await import(pathToFileURL(enginePath).href),root=path.join(userData,'billboards'),agents=new Set();
  Object.assign(methods, {
    'billboard.list':()=>api.listBillboards(root),
    'billboard.create':({name,from})=>api.createBillboard(root,name,{from}),
    'billboard.read':({name,asset})=>api.readBillboard(root,name,asset),
    'billboard.importSvg':({name,path:source})=>api.importBillboardSvg(root,name,source),
    'billboard.addAsset':({name,path:source})=>api.addBillboardAsset(root,name,source),
    'billboard.restore':({name,snapshotId})=>api.restoreBillboard(root,name,snapshotId),
    'billboard.delete':({name})=>api.deleteBillboard(root,name),
    async 'billboard.agent'({name,request,preset='muse'}) {
      if(!Object.hasOwn(api.AGENT_PRESETS,preset))throw Error(`Unknown billboard agent preset: ${preset}`);
      const agent={...api.AGENT_PRESETS[preset]};
      const onPath=(process.env.PATH||'').split(path.delimiter).some(d=>d&&fs.existsSync(path.join(d,agent.command)));
      const local=path.join(os.homedir(),'.local','bin',agent.command);
      if(!onPath&&process.platform!=='win32'&&fs.existsSync(local))agent.command=local;
      const controller=new AbortController();agents.add(controller);
      try {return await api.runBillboardAgent({root,name,request,agent,signal:controller.signal,onOutput:output=>emit('billboard.agentOutput',{name,...output})});}
      finally {agents.delete(controller);}
    },
  });
  const close=()=>{for(const controller of agents)controller.abort();};
  port.on('close',close);process.once('disconnect',close);process.once('exit',close);
}
