// Display geometry and background subtraction only; no timing or identity model.
export function scanBoundaries(bands, style, height) {
  const ordered = [...bands].sort((a, b) => a.top - b.top);
  if (!ordered.length) return [];
  const edge = (above, below) => {
    const a = above && (style.positions?.[above.lane] || above);
    const b = below && (style.positions?.[below.lane] || below);
    const key = above && below ? `${above.lane}:${below.lane}` : above ? `${above.lane}:bottom` : `top:${below.lane}`;
    const fallback = a && b ? (a.bottom + b.top) / 2 : a ? a.bottom : b.top;
    return { key, above: above?.lane ?? null, below: below?.lane ?? null, row: style.boundaries?.[key] ?? fallback };
  };
  const result = [edge(null, ordered[0]), ...ordered.map((band, i) => edge(band, ordered[i + 1]))];
  // Preserve spatial order, including old profiles whose independently moved bands overlapped.
  result.forEach((b, i) => {
    const row = Number.isFinite(b.row) ? b.row : i;
    b.row = Math.max(i ? result[i - 1].row + 1 : 0, Math.min(height - result.length + i, row));
  });
  return result;
}

export function movedBoundaryRow(boundaries, index, row, height) {
  return Math.max(index ? boundaries[index - 1].row + 1 : 0,
    Math.min(index + 1 < boundaries.length ? boundaries[index + 1].row - 1 : height - 1, row));
}

const pixelIndex = (image, x, y) => (image.layout === 'rows' ? y * image.width + x : x * image.height + y) * image.channels;

// The caller supplies empty pre-roll. Keep the reference fixed: adapting it to
// foreground would eventually burn stationary/slow objects into the background.
export function scanBackground(image, sample = 24) {
  const n = Math.max(0, Math.min(Math.floor(sample), image.width));
  const values = new Array(n), colors = new Uint8Array(image.height * 3);
  const tolerance = new Uint8Array(image.height);
  for (let y = 0; y < image.height; y++) {
    let noise = 0;
    for (let c = 0; c < 3; c++) {
      for (let x = 0; x < n; x++) values[x] = image.data[pixelIndex(image, x, y) + (image.channels < 3 ? 0 : c)];
      values.sort((a, b) => a - b);
      const median = n ? values[n >> 1] : 0; colors[y * 3 + c] = median;
      for (let x = 0; x < n; x++) values[x] = Math.abs(values[x] - median);
      values.sort((a, b) => a - b);
      if (n) noise = Math.max(noise, values[n >> 1]);
    }
    tolerance[y] = Math.max(18, Math.min(64, noise * 6));
  }
  return { colors, tolerance };
}

// Bounded one-column lookahead. The newest column is provisional; the next call
// may refine it, even when it belongs to the preceding target tile. Retain only
// three fixed column buffers and one caller-owned target, never source bytes.
function streamState(background, height) {
  let state = background._foreground;
  if (!state || state.height !== height) {
    state = background._foreground = {
      height, hist: new Uint32Array(511), offsets: new Int16Array(3),
      columns: Array.from({ length: 3 }, () => ({
        weak: new Uint8Array(height), strong: new Uint8Array(height),
        keep: new Uint8Array(height), seed: new Uint8Array(height),
        delta: new Int16Array(height * 3)
      })), left: null, pending: null, next: 0, target: null, offset: 0
    };
  }
  return state;
}

function evidence(image, x, background, state, out) {
  const h = image.height, colors = background.colors, hist = state.hist;
  // A median signed RGB residual estimates per-column exposure/colour drift.
  // This resists sparse foreground and spikes without learning noise from pre-roll.
  for (let c = 0; c < 3; c++) {
    hist.fill(0);
    for (let y = 0; y < h; y++) {
      const v = image.data[pixelIndex(image, x, y) + (image.channels < 3 ? 0 : c)];
      hist[v - colors[y * 3 + c] + 255]++;
    }
    let count = 0, i = 0;
    for (; i < 510; i++) { count += hist[i]; if (count > (h >> 1)) break; }
    state.offsets[c] = i - 255;
  }
  for (let y = 0; y < h; y++) {
    const src = pixelIndex(image, x, y), ref = y * 3;
    const r = image.data[src] - state.offsets[0];
    const g = image.data[src + (image.channels < 3 ? 0 : 1)] - state.offsets[1];
    const b = image.data[src + (image.channels < 3 ? 0 : 2)] - state.offsets[2];
    const R = colors[ref], G = colors[ref + 1], B = colors[ref + 2];
    const delta = Math.max(Math.abs(r - R), Math.abs(g - G), Math.abs(b - B));
    const tolerance = background.tolerance[y];
    out.delta[ref] = r - R; out.delta[ref + 1] = g - G; out.delta[ref + 2] = b - B;
    out.weak[y] = delta > Math.max(7, tolerance / 2);
    // A neutral attenuation is evidence of shadow, not a foreground seed.
    // Leave it weak so an attached, otherwise visible limb/garment can survive.
    const norm = R * R + G * G + B * B;
    const gain = norm ? (r * R + g * G + b * B) / norm : 1;
    const chroma = Math.max(Math.abs(r - gain * R), Math.abs(g - gain * G), Math.abs(b - gain * B));
    const shadow = gain >= 0.55 && gain < 1 && chroma <= 7;
    out.strong[y] = delta > tolerance && !shadow;
  }
  // A five-row residual mean recovers low-contrast fabric through independent
  // noise. Require some evidence at the pixel itself to avoid expanding a clean
  // contour onto unchanged background. The spatial radius is only two rows.
  for (let y = 2; y + 2 < h; y++) {
    if (out.weak[y] || Math.max(Math.abs(out.delta[y * 3]), Math.abs(out.delta[y * 3 + 1]), Math.abs(out.delta[y * 3 + 2])) <= 4) continue;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let j = y - 2; j <= y + 2; j++) sum += out.delta[j * 3 + c];
      if (Math.abs(sum) > Math.max(6, background.tolerance[y] / 3) * 5) out.weak[y] = 1;
    }
  }
}

function resolve(column, left, right, height, tolerance) {
  const weak = column.weak, strong = column.strong, keep = column.keep, seed = column.seed;
  keep.fill(0); seed.fill(0);
  const line = (a, ay, b, by, c, cy, threshold) => {
    if (!a || !b || !c || ay < 0 || ay >= height || by < 0 || by >= height || cy < 0 || cy >= height) return false;
    if (!a.strong[ay] || !b.strong[by] || !c.strong[cy]) return false;
    for (let ch = 0; ch < 3; ch++) {
      if (Math.abs(a.delta[ay * 3 + ch] + b.delta[by * 3 + ch] + c.delta[cy * 3 + ch]) > threshold * 3) return true;
    }
    return false;
  };
  for (let y = 0; y < height; y++) {
    if (!strong[y]) continue;
    const threshold = tolerance[y];
    seed[y] = line(column, y - 1, column, y, column, y + 1, threshold)
      || line(left, y, column, y, right, y, threshold)
      || line(left, y - 1, column, y, right, y + 1, threshold)
      || line(left, y + 1, column, y, right, y - 1, threshold);
    // Rasterized one-pixel limbs form staircases rather than exact straight
    // diagonals. Require coherent support on both sides within one row.
    if (!seed[y]) for (let a = y - 1; a <= y + 1 && !seed[y]; a++) {
      for (let b = y - 1; b <= y + 1 && !seed[y]; b++) seed[y] = line(left, a, column, y, right, b, threshold);
    }
    // A high-contrast vertical pair also supports small two-pixel details.
    if (!seed[y]) for (const j of [y - 1, y + 1]) {
      if (j < 0 || j >= height || !strong[j]) continue;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(column.delta[y * 3 + c] + column.delta[j * 3 + c]) > 120) seed[y] = 1;
      }
    }
  }
  // Vertical weak components retain attached low-contrast clothing and limbs.
  // Only a local seed (or the preceding column's seed) can accept a component;
  // accepted weak noise cannot propagate indefinitely through the stream.
  for (let y = 0; y < height;) {
    if (!weak[y]) { y++; continue; }
    const first = y;
    let supported = false;
    while (y < height && weak[y]) { supported ||= !!seed[y] || !!left?.seed[y]; y++; }
    if (supported) keep.fill(1, first, y);
  }
}

function writeColumn(target, offset, column, height) {
  for (let y = 0; y < height; y++) {
    const bit = offset * height + y, flag = 1 << (bit & 7);
    if (column.keep[y]) target[bit >> 3] |= flag;
    else target[bit >> 3] &= ~flag;
  }
}

// Display-only column-major bitmask. Use a fresh background for each stream or
// replay; consecutive calls may switch target tiles and reset columnOffset.
// Alpha is ignored. Input bytes and the fixed background reference are unchanged.
export function writeForegroundMask(target, columnOffset, image, background) {
  const state = streamState(background, image.height), h = image.height;
  // Rewriting the same target from a different position starts a replay.
  if (state.target === target && columnOffset !== state.offset + 1) {
    state.left = state.pending = null;
  }
  for (let x = 0; x < image.width; x++) {
    const current = state.columns[state.next];
    state.next = (state.next + 1) % 3;
    evidence(image, x, background, state, current);
    if (state.pending) {
      resolve(state.pending, state.left, current, h, background.tolerance);
      writeColumn(state.target, state.offset, state.pending, h);
    }
    resolve(current, state.pending, null, h, background.tolerance);
    writeColumn(target, columnOffset + x, current, h);
    state.left = state.pending;
    state.pending = current;
    state.target = target;
    state.offset = columnOffset + x;
  }
}

export function foregroundInRows(mask, column, height, firstRow, lastRow) {
  if (!mask || column < 0) return false;
  const lo=Math.max(0,firstRow),hi=Math.min(height-1,lastRow);
  if(hi<lo)return false;
  const first=column*height+lo,last=column*height+hi,a=first>>3,b=last>>3;
  const start=255<<(first&7),end=255>>>(7-(last&7));
  if(a===b)return !!(mask[a]&start&end);
  if((mask[a]&start)||(mask[b]&end))return true;
  // Whole bytes skip empty native rows without a per-pixel query.
  for(let i=a+1;i<b;i++)if(mask[i])return true;
  return false;
}
