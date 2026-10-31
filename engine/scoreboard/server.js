import http from 'node:http';
import { watch } from 'node:fs';
import { readdir, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeState } from './state.js';
import { RUNTIME_JS } from './runtime.js';
import { libraryRoot, containedPath, validateName, forbidden } from './paths.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

/** Validate before URL normalization can erase traversal components.
 * @param {string} raw
 */
function requestPath(raw) {
  let value = raw.split('?')[0];
  for (let i = 0; i < 5 && value.includes('%'); i++) {
    try { value = decodeURIComponent(value); } catch { throw forbidden('Malformed URL'); }
  }
  if (value.includes('%') || /[\\:\u0000-\u001f]/.test(value) || !value.startsWith('/')) throw forbidden();
  if (value.split('/').some(part => part.startsWith('.'))) throw forbidden();
  return value;
}

/**
 * A read-only local display server. publish() is the only write path, called by
 * the engine rather than exposed over the network. listen()/close() are async.
 * @param {{root: string, host?: string, port?: number}} options
 */
export function createScoreboardServer({ root, host = '0.0.0.0', port = 0 }) {
  let state = normalizeState(), dir, listening = null, closing = null, closed = false;
  let actualPort = port, scanPromise = null, debounce = null, poll = null, heartbeat = null;
  const clients = new Set(), watchers = new Map(), signatures = new Map();
  const versions = Object.create(null), generation = randomUUID();
  let counter = 0;
  const packet = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  function broadcast(event, data) {
    for (const res of clients) {
      // Disconnect slow consumers instead of buffering unbounded timing updates.
      if (!res.write(packet(event, data))) res.destroy();
    }
  }
  function scheduleScan() {
    clearTimeout(debounce);
    debounce = setTimeout(() => { scan().catch(() => {}); }, 150);
  }
  async function scan() {
    if (closed) return;
    if (scanPromise) return scanPromise;
    scanPromise = (async () => {
      const directories = new Set([dir]), found = new Map();
      async function walk(folder, relative, lines) {
        directories.add(folder);
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const file = path.join(folder, entry.name), rel = relative + '/' + entry.name;
          const st = await lstat(file);
          if (st.isSymbolicLink()) continue;
          lines.push(`${rel}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
          if (st.isDirectory()) await walk(file, rel, lines);
        }
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9-]{1,40}$/.test(entry.name)) continue;
        try {
          const folder = await containedPath(dir, entry.name), lines = [];
          await walk(folder, entry.name, lines);
          found.set(entry.name, lines.join('\n'));
        } catch { /* atomic rename or delete; polling will retry */ }
      }
      if (closed) return;
      let changed = false;
      for (const name of new Set([...signatures.keys(), ...found.keys()])) {
        if (signatures.get(name) !== found.get(name)) {
          versions[name] = `${generation}:${++counter}`;
          changed = true;
        }
      }
      signatures.clear();
      for (const [name, value] of found) signatures.set(name, value);
      for (const [folder, watcher] of watchers) {
        if (!directories.has(folder)) { watcher.close(); watchers.delete(folder); }
      }
      for (const folder of directories) {
        if (watchers.has(folder)) continue;
        try {
          const watcher = watch(folder, scheduleScan);
          watchers.set(folder, watcher);
          watcher.on('error', () => { watcher.close(); watchers.delete(folder); });
        } catch { /* fs.watch unsupported: the poll still works */ }
      }
      if (changed) broadcast('version', versions);
    })().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const pathname = requestPath(req.url || '/');
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      if (pathname === '/scoreboard/feed' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 1000\n\n' + packet('state', state) + packet('version', versions));
        clients.add(res);
        res.on('close', () => clients.delete(res));
        return;
      }
      if (pathname === '/scoreboard/state' || pathname === '/scoreboard/runtime.js') {
        const runtime = pathname.endsWith('runtime.js');
        res.writeHead(200, { 'Content-Type': runtime ? MIME['.js'] : MIME['.json'] });
        res.end(req.method === 'HEAD' ? undefined : runtime ? RUNTIME_JS : JSON.stringify(state));
        return;
      }
      const parts = pathname.split('/');
      if (parts[1] !== 'scoreboard' || !parts[2]) { res.writeHead(404); res.end(); return; }
      validateName(parts[2]);
      const folder = await containedPath(dir, parts[2]);
      if (parts.length === 3) {
        res.writeHead(308, { Location: `/scoreboard/${parts[2]}/` }); res.end(); return;
      }
      const relative = parts.slice(3).join('/') || 'index.html';
      const file = await containedPath(folder, relative);
      // Open after containment checks; reject devices, FIFOs and directories.
      if (!(await lstat(file)).isFile()) throw forbidden();
      const handle = await open(file, 'r');
      try {
        if (req.method === 'HEAD') {
          const stat = await handle.stat();
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
          res.end(); return;
        }
        const bytes = await handle.readFile();
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } finally { await handle.close(); }
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(err.code === 'EACCES' ? 403 : ['ENOENT', 'ENOTDIR'].includes(err.code) ? 404 : 500);
      res.end();
    }
  });

  return {
    listen() {
      if (closed) return Promise.reject(new Error('Scoreboard server is closed'));
      if (listening) return listening;
      listening = (async () => {
        dir = await libraryRoot(root, true);
        await scan();
        await new Promise((resolve, reject) => {
          const onError = err => { server.off('listening', onListen); reject(err); };
          const onListen = () => { server.off('error', onError); resolve(); };
          server.once('error', onError); server.once('listening', onListen);
          server.listen(port, host);
        });
        actualPort = server.address().port;
        poll = setInterval(() => { scan().catch(() => {}); }, 1000);
        heartbeat = setInterval(() => { for (const res of clients) if (!res.write(': heartbeat\n\n')) res.destroy(); }, 15000);
        return { port: actualPort };
      })().catch(err => {
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear(); listening = null; throw err;
      });
      return listening;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try { await listening; } catch { /* listen failed */ }
        clearTimeout(debounce); clearInterval(poll); clearInterval(heartbeat);
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
        await scanPromise;
        for (const res of clients) res.end();
        clients.clear();
        if (server.listening) await new Promise((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
    /** @param {unknown} input */
    publish(input) { state = normalizeState(input); broadcast('state', state); return structuredClone(state); },
    /** The wildcard bind address is exposed as loopback for local windows.
     * @param {string} name
     */
    url(name) {
      validateName(name);
      const address = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      return `http://${address}:${actualPort}/scoreboard/${name}/`;
    },
    get port() { return actualPort; },
  };
}
