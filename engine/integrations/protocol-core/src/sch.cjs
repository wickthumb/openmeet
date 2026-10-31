'use strict';
// Original implementation of source-informed SCH-v1 bounded requirements.
const {extract} = require('./ppl.cjs');
const copy = x => structuredClone(x);
const empty = () => ({event:'', round:'', heat:''});
const equal = (a,b) => ['event','round','heat'].every(k => a[k] === b[k]);
const identity = k => [k.event,k.round,k.heat].join('|');
function required(map, key) {
  if (!map || !Object.hasOwn(map,key)) throw new Error('Unsupported missing provider: '+key);
  return map[key];
}
function resolvedBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error('Unsupported unresolved '+name);
  return value;
}
function records(text) {
  if (typeof text !== 'string' || /[^\x00-\x7f]/.test(text) || /\r(?!\n)/.test(text))
    throw new Error('Unsupported decoded text');
  return text.split(/\r?\n/).filter(s => s !== '' && !s.startsWith(';')).map(s => {
    const f = extract(s).slice(0,3).map(x=>x.trim());
    return {event:f[0],round:f[1] || '1',heat:f[2] || '1'};
  }).filter(k=>k.event !== '');
}
// source() performs database preflight and returns fresh resolved existence/text observations.
function select({cursor,direction}, providers) {
  if (![1,-1,0].includes(direction)) throw new Error('Unsupported direction');
  const s = providers.source();
  const source = resolvedBoolean(s.schExists,'SCH existence') ? 'SCH' :
    resolvedBoolean(s.evtExists,'EVT existence') ? 'EVT' : null;
  const out = {source,cursor:copy(cursor),selected:null,selectedIndex:null,reason:'none'};
  if (direction === 0) return out;
  if (source === null) {out.reason='no-sch-or-evt';return out;}
  const list = records(source === 'SCH' ? s.schText : s.evtText);
  const match = list.findIndex(k=>equal(k,cursor));
  const index = match < 0 ? (direction === 1 ? 0 : list.length-1) : match+direction;
  if (!list.length || index < 0 || index >= list.length) {
    out.cursor=empty();out.reason=list.length ? 'matched-endpoint' : 'empty';return out;
  }
  out.cursor=copy(list[index]);out.selected=copy(list[index]);out.selectedIndex=index;out.reason='selected';
  return out;
}
function loadSchedule(state, providers) {
  const saved = {cursor:copy(state.cursor),messageFlag:state.messageFlag,importFlag:state.importFlag};
  state.cachedList=[];state.cursor=empty();state.messageFlag=false;state.importFlag=false;
  const target=providers.createTemporary();
  let selectorCalls=0,source=null,beeps=0,prior,reason;
  for (;;) {
    if (resolvedBoolean(providers.interrupted(state.cachedList.length),'interruption')) {reason='cooperative-cancel';break;}
    const r=select({cursor:state.cursor,direction:1},providers);selectorCalls++;source=r.source;state.cursor=r.cursor;
    if (!r.selected) {reason='selector-ended';break;}
    const metadata=providers.metadata(r.selected,target);
    if (resolvedBoolean(providers.recursionCheck,'recursionCheck')) {
      const position=providers.position(r.selectedIndex,r.source);
      if (!Number.isFinite(position)) throw new Error('Unsupported position sample');
      if (prior !== undefined && position <= prior) {providers.beep();beeps++;reason='nonincreasing-position';break;}
      prior=position;
    }
    if (typeof metadata.name !== 'string') throw new Error('Unsupported metadata name');
    state.cachedList.push({key:copy(r.selected),name:metadata.name});
  }
  Object.assign(state,saved);providers.disposeTemporary(target);
  return {...copy(state),returnedTrue:true,reason,beeps,selectorCalls,source};
}
function refreshDialog(controls,list) {
  let selectedIndex=-1;
  list.forEach((item,i)=>{if(equal(controls,item.key))selectedIndex=i;});
  return {controls:copy(controls),list:copy(list),selectedIndex};
}
function selectDialogItem(dialog,index) {
  if (!Number.isInteger(index) || !dialog.list[index]) throw new Error('Unsupported list index');
  return {...copy(dialog),controls:copy(dialog.list[index].key),selectedIndex:index};
}
function loadDialog(state,controls,providers) {
  const result=loadSchedule(state,providers);
  return {result,dialog:refreshDialog(controls,state.cachedList)};
}
function control(input,providers) {
  const out={returnedWindow:null,windows:copy(input.windows),cursor:copy(input.cursor),closed:[],saves:[],selectionReads:0,imports:0,activationCalls:0,reason:''};
  const finish=reason=>{out.reason=reason;return out;};
  if (!['Next','Previous','GoTo'].includes(input.action)) throw new Error('Unsupported action');
  const existing=input.existingWindowToken === null ? null : out.windows.find(w=>w.token===input.existingWindowToken);
  if (input.existingWindowToken !== null && !existing) throw new Error('Unsupported missing existing window');
  if (existing && existing.dirty && !resolvedBoolean(providers.confirmDirty(existing),'dirty confirmation'))
    return finish('dirty-confirmation-veto');
  if (!existing && resolvedBoolean(input.singleEvent,'SingleEvent')) {
    while(out.windows.length) {
      const w=out.windows[0];
      if(w.dirty) {
        const choice=providers.closeChoice(w);
        if(!['Yes','No','Cancel'].includes(choice))throw new Error('Unsupported close choice');
        if(choice==='Cancel')return finish('close-veto');
        if(choice==='Yes') {
          out.saves.push(w.token);const status=providers.save(w);
          if(!Number.isInteger(status))throw new Error('Unsupported save status');
          if(status!==0)return finish('save-veto');
        }
      }
      out.closed.push(w.token);out.windows.shift();
    }
  }
  let key;
  if(input.action==='GoTo') {
    const dialog=providers.dialog(copy(out.cursor));
    if(!resolvedBoolean(dialog.accepted,'dialog acceptance')) {
      out.returnedWindow=existing ? existing.token : null;return finish('dialog-cancel');
    }
    key=copy(dialog.key);
  } else {
    out.selectionReads++;
    const selected=select({cursor:out.cursor,direction:input.action==='Next'?1:-1},providers);
    out.cursor=selected.cursor;if(!selected.selected)return finish(selected.reason);key=selected.selected;
  }
  out.imports++;
  const imported=providers.importEvent(copy(key),existing ? copy(existing) : null);
  if(imported===null)return finish('evt-import-failed');
  if(!Array.isArray(imported.rows))throw new Error('Unsupported imported rows');
  out.cursor=copy(key);
  if(existing) {
    existing.key=copy(key);existing.rows=copy(imported.rows);out.returnedWindow=existing.token;
    return finish('imported-in-place');
  }
  const fresh=providers.createWindow(key,imported);
  if(typeof fresh.token!=='string'||typeof fresh.eventToken!=='string')throw new Error('Unsupported fresh tokens');
  const w={token:fresh.token,eventToken:fresh.eventToken,key:copy(key),dirty:false,rows:copy(imported.rows)};
  out.windows.push(w);out.returnedWindow=w.token;out.activationCalls++;providers.activate(copy(w));
  return finish('new-child-imported');
}
// Explicit finite adapter; callbacks can replace each provider for real composition.
function finiteProviders(input,packet) {
  const p={...packet,...input};
  return {
    source:()=>({schExists:p.schExists,evtExists:p.evtExists,schText:p.schText,evtText:p.evtText}),
    confirmDirty:()=>p.dirtyConfirmation,
    closeChoice:w=>required(p.closeChoices,w.token),save:w=>required(p.saveStatuses,w.token),
    dialog:()=>({accepted:p.dialogAccepted,key:p.dialogKey}),
    importEvent:key=>p.evtExists && Object.hasOwn(p.evtNames,identity(key)) ?
      {name:required(p.evtNames,identity(key)),rows:copy(required(p.evtRowIds,identity(key)))} : null,
    createWindow:()=>{if(p.templateStatus!==0)throw new Error('Unsupported template status');
      return {token:required(p,'freshWindowToken'),eventToken:required(p,'freshEventToken')};},
    activate:()=>required(p,'activationReturn'),
    recursionCheck:p.recursionCheck,interrupted:n=>p.cancelAfter===null?false:n>=required(p,'cancelAfter'),
    position:i=>required(p.positions,i),beep:()=>{},
    createTemporary:()=>({}),disposeTemporary:()=>{},
    metadata:key=>({name:p.evtExists && Object.hasOwn(p.evtNames,identity(key)) ?
      required(p.evtNames,identity(key)) : required(p,'notInEvtLabel')})
  };
}
module.exports={records,select,loadSchedule,refreshDialog,selectDialogItem,loadDialog,control,finiteProviders};
