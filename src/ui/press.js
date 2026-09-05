// Shared helpers for the floating panels.

// Panel buttons act on pointerdown. A plain click handler loses the first
// click after editing a field: the blur commits, the store emits, and the
// panel rebuild replaces the button between mousedown and mouseup, so the
// click never lands. Pointerdown fires before the blur; any pending edit is
// committed explicitly first so ordering matches the old click path. The
// click listener stays for keyboard activation, suppressed after a pointer
// press so the same activation can't fire twice.
export function onPress(btn, fn) {
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const ae = document.activeElement;
    if (ae && ae !== btn && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) ae.blur();
    btn._pointerFired = true;
    window.addEventListener('pointerup', () => {
      setTimeout(() => { btn._pointerFired = false; }, 0);
    }, { once: true });
    fn(e);
  });
  btn.addEventListener('click', (e) => {
    if (!btn._pointerFired) fn(e);
  });
}

export function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Non-blocking notice in the corner of the canvas, in place of alert(). An
// optional action ({ label, run }) adds a button and keeps the toast up
// longer, in place of confirm(): the default happens at once and the button
// is the way back.
let toastTimer = null;
export function toast(message, { action = null } = {}) {
  const t = document.getElementById('toast');
  t.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      t.hidden = true;
      action.run();
    });
    t.append(btn);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 9000 : 3600);
}

// showModal() throws on a dialog that is already open.
export function openModal(dialog) {
  if (!dialog.open) dialog.showModal();
}
