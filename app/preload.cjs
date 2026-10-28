// The only bridge between the console (renderer) and the rest of OpenMeet.
// The renderer gets no Node access: it calls engine methods by name and listens for engine events.
const { contextBridge, ipcRenderer } = require('electron');
const subscriptions = new Map();
ipcRenderer.on('om:event', (_e, name, data) => {
  for (const cb of [...(subscriptions.get(name) || [])]) cb(data);
});

contextBridge.exposeInMainWorld('openmeet', {
  /** Call an engine method; resolves with its result or rejects with its error message. */
  call: (method, params) => ipcRenderer.invoke('om:call', method, params),
  /** Subscribe to an engine event; returns an unsubscribe function. */
  on: (event, cb) => {
    const callbacks = subscriptions.get(event) || new Set();
    const handler = data => cb(data);
    callbacks.add(handler);
    subscriptions.set(event, callbacks);
    return () => {
      callbacks.delete(handler);
      if (!callbacks.size) subscriptions.delete(event);
    };
  },
  /** Native folder picker; resolves with an absolute path or null. */
  pickFolder: title => ipcRenderer.invoke('om:pickFolder', title),
  /** Native file picker (kind 'image' filters to images); resolves with an absolute path or null. */
  pickFile: (title, kind) => ipcRenderer.invoke('om:pickFile', title, kind),
  /** Open a scoreboard (local scoreboard server URL) in its own window. */
  openBoard: (url, title) => ipcRenderer.invoke('om:openBoard', url, title),
  /** URL the renderer can load (img, video) for a file under a folder the user opened. */
  fileUrl: absPath => 'omfile://local/' + encodeURIComponent(absPath),
  platform: process.platform,
});
