// Conversation: setup sheet first, then the conversation screen (same flow at every width).
//  Setup:  their language ⇄ your language, mode (Listening · Conversation · Text only),
//          optional face-to-face split screen, Start.
//  Screen: language pair on top, transcript (translation large, original small, newest last),
//          mode pill + big mic + keyboard at the bottom.
//  Modes:  listening    = only their language is captured, translated into yours, captions only
//          conversation = take turns (alternates automatically), translations read aloud
//          text         = take turns, nothing read aloud
import { translate, describeError, langName, fallbackNote } from '../state.js';
import { settings } from '../store.js';
import { isRtl } from '../languages.js';
import { pickLanguage, escapeHtml } from '../ui/langpicker.js';
import { setupDialog, openDialog, closeDialog } from '../ui/sheet.js';
import { icon } from '../ui/icons.js';
import { speak, stopSpeaking, canDictate, dictate, dictationMessage } from './speech.js';
import { ensureMicrophone } from './permissions.js';
import { toast, copyToClipboard } from '../ui/snackbar.js';
import { startCaptions, canShareAudio, usesBrowserService } from './captions.js';
import { speechOrder } from './stt.js';
import { pipSupported } from './pip.js';

const $ = (id) => document.getElementById(id);
const KEY = 'ot.conversation.v1';
const MODES = {
  listening: { label: 'Listening', icon: 'headphones' },
  conversation: { label: 'Conversation', icon: 'voiceOver' },
  text: { label: 'Text only', icon: 'notes' },
};
const other = (w) => (w === 'them' ? 'me' : 'them');
const CAP_SIZES = [0.8, 1, 1.3, 1.7, 2.2];   // Listening: caption text sizes (A− / A+)

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
  let captions = null;     // Listening: the running live captions (captions.js)
  let liveLi = null;       // Listening: the line being heard, greyed until it's final
  let follow = true;       // keep scrolled to the newest line (false once the user scrolls up)
  let capWin = null;       // floating captions window (computers)
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
  // Reduced motion also means calm text: whole sentences only, no words appearing as they're spoken
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    const listening = mode === 'listening';
    $('setup-split-row').hidden = listening;
    $('setup-pause-row').hidden = !listening;
    $('setup-pause').checked = pauseWhenQuiet();
    $('setup-audio').hidden = !listening || !canShareAudio();
    for (const r of setup.querySelectorAll('[name="setup-audio"]')) r.checked = r.value === audioSource();
    const cost = costNote();
    $('setup-cost').hidden = !listening || !cost;
    $('setup-cost').textContent = cost;
  }

  /* ---------------- Listening options (remembered) ---------------- */
  const pauseWhenQuiet = () => settings.get().captionsPause !== false;
  const audioSource = () => (settings.get().captionsSource === 'tab' && canShareAudio() ? 'tab' : 'mic');
  const capSize = () => { const i = settings.get().captionSize; return Number.isInteger(i) && CAP_SIZES[i] ? i : 1; };
  /** Which engine Listening will use, as a note about costs or tab sound; '' when there's nothing to say. */
  function costNote() {
    const tab = audioSource() === 'tab';
    const engine = tab || !usesBrowserService() ? speechOrder().find((e) => e !== 'browser') : 'browser';
    const notes = [];
    if (tab && usesBrowserService()) notes.push('The browser’s speech service only hears the microphone, so tab sound uses your next speech engine (Settings › Voice).');
    if (engine === 'api') notes.push('Your AI service charges for speech recognition by the minute: live captions can add up.');
    if (engine === 'elevenlabs') notes.push('ElevenLabs charges for speech recognition by the minute: live captions can add up.');
    return notes.join(' ');
  }
  function setPauseWhenQuiet(on) {
    settings.set({ captionsPause: on });
    captions?.setPauseWhenQuiet(on);
    renderCaptionBar();
    if (setup.open) $('setup-pause').checked = on;
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
  $('setup-pause').addEventListener('change', (e) => setPauseWhenQuiet(e.target.checked));
  $('setup-audio').addEventListener('change', (e) => { settings.set({ captionsSource: e.target.value }); renderSetup(); renderCaptionBar(); });
  clearBtn.addEventListener('click', () => {
    utterances = []; stopSpeaking(); renderTranscript(); renderPip(); clearBtn.hidden = true; $('cap-transcript').disabled = true;
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
    view.classList.toggle('is-listening', mode === 'listening');
    renderCaptionBar();
    view.classList.toggle('is-split', splitOn());
    shared.hidden = splitOn();
    splitBox.hidden = !splitOn();
    renderMic();
    renderComposer();
  }

  function idleStatus() {
    const name = langName(langs[speakerNow()]);
    if (!canDictate()) return `Voice input isn't available here. Tap the keyboard to type in ${name}.`;
    if (mode === 'listening') return audioSource() === 'tab' ? `Tap mic to caption a tab or the screen in ${name}` : `Tap mic to start live captions of ${name}`;
    return `Tap mic to start · ${name}`;
  }

  function renderMic() {
    const name = langName(langs[speakerNow()]);
    const on = !!(stopDictation || captions);
    bigMic.setAttribute('aria-pressed', String(on));
    bigMic.setAttribute('aria-label', on ? 'Stop listening' : (mode === 'listening' ? `Start live captions of ${name}` : `Speak ${name}`));
    if (!on) status.textContent = idleStatus();
  }

  /* ---------------- live captions tools ---------------- */

  function renderCaptionBar() {
    const bar = $('caption-bar');
    bar.hidden = mode !== 'listening';
    view.style.setProperty('--cap', String(CAP_SIZES[capSize()]));
    $('cap-smaller').disabled = capSize() === 0;
    $('cap-larger').disabled = capSize() === CAP_SIZES.length - 1;
    $('cap-pause').setAttribute('aria-pressed', String(pauseWhenQuiet()));
    const src = $('cap-source');
    src.hidden = !canShareAudio();
    const tab = audioSource() === 'tab';
    src.innerHTML = `${icon(tab ? 'openIn' : 'mic')}<span>${tab ? 'Tab sound' : 'Microphone'}</span>`;
    src.setAttribute('aria-label', `Listening to: ${tab ? 'a tab or the screen' : 'the microphone'}. Change`);
    src.disabled = !!captions;
    $('cap-popout').hidden = !pipSupported();
    $('cap-share').hidden = !navigator.share;
    $('cap-transcript').disabled = !utterances.length;
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
      if (follow) sheetEl.scrollTop = sheetEl.scrollHeight;
      splitThem.scrollTop = splitThem.scrollHeight;
      splitMe.scrollTop = splitMe.scrollHeight;
    });
  }

  async function addUtterance(from, text) {
    text = text.trim();
    if (!text) return;
    const to = other(from);
    const u = { from, fromLang: langs[from], toLang: langs[to], text, translated: null, error: null, els: null, time: new Date() };
    utterances.push(u);
    renderUtterance(u);
    if (liveLi) shared.append(liveLi);   // the line being heard stays last
    $('cap-transcript').disabled = false;
    renderPip();
    if (mode !== 'listening') { turn = to; renderScreen(); }   // alternate turns automatically
    try {
      const res = await translate(u.text, u.fromLang, u.toLang);
      u.translated = res.text;
      renderUtterance(u);
      announce(u);
      renderPip();
      if (fallbackNote(res)) toast(fallbackNote(res));   // e.g. Classic stood in for Advanced, or the next service did
      if (mode === 'conversation') speak(res.text, u.toLang).catch(() => {});
    } catch (e) {
      const { title, message } = describeError(e);
      u.error = `${title}. ${message}`;
      renderUtterance(u);
      announce(u);
    }
  }

  /** Read a finished translation (or its error) once to screen readers, in its own language's voice.
   *  The transcript itself isn't a live region: it fills in step by step, and re-renders when languages change. */
  function announce(u) {
    const box = $('convo-announce');
    if (!box) return;
    const line = document.createElement('span');
    if (u.error) line.textContent = `Not translated. ${u.error}`;
    else {
      line.append(`${langName(u.toLang)}: `);
      const t = Object.assign(document.createElement('span'), { lang: u.toLang, dir: dirOf(u.toLang), textContent: u.translated });
      line.append(t);
    }
    box.replaceChildren(line);
  }

  /* ---------------- voice ---------------- */

  async function toggleMic() {
    if (captions) { userStopped = true; captions.stop(); return; }
    if (stopDictation) { userStopped = true; stopDictation(); return; }
    if (mode === 'listening' && audioSource() === 'tab') { stopSpeaking(); userStopped = false; startLive(); return; }
    if (!canDictate()) {
      toast(dictationMessage('UNSUPPORTED'), { duration: 6000 });
      typing = true; renderComposer({ focus: true });
      return;
    }
    if (!(await ensureMicrophone())) return;
    stopSpeaking();
    userStopped = false;
    if (mode === 'listening') startLive(); else listenOnce();
  }

  /* Listening: live captions until stopped (captions.js). The words being heard show greyed as the last
     line; each final piece becomes a caption and is translated. */
  function setLive(text) {
    if (!text) { liveLi?.remove(); liveLi = null; return; }
    if (calm()) text = '…';   // reduced motion: no words changing while they're heard, only whole sentences
    if (!liveLi) {
      liveLi = document.createElement('li');
      liveLi.className = 'utt from-them live';
      liveLi.setAttribute('aria-hidden', 'true');   // screen readers hear final captions only
      liveLi.innerHTML = '<p class="utt-orig"></p>';
    }
    const p = liveLi.firstChild;
    p.textContent = text;
    p.lang = langs.them; p.dir = dirOf(langs.them);
    shared.append(liveLi);
    scrollDown();
  }

  function startLive() {
    const code = langs.them;
    const name = langName(code);
    const tab = audioSource() === 'tab';
    follow = true;
    let on = true;   // until onEnd (the first onState comes before startCaptions returns)
    captions = startCaptions(code, {
      source: tab ? 'tab' : 'mic',
      pauseWhenQuiet: pauseWhenQuiet(),
      onState: (st) => {
        if (!on) return;
        status.textContent = st === 'transcribing' ? `Live captions · ${name} · transcribing…` : `Live captions · ${name}${tab ? ' · tab sound' : ''}`;
      },
      onInterim: (t) => setLive(t),
      onFinal: (t) => { setLive(''); addUtterance('them', t); },
      onPaused: () => { toast('Live captions paused after 2 minutes of silence. Tap the mic to go on.', { duration: 8000 }); },
      onError: (e) => {
        const m = e?.message;
        const msg = m === 'NO_SHARED_AUDIO' ? 'No sound was shared. Choose a tab or the screen and turn on its audio.'
          : m === 'SHARING_ENDED' ? 'Sharing ended, so live captions stopped.'
            : m === 'NotAllowedError' && tab ? '' : dictationMessage(e);
        if (msg) toast(msg, { duration: 7000 });
      },
      onEnd: () => {
        on = false;
        captions = null;
        setLive('');
        renderMic();
        renderCaptionBar();
        if (!userStopped && visible) status.textContent = 'Paused. Tap mic to go on.';
      },
    });
    renderMic();
    renderCaptionBar();
  }

  /* ---------------- transcript: copy, share, download ---------------- */

  function transcriptText() {
    const t = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const head = `${MODES[mode].label} · ${langName(langs.them)} → ${langName(langs.me)} · ${new Date().toLocaleDateString()}`;
    return [head, '', ...utterances.map((u) => `[${t(u.time || new Date())}] ${u.translated ?? ''}\n        ${u.text}`)].join('\n');
  }
  $('cap-transcript-menu').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-transcript]');
    if (!b) return;
    $('cap-transcript-menu').hidePopover?.();
    if (!utterances.length) { toast('Nothing in the transcript yet'); return; }
    const text = transcriptText();
    if (b.dataset.transcript === 'copy') copyToClipboard(text, 'Transcript copied');
    else if (b.dataset.transcript === 'share') navigator.share({ title: 'Transcript', text }).catch(() => {});
    else {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
        download: `transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`,
      });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  });

  /* ---------------- floating captions window (computers, Document Picture-in-Picture) ---------------- */

  async function popOut() {
    if (capWin) { capWin.focus(); return; }
    try { capWin = await window.documentPictureInPicture.requestWindow({ width: 480, height: 220 }); } catch { return; }
    const doc = capWin.document;
    doc.title = 'Live captions';
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) doc.head.append(Object.assign(doc.createElement('link'), { rel: 'stylesheet', href: link.href }));
    doc.head.append(Object.assign(doc.createElement('style'), { textContent: `
      html, body { height: 100%; margin: 0; }
      body { display: flex; flex-direction: column; justify-content: flex-end; padding: 12px 16px; box-sizing: border-box; overflow: hidden;
        background: var(--surface, #fff); color: var(--on-surface, #1b1b1f); font: 15px/1.35 system-ui, sans-serif; }
      ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .t { margin: 0; font-size: calc(22px * var(--cap, 1)); line-height: 1.3; }
      li:last-child .t { font-size: calc(26px * var(--cap, 1)); }
      .o { margin: 2px 0 0; font-size: 14px; color: var(--on-surface-variant, #44474f); }
      .empty { color: var(--on-surface-variant, #44474f); }` }));
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme || '';
    doc.documentElement.lang = 'en';
    doc.body.innerHTML = '<ol id="caps" aria-live="polite"></ol>';
    capWin.addEventListener('pagehide', () => { capWin = null; }, { once: true });
    renderPip();
  }
  function renderPip() {
    if (!capWin) return;
    const doc = capWin.document;
    doc.documentElement.style.setProperty('--cap', String(CAP_SIZES[capSize()]));
    const last = utterances.filter((u) => u.from === 'them' || mode !== 'listening').slice(-3);
    doc.getElementById('caps').innerHTML = last.length
      ? last.map((u) => `<li><p class="t" lang="${u.toLang}" dir="${dirOf(u.toLang)}">${escapeHtml(u.translated ?? '…')}</p><p class="o" lang="${u.fromLang}" dir="${dirOf(u.fromLang)}">${escapeHtml(u.text)}</p></li>`).join('')
      : '<li class="empty">Captions appear here.</li>';
  }

  /* ---------------- captions toolbar ---------------- */

  const sizeBy = (d) => { settings.set({ captionSize: Math.max(0, Math.min(CAP_SIZES.length - 1, capSize() + d)) }); renderCaptionBar(); renderPip(); scrollDown(); };
  $('cap-smaller').addEventListener('click', () => sizeBy(-1));
  $('cap-larger').addEventListener('click', () => sizeBy(1));
  $('cap-pause').addEventListener('click', () => setPauseWhenQuiet(!pauseWhenQuiet()));
  $('cap-source').addEventListener('click', () => { settings.set({ captionsSource: audioSource() === 'tab' ? 'mic' : 'tab' }); renderCaptionBar(); renderMic(); });
  $('cap-popout').addEventListener('click', popOut);
  // follow the newest line unless the user scrolled up to read; then offer a way back
  // (only the user's own scrolling counts: wheel, touch, keys, scrollbar; not new lines or a bigger text size)
  let userScroll = 0;
  const intent = () => { userScroll = performance.now(); };
  for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) sheetEl.addEventListener(ev, intent, { passive: true });
  sheetEl.addEventListener('scroll', () => {
    const atEnd = sheetEl.scrollTop + sheetEl.clientHeight >= sheetEl.scrollHeight - 40;
    if (atEnd) follow = true;
    else if (performance.now() - userScroll < 1000) follow = false;
    $('convo-jump').hidden = follow || mode !== 'listening';
  }, { passive: true });
  $('convo-jump').addEventListener('click', () => {
    follow = true; $('convo-jump').hidden = true;
    // the button goes away, so focus goes on to the newest caption instead of being lost
    const last = [...shared.querySelectorAll(':scope > li.utt:not(.live)')].pop();
    if (last) { last.tabIndex = -1; last.focus({ preventScroll: true }); } else bigMic.focus();
    sheetEl.scrollTo({ top: sheetEl.scrollHeight, behavior: calm() ? 'auto' : 'smooth' });
  });

  function listenOnce() {
    const who = speakerNow();
    const code = langs[who];
    const name = langName(code);
    const finish = () => { stopDictation = null; interim.textContent = ''; renderMic(); };
    stopDictation = dictate(code, {
      onState: (st) => {
        status.textContent = st === 'listening' ? `Listening · ${name}…` : st === 'transcribing' ? 'Transcribing…' : st;
      },
      onText: (t) => { interim.textContent = t && calm() ? '…' : t; interim.lang = code; interim.dir = dirOf(code); },   // calm: only a sign that words are heard
      onEnd: (finalText) => {
        finish();
        if (finalText) addUtterance(who, finalText);
      },
      onError: (e) => {
        finish();
        const m = dictationMessage(e);
        if (m) toast(m, { duration: 6000 });
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
      captions?.stop();
      capWin?.close();
      stopSpeaking();
      if (setup.open) setup.close();
    },
  };
}
