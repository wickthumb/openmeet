export function sourceLabel(source) {
  if (source?.type === 'real') return `REAL MEET REPLAY · ${source.name}`;
  if (source?.type === 'ttp') return `TTP simulator · ${source.name}`;
  return 'Simple built-in';
}

export function sourceChoices(catalog) {
  const sources = catalog?.sources || [{ id: 'builtin', type: 'builtin', name: 'Simple built-in', path: null }];
  const choices = sources.map(s => ({ value: s.id, label: sourceLabel(s) }));
  if (!sources.some(s => s.type === 'ttp')) choices.push({ value: 'import:ttp', label: 'TTP simulator · Import folder…' });
  if (!sources.some(s => s.type === 'real')) choices.push({ value: 'import:real', label: 'REAL MEET REPLAY · Import folder…' });
  return choices;
}

export function replayCameras(h) {
  const folder = !!(h.asset || h.replaySourceType);
  return { folder, primary: !folder || !!h.asset?.primary,
    comparison: !folder || !!h.asset?.backup, front: !folder || !!(h.frontRec?.path || h.asset?.front) };
}

export const replayHeatKey = h => `${h.event ?? h.ev}|${h.round ?? h.rd}|${h.heat ?? h.ht}`;

export function replayReferenceTiming(h) {
  return !!h.asset?.lineScans?.find(s=>s.png===h.asset.primary)?.referenceTiming;
}

// Finish API v1 accepts 0 as an absent competitor ID. Never turn null into a bib.
export const replayStartList = athletes => athletes.map(a=>({lane:a.lane,id:a.id==null||a.id===''?0:String(a.id)}));
