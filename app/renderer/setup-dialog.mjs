// Configuration lives in the browser's top layer; capture remains engine-owned.
import { dismissOnBackdrop } from './dialog-dismiss.mjs';
export class SetupDialog {
  constructor({drawer,onDismiss,onReturnLive,beforeDismiss=()=>true}) {
    this.drawer=drawer;this.onDismiss=onDismiss;this.onReturnLive=onReturnLive;this.beforeDismiss=beforeDismiss;
    const dialog=document.createElement('dialog');dialog.id='setupDialog';dialog.className='setup-dialog';dialog.setAttribute('aria-labelledby','drawerTitle');
    drawer.before(dialog);dialog.append(drawer);this.dialog=dialog;
    const live=document.createElement('div');live.className='dialog-live';live.hidden=true;
    const status=document.createElement('span');status.setAttribute('role','status');
    const back=document.createElement('button');back.className='btn sm';back.textContent='Return to live';back.onclick=()=>this.dismiss(onReturnLive);
    live.append(status,back);drawer.querySelector('.ph .r').prepend(live);Object.assign(this,{live,status,back});
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.dismiss();});
    dismissOnBackdrop(dialog,()=>this.dismiss());
    dialog.addEventListener('close',()=>{if(!dialog.open&&drawer.classList.contains('open'))onDismiss();});
    this.observer=new MutationObserver(()=>this.sync());this.observer.observe(drawer,{attributes:true,attributeFilter:['class']});this.sync();
  }
  async dismiss(action=this.onDismiss){
    if(this.dismissing)return;
    this.dismissing=true;
    try{if(await this.beforeDismiss())action();}finally{this.dismissing=false;}
  }
  sync(){
    const open=this.drawer.classList.contains('open');
    if(open&&!this.dialog.open){const trigger=document.querySelector('#tabs button[aria-expanded=true]')||document.querySelector('.setup-modes button.primary')||document.querySelector('#browseEvents');this.returnLabel=trigger?.textContent;this.dialog.showModal();}
    else if(!open&&this.dialog.open){this.dialog.close();queueMicrotask(()=>{if(this.dialog.open)return;const trigger=[...document.querySelectorAll('#tabs button,.setup-modes button,#browseEvents')].find(button=>button.textContent===this.returnLabel&&!button.disabled);trigger?.focus({preventScroll:true});});}
  }
  updateLive(heat,preview=false){
    this.live.hidden=!heat&&!preview;this.back.hidden=!heat;
    this.status.textContent=heat?`Recording · Event ${heat.ev} · Heat ${heat.ht}`:preview?'Camera preview running':'';
  }
}
