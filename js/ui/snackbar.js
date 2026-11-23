// M3 snackbar. toast('Copied') or toast('Removed', { action: 'Undo', onAction }); a full stop is added if missing
//
// Accessibility:
// - Messages with an action (Undo) stay until the person uses it, dismisses it, another
//   message replaces it, or they move to another tab: no time limit (WCAG 2.2.1 / 2.2.3).
// - Plain messages hide after a while, but never while hovered or focused.
// - ✕ and Escape mean "stop" for a message that has one (onDismiss), e.g. Cancel on "Reading photo 2 of 3…".
// - It sits above bottom button bars marked data-toast-above, so it never hides a focused button there (WCAG 2.4.11).
// - While a modal dialog is open, everything outside it is inert, so the snackbar moves into
//   the topmost open dialog to stay reachable and announced.
const bar = () => document.getElementById('snackbar');
let timer = null;
let remaining = 0;
let started = 0;
let wired = false;
let dismissed = null;   // called when the person closes the message (✕ or Escape), not when it times out or is replaced

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
  const close = () => { const f = dismissed; hide(); f?.(); };
  document.getElementById('snackbar-close').addEventListener('click', close);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  // the dialog holding the snackbar closed: put it back, hidden
  document.addEventListener('close', (e) => {
    if (e.target?.localName === 'dialog' && e.target.contains(el)) { hide(); document.body.append(el); }
  }, true);
}

/** Every message is a sentence: "Text copied." (one place, so all messages end the same way). */
const sentence = (m) => { const t = String(m ?? '').trim(); return !t || /[.!?…:]$/.test(t) ? t : `${t}.`; };

export function toast(message, { action, onAction, onDismiss, duration = 6000 } = {}) {
  message = sentence(message);
  const el = bar();
  wire(el);
  const text = document.getElementById('snackbar-text');
  const btn = document.getElementById('snackbar-action');
  const close = document.getElementById('snackbar-close');
  const host = topDialog() || document.body;
  const moved = el.parentElement !== host;
  if (moved) host.append(el);
  place(el, host);
  if (action) {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => { hide(); onAction?.(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  close.hidden = !action;
  dismissed = onDismiss || null;
  el.classList.add('show');
  clearTimeout(timer); timer = null;
  remaining = action ? 0 : duration;
  // a live region that just moved needs a moment before screen readers pick up new text
  text.textContent = '';
  setTimeout(() => { text.textContent = message; }, moved ? 150 : 30);
  if (!action) { started = Date.now(); timer = setTimeout(hide, duration); }
}

/** Above a visible bottom bar (data-toast-above), e.g. the camera's Retake / Original / Share row. */
function place(el, host) {
  const under = host === document.body ? [...document.querySelectorAll('[data-toast-above]')].find((b) => b.getClientRects().length && b.checkVisibility?.() !== false) : null;
  const top = under ? under.getBoundingClientRect().top : innerHeight;
  el.style.bottom = top < innerHeight ? `${Math.round(innerHeight - top + 8)}px` : '';
}

/** Moving to another tab: an Undo that belongs to the screen you left goes with it, instead of
 *  covering the camera's shutter or the conversation's mic. (Its own action isn't run.) */
export function leaveScreen() {
  if (bar().classList.contains('show') && !document.getElementById('snackbar-action').hidden) hide();
}

export function hide() {
  clearTimeout(timer); timer = null; remaining = 0; dismissed = null;
  bar().classList.remove('show');
}

/** Copy text (e.g. a chrome:// address, which a page can't link to), then say so. */
export async function copyToClipboard(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(done);
}
