// Observe real host resources without adding production debugging endpoints.
import fs from 'node:fs';
import {Server} from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
let columnStoreOpens=0;
const open=fs.openSync;
fs.openSync=function(file,...args){if(String(file).endsWith('columns.bin'))columnStoreOpens++;return open.call(this,file,...args);};
syncBuiltinESMExports();
process.parentPort={
  on(event,callback){
    if(event==='message')process.on('message',data=>{
      if(data.method==='audit.metrics')process.send({id:data.id,result:{columnStoreOpens,listeningServers:process._getActiveHandles().filter(handle=>handle instanceof Server&&handle.listening).length}});
      else callback({data});
    });
    else if(event==='close')process.on('disconnect',callback);
  },
  postMessage(message){process.send(message);},
};
await import('../../engine-host.mjs');
