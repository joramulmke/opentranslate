// "Install app" in the menu. Where the browser can install (Chrome, Edge, Samsung Internet) it opens the
// browser's own install dialog; elsewhere (Safari, Firefox) a short sheet says how to add it by hand.
// Hidden while OpenTranslate already runs as an installed app.
import { setupDialog, openDialog } from './sheet.js';

let prompt = null;   // the browser's deferred install prompt, when it offers one
let item = null;

const installed = () => matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches
  || navigator.standalone === true;

function render() { if (item) item.hidden = installed(); }

/** Where to find "Add to Home Screen" (or the like) in this browser. */
function steps() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const firefox = /Firefox|FxiOS/.test(ua);
  if (ios) return ['Tap the Share button <span aria-hidden="true">(the square with an arrow)</span>, in the address bar or at the bottom.',
    'Scroll down and tap <strong>Add to Home Screen</strong>.', 'Tap <strong>Add</strong>.'];
  if (/Android/.test(ua) && firefox) return ['Tap the menu <span aria-hidden="true">(⋮)</span>.', 'Tap <strong>Add app to Home screen</strong> (or <strong>Install</strong>).'];
  if (/Android/.test(ua)) return ['Open the browser menu <span aria-hidden="true">(⋮)</span>.', 'Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.'];
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return ['In the menu bar, choose <strong>File</strong>.', 'Choose <strong>Add to Dock</strong>.'];
  if (firefox) return ['Firefox on a computer can’t install web apps.', 'Open OpenTranslate in Chrome, Edge or Safari and install it from there.'];
  return ['Open the browser menu.', 'Choose <strong>Install OpenTranslate</strong> (or <strong>Apps › Install</strong>).'];
}

export function initInstall(menuItem) {
  item = menuItem;
  const dlg = setupDialog(document.getElementById('install-dialog'));
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; });
  window.addEventListener('appinstalled', () => { prompt = null; render(); });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', render);
  render();
  return async function install() {
    if (prompt) {
      const p = prompt;
      prompt = null; // a prompt can be used once
      try { await p.prompt(); } catch { /* dismissed or not allowed */ }
      return;
    }
    document.getElementById('install-steps').innerHTML = steps().map((s) => `<li>${s}</li>`).join('');
    openDialog(dlg);
  };
}
