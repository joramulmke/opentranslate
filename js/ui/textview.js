// Text view: input, output, live translation, swap, copy, speak, star, mic.
// On phones it also drives the home ↔ typing ("edit") states of the reference layout:
//   home: big "Translate text" sheet + language pills + Conversation · Mic · Camera
//   edit: input focused or holding text; top bar becomes back · history/clear · pen · more
import { state, subscribe, set, langName, detect, translate, describeError, errorText, warmUp, setSource, setMode, fallbackNote } from '../state.js';
import { settings, history, phrasebook, onChange, recentLangs } from '../store.js';
import { isRtl } from '../languages.js';
import { createLangBar } from './langbar.js';
import { pickLanguage } from './langpicker.js';
import { icon } from './icons.js';
import { toast, copyToClipboard } from './snackbar.js';
import { wiktionaryLink } from '../features/wiktionary.js';
import { isPhone } from './layout.js';
import { wordMarker } from './wordmark.js';
import { showCard } from './showcard.js';
import { speak, stopSpeaking, nextIsSlow, canDictate, dictate, dictationMessage } from '../features/speech.js';
import { ensureMicrophone } from '../features/permissions.js';
import { downloadPacks, formatMB } from './offlineui.js';

const $ = (id) => document.getElementById(id);
export const MAX = 5000;   // characters the text box holds
const DEBOUNCE_MS = 550;
const HISTORY_IDLE_MS = 2500;

let el;
let reqId = 0;
let debounceTimer = null;
let historyTimer = null;
let skeletonTimer = null;
let result = null;          // { text, source, target, input, mock }
let stopDictation = null;
let navigate = () => {};
let openSettings = () => {};
let visible = false;
let editing = false;        // phone "edit" state latch: set on focus, cleared by Back

export function initTextView(opts) {
  navigate = opts.navigate;
  openSettings = opts.openSettings;
  el = {
    app: $('app'), view: $('view-text'), panes: $('text-panes'), input: $('src-text'), clear: $('btn-clear'), count: $('char-count'),
    srcLabel: $('src-label'), tgtLabel: $('tgt-label'), translateBtn: $('btn-translate'),
    mic: $('btn-mic'), homeMic: $('home-mic'), toCamera: $('btn-to-camera'), paste: $('btn-paste'),
    speakSrc: $('btn-speak-src'), copySrc: $('btn-copy-src'),
    outCard: $('output-card'), placeholder: $('out-placeholder'), skeleton: $('out-skeleton'),
    out: $('out-text'), err: $('out-error'), errTitle: $('out-error-title'), errMsg: $('out-error-msg'), errNote: $('out-error-note'),
    errActions: $('out-error-actions'), divider: $('out-divider'), mockChip: $('mock-chip'), why: $('btn-why'), whyList: $('why-list'),
    speakBtn: $('btn-speak'), copyBtn: $('btn-copy'), shareBtn: $('btn-share'), showBtn: $('btn-show'), starBtn: $('btn-star'),
    inputCard: $('input-card'), live: $('out-live'), wikt: $('wikt-link'),
  };

  createLangBar(el.view.querySelector('[data-langbar]'), { onSwap: swapTexts });

  el.input.addEventListener('input', onInput);
  el.input.addEventListener('focus', () => { warmUp(); if (!editing) { editing = true; applyMode(); } });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runTranslate({ commit: true }); }
    if (e.key === 'Escape' && isPhone() && editing) { e.preventDefault(); exitEdit(); }
  });
  el.input.addEventListener('blur', commitHistorySoon);
  // tapping anywhere on the empty home sheet starts typing, like the reference
  el.panes.addEventListener('click', (e) => {
    if (!isPhone() || e.target.closest('button, textarea, a, .output-card')) return;
    el.input.focus();
  });
  el.clear.addEventListener('click', () => clearText());
  el.translateBtn.addEventListener('click', () => runTranslate({ commit: true }));
  el.copyBtn.addEventListener('click', copyResult);
  // the phone's share menu (WhatsApp, email…); only where the browser can share text
  el.shareBtn.hidden = typeof navigator.share !== 'function';
  el.shareBtn.addEventListener('click', shareResult);
  el.showBtn.addEventListener('click', () => {
    if (!result) return;
    stopSpeaking();
    commitHistory();
    showCard(result.text, result.target);
  });
  el.why?.addEventListener('click', () => {
    const open = el.whyList.hidden;
    el.whyList.hidden = !open;
    el.why.setAttribute('aria-expanded', String(open));
  });
  el.speakBtn.addEventListener('click', toggleSpeak);
  el.starBtn.addEventListener('click', toggleStar);
  el.mic.addEventListener('click', toggleMic);
  el.homeMic.addEventListener('click', toggleMic);
  el.toCamera.addEventListener('click', () => navigate('camera'));
  el.paste.addEventListener('click', pasteText);
  el.speakSrc.addEventListener('click', speakSource);
  el.copySrc.addEventListener('click', async () => {
    if (!el.input.value) return;
    await copyText(el.input.value);
    toast('Text copied');
  });

  // re-translate when languages or provider change
  let last = { source: state.source, target: state.target, provider: state.provider };
  subscribe((s) => {
    renderLabels();
    const changed = s.source !== last.source || s.target !== last.target || s.provider !== last.provider;
    last = { source: s.source, target: s.target, provider: s.provider };
    if (changed && el.input.value.trim()) runTranslate();
    if (changed && !el.input.value.trim()) clearOutput();
  });
  onChange((what) => { if (what === 'settings') renderLive(); });

  renderLabels();
  renderLive();
  updateCount();
  wireDivider();
  autosize();
}

/* ---------------- phone states ---------------- */

function applyMode() {
  if (!visible) { el.app.dataset.mode = 'view'; return; }
  el.app.dataset.mode = editing || el.input.value.length ? 'edit' : 'home';
}

function renderLive() {
  el.app.dataset.live = settings.get().liveTranslate ? 'on' : 'off';
}

/** Back arrow (phones): keep the translation in history, clear the input, return home. */
export function exitEdit() {
  commitHistory();
  stopDictation?.();
  editing = false;
  setInput('');
  el.input.blur();
  applyMode();
  $('main').focus({ preventScroll: true });
}

export function clearText() {
  commitHistory();
  setInput('');
  el.input.focus();
}

export function onShow() { visible = true; applyMode(); requestAnimationFrame(autosize); }
export function onHide() { visible = false; applyMode(); stopSpeaking(); stopDictation?.(); }
export function onLayoutChange() { applyMode(); autosize(); }
export const getInput = () => (el ? el.input.value : '');
export function focusInput() {
  editing = true;
  applyMode();
  el.input.focus();
  const n = el.input.value.length;
  el.input.setSelectionRange(n, n);
}

/* ---------------- input ---------------- */

function onInput() {
  updateCount();
  autosize();
  result && el.out.classList.add('stale');
  clearTimeout(debounceTimer);
  clearTimeout(historyTimer);
  if (!el.input.value.trim()) { clearOutput(); if (state.source === 'auto') set({ detected: null }); return; }
  // live translation also when only the other mode has a service (it stands in, and says so)
  if (settings.get().liveTranslate && (state.provider || state.classic || state.advanced)) {
    debounceTimer = setTimeout(() => runTranslate(), DEBOUNCE_MS);
  }
}

function updateCount() {
  const n = el.input.value.length;
  el.count.textContent = `${n.toLocaleString()} / ${MAX.toLocaleString()}`;
  el.count.classList.toggle('near', n > MAX * 0.95);
  el.clear.hidden = n === 0;
  el.app.dataset.hasText = n ? '1' : '0';
  sizeTexts();
  if (n && !editing) { editing = true; }
  applyMode();
}

// Phone: the text box grows with the text up to about a third of the screen, then scrolls inside, so the
// translation always starts in the top half. The line between the two (#out-divider) resizes it by hand;
// the chosen size (a share of the screen) is remembered, double-tap goes back to automatic.
const SIZE_KEY = 'ot.inputSize.v1';
const AUTO_SHARE = 0.36;
let inputShare = (() => { try { const v = Number(localStorage.getItem(SIZE_KEY)); return v > 0 ? v : null; } catch { return null; } })();
const MIN_SHARE = 0.1, MAX_SHARE = 0.75;

function autosize() {
  el.input.style.height = 'auto';
  if (!isPhone()) {
    el.input.style.height = Math.min(el.input.scrollHeight + 2, window.innerHeight * 0.5) + 'px';
    return;
  }
  // the card's label and buttons take part of the share; the text box gets the rest (at least 2 lines)
  const chrome = el.inputCard.offsetHeight - el.input.offsetHeight;
  const room = (share) => Math.max(72, Math.round(window.innerHeight * share - chrome));
  const h = inputShare ? room(inputShare) : Math.min(el.input.scrollHeight + 2, room(AUTO_SHARE));
  el.input.style.height = h + 'px';
  updateDivider();
}

function updateDivider() {
  const d = el.divider;
  if (!d) return;
  const pct = Math.round((inputShare || AUTO_SHARE) * 100);
  d.setAttribute('aria-valuenow', String(pct));
  d.setAttribute('aria-valuetext', inputShare ? `Text box: ${pct}% of the screen` : 'Text box: automatic size');
}

function setInputShare(share) {
  inputShare = share == null ? null : Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
  try { inputShare == null ? localStorage.removeItem(SIZE_KEY) : localStorage.setItem(SIZE_KEY, String(inputShare.toFixed(3))); } catch { /* private mode */ }
  autosize();
}

function wireDivider() {
  const d = el.divider;
  if (!d) return;
  let drag = null;
  let lastTap = 0;   // double tap = automatic size (the browser's dblclick is unreliable on touch screens)
  d.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, card: el.inputCard.getBoundingClientRect().height, moved: false };
    d.classList.add('dragging');
  });
  d.addEventListener('pointermove', (e) => {
    if (!drag || (!drag.moved && Math.abs(e.clientY - drag.y) < 4)) return;
    drag.moved = true;
    setInputShare((drag.card + e.clientY - drag.y) / window.innerHeight);
  });
  const end = (e) => {
    if (drag && !drag.moved && e.type === 'pointerup') {
      if (e.timeStamp - lastTap < 400) { setInputShare(null); lastTap = 0; } else lastTap = e.timeStamp;
    }
    drag = null; d.classList.remove('dragging');
  };
  d.addEventListener('pointerup', end);
  d.addEventListener('pointercancel', end);
  d.addEventListener('keydown', (e) => {
    const now = inputShare || el.inputCard.getBoundingClientRect().height / window.innerHeight;
    const step = { ArrowUp: -0.05, ArrowDown: 0.05 }[e.key];
    if (step) setInputShare(now + step);
    else if (e.key === 'Home') setInputShare(MIN_SHARE);
    else if (e.key === 'End') setInputShare(MAX_SHARE);
    else if (e.key === 'Enter' || e.key === ' ') setInputShare(null);
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', () => requestAnimationFrame(autosize));
}

/** Public: put text into the input (from camera, handwriting, history). */
export function setInput(text, { translateNow = false, source, target } = {}) {
  el.input.value = text.slice(0, MAX);
  clearTimeout(debounceTimer);
  updateCount();
  autosize();
  if (source && source !== state.source) setSource(source);
  if (target && target !== state.target) { set({ target }); settings.set({ target }); }
  if (!text.trim()) { clearOutput(); if (state.source === 'auto') set({ detected: null }); return; }
  if (translateNow) runTranslate({ commit: true });
}

async function pasteText() {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) { toast('Clipboard is empty'); return; }
    setInput(t, { translateNow: true });
    focusInput();
  } catch {
    toast('Paste is blocked here. Long-press the text box and choose Paste.');
    focusInput();
  }
}

/* ---------------- translation ---------------- */

async function runTranslate({ commit = false } = {}) {
  clearTimeout(debounceTimer);
  const text = el.input.value;
  if (!text.trim()) { clearOutput(); return; }
  const id = ++reqId;
  showLoading();
  try {
    let source = state.source;
    let detected = null;
    if (source === 'auto') {
      try {
        detected = await detect(text);
      } catch (e) {
        if (e.code !== 'BAD_RESPONSE') throw e;   // fall back to provider-side auto below
      }
      if (id !== reqId) return;
      if (detected) { set({ detected }); source = detected.language; }
    }
    // typed in the language you translate into ("Detect language" → English, English typed):
    // translate the other way, into the last other language you used
    const target = state.source === 'auto' && detected && base(detected.language) === base(state.target) ? otherTarget() : state.target;
    const res = await translate(text, source, target);
    if (id !== reqId) return;
    if (state.source === 'auto' && !detected && res.detected) {
      set({ detected: { language: res.detected, confidence: 1 } });
      source = res.detected;
    }
    showResult({ text: res.text, source, target, input: text, mock: !!state.provider?.isMock && !res.note, via: res.via, note: res.note, tried: res.tried, answered: res.answered || res.via });
    if (commit) commitHistory(); else commitHistorySoon();
  } catch (err) {
    if (id !== reqId) return;
    showError(err);
  }
}

const base = (c) => String(c || '').split('-')[0];
/** The language to translate into when the text is already in the target language. */
function otherTarget() {
  const other = recentLangs.get('target').find((c) => base(c) !== base(state.target));
  return other || (base(state.target) === 'en' ? 'es' : 'en');
}

/** Your text and its translation always share one size: smaller when either one is long. */
function sizeTexts() {
  const long = Math.max(el.input.value.length, result && !el.out.hidden ? result.text.length : 0) > 120;
  el.input.classList.toggle('long', long);
  el.out.classList.toggle('long', long);
}

function setOutState(s) { el.outCard.dataset.state = s; }

function showLoading() {
  el.outCard.setAttribute('aria-busy', 'true');
  el.err.hidden = true;
  clearTimeout(skeletonTimer);
  // only show the skeleton if the answer is slow; avoids flicker while typing
  skeletonTimer = setTimeout(() => {
    if (el.outCard.getAttribute('aria-busy') === 'true' && !result) {
      el.placeholder.hidden = true; el.skeleton.hidden = false; setOutState('loading');
    }
  }, 180);
  el.translateBtn.disabled = true;
}

function endLoading() {
  clearTimeout(skeletonTimer);
  el.outCard.setAttribute('aria-busy', 'false');
  el.skeleton.hidden = true;
  el.translateBtn.disabled = false;
}

/** "Why?" under the note: every service that was tried, what went wrong, and which one answered. */
function showWhy(tried, answered) {
  if (!el.why) return;
  el.why.hidden = !tried.length;
  el.why.setAttribute('aria-expanded', 'false');
  el.whyList.hidden = true;
  el.whyList.replaceChildren(...tried.map((t) => {
    const li = document.createElement('li');
    li.textContent = `${t.name}: ${t.reason}`;
    return li;
  }), ...(tried.length && answered ? [Object.assign(document.createElement('li'), { className: 'why-ok', textContent: `${answered}: translated this` })] : []));
}

const arrow = () => { const a = document.createElement('span'); a.setAttribute('aria-hidden', 'true'); a.textContent = '↗'; return a; };

/** "Look up "test" on Wiktionary": only for a word or a few, never a sentence. */
function showWiktionary(r) {
  if (!el.wikt) return;
  const link = r && wiktionaryLink(r);
  el.wikt.hidden = !link;
  if (!link) return;
  el.wikt.href = link.url;
  const w = document.createElement('span');
  w.lang = r.target; w.textContent = link.word;
  el.wikt.replaceChildren('Look up “', w, '” on Wiktionary ', arrow());
  el.wikt.setAttribute('aria-label', `Look up ${link.word} on Wiktionary (opens in a new tab)`);
}

function showResult(r) {
  endLoading();
  result = r;
  setOutState('result');
  el.placeholder.hidden = true;
  el.err.hidden = true;
  el.out.hidden = false;
  el.out.textContent = r.text;
  el.out.lang = r.target;
  el.out.dir = isRtl(r.target) ? 'rtl' : 'ltr';
  el.out.classList.remove('stale');
  sizeTexts();
  // "Offline demo translation", or which service answered when the first choice couldn't
  el.mockChip.textContent = r.mock ? 'Offline demo translation' : fallbackNote(r);
  el.mockChip.hidden = !r.mock && !r.via && !r.note;
  showWhy(r.mock ? [] : r.tried || [], r.answered);
  showWiktionary(r.mock ? null : r);
  // one short polite announcement instead of a live region around the whole card
  if (el.live) {
    const t = document.createElement('span');
    t.lang = r.target; t.textContent = r.text;
    el.live.replaceChildren(`${langName(r.target)}: `, t, el.mockChip.hidden ? '' : `. ${el.mockChip.textContent}`);
  }
  setOutputActions(true);
  renderStar();
  renderLabels();
}

function showError(err) {
  endLoading();
  result = null;
  showWiktionary(null);
  setOutState('error');
  const { code, title, message } = describeError(err);
  el.placeholder.hidden = true;
  el.out.hidden = true;
  el.mockChip.hidden = true;
  showWhy([]);
  el.err.hidden = false;
  el.errTitle.textContent = title;
  el.errMsg.textContent = message;
  // a first download is a normal step, not a failure: calm colours, a download icon, no alert
  const prompt = code === 'NEEDS_DOWNLOAD';
  el.err.classList.toggle('prompt', prompt);
  el.err.setAttribute('role', prompt ? 'status' : 'alert');
  el.err.querySelector('.ic')?.replaceWith(document.createRange().createContextualFragment(icon(prompt ? 'download' : 'warning')));
  el.errNote.textContent = err?.detail?.source || '';
  el.errNote.hidden = !el.errNote.textContent;
  el.errActions.innerHTML = '';
  const action = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'text-btn'; b.textContent = label;
    b.addEventListener('click', fn);
    el.errActions.append(b);
  };
  if (code === 'NEEDS_DOWNLOAD') {
    const { langs = [], size, download } = err.detail || {};
    action(`Download${size ? ` (${formatMB(size)})` : ''}`, (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const onProgress = (p) => { btn.textContent = `Downloading… ${Math.round(p * 100)}%`; };
      // offline language packs, or another download the error brings along (the on-device AI model)
      (download ? download(onProgress) : downloadPacks(langs, { onProgress })).then(() => runTranslate({ commit: true }), (er) => {
        btn.disabled = false; btn.textContent = 'Try again';
        // e.g. Gemini Nano: the reason names an address to paste into Chrome, which a page can't link to
        const copy = er.detail?.copy;
        toast(errorText(er), copy ? { action: 'Copy address', onAction: () => copyToClipboard(copy, 'Copied. Paste it into Chrome’s address bar.') } : {});
      });
    });
  }
  if (err?.detail?.copy) action(`Copy ${err.detail.copy}`, () => copyToClipboard(err.detail.copy, 'Copied. Paste it into Chrome’s address bar.'));
  const switchTo = err?.detail?.switchTo;
  if (switchTo) action(`Use ${switchTo === 'advanced' ? 'Advanced' : 'Classic'}`, () => { setMode(switchTo); runTranslate({ commit: true }); });
  if (code === 'NO_PROVIDER' || code === 'AUTH' || code === 'BROWSER_BLOCKED') action('Open settings', openSettings);
  if (code === 'UNSUPPORTED_PAIR') action('Change language', async () => {
    const c = await pickLanguage({ side: 'target', selected: state.target });
    if (c) { set({ target: c }); settings.set({ target: c }); }
  });
  if (code === 'NETWORK') action('Settings', openSettings);
  if (['NETWORK', 'RATE_LIMIT', 'SERVER', 'BAD_RESPONSE'].includes(code)) action('Try again', () => runTranslate({ commit: true }));
  setOutputActions(false);
}

function clearOutput() {
  ++reqId;
  endLoading();
  result = null;
  setOutState('empty');
  stopSpeaking();
  el.out.hidden = true;
  el.out.textContent = '';
  el.err.hidden = true;
  el.mockChip.hidden = true;
  showWhy([]);
  showWiktionary(null);
  el.placeholder.hidden = false;
  if (el.live) el.live.textContent = '';
  setOutputActions(false);
  renderStar();
}

function setOutputActions(on) {
  el.speakBtn.disabled = !on;
  if (!el.speakBtn.dataset.speaking) {
    const l = on && result && nextIsSlow(result.text, result.target) ? 'Listen again, slower' : 'Listen to translation';
    el.speakBtn.setAttribute('aria-label', l);
    el.speakBtn.title = l;
  }
  el.copyBtn.disabled = !on;
  el.shareBtn.disabled = !on;
  el.showBtn.disabled = !on;
  el.starBtn.disabled = !on;
}

function renderLabels() {
  const det = state.detected?.language;
  if (state.source === 'auto') {
    el.srcLabel.innerHTML = det && el.input.value.trim()
      ? `<span class="detected">${langName(det)}</span> · Detected`
      : 'Detect language';
  } else {
    el.srcLabel.textContent = langName(state.source);
  }
  // the language this translation is really in (it can be the other one, see otherTarget)
  el.tgtLabel.textContent = langName(result && el.input.value.trim() ? result.target : state.target);
  const srcLang = state.source === 'auto' ? det : state.source;
  if (srcLang) { el.input.lang = srcLang; el.input.dir = isRtl(srcLang) ? 'rtl' : 'auto'; }
  else { el.input.removeAttribute('lang'); el.input.dir = 'auto'; }
  el.placeholder.lang = 'en';
}

/* ---------------- history ---------------- */

const entry = () => result && { text: result.input, result: result.text, source: result.source, target: result.target };

function commitHistory() {
  clearTimeout(historyTimer);
  const e = entry();
  if (e) history.add(e);
}
function commitHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, HISTORY_IDLE_MS);
}

/* ---------------- swap ---------------- */

function swapTexts() {
  stopSpeaking();
  const hasResult = result && !el.out.hidden;
  if (!hasResult) return true; // langbar swaps languages; subscription re-translates any input
  const oldIn = result.input;
  const oldOut = result.text;
  const from = result.source;
  const to = result.target;
  ++reqId; // cancel in-flight
  // swap the panes' contents, animating like the reference app
  el.input.value = oldOut;
  updateCount(); autosize();
  result = { text: oldIn, source: to, target: from, input: oldOut, mock: result.mock };
  // Suppress the subscription's re-translate: we already have both sides.
  queueMicrotask(() => { ++reqId; showResult(result); });
  el.input.classList.remove('slide-from-right'); el.out.classList.remove('slide-from-left');
  void el.input.offsetWidth;
  el.input.classList.add('slide-from-right');
  el.out.classList.add('slide-from-left');
  setTimeout(() => { el.input.classList.remove('slide-from-right'); el.out.classList.remove('slide-from-left'); }, 400);
  set({ detected: null });
  return true;
}

/* ---------------- actions ---------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

async function copyResult() {
  if (!result) return;
  await copyText(result.text);
  commitHistory();
  toast('Translation copied');
}

async function shareResult() {
  if (!result) return;
  const text = result.text;
  commitHistory();
  try {
    await navigator.share({ text });
  } catch (e) {
    if (e?.name === 'AbortError') return;   // closed the share menu
    await copyText(text);
    toast('Couldn’t open sharing. Translation copied instead');
  }
}

function speakSource() {
  const text = el.input.value.trim();
  if (!text) return;
  const lang = state.source === 'auto' ? (state.detected?.language || 'en') : state.source;
  speak(text, lang).catch((e) => {
    toast(e.message === 'NO_TTS' ? 'Read aloud is not supported in this browser' : `No ${langName(lang)} voice on this device`);
  });
}

let speakLabelTimer = null;
function toggleSpeak() {
  if (!result) return;
  if (el.speakBtn.dataset.speaking) { stopSpeaking(); return; }
  const btn = el.speakBtn;
  const { text, target } = result;
  const setIcon = (on, slow) => {
    btn.innerHTML = icon(on ? 'stop' : 'volume');
    // right after a play, the next one is slower (pronunciation practice): say so on the button
    const again = !on && nextIsSlow(text, target);
    // not "Stop listening": that's the mic's label (stop dictation)
    const label = on ? (slow ? 'Stop reading aloud (playing slower)' : 'Stop reading aloud') : again ? 'Listen again, slower' : 'Listen to translation';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    if (on) btn.dataset.speaking = '1'; else delete btn.dataset.speaking;
    clearTimeout(speakLabelTimer);
    if (again) speakLabelTimer = setTimeout(() => { if (!btn.dataset.speaking) setIcon(false); }, 10500);
  };
  speak(text, target, { onStart: (slow) => setIcon(true, slow), onEnd: () => setIcon(false), onWord: wordMarker(el.out) })
    .catch((e) => {
      setIcon(false);
      toast(e.message === 'NO_TTS' ? 'Read aloud is not supported in this browser' : `No ${langName(result.target)} voice on this device`);
    });
  commitHistory();
}

function toggleStar() {
  const e = entry();
  if (!e) return;
  const added = phrasebook.toggle(e);
  commitHistory();
  renderStar();
  toast(added ? 'Translation saved' : 'Removed from saved translations', {
    action: 'Undo', onAction: () => { phrasebook.toggle(e); renderStar(); },
  });
}

function renderStar() {
  const e = entry();
  const on = !!e && phrasebook.has(e);
  el.starBtn.setAttribute('aria-pressed', String(on));
  el.starBtn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save translation');
  el.starBtn.innerHTML = icon(on ? 'star' : 'starBorder');
}
export const refreshStar = () => el && renderStar();

function setMicPressed(on) {
  for (const b of [el.mic, el.homeMic]) {
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Stop listening' : 'Translate by voice');
  }
}

async function toggleMic() {
  if (stopDictation) { stopDictation(); return; }
  if (!canDictate()) { toast(dictationMessage('UNSUPPORTED'), { duration: 6000 }); return; }
  if (!(await ensureMicrophone())) return;
  const before = el.input.value ? el.input.value.replace(/\s*$/, ' ') : '';
  const lang = state.source === 'auto' ? (state.detected?.language || navigator.language) : state.source;
  setMicPressed(true);
  const done = () => { stopDictation = null; setMicPressed(false); };
  const placeholder = el.input.placeholder;
  const restore = () => { el.input.placeholder = placeholder; };
  stopDictation = dictate(lang, {
    autoLang: state.source === 'auto',   // recorded audio: let the model detect the language
    onState: (st) => {
      el.input.placeholder = st === 'listening' ? 'Listening…' : st === 'transcribing' ? 'Transcribing…' : st;
    },
    onText: (t) => { restore(); el.input.value = before + t; onInput(); },
    onEnd: () => { done(); restore(); if (el.input.value.trim()) runTranslate({ commit: true }); },
    onError: (e) => {
      done(); restore();
      const m = dictationMessage(e);
      if (m) toast(m, { duration: 6000 });
    },
  });
}
