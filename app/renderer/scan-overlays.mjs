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

// The initial empty-track columns establish a robust per-row reference and noise tolerance.
export function scanBackground(image, sample = 24) {
  const n = Math.min(sample, image.width), values = new Array(n);
  const colors = new Uint8Array(image.height * 3), tolerance = new Uint8Array(image.height);
  for (let y = 0; y < image.height; y++) {
    let noise = 0;
    for (let c = 0; c < 3; c++) {
      for (let x = 0; x < n; x++) values[x] = image.data[pixelIndex(image, x, y) + (image.channels < 3 ? 0 : c)];
      values.sort((a, b) => a - b);
      const median = values[n >> 1]; colors[y * 3 + c] = median;
      for (let x = 0; x < n; x++) values[x] = Math.abs(values[x] - median);
      values.sort((a, b) => a - b); noise = Math.max(noise, values[n >> 1]);
    }
    tolerance[y] = Math.max(18, Math.min(64, noise * 6));
  }
  return { colors, tolerance };
}

// A compact display mask (one bit per native pixel); original image bytes are never modified.
export function writeForegroundMask(target, columnOffset, image, background) {
  for (let x = 0; x < image.width; x++) for (let y = 0; y < image.height; y++) {
    const src = pixelIndex(image, x, y), ref = y * 3, bit = (columnOffset + x) * image.height + y;
    let changed = false;
    for (let c = 0; c < 3; c++) {
      if (Math.abs(image.data[src + (image.channels < 3 ? 0 : c)] - background.colors[ref + c]) > background.tolerance[y]) changed = true;
    }
    if (changed) target[bit >> 3] |= 1 << (bit & 7);
    else target[bit >> 3] &= ~(1 << (bit & 7));
  }
}

export function foregroundInRows(mask, column, height, firstRow, lastRow) {
  if (!mask || column < 0) return false;
  for (let y = Math.max(0, firstRow); y <= Math.min(height - 1, lastRow); y++) {
    const bit = column * height + y;
    if (mask[bit >> 3] & (1 << (bit & 7))) return true;
  }
  return false;
}
