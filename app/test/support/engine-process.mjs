// Exercise the real utility-process host over Node IPC without Electron dependencies.
process.parentPort = {
  on(event, callback) {
    if(event==='message')process.on('message',data=>callback({data}));
    else if(event==='close')process.on('disconnect',callback);
  },
  postMessage(message) { process.send(message); },
};
await import('../../engine-host.mjs');
