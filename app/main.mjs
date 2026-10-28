// OpenMeet main process: one window (the console) and one utility process (the engine).
// The engine owns files and timing; a renderer crash or reload never touches it.
import { app, BrowserWindow, ipcMain, dialog, protocol, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

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
  // omfile:// serves files under opened folders, with byte ranges so recordings seek frame-exact.
  protocol.handle('omfile', async req => {
    const abs = path.resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)));
    const ok = [...roots].some(r => abs === r || abs.startsWith(r + path.sep));
    if (!ok) return new Response('forbidden', { status: 403 });
    let st;
    try { st = await fs.promises.stat(abs); } catch { return new Response('not found', { status: 404 }); }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      let end = m[1] && m[2] ? +m[2] : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(abs)), { headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' } });
  });
  ipcMain.handle('om:call', (_e, method, params) => callEngine(method, params));
  ipcMain.handle('om:pickFile', async (_e, title, kind) => {
    const filters = kind === 'image' ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'] }] : [];
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose file', properties: ['openFile'], filters });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  // Scoreboard output: its own window on the local scoreboard server, for a second display, screen share or OBS capture.
  const boards = new Map();
  ipcMain.handle('om:openBoard', (_e, url, title) => {
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !u.pathname.startsWith('/scoreboard/')) throw new Error('not a scoreboard URL');
    const existing = boards.get(u.pathname);
    if (existing && !existing.isDestroyed()) { existing.loadURL(url); existing.focus(); return true; }
    const b = new BrowserWindow({ width: 1280, height: 720, backgroundColor: '#000000', title: title || 'OpenMeet Scoreboard', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    b.loadURL(url);
    boards.set(u.pathname, b);
    return true;
  });
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
