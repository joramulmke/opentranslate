// Floating window (Document Picture-in-Picture): a small always-on-top translator for working in other apps.
// Chrome and Edge 116+ on computers only; the menu entry is hidden everywhere else. It uses the same services,
// languages and settings as the main window, and the main tab has to stay open (the window belongs to it).
// Later the live captions (IDEAS #2) can run in it too.
import { state, subscribe, translate, detect, setSource, setTarget, setPair, langName, describeError } from '../state.js';
import { speak, stopSpeaking } from './speech.js';
import { isRtl } from '../languages.js';
import { icon } from '../ui/icons.js';
import { history } from '../store.js';

let win = null;

/** True where a floating window can open (not on phones: Chrome on Android has no Document PiP). */
export const pipSupported = () => typeof window !== 'undefined' && 'documentPictureInPicture' in window
  && !matchMedia('(pointer: coarse)').matches;

export const pipOpen = () => !!win;

const CSS = `
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box;
    background: var(--surface, #fff); color: var(--on-surface, #1b1b1f); font: 15px/1.4 system-ui, sans-serif; }
  .pip-langs { display: flex; align-items: center; gap: 4px; }
  .pip-langs select { flex: 1; min-width: 0; min-height: 36px; padding: 0 6px; border-radius: 8px; font: inherit; font-size: 14px;
    border: 1px solid var(--outline-variant, #c4c6d0); background: var(--surface-container, #f0f0f4); color: inherit; }
  .pip-btn { display: inline-grid; place-items: center; width: 36px; height: 36px; flex: none; padding: 0; border: 0;
    border-radius: 18px; background: none; color: inherit; cursor: pointer; }
  .pip-btn:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  .pip-btn:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--primary, #2C4777); outline-offset: 1px; }
  .pip-btn:disabled { opacity: .38; cursor: default; }
  .pip-btn svg { width: 20px; height: 20px; fill: currentColor; }
  textarea { flex: 1 1 40%; min-height: 56px; resize: none; padding: 8px; border-radius: 10px; font: inherit;
    border: 1px solid var(--outline-variant, #c4c6d0); background: var(--surface-container-lowest, #fff); color: inherit; }
  .pip-out { flex: 1 1 45%; min-height: 56px; overflow: auto; margin: 0; padding: 8px; border-radius: 10px;
    background: var(--surface-container, #f0f0f4); white-space: pre-wrap; overflow-wrap: anywhere; }
  .pip-out.muted { color: var(--on-surface-variant, #44474f); }
  .pip-out.error { color: var(--error, #ba1a1a); }
  .pip-actions { display: flex; justify-content: flex-end; gap: 4px; }
`;

function options(sel, codes, value) {
  sel.replaceChildren(...codes.map(([code, name]) => Object.assign(document.createElement('option'), { value: code, textContent: name, selected: code === value })));
}

/** Open the floating window, or bring it back to front when it's already open. */
export async function openPip() {
  if (!pipSupported()) return;
  if (win) { win.focus(); return; }
  win = await window.documentPictureInPicture.requestWindow({ width: 380, height: 320 });
  const doc = win.document;
  doc.title = 'OpenTranslate';
  // the app's colours (CSS variables) and theme, then the window's own layout
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    doc.head.append(Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: link.href }));
  }
  doc.head.append(Object.assign(doc.createElement('style'), { textContent: CSS }));
  const syncTheme = () => {
    const t = document.documentElement.dataset.theme;
    if (t) doc.documentElement.dataset.theme = t; else delete doc.documentElement.dataset.theme;
  };
  syncTheme();
  const themeObs = new MutationObserver(syncTheme);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  doc.documentElement.lang = 'en';
  doc.body.innerHTML = `
    <div class="pip-langs">
      <select id="pip-src" aria-label="Translate from"></select>
      <button class="pip-btn" type="button" id="pip-swap" aria-label="Swap languages" title="Swap languages">${icon('swap')}</button>
      <select id="pip-tgt" aria-label="Translate to"></select>
    </div>
    <textarea id="pip-in" placeholder="Type or paste text" aria-label="Text to translate" spellcheck="true"></textarea>
    <p class="pip-out muted" id="pip-out" aria-live="polite">Translation</p>
    <div class="pip-actions">
      <button class="pip-btn" type="button" id="pip-speak" aria-label="Listen to translation" title="Listen" disabled>${icon('volume')}</button>
      <button class="pip-btn" type="button" id="pip-copy" aria-label="Copy translation" title="Copy" disabled>${icon('copy')}</button>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  const src = $('pip-src'); const tgt = $('pip-tgt'); const input = $('pip-in'); const out = $('pip-out');
  let last = null;   // { text, target, input, source }
  let req = 0;
  let timer = 0;

  const renderLangs = () => {
    const langs = state.languages.map((l) => [l.code, l.name]);
    options(src, [['auto', 'Detect language'], ...langs], state.source);
    options(tgt, langs, state.target);
  };
  const show = (text, cls = '') => {
    out.className = `pip-out ${cls}`.trim();
    out.textContent = text;
  };
  const setActions = (on) => { $('pip-speak').disabled = !on; $('pip-copy').disabled = !on; };

  async function run() {
    const text = input.value;
    const id = ++req;
    if (!text.trim()) { last = null; setActions(false); show('Translation', 'muted'); return; }
    try {
      let source = state.source;
      if (source === 'auto') {
        try { const d = await detect(text); if (d) source = d.language; } catch { /* the service detects */ }
      }
      const res = await translate(text, source, state.target);
      if (id !== req) return;
      last = { text: res.text, target: state.target, input: text, source };
      show(res.text);
      out.lang = state.target;
      out.dir = isRtl(state.target) ? 'rtl' : 'ltr';
      setActions(true);
    } catch (err) {
      if (id !== req) return;
      last = null; setActions(false);
      const { title, message } = describeError(err);
      show(`${title}. ${message || ''}`.trim(), 'error');
    }
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(run, 350); };

  renderLangs();
  input.addEventListener('input', soon);
  input.addEventListener('blur', () => { if (last) history.add({ text: last.input, result: last.text, source: last.source, target: last.target }); });
  src.addEventListener('change', () => setSource(src.value));
  tgt.addEventListener('change', () => setTarget(tgt.value));
  $('pip-swap').addEventListener('click', () => {
    const from = state.source === 'auto' ? (state.detected?.language || null) : state.source;
    if (!from) return;
    if (last) input.value = last.text;
    setPair(state.target, from);
  });
  $('pip-copy').addEventListener('click', async () => {
    if (!last) return;
    try { await win.navigator.clipboard.writeText(last.text); } catch { await navigator.clipboard.writeText(last.text).catch(() => {}); }
    $('pip-copy').setAttribute('aria-label', 'Copied');
    setTimeout(() => $('pip-copy')?.setAttribute('aria-label', 'Copy translation'), 1500);
  });
  $('pip-speak').addEventListener('click', () => { if (last) speak(last.text, last.target).catch(() => {}); });

  // languages or services changed in the main window: follow them
  const unsub = subscribe((_, patch) => {
    if ('languages' in patch || 'source' in patch || 'target' in patch) renderLangs();
    if ('target' in patch || 'source' in patch || 'provider' in patch || 'mode' in patch) soon();
  });

  win.addEventListener('pagehide', () => {
    unsub(); themeObs.disconnect(); clearTimeout(timer); stopSpeaking();
    win = null;
  }, { once: true });
  input.focus();
}
