// Translation-service dropdown (the "Classic ▾ / Advanced ▾" control in the source pane).
// Lists every service, grouped as Classic and Advanced; picking one makes it the one used first.
import { state, subscribe, useEntry, kindOf } from '../state.js';
import { settings } from '../store.js';
import { escapeHtml } from './langpicker.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);

const GROUPS = {
  classic: { title: 'Classic', hint: 'Fast. Your LibreTranslate server or languages downloaded to this device.' },
  advanced: { title: 'Advanced', hint: 'AI model: more fluent. Your text goes to that service.' },
};

export function initModeMenu({ openSettings }) {
  const btn = $('btn-mode');
  const dlg = $('mode-menu');
  const host = $('mode-items');
  const label = $('mode-label');
  const items = () => [...host.querySelectorAll('[role^="menuitem"]')];

  const activeId = () => (state.mode === 'advanced' ? state.advanced : state.classic)?.entryId;

  const renderItems = () => {
    const list = settings.get().entries;
    const current = activeId();
    host.innerHTML = Object.entries(GROUPS).map(([kind, g]) => {
      const ofKind = list.filter((e) => kindOf(e) === kind);
      const rows = ofKind.length
        ? ofKind.map((e) => {
          const on = state.mode === kind && e.id === current;
          return `<button type="button" role="menuitemradio" aria-checked="${on}" data-entry="${e.id}" title="${escapeHtml(e.label)}">
            <span class="mode-copy"><strong>${escapeHtml(e.label)}</strong></span>${icon('check', 'mode-check')}</button>`;
        }).join('')
        : `<button type="button" role="menuitem" data-add="advanced">
            <span class="mode-copy"><strong>Set up an AI model…</strong></span>${icon('add', 'mode-check is-visible')}</button>`;
      return `<div role="group" aria-labelledby="mode-g-${kind}" class="mode-group">
        <p class="mode-group-head" id="mode-g-${kind}"><strong>${g.title}</strong><small>${g.hint}</small></p>${rows}</div>`;
    }).join('') + `<div role="separator" class="mode-sep"></div>
      <button type="button" role="menuitem" data-manage>
        <span class="mode-copy"><strong>Manage services</strong></span>${icon('settings', 'mode-check is-visible')}</button>`;
  };

  const render = () => {
    const adv = state.mode === 'advanced';
    label.textContent = adv ? 'Advanced' : 'Classic';
    const p = adv ? state.advanced : state.classic;
    btn.setAttribute('aria-label', `Translation: ${label.textContent}${p?.entryLabel ? `, ${p.entryLabel}` : ''}. Change`);
    btn.title = p?.entryLabel || '';
    btn.classList.toggle('is-advanced', adv);
  };

  const close = () => { if (dlg.open) dlg.close(); };
  const open = () => {
    renderItems();
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    dlg.style.inset = 'auto';
    dlg.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 4;
    const fitsBelow = window.innerHeight - below >= r.top || window.innerHeight - below > 360;
    // the menu scrolls inside whatever room is left on the side it opens to
    const room = fitsBelow ? window.innerHeight - below - 8 : r.top - 12;
    dlg.style.top = fitsBelow ? `${below}px` : 'auto';
    dlg.style.bottom = fitsBelow ? 'auto' : `${window.innerHeight - r.top + 4}px`;
    dlg.style.maxHeight = `${Math.max(160, room)}px`;
    dlg.style.width = `${w}px`;
    btn.setAttribute('aria-expanded', 'true');
    dlg.showModal();
    (items().find((i) => i.getAttribute('aria-checked') === 'true') || items()[0]).focus();
  };

  btn.addEventListener('click', () => (dlg.open ? close() : open()));
  dlg.addEventListener('close', () => { btn.setAttribute('aria-expanded', 'false'); if (!document.querySelector('dialog[open]')) btn.focus(); });
  dlg.addEventListener('click', (e) => {
    const item = e.target.closest('[role^="menuitem"]');
    if (item) {
      close();
      if (item.dataset.entry) useEntry(item.dataset.entry);
      else if (item.dataset.add) openSettings('advanced');
      else if ('manage' in item.dataset) openSettings();
      return;
    }
    if (e.target === dlg) close(); // backdrop
  });
  dlg.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); list[(i + step + list.length) % list.length].focus(); }
    if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    if (e.key === 'Tab') { e.preventDefault(); close(); }
  });

  subscribe(render);
  render();
}
