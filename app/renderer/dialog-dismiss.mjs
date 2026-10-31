// A drag that starts inside a dialog must never become a backdrop dismissal.
export function dismissOnBackdrop(dialog, dismiss = () => dialog.close()) {
  let startedOutside = false;
  const outside = event => {
    const r = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = event.button === 0 && outside(event); });
  dialog.addEventListener('pointerup', event => {
    const shouldDismiss = startedOutside && outside(event); startedOutside = false;
    if (shouldDismiss) { event.preventDefault(); event.stopPropagation(); dismiss(); }
  });
  dialog.addEventListener('pointercancel', () => { startedOutside = false; });
}

export function confirmDiscardChanges() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'race-reset-dialog discard-dialog';
    dialog.setAttribute('aria-labelledby', 'discard-title');dialog.setAttribute('aria-describedby', 'discard-detail');
    const title = document.createElement('h2');title.id = 'discard-title';title.textContent = 'Discard unsaved changes?';
    const detail = document.createElement('p');detail.id = 'discard-detail';detail.textContent = 'Your changes have not been saved.';
    const actions = document.createElement('div');actions.className = 'race-reset-actions';
    const keep = document.createElement('button');keep.className = 'btn primary';keep.textContent = 'Keep editing';keep.autofocus = true;keep.onclick = () => dialog.close();
    const discard = document.createElement('button');discard.className = 'btn warn';discard.textContent = 'Discard changes';discard.dataset.discard = 'true';discard.onclick = () => dialog.close('discard');
    actions.append(keep, discard);dialog.append(title, detail, actions);dismissOnBackdrop(dialog);
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => { const confirmed = dialog.returnValue === 'discard';dialog.remove();resolve(confirmed); }, { once: true });
    document.body.append(dialog);dialog.showModal();
  });
}
