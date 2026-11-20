// Language bar, one instance per view, all bound to shared state. Two presentations:
//  - pills:  [source] (⇄) [target]                         phones + tabbed layout (< 1200px)
//  - tabs:   Detect · English · Spanish · French ⌄  ⇄  Spanish · English · Arabic ⌄   (1200px+)
// CSS decides which one is visible; both share the same choose/swap logic.
import { state, subscribe, langName, setSource, setTarget } from '../state.js';
import { recentLangs } from '../store.js';
import { icon } from './icons.js';
import { pickLanguage } from './langpicker.js';

const bars = [];
const TAB_COUNT = 3;
// Languages shown as quick tabs; kept in a stable order (the chosen one is added in front only when missing).
const shown = { source: null, target: null };

function quickList(side) {
  const known = new Set(state.languages.map((l) => l.code));
  if (!shown[side]) {
    const seed = [...recentLangs.get(side), ...(side === 'source' ? ['en', 'es', 'fr'] : ['es', 'en', 'fr'])];
    shown[side] = [...new Set(seed)].filter((c) => c !== 'auto').slice(0, TAB_COUNT);
  }
  const cur = side === 'source' ? state.source : state.target;
  if (cur !== 'auto' && !shown[side].includes(cur)) shown[side] = [cur, ...shown[side]].slice(0, TAB_COUNT);
  return shown[side].filter((c) => known.has(c) || c === cur);
}

/**
 * @param {HTMLElement} host
 * @param {{ onSwap?: () => boolean|void, variant?: 'dark' }} opts  onSwap returns false to cancel
 */
export function createLangBar(host, opts = {}) {
  const dark = opts.variant === 'dark';
  host.innerHTML = `
    <div class="langbar ${dark ? 'dark' : ''}">
      <button type="button" class="pill src-pill" aria-haspopup="dialog"><span class="pill-label"></span></button>
      <button type="button" class="icon-btn swap-btn" aria-label="Swap languages">${icon('swap')}</button>
      <button type="button" class="pill tgt-pill" aria-haspopup="dialog"><span class="pill-label"></span></button>
    </div>
    ${dark ? '' : `
    <div class="weblangs">
      <div class="wl-side wl-src" role="group" aria-label="Translate from">
        <div class="wl-tabs"></div>
        <button type="button" class="icon-btn wl-more" aria-label="More source languages" aria-haspopup="dialog" aria-expanded="false">${icon('chevronDown')}</button>
      </div>
      <button type="button" class="icon-btn wl-swap" aria-label="Swap languages">${icon('swap')}</button>
      <div class="wl-side wl-tgt" role="group" aria-label="Translate to">
        <div class="wl-tabs"></div>
        <button type="button" class="icon-btn wl-more" aria-label="More target languages" aria-haspopup="dialog" aria-expanded="false">${icon('chevronDown')}</button>
      </div>
    </div>`}`;
  const src = host.querySelector('.src-pill');
  const tgt = host.querySelector('.tgt-pill');
  const swap = host.querySelector('.swap-btn');
  const web = host.querySelector('.weblangs');

  function chooseSource(code) {
    if (!code || code === state.source) return;
    if (code === state.target && code !== 'auto') { animateSwap(); setTarget(state.source === 'auto' ? (state.detected?.language || 'en') : state.source); }
    setSource(code);
  }
  function chooseTarget(code) {
    if (!code || code === state.target) return;
    if (code === state.source) { animateSwap(); setSource(state.target); }
    setTarget(code);
  }
  function doSwap() {
    const from = state.source === 'auto' ? state.detected?.language : state.source;
    const to = state.target;
    if (!from) return;
    if (opts.onSwap && opts.onSwap() === false) return;
    animateSwap();
    setSource(to);
    setTarget(from);
  }

  const tabHtml = (code, selected, label) =>
    `<button type="button" class="wl-tab" data-code="${code}" aria-pressed="${selected}" lang="${code === 'auto' ? 'en' : code}">${label}</button>`;

  const render = () => {
    const sLabel = state.source === 'auto'
      ? (state.detected?.language ? `${langName(state.detected.language)} · Detected` : 'Detect language')
      : langName(state.source);
    src.querySelector('.pill-label').textContent = sLabel;
    tgt.querySelector('.pill-label').textContent = langName(state.target);
    src.setAttribute('aria-label', `Source language: ${sLabel}. Change`);
    tgt.setAttribute('aria-label', `Target language: ${langName(state.target)}. Change`);
    const canSwap = state.source !== 'auto' || !!state.detected?.language;
    for (const b of [swap, web?.querySelector('.wl-swap')]) {
      if (!b) continue;
      b.setAttribute('aria-disabled', String(!canSwap));
      b.style.opacity = canSwap ? '' : '.38';
    }
    if (!web) return;
    // re-rendering replaces the tab buttons; keep keyboard focus on the same language
    const f = document.activeElement;
    const keep = f?.classList?.contains('wl-tab') && web.contains(f) ? `.${f.closest('.wl-side').classList[1]} [data-code="${f.dataset.code}"]` : null;
    const det = state.detected?.language;
    const autoLabel = det ? `${langName(det)} - detected` : 'Detect language';
    web.querySelector('.wl-src .wl-tabs').innerHTML = tabHtml('auto', state.source === 'auto', autoLabel)
      + quickList('source').map((c) => tabHtml(c, state.source === c, langName(c))).join('');
    web.querySelector('.wl-tgt .wl-tabs').innerHTML =
      quickList('target').map((c) => tabHtml(c, state.target === c, langName(c))).join('');
    if (keep) web.querySelector(keep)?.focus();
  };

  src.addEventListener('click', async () => {
    chooseSource(await pickLanguage({ side: 'source', selected: state.source, includeAuto: true }));
  });
  tgt.addEventListener('click', async () => {
    chooseTarget(await pickLanguage({ side: 'target', selected: state.target }));
  });
  swap.addEventListener('click', () => { if (swap.getAttribute('aria-disabled') !== 'true') doSwap(); });

  if (web) {
    web.addEventListener('click', async (e) => {
      const tab = e.target.closest('.wl-tab');
      if (tab) {
        const side = tab.closest('.wl-src') ? 'source' : 'target';
        if (side === 'source') chooseSource(tab.dataset.code); else chooseTarget(tab.dataset.code);
        return;
      }
      const more = e.target.closest('.wl-more');
      if (more) {
        const side = more.closest('.wl-src') ? 'source' : 'target';
        more.setAttribute('aria-expanded', 'true');
        const code = await pickLanguage({
          side, selected: side === 'source' ? state.source : state.target, includeAuto: side === 'source', anchor: web,
        });
        more.setAttribute('aria-expanded', 'false');
        if (side === 'source') chooseSource(code); else chooseTarget(code);
        return;
      }
      const ws = e.target.closest('.wl-swap');
      if (ws && ws.getAttribute('aria-disabled') !== 'true') doSwap();
    });
  }

  const bar = { host, src, tgt, swap, web, render };
  bars.push(bar);
  subscribe(render);
  render();
  return bar;
}

/** Pills cross over each other and the swap icon spins, as in the reference app. */
export function animateSwap() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const opts = { duration: 320, easing: 'cubic-bezier(.2,0,0,1)' };
  for (const b of bars) {
    if (!b.host.offsetParent) continue; // hidden view
    const ws = b.web?.querySelector('.wl-swap .ic');
    if (ws && ws.getClientRects().length) ws.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], opts);
    const a = b.src.getBoundingClientRect();
    const c = b.tgt.getBoundingClientRect();
    if (!a.width) continue; // pills hidden (1200px+ layout)
    const dx = c.left + c.width / 2 - (a.left + a.width / 2);
    b.src.animate([{ transform: `translateX(${dx}px)`, opacity: .4 }, { transform: 'none', opacity: 1 }], opts);
    b.tgt.animate([{ transform: `translateX(${-dx}px)`, opacity: .4 }, { transform: 'none', opacity: 1 }], opts);
    b.swap.querySelector('.ic').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], opts);
  }
}
