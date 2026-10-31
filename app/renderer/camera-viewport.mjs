import { linkedCameraRange } from './front-preview.mjs';

const close = (a, b) => Math.abs(a - b) < 1e-7;
// Project every switch from the last operator-selected viewport. Reprojecting an
// already projected crop accumulates perspective/padding errors on each A/B swap.
export function switchCameraViewport(previous, view, height, from, to) {
  const span = height / view.zy;
  const last = previous?.last;
  const unchanged = last && last.id === from.id && close(last.top, view.r0) && close(last.span, span)
    && last.focusLane === view.focusLane && close(last.frameTop, from.top) && close(last.frameBottom, from.bottom);
  const anchor = unchanged ? previous.anchor : {
    source: structuredClone(from), top: view.r0, span, focusLane: view.focusLane,
    fullHeight: span >= from.bottom - from.top - 0.5,
  };
  let top = to.top, targetSpan = to.bottom - to.top;
  if (!anchor.fullHeight) {
    if (anchor.source.id === to.id) { top = anchor.top; targetSpan = anchor.span; }
    else {
      const mapped = linkedCameraRange({ c0: 0, zx: 1, r0: anchor.top, zy: 1 / anchor.span, focusLane: anchor.focusLane }, {
        rows: anchor.source.rows, height: 1, width: 1, period: 1, timeOrigin: 0, otherWidth: 1,
        otherRows: to.rows, mainLanes: anchor.source.lanes, otherLanes: to.lanes,
      });
      top = mapped.r0 * to.rows; targetSpan = mapped.rv * to.rows;
    }
    targetSpan = Math.min(to.bottom - to.top, Math.max(1, targetSpan));
    top = Math.max(to.top, Math.min(to.bottom - targetSpan, top));
  }
  return { r0: top, zy: height / targetSpan, state: { anchor,
    last: { id: to.id, top, span: targetSpan, focusLane: view.focusLane, frameTop: to.top, frameBottom: to.bottom } } };
}
