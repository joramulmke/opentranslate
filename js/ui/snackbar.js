// M3 snackbar. toast('Copied') or toast('Removed', { action: 'Undo', onAction })
//
// Accessibility:
// - Messages with an action (Undo) stay until the person uses it, dismisses it, or another
//   message replaces it: no time limit (WCAG 2.2.1 / 2.2.3).
// - Plain messages hide after a while, but never while hovered or focused.
// - While a modal dialog is open, everything outside it is inert, so the snackbar moves into
//   the topmost open dialog to stay reachable and announced.
const bar = () => document.getElementById('snackbar');
let timer = null;
let remaining = 0;
let started = 0;
let wired = false;

function topDialog() {
  const open = [...document.querySelectorAll('dialog[open]')];
  return open[open.length - 1] || null;
}

function wire(el) {
  if (wired) return;
  wired = true;
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; remaining -= Date.now() - started; } };
  const resume = () => {
    if (!remaining || timer || el.matches(':hover') || el.contains(document.activeElement)) return;
    started = Date.now();
    timer = setTimeout(hide, Math.max(remaining, 1500));
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('focusin', pause);
  el.addEventListener('pointerleave', resume);
  el.addEventListener('focusout', () => setTimeout(resume, 0));
  document.getElementById('snackbar-close').addEventListener('click', hide);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); } });
  // the dialog holding the snackbar closed: put it back, hidden
  document.addEventListener('close', (e) => {
    if (e.target?.localName === 'dialog' && e.target.contains(el)) { hide(); document.body.append(el); }
  }, true);
}

export function toast(message, { action, onAction, duration = 6000 } = {}) {
  const el = bar();
  wire(el);
  const text = document.getElementById('snackbar-text');
  const btn = document.getElementById('snackbar-action');
  const close = document.getElementById('snackbar-close');
  const host = topDialog() || document.body;
  const moved = el.parentElement !== host;
  if (moved) host.append(el);
  if (action) {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => { hide(); onAction?.(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  close.hidden = !action;
  el.classList.add('show');
  clearTimeout(timer); timer = null;
  remaining = action ? 0 : duration;
  // a live region that just moved needs a moment before screen readers pick up new text
  text.textContent = '';
  setTimeout(() => { text.textContent = message; }, moved ? 150 : 30);
  if (!action) { started = Date.now(); timer = setTimeout(hide, duration); }
}

export function hide() {
  clearTimeout(timer); timer = null; remaining = 0;
  bar().classList.remove('show');
}
