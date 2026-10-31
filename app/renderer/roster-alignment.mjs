// Match sidebar rows to the displayed lane boundaries, in CSS pixels. Never
// hide an athlete to make a cropped or undersized view appear to fit.
export function rosterLaneLayout({ athletes, boundaries, rowOrigin, rowScale,
  scanHeight, scanTop, listTop, listHeight, rowHeights = new Map(), unlaned = false }) {
  const unavailable = reason => ({ aligned: false, reason, rows: [] });
  if (unlaned) return unavailable('Available for lane races.');
  if (!athletes.length || boundaries.length < 2) return unavailable('Lane assignments are needed.');
  if (![rowOrigin, rowScale, scanHeight, scanTop, listTop, listHeight].every(Number.isFinite)
      || rowScale <= 0 || scanHeight <= 0 || listHeight <= 0) {
    return unavailable('Waiting for the line-scan view.');
  }
  const bands = new Map();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lane = boundaries[i].below;
    const top = (boundaries[i].row - rowOrigin) * rowScale;
    const bottom = (boundaries[i + 1].row - rowOrigin) * rowScale;
    if (lane == null || bands.has(lane) || ![top, bottom].every(Number.isFinite) || bottom <= top) {
      return unavailable('Lane assignments must match the line-scan.');
    }
    if (top < -0.5 || bottom > scanHeight + 0.5) return unavailable('Show all lanes to align the list.');
    bands.set(lane, { lane, top: scanTop - listTop + Math.max(0, top), height: Math.min(scanHeight, bottom) - Math.max(0, top) });
  }
  const rows = [], seen = new Set();
  for (const athlete of athletes) {
    const band = bands.get(athlete.lane);
    if (!band || seen.has(athlete.lane)) return unavailable('Lane assignments must match the line-scan.');
    seen.add(athlete.lane);
    if (band.top < -0.5 || band.top + band.height > listHeight + 0.5) {
      return unavailable('More space is needed below the race controls.');
    }
    if (band.height + 0.5 < (rowHeights.get(athlete.lane) || 0)) {
      return unavailable('Athlete row does not fit its lane.');
    }
    rows.push(band);
  }
  return { aligned: true, reason: 'Aligned with line-scan lanes.', rows };
}
