// Settings: the same short tags on every option (privacy, internet, size, quality) and an ⓘ button
// that opens the details (source, licence, model page) in a small sheet.
import { escapeHtml as esc } from './langpicker.js';
import { icon } from './icons.js';
import { setupDialog, openDialog } from './sheet.js';
import { formatMB } from './offlineui.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ tags */

export const PRIVATE = { kind: 'private', text: 'Private' };
export const sends = (host) => ({ kind: 'sends', text: `Sends to ${host}` });
export const OFFLINE = { kind: 'offline', text: 'Works offline' };
export const ONLINE = { kind: 'online', text: 'Needs internet' };
export const NO_DOWNLOAD = { kind: 'size', text: 'No download' };
export const READY = { kind: 'ready', text: 'Ready' };
export const download = (mb) => ({ kind: 'size', text: `${typeof mb === 'number' ? formatMB(mb * 1e6) : mb} download` });
export const downloading = (p) => ({ kind: 'busy', text: `Downloading ${Math.round((p || 0) * 100)}%` });
export const quality = (q) => (q ? { kind: 'quality', text: q } : null);
export const UNAVAILABLE = { kind: 'off', text: 'Not available' };

/** One line of tags; the id lets the option's radio describe itself with them. */
export function tagLine(id, list) {
  const items = list.filter(Boolean);
  if (!items.length) return '';
  return `<span class="svc-tags" id="${id}">${items.map((t) => `<span class="tag tag-${t.kind}">${esc(t.text)}</span>`).join('<span class="visually-hidden">, </span>')}</span>`;
}

/* ------------------------------------------------------------ ⓘ details */

const infos = new Map();   // id -> { title, html }
let dlg = null; let opener = null;

/** The ⓘ button of an option; `html` is the details (already escaped, may contain links). */
export function infoButton(id, title, html) {
  if (!html) return '';
  infos.set(id, { title, html });
  return `<button class="icon-btn sm info-btn" type="button" data-info="${esc(id)}" aria-label="Details: ${esc(title)}" aria-haspopup="dialog">${icon('info')}</button>`;
}

export function openInfo(id) {
  const info = infos.get(id);
  if (!info || !dlg) return;
  opener = document.activeElement;
  $('info-title').textContent = info.title;
  $('info-body').innerHTML = info.html;
  openDialog(dlg);
  requestAnimationFrame(() => { if (dlg.open) dlg.querySelector('[data-close]')?.focus(); });
}

export function initInfo() {
  if (!$('info-dialog')) return;
  dlg = setupDialog($('info-dialog'), { onClose: () => {
    // back to the same ⓘ (the row may have been re-rendered meanwhile)
    const id = opener?.dataset?.info;
    const again = opener?.isConnected ? opener : (id && [...document.querySelectorAll('[data-info]')].find((b) => b.dataset.info === id));
    again?.focus?.();
    opener = null;
  } });
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-info]');
    if (b) { e.preventDefault(); openInfo(b.dataset.info); }
  });
}

/** Details as a list of short paragraphs (each already HTML). */
export const details = (...parts) => parts.filter(Boolean).map((p) => `<p>${p}</p>`).join('');
