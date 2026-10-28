// Served verbatim to browsers; also exported as a string for dependency-free use.
export const RUNTIME_JS = `(() => {
  'use strict';
  const callbacks = new Set();
  let current = null;
  let version;
  const match = location.pathname.match(/^\\/scoreboard\\/([^/]+)/);
  const name = match ? decodeURIComponent(match[1]) : '';
  function raceTime(state) {
    const clock = state && state.clock || {};
    if (clock.running && Number.isFinite(clock.startedAtMs)) {
      return Math.max(0, (Date.now() - clock.startedAtMs) / 1000 * (Number.isFinite(clock.speed) ? Math.max(0, clock.speed) : 1));
    }
    return Number.isFinite(clock.frozenS) ? Math.max(0, clock.frozenS) : 0;
  }
  function deliver(cb) {
    try { cb(current); } catch (error) { console.error('Scoreboard onData callback:', error); }
  }
  window.OpenMeetScoreboard = Object.freeze({
    onData(cb) {
      if (typeof cb !== 'function') throw new TypeError('onData requires a callback');
      callbacks.add(cb);
      if (current !== null) deliver(cb);
      return () => callbacks.delete(cb);
    },
    raceTime,
  });
  // EventSource reconnects automatically. Every connection receives the current
  // state first, so a disconnected display catches up without replaying a log.
  const feed = new EventSource('/scoreboard/feed');
  feed.addEventListener('state', event => {
    try { current = JSON.parse(event.data); } catch { return; }
    for (const cb of callbacks) deliver(cb);
  });
  feed.addEventListener('version', event => {
    let versions;
    try { versions = JSON.parse(event.data); } catch { return; }
    const next = versions[name] || null;
    if (version !== undefined && next !== version) location.reload();
    version = next;
  });
  addEventListener('pagehide', () => feed.close(), { once: true });
})();`;
