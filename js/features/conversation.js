// Conversation: setup sheet first, then the conversation screen (same flow at every width).
//  Setup:  their language ⇄ your language, mode (Listening · Conversation · Text only),
//          optional face-to-face split screen, Start.
//  Screen: language pair on top, transcript (translation large, original small, newest last),
//          mode pill + big mic + keyboard at the bottom.
//  Modes:  listening    = only their language is captured, translated into yours, captions only
//          conversation = take turns (alternates automatically), translations read aloud
//          text         = take turns, nothing read aloud
import { translate, describeError, langName } from '../state.js';
import { settings } from '../store.js';
import { isRtl } from '../languages.js';
import { pickLanguage, escapeHtml } from '../ui/langpicker.js';
import { setupDialog, openDialog, closeDialog } from '../ui/sheet.js';
import { icon } from '../ui/icons.js';
import { speak, stopSpeaking, canDictate, dictate, dictationMessage } from './speech.js';
import { ensureMicrophone } from './permissions.js';
import { toast } from '../ui/snackbar.js';

const $ = (id) => document.getElementById(id);
const KEY = 'ot.conversation.v1';
const MODES = {
  listening: { label: 'Listening', icon: 'headphones' },
  conversation: { label: 'Conversation', icon: 'voiceOver' },
  text: { label: 'Text only', icon: 'notes' },
};
const other = (w) => (w === 'them' ? 'me' : 'them');
const MAX_QUIET_RESTARTS = 2;   // Listening: how often silence may restart the mic before pausing

export function initConversation({ leave = () => {} } = {}) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const langs = {
    them: saved.them || saved.b || 'es',   // older saves used a (person 1, you) / b (person 2)
    me: saved.me || saved.a || 'en',
  };
  let mode = MODES[saved.mode] ? saved.mode : 'conversation';
  let split = !!saved.split;
  let turn = 'me';
  let utterances = [];
  let stopDictation = null;
  let userStopped = false;
  let quiet = 0;
  let typing = false;
  let visible = false;

  const view = $('view-conversation');
  const sheetEl = $('convo-sheet');
  const shared = $('convo-shared');
  const splitBox = $('convo-split');
  const splitThem = $('split-them');
  const splitMe = $('split-me');
  const status = $('convo-status');
  const interim = $('convo-interim');
  const bigMic = $('convo-bigmic');
  const typeBtn = $('convo-type');
  const modeBtn = $('convo-mode');
  const turnBox = $('turn-toggle');
  const composer = $('convo-composer');
  const input = $('convo-input');
  const setup = setupDialog($('convo-setup'), { onClose: onSetupClosed });
  const modeRadios = [...setup.querySelectorAll('[role="radio"]')];
  const splitSwitch = $('setup-split');
  const clearBtn = $('setup-clear');
  let setupIsEntry = false;   // opened on entering the view: closing it without Start leaves the view

  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ them: langs.them, me: langs.me, mode, split })); } catch { /* */ }
  };
  const speakerNow = () => (mode === 'listening' ? 'them' : turn);
  const splitOn = () => split && mode !== 'listening';
  const dirOf = (code) => (isRtl(code) ? 'rtl' : 'auto');

  /* ---------------- setup sheet ---------------- */

  function openSetup({ entry = false } = {}) {
    setupIsEntry = entry;
    // Conversation vs Text only mirrors the "read conversation translations aloud" setting
    if (mode !== 'listening') mode = settings.get().speakConversation === false ? 'text' : 'conversation';
    splitSwitch.checked = split;
    clearBtn.hidden = !utterances.length;
    renderSetup();
    setup.returnValue = '';
    openDialog(setup);
    requestAnimationFrame(() => $('setup-start').focus());
  }

  function renderSetup() {
    for (const w of ['them', 'me']) {
      const b = setup.querySelector(`[data-setup-lang="${w}"]`);
      b.querySelector('.pill-label').textContent = langName(langs[w]);
      b.setAttribute('aria-label', `${w === 'them' ? 'Their' : 'Your'} language: ${langName(langs[w])}. Change`);
    }
    modeRadios.forEach((r) => {
      const on = r.dataset.mode === mode;
      r.setAttribute('aria-checked', String(on));
      r.tabIndex = on ? 0 : -1;
    });
  }

  function chooseMode(m) {
    mode = m;
    if (m !== 'listening') settings.set({ speakConversation: m === 'conversation' });
    persist();
    renderSetup();
    renderScreen();
  }

  function onSetupClosed() {
    const started = setup.returnValue === 'start';
    const entry = setupIsEntry;
    setupIsEntry = false;
    if (!visible) return;
    if (started) {
      persist();
      renderScreen();
      bigMic.focus();
    } else if (entry) {
      leave();          // like the reference: closing the first sheet returns to where you came from
    } else {
      $('convo-options').focus();
    }
  }

  setup.querySelectorAll('[data-setup-lang]').forEach((b) => b.addEventListener('click', () => changeLang(b.dataset.setupLang, b)));
  $('setup-swap').addEventListener('click', swapLangs);
  $('setup-start').addEventListener('click', () => closeDialog(setup, 'start'));
  splitSwitch.addEventListener('change', () => { split = splitSwitch.checked; persist(); renderScreen(); });
  clearBtn.addEventListener('click', () => {
    utterances = []; stopSpeaking(); renderTranscript(); clearBtn.hidden = true;
    toast('Transcript cleared');
    $('setup-start').focus();
  });
  const modesBox = $('setup-modes');
  modesBox.addEventListener('click', (e) => { const r = e.target.closest('[role="radio"]'); if (r) chooseMode(r.dataset.mode); });
  modesBox.addEventListener('keydown', (e) => {
    const i = modeRadios.findIndex((r) => r.dataset.mode === mode);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = modeRadios[(i + step + modeRadios.length) % modeRadios.length];
    chooseMode(next.dataset.mode);
    next.focus();
  });

  async function changeLang(who, returnTo) {
    const code = await pickLanguage({ side: 'target', selected: langs[who], heading: who === 'them' ? 'Their language' : 'Your language' });
    if (code) {
      if (code === langs[other(who)]) langs[other(who)] = langs[who];   // picking the other side's language swaps
      langs[who] = code;
      persist();
      renderSetup();
      renderScreen();
    }
    returnTo?.focus();
  }

  function swapLangs() {
    [langs.them, langs.me] = [langs.me, langs.them];
    persist();
    renderSetup();
    renderScreen();
  }

  /* ---------------- conversation screen ---------------- */

  function renderScreen() {
    for (const w of ['them', 'me']) {
      const b = view.querySelector(`[data-convo-lang="${w}"]`);
      b.querySelector('.pill-label').textContent = langName(langs[w]);
      b.setAttribute('aria-label', `${w === 'them' ? 'Their' : 'Your'} language: ${langName(langs[w])}. Change`);
      b.lang = 'en';
      const t = turnBox.querySelector(`[data-turn="${w}"]`);
      t.textContent = langName(langs[w]);
      t.setAttribute('aria-pressed', String(turn === w));
      t.setAttribute('aria-label', `${w === 'them' ? 'Their' : 'Your'} turn: ${langName(langs[w])}`);
    }
    const m = MODES[mode];
    modeBtn.innerHTML = `${icon(m.icon)}<span id="convo-mode-label">${m.label}</span>`;
    modeBtn.setAttribute('aria-label', `Mode: ${m.label}. Change setup`);
    turnBox.hidden = mode === 'listening';
    view.classList.toggle('is-split', splitOn());
    shared.hidden = splitOn();
    splitBox.hidden = !splitOn();
    renderMic();
    renderComposer();
  }

  function idleStatus() {
    const name = langName(langs[speakerNow()]);
    if (!canDictate()) return `Voice input isn't available here. Tap the keyboard to type in ${name}.`;
    if (mode === 'listening') return `Tap mic to start listening to ${name}`;
    return `Tap mic to start · ${name}`;
  }

  function renderMic() {
    const name = langName(langs[speakerNow()]);
    bigMic.setAttribute('aria-pressed', String(!!stopDictation));
    bigMic.setAttribute('aria-label', stopDictation ? 'Stop listening' : (mode === 'listening' ? `Listen to ${name}` : `Speak ${name}`));
    if (!stopDictation) status.textContent = idleStatus();
  }

  function renderComposer({ focus = false } = {}) {
    composer.hidden = !typing;
    typeBtn.setAttribute('aria-pressed', String(typing));
    typeBtn.setAttribute('aria-label', typing ? 'Close keyboard' : 'Type instead');
    const code = langs[speakerNow()];
    const name = langName(code);
    input.placeholder = `Type in ${name}…`;
    input.lang = code;
    input.dir = dirOf(code);
    $('convo-input-label').textContent = `Message in ${name}`;
    if (focus && typing) input.focus();
  }

  /* ---------------- transcript ---------------- */

  function liFor(u, list) {
    // list: 'shared' (translation large, original small), or a split half showing one language
    const li = document.createElement('li');
    li.className = `utt from-${u.from}`;
    if (list === 'shared') {
      li.innerHTML = `<span class="visually-hidden">${escapeHtml(langName(u.fromLang))} to ${escapeHtml(langName(u.toLang))}:</span>
        <p class="utt-trans" lang="${u.toLang}" dir="${dirOf(u.toLang)}"></p>
        <p class="utt-orig" lang="${u.fromLang}" dir="${dirOf(u.fromLang)}">${escapeHtml(u.text)}</p>
        <p class="utt-err" hidden></p>`;
    } else {
      // split halves: each person reads their own language; own words stay small
      const own = u.from === list;
      const code = own ? u.fromLang : u.toLang;
      li.classList.add(own ? 'own' : 'heard');
      li.innerHTML = `<p class="utt-trans" lang="${code}" dir="${dirOf(code)}"></p><p class="utt-err" hidden></p>`;
    }
    return li;
  }

  function fillLi(li, u, list) {
    const pending = u.translated == null && !u.error;
    li.classList.toggle('pending', pending);
    li.setAttribute('aria-busy', String(pending));
    const own = list !== 'shared' && u.from === list;
    li.querySelector('.utt-trans').textContent = own ? u.text : (u.translated ?? (u.error ? '' : '…'));
    const err = li.querySelector('.utt-err');
    err.hidden = !u.error || own;
    err.textContent = u.error || '';
  }

  function renderUtterance(u) {
    if (!u.els) {
      u.els = { shared: liFor(u, 'shared'), them: liFor(u, 'them'), me: liFor(u, 'me') };
      shared.append(u.els.shared); splitThem.append(u.els.them); splitMe.append(u.els.me);
    }
    fillLi(u.els.shared, u, 'shared'); fillLi(u.els.them, u, 'them'); fillLi(u.els.me, u, 'me');
    scrollDown();
  }

  function renderTranscript() {
    shared.replaceChildren(); splitThem.replaceChildren(); splitMe.replaceChildren();
    utterances.forEach((u) => { u.els = null; renderUtterance(u); });
    scrollDown();
  }

  function scrollDown() {
    requestAnimationFrame(() => {
      sheetEl.scrollTop = sheetEl.scrollHeight;
      splitThem.scrollTop = splitThem.scrollHeight;
      splitMe.scrollTop = splitMe.scrollHeight;
    });
  }

  async function addUtterance(from, text) {
    text = text.trim();
    if (!text) return;
    const to = other(from);
    const u = { from, fromLang: langs[from], toLang: langs[to], text, translated: null, error: null, els: null };
    utterances.push(u);
    renderUtterance(u);
    if (mode !== 'listening') { turn = to; renderScreen(); }   // alternate turns automatically
    try {
      const res = await translate(u.text, u.fromLang, u.toLang);
      u.translated = res.text;
      renderUtterance(u);
      if (res.note) toast(res.note);   // e.g. Classic stood in for Advanced
      if (mode === 'conversation') speak(res.text, u.toLang).catch(() => {});
    } catch (e) {
      const { title, message } = describeError(e);
      u.error = `${title}. ${message}`;
      renderUtterance(u);
    }
  }

  /* ---------------- voice ---------------- */

  async function toggleMic() {
    if (stopDictation) { userStopped = true; stopDictation(); return; }
    if (!canDictate()) {
      toast(dictationMessage('UNSUPPORTED'), { duration: 6000 });
      typing = true; renderComposer({ focus: true });
      return;
    }
    if (!(await ensureMicrophone())) return;
    stopSpeaking();
    userStopped = false;
    quiet = 0;
    listenOnce();
  }

  function listenOnce() {
    const who = speakerNow();
    const code = langs[who];
    const name = langName(code);
    const finish = () => { stopDictation = null; interim.textContent = ''; renderMic(); };
    stopDictation = dictate(code, {
      onState: (st) => {
        status.textContent = st === 'listening' ? `Listening · ${name}…` : st === 'transcribing' ? 'Transcribing…' : st;
      },
      onText: (t) => { interim.textContent = t; interim.lang = code; interim.dir = dirOf(code); },
      onEnd: (finalText) => {
        finish();
        if (finalText) { quiet = 0; addUtterance(who, finalText); }
        // Listening keeps captioning until the user stops it or leaves the screen
        if (mode === 'listening' && !userStopped && visible) listenOnce();
      },
      onError: (e) => {
        finish();
        const silent = e?.message === 'no-speech';
        if (silent && mode === 'listening' && !userStopped && visible && quiet++ < MAX_QUIET_RESTARTS) { listenOnce(); return; }
        const m = dictationMessage(e);
        if (m) toast(m, { duration: 6000 });
        if (silent && mode === 'listening') status.textContent = 'Paused. Tap mic to keep listening.';
      },
    });
    renderMic();
  }

  /* ---------------- wiring ---------------- */

  bigMic.addEventListener('click', toggleMic);
  typeBtn.addEventListener('click', () => {
    typing = !typing;
    renderComposer({ focus: true });
    if (!typing) typeBtn.focus();
  });
  modeBtn.addEventListener('click', () => openSetup());
  $('convo-options').addEventListener('click', () => openSetup());
  $('convo-swap').addEventListener('click', swapLangs);
  view.querySelectorAll('[data-convo-lang]').forEach((b) => b.addEventListener('click', () => changeLang(b.dataset.convoLang, b)));
  turnBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-turn]');
    if (!b || mode === 'listening') return;
    stopDictation?.();
    turn = b.dataset.turn;
    renderScreen();
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    autosize();
    addUtterance(speakerNow(), t).then(() => renderComposer());
    renderComposer({ focus: true });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composer.requestSubmit(); }
    if (e.key === 'Escape') { e.preventDefault(); typing = false; renderComposer(); typeBtn.focus(); }
  });
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
  input.addEventListener('input', autosize);

  renderScreen();

  return {
    onShow({ viaArrowKeys = false } = {}) {
      visible = true;
      renderScreen();
      // every deliberate entry starts with the setup sheet; just arrowing across the mode tabs doesn't
      // pop it up (the mode pill / options button opens it from the conversation screen)
      if (!viaArrowKeys) openSetup({ entry: true });
    },
    onHide() {
      visible = false;
      userStopped = true;
      stopDictation?.();
      stopSpeaking();
      if (setup.open) setup.close();
    },
  };
}
