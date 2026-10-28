// OpenMeet main process: one window (the console) and one utility process (the engine).
// The engine owns files and timing; a renderer crash or reload never touches it.
import { app, BrowserWindow, ipcMain, dialog, protocol, net, utilityProcess } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let engine = null;
let nextId = 1;
const pending = new Map();
// Folders the renderer may load files from through omfile:// (only ones the user picked or the engine opened).
const roots = new Set();

protocol.registerSchemesAsPrivileged([
  { scheme: 'omfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function startEngine() {
  engine = utilityProcess.fork(path.join(here, 'engine-host.mjs'), [app.getPath('userData')], {
    serviceName: 'OpenMeet Engine',
    stdio: 'inherit',
  });
  engine.on('message', msg => {
    if (msg && msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
    } else if (msg && msg.event) {
      if (msg.event === 'roots.add') { (msg.data || []).forEach(r => roots.add(path.resolve(r))); return; }
      win?.webContents.send('om:event', msg.event, msg.data);
    }
  });
  engine.on('exit', code => {
    for (const { reject } of pending.values()) reject(new Error('engine restarted'));
    pending.clear();
    win?.webContents.send('om:event', 'engine.exit', { code });
    if (!app.isQuitting) setTimeout(startEngine, 500);
  });
}

function callEngine(method, params) {
  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('engine not running'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    engine.postMessage({ id, method, params });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#081022',
    title: 'OpenMeet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  // A crashed console reloads; the engine and its capture keep running.
  win.webContents.on('render-process-gone', () => setTimeout(() => win && !win.isDestroyed() && win.reload(), 300));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  protocol.handle('omfile', req => {
    const abs = path.resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)));
    const ok = [...roots].some(r => abs === r || abs.startsWith(r + path.sep));
    if (!ok) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });
  ipcMain.handle('om:call', (_e, method, params) => callEngine(method, params));
  ipcMain.handle('om:pickFolder', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    roots.add(path.resolve(r.filePaths[0]));
    return r.filePaths[0];
  });
  startEngine();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('before-quit', () => { app.isQuitting = true; engine?.kill(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
