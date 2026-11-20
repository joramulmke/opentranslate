// Classic / Advanced translation-mode dropdown (the "Advanced ▾" control in the source pane).
import { state, subscribe, setMode, advancedReady } from '../state.js';
import { toast } from './snackbar.js';

const $ = (id) => document.getElementById(id);

export function initModeMenu({ openSettings }) {
  const btn = $('btn-mode');
  const dlg = $('mode-menu');
  const label = $('mode-label');
  const items = () => [...dlg.querySelectorAll('[role="menuitemradio"]')];
  let pendingAdvanced = false;

  const render = () => {
    const adv = state.mode === 'advanced';
    label.textContent = adv ? 'Advanced' : 'Classic';
    btn.setAttribute('aria-label', `Translation mode: ${label.textContent}. Change`);
    btn.classList.toggle('is-advanced', adv);
    items().forEach((i) => i.setAttribute('aria-checked', String(i.dataset.mode === state.mode)));
  };

  const close = () => { if (dlg.open) dlg.close(); };
  const open = () => {
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    dlg.style.inset = 'auto';
    dlg.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 4;
    const fitsBelow = below + 170 < window.innerHeight;
    dlg.style.top = fitsBelow ? `${below}px` : 'auto';
    dlg.style.bottom = fitsBelow ? 'auto' : `${window.innerHeight - r.top + 4}px`;
    dlg.style.width = `${w}px`;
    btn.setAttribute('aria-expanded', 'true');
    dlg.showModal();
    (items().find((i) => i.dataset.mode === state.mode) || items()[0]).focus();
  };

  const choose = (mode) => {
    close();
    if (mode === 'advanced' && !advancedReady()) {
      pendingAdvanced = true;
      toast('Set up an AI model API to use Advanced translation');
      openSettings('advanced');
      return;
    }
    pendingAdvanced = false;
    if (mode !== state.mode) setMode(mode);
  };

  btn.addEventListener('click', () => (dlg.open ? close() : open()));
  dlg.addEventListener('close', () => { btn.setAttribute('aria-expanded', 'false'); if (!document.querySelector('dialog[open]')) btn.focus(); });
  dlg.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (item) { choose(item.dataset.mode); return; }
    if (e.target === dlg) close(); // backdrop
  });
  dlg.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); list[(i + step + list.length) % list.length].focus(); }
    if (e.key === 'Tab') { e.preventDefault(); close(); }
  });

  // After the user configures Advanced in Settings, switch to it if that's what they asked for.
  subscribe(() => {
    if (pendingAdvanced && advancedReady()) {
      pendingAdvanced = false;
      setMode('advanced');
      toast('Advanced translation is on');
    }
    render();
  });
  render();
}
