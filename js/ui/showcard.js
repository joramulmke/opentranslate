// Show to someone (IDEAS #15): the translation alone, as big as fits, full screen. Reads it aloud after
// 5 seconds (Stop cancels), keeps the screen on, and marks each word while reading (#16).
import { speak, stopSpeaking, canReadAloud } from '../features/speech.js';
import { isRtl } from '../languages.js';
import { icon } from './icons.js';
import { wordMarker, clearWordMark } from './wordmark.js';

const DELAY = 5;
let dlg, textEl, statusEl, playBtn, closeBtn;
let lang = '';
let countdown = 0;     // interval id while counting down
let speaking = false;
let lock = null;
let wentFullscreen = false;

function build() {
  dlg = document.getElementById('show-card');
  textEl = document.getElementById('show-text');
  statusEl = document.getElementById('show-status');
  playBtn = document.getElementById('show-play');
  closeBtn = document.getElementById('show-close');
  closeBtn.addEventListener('click', close);
  playBtn.addEventListener('click', () => {
    if (countdown || speaking) { stopAll(); return; }
    read();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Escape, phone Back
  dlg.addEventListener('close', cleanup);
  // Back (or Escape) leaves full screen first: then close the card too
  document.addEventListener('fullscreenchange', () => { if (wentFullscreen && !document.fullscreenElement && dlg.open) close(); });
  document.addEventListener('visibilitychange', () => { if (dlg.open && document.visibilityState === 'visible') keepAwake(); });
  new ResizeObserver(() => { if (dlg.open) fit(); }).observe(dlg);
}

/** The biggest font size at which the whole text fits the card. */
function fit() {
  const box = textEl.parentElement;
  const cs = getComputedStyle(box);
  const h = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // words stay whole (no hyphens), so the longest word decides the width; only when even the
  // smallest size is too wide may a word break
  textEl.classList.remove('break');
  const fits = (px) => { textEl.style.fontSize = `${px}px`; return textEl.scrollHeight <= h && textEl.scrollWidth <= w; };
  let lo = 16, hi = 400;
  if (fits(hi)) return;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
  if (!fits(lo)) textEl.classList.add('break');
}

async function keepAwake() {
  if (!navigator.wakeLock || (lock && !lock.released)) return;
  try { lock = await navigator.wakeLock.request('screen'); } catch { /* not allowed: the screen dims as usual */ }
  if (!dlg.open) { lock?.release().catch(() => {}); lock = null; }
}

function setButton(state) {
  // state: 'counting' | 'speaking' | 'idle'
  const stop = state !== 'idle';
  playBtn.innerHTML = `${icon(stop ? 'stop' : 'volume')}<span>${stop ? 'Stop' : 'Play'}</span>`;
  playBtn.setAttribute('aria-label', stop ? (state === 'counting' ? 'Stop: don’t read aloud' : 'Stop reading aloud') : 'Read aloud');
}

function startCountdown() {
  let left = DELAY;
  const tick = () => { statusEl.textContent = `Reading aloud in ${left}…`; };
  tick();
  setButton('counting');
  countdown = setInterval(() => {
    left -= 1;
    if (left > 0) { tick(); return; }
    clearInterval(countdown); countdown = 0;
    read(true);
  }, 1000);
}

function read(auto = false) {
  statusEl.textContent = '';
  speaking = true;
  setButton('speaking');
  speak(textEl.textContent, lang, {
    normalSpeed: auto,   // the first reading is at normal speed; pressing Play again right after is slower
    onWord: wordMarker(textEl),
    onEnd: () => { speaking = false; if (dlg.open) setButton('idle'); },
  }).catch(() => {
    speaking = false;
    if (!dlg.open) return;
    setButton('idle');
    statusEl.textContent = 'No voice for this language on this device.';
  });
}

function stopAll() {
  if (countdown) { clearInterval(countdown); countdown = 0; statusEl.textContent = ''; }
  if (speaking) { speaking = false; stopSpeaking(); }
  clearWordMark();
  setButton('idle');
}

function cleanup() {
  stopAll();
  lock?.release().catch(() => {}); lock = null;
  if (wentFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wentFullscreen = false;
  opener?.focus();
}
let opener = null;

function close() { if (dlg.open) dlg.close(); }

/** Show text (in language l) full screen to someone. */
export async function showCard(text, l) {
  if (!dlg) build();
  if (!text) return;
  opener = document.activeElement;
  lang = l;
  textEl.textContent = text;
  textEl.lang = l;
  textEl.dir = isRtl(l) ? 'rtl' : 'ltr';
  statusEl.textContent = '';
  dlg.showModal();
  closeBtn.focus();
  // real full screen where the browser allows it (not iPhone Safari): the card fills the page anyway
  if (document.fullscreenEnabled && !document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); wentFullscreen = true; } catch { /* fine */ }
  }
  fit();
  keepAwake();
  const voice = canReadAloud(l);
  playBtn.hidden = !voice;
  if (voice) startCountdown();
}
