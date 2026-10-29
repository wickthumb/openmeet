// Exercise the real utility-process host over Node IPC without Electron dependencies.
process.parentPort = {
  on(_event, callback) { process.on('message', data => callback({ data })); },
  postMessage(message) { process.send(message); },
};
await import('../../engine-host.mjs');
