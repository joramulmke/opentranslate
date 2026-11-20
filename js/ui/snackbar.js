// M3 snackbar. toast('Copied') or toast('Removed', { action: 'Undo', onAction })
const bar = () => document.getElementById('snackbar');
let timer = null;

export function toast(message, { action, onAction, duration = 3200 } = {}) {
  const el = bar();
  const text = document.getElementById('snackbar-text');
  const btn = document.getElementById('snackbar-action');
  text.textContent = message;
  if (action) {
    btn.hidden = false;
    btn.textContent = action;
    btn.onclick = () => { hide(); onAction?.(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(hide, action ? Math.max(duration, 5000) : duration);
}

export function hide() {
  bar().classList.remove('show');
}
