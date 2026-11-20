// Full-screen language picker: search, "Detect language", recent languages, all languages.
import { state, langName } from '../state.js';
import { recentLangs } from '../store.js';
import { icon } from './icons.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { isWeb } from './layout.js';
import { STATIC_LANGUAGES } from '../languages.js';
import { offlineLanguages, onOfflineChange, loadRegistry } from '../features/offline.js';
import { dlButton, updateDownloadButtons, onDownloadClick } from './offlineui.js';

let dlg, list, search, title, searchBtn;
let current = null; // { side, selected, includeAuto, resolve, returnFocus }

function init() {
  if (dlg) return;
  dlg = document.getElementById('lang-dialog');
  list = document.getElementById('lang-list');
  search = document.getElementById('lang-search');
  title = document.getElementById('lang-title');
  searchBtn = document.getElementById('lang-search-btn');
  searchBtn.addEventListener('click', () => setSearching(!dlg.classList.contains('searching'), true));
  setupDialog(dlg, {
    onClose: () => {
      const c = current; current = null;
      c?.resolve(dlg.returnValue || null);
      c?.returnFocus?.focus();
    },
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.lang-item')?.focus(); }
    if (e.key === 'Enter') {
      const first = list.querySelector('.lang-item:not([aria-disabled="true"])');
      if (first) { e.preventDefault(); pick(first.dataset.code); }
    }
  });
  onOfflineChange(() => { if (dlg.open) updateDownloadButtons(list); });
  list.addEventListener('click', (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { onDownloadClick(dl.dataset.dl); return; }
    const b = e.target.closest('.lang-item');
    if (!b) return;
    if (b.getAttribute('aria-disabled') === 'true') explain(b.dataset.code);
    else pick(b.dataset.code);
  });
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.lang-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i === 0 && dlg.classList.contains('searching') ? search : items[Math.max(i - 1, 0)]).focus(); }
    if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    if (e.key === 'ArrowRight') { const dl = items[i].parentElement.querySelector('[data-dl]'); if (dl) { e.preventDefault(); dl.focus(); } }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && e.target.matches('[data-dl]')) { e.preventDefault(); e.target.parentElement.querySelector('.lang-item').focus(); }
  });
}

function pick(code) { closeDialog(dlg, code); }

/** Codes the active setup can use on this side, or null = everything. */
function availableCodes(side) {
  const codes = new Set(state.languages.map((l) => l.code));
  if (side === 'target' && state.source !== 'auto' && typeof state.provider?.targetsFor === 'function') {
    const t = state.provider.targetsFor(state.source);
    if (t) return new Set(t.filter((c) => codes.has(c)));
  }
  return codes;
}

function explain(code) {
  const name = langName(code);
  const p = state.provider;
  let why;
  if (state.mode !== 'advanced' && p && !p.isMock && current.side === 'target' && state.source !== 'auto' && p.targetsFor?.(state.source) && state.languages.some((l) => l.code === code)) {
    why = `Your translation server can't translate ${langName(state.source)} into ${name}. Pick another language, or switch to Advanced mode.`;
  } else if (state.mode === 'advanced') {
    why = `${name} isn't available right now.`;
  } else if (!p || p.isMock) {
    why = `The offline demo doesn't include ${name}. Add a LibreTranslate server or an AI model in Settings to use it.`;
  } else {
    why = `${name} isn't installed on your LibreTranslate server. Install its language model on the server, or switch to Advanced mode (AI) to use it.`;
  }
  let note = list.querySelector('.lang-note');
  if (!note) { note = document.createElement('p'); note.className = 'lang-note'; note.setAttribute('role', 'status'); list.prepend(note); }
  note.textContent = why;
  note.scrollIntoView({ block: 'nearest' });
}

let offlineSet = null;     // app codes that can be downloaded here, or null when not relevant

let avail = null;
function item(code, selected, sub = '') {
  if (offlineSet?.has(code)) return `<div class="lang-row">${itemButton(code, selected, sub)}${dlButton(code, true)}</div>`;
  return itemButton(code, selected, sub);
}
function itemButton(code, selected, sub = '') {
  const isSel = code === selected;
  const off = code !== 'auto' && avail && !avail.has(code);
  if (off) sub = 'Not available';
  const trail = isSel ? icon('check', 'trail') : code === 'auto' ? icon('sparkle', 'trail') : '';
  return `<button type="button" class="lang-item${off ? ' unavailable' : ''}" ${isSel ? 'aria-current="true"' : ''}${off ? ' aria-disabled="true"' : ''} data-code="${code}" lang="${code === 'auto' ? 'en' : code}">
    <span class="name">${escapeHtml(langName(code))}</span>${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}${trail}
  </button>`;
}

/** The search field replaces the big title, as in the reference picker. */
function setSearching(on, focus = false) {
  dlg.classList.toggle('searching', on);
  searchBtn.setAttribute('aria-pressed', String(on));
  searchBtn.setAttribute('aria-label', on ? 'Close search' : 'Search languages');
  if (!on && search.value) { search.value = ''; render(); }
  if (on && focus) search.focus();
}

function render() {
  const { side, selected, includeAuto } = current;
  const q = search.value.trim().toLowerCase();
  avail = availableCodes(side);
  // download buttons: Classic mode, languages the on-device engine knows (English is built in)
  offlineSet = state.mode === 'classic' ? new Set(offlineLanguages().filter((c) => c !== 'en')) : null;
  if (offlineSet) loadRegistry().then(() => { if (dlg.open) updateDownloadButtons(list); }).catch(() => {});
  const byCode = new Map([...STATIC_LANGUAGES, ...state.languages].map((l) => [l.code, l]));
  const langs = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
  let html = '';
  if (q) {
    const hits = langs.filter((l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase() === q);
    html = hits.length ? hits.map((l) => item(l.code, selected)).join('') : `<p class="lang-empty">No languages match “${escapeHtml(search.value)}”</p>`;
  } else {
    if (includeAuto) {
      const det = state.detected?.language;
      html += item('auto', selected, det ? `${langName(det)} detected` : '');
    }
    const known = new Set(langs.map((l) => l.code));
    const recents = recentLangs.get(side).filter((c) => known.has(c));
    if (recents.length) html += `<h3 class="lang-section">Recent languages</h3>` + recents.map((c) => item(c, selected)).join('');
    html += `<h3 class="lang-section">All languages</h3>` + langs.map((l) => item(l.code, selected)).join('');
  }
  list.innerHTML = html;
}

/**
 * @returns {Promise<string|null>} chosen code, or null if dismissed
 */
export function pickLanguage({ side = 'target', selected, includeAuto = false, heading, anchor } = {}) {
  init();
  return new Promise((resolve) => {
    current = { side, selected, includeAuto, resolve, returnFocus: document.activeElement };
    title.textContent = heading || (side === 'source' ? 'Translate from' : 'Translate to');
    search.value = '';
    dlg.returnValue = '';
    // 1200px+: opened from a language-row chevron, the picker becomes a full-width panel
    // over the two panes (multi-column list, search field always shown)
    const panel = !!anchor && isWeb();
    dlg.classList.toggle('panel', panel);
    if (panel) {
      const r = anchor.getBoundingClientRect();
      dlg.style.setProperty('--pt', `${Math.round(r.bottom)}px`);
      dlg.style.setProperty('--pl', `${Math.round(r.left)}px`);
      dlg.style.setProperty('--pw', `${Math.round(r.width)}px`);
    }
    // touch: start with the big title and a search icon; keyboard/mouse: start in the search field
    const coarse = matchMedia('(pointer: coarse)').matches && !panel;
    setSearching(!coarse);
    render();
    openDialog(dlg);
    requestAnimationFrame(() => {
      const sel = list.querySelector('[aria-current="true"]');
      if (coarse) sel?.focus({ preventScroll: true });
      else search.focus();
      sel?.scrollIntoView({ block: 'center' });
    });
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
