// Shared bits for on-device language downloads (error card, language picker, settings).
import { downloadPack, packProgress, packState, packSize, onOfflineChange, deletePack, cancelDownload } from '../features/offline.js';
import { langName } from '../state.js';
import { toast } from './snackbar.js';
import { icon } from './icons.js';
import { sheet } from '../features/permissions.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const formatMB = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/**
 * Download several language packs, reporting combined progress 0..1.
 * Shows a snackbar when done.
 */
export async function downloadPacks(langs, { onProgress } = {}) {
  const todo = langs.filter((l) => packState(l) !== 'ready');
  if (!todo.length) return;
  const off = onOfflineChange(() => {
    const total = todo.reduce((a, l) => a + (packSize(l) || 1), 0);
    const done = todo.reduce((a, l) => a + (packState(l) === 'ready' ? 1 : packProgress(l)) * (packSize(l) || 1), 0);
    onProgress?.(Math.min(1, done / total));
  });
  try {
    await Promise.all(todo.map((l) => downloadPack(l)));
    toast(`${todo.map(langName).join(' and ')} ready to use offline`);
  } finally { off(); }
}

/* ---------- the download / downloaded / progress button ---------- */

function dlInfo(code) {
  const st = packState(code);
  const size = packSize(code);
  const name = langName(code);
  if (st === 'ready') return { ic: 'downloadDone', label: `${name} is downloaded. Remove from this device`, pct: 0 };
  if (st === 'downloading') { const p = Math.round(packProgress(code) * 100); return { ic: 'close', label: `Downloading ${name}, ${p}%. Cancel`, pct: p }; }
  return { ic: 'download', label: `Download ${name} for offline use${size ? ` (${formatMB(size)})` : ''} from Mozilla`, pct: 0 };
}

/** @param {boolean} [tabbable]  false inside listboxes (reached with the arrow keys) */
export function dlButton(code, tabbable = false) {
  const d = dlInfo(code);
  return `<button type="button" class="icon-btn lang-dl" data-dl="${code}" data-state="${packState(code)}" ${tabbable ? '' : 'tabindex="-1"'} aria-label="${esc(d.label)}" style="--p:${d.pct}">${icon(d.ic)}</button>`;
}

export function updateDownloadButtons(root) {
  root.querySelectorAll('[data-dl]').forEach((b) => {
    const code = b.dataset.dl; const d = dlInfo(code); const st = packState(code);
    b.setAttribute('aria-label', d.label);
    b.style.setProperty('--p', d.pct);
    if (b.dataset.state !== st) { b.dataset.state = st; b.innerHTML = icon(d.ic); }
  });
}

/** Download, cancel, or (after asking) remove a language. */
export async function onDownloadClick(code) {
  const st = packState(code);
  if (st === 'downloading') { cancelDownload(code); return; }
  if (st === 'ready') {
    const size = packSize(code);
    const ok = await sheet({
      iconName: 'delete', title: `Remove ${langName(code)}?`,
      body: `It will no longer translate offline${size ? `, and ${formatMB(size)} are freed` : ''}. You can download it again at any time.`,
      allowLabel: 'Remove', cancelLabel: 'Cancel',
    });
    if (ok) { await deletePack(code); toast(`Removed ${langName(code)}`); }
    return;
  }
  downloadPacks([code]).catch((e) => { if (!/cancel/i.test(e.message)) toast(e.message); });
}
