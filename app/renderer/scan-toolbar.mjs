// Display controls only. Camera recording and private timing inference stay separate.
export const SCAN_TOOLS = [
  { id:'follow', label:'Follow live', group:'View', help:'Return to the newest columns. Scrolling or panning pauses following.' },
  { id:'zoom', label:'Zoom', group:'View', shortcut:'Shift + drag', help:'Drag a box to inspect it. Zoom only changes the view.' },
  { id:'unzoom', label:'Unzoom', group:'View', shortcut:'Esc', help:'Fit the capture to your camera framing again. Appears while zoomed.' },
  { id:'height', label:'Frame height', group:'View', help:'Drag the top and bottom edges to hide unused vertical space. Saved per camera; Full height restores every row.' },
  { id:'mark', label:'Mark', group:'Marking', shortcut:'Enter', help:'Create or replace the selected athlete’s finish at the selected column.' },
  { id:'delete', label:'Delete mark', group:'Marking', shortcut:'Delete', help:'Remove the selected finish. The original recording is retained.' },
  { id:'flip', label:'Flip', group:'View', help:'Mirror the scan. Column timestamps and results stay the same.' },
  { id:'lanes', label:'Lanes', group:'View', help:'Show and style lane overlays. Left-column dividers are always draggable.' },
  { id:'auto', label:'Auto timing', group:'Timing', help:'Turn automatic suggestions on or off, or request suggestions now.' },
  { id:'hideEmpty', label:'Hide empty spans', group:'View', help:'Hide empty time spans using the private cropper. Original columns remain stored; breaks mark skipped time.' },
  { id:'autoRun', label:'Auto-mark', group:'Timing', help:'Request finish suggestions now for the captured race.' },
  { id:'clear', label:'Clear marks', group:'Results', help:'Remove all finish marks in this heat. Race statuses stay.' },
  { id:'revert', label:'Revert', group:'Results', help:'Restore the last saved results, or the state when capture stopped.' },
];
const DEFAULT_PINS = ['follow','zoom','unzoom','mark','lanes','auto'];
export function toolbarPreferences(saved) {
  const ids=SCAN_TOOLS.map(t=>t.id),known=new Set(ids);
  const order=[...new Set([...(Array.isArray(saved?.order)?saved.order:[]),...ids])].filter(id=>known.has(id));
  const pinned=Array.isArray(saved?.pinned)?[...new Set(saved.pinned)].filter(id=>known.has(id)):[...DEFAULT_PINS];
  return {version:1,order,pinned};
}
export function moveToolbarTool(preferences,id,delta) {
  const next=toolbarPreferences(preferences),from=next.order.indexOf(id),to=from+delta;
  if(from>=0&&to>=0&&to<next.order.length)[next.order[from],next.order[to]]=[next.order[to],next.order[from]];
  return next;
}
