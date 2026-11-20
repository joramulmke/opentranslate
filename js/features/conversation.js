// Conversation: two people, one language each.
// Phones: one shared log, a language pair on top and one mic; turns alternate after each message
//         (optional face-to-face split screen in the options sheet).
// 720px+: two side-by-side panes with a speak button per person.
// Typing (composer) works everywhere, so the view is usable without speech recognition.
import { translate, describeError, langName } from '../state.js';
import { settings } from '../store.js';
import { isRtl } from '../languages.js';
import { pickLanguage, escapeHtml } from '../ui/langpicker.js';
import { setupDialog, openDialog } from '../ui/sheet.js';
import { isPhone, onLayoutChange } from '../ui/layout.js';
import { speak, stopSpeaking, canDictate, dictate, dictationMessage } from './speech.js';
import { toast } from '../ui/snackbar.js';

const $ = (id) => document.getElementById(id);
const KEY = 'ot.conversation.v1';

export function initConversation() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const people = {
    a: { lang: saved.a || 'en', pane: $('convo-a'), btn: $('speak-a') },
    b: { lang: saved.b || 'es', pane: $('convo-b'), btn: $('speak-b') },
  };
  const other = (p) => (p === 'a' ? 'b' : 'a');
  const view = $('view-conversation');
  const composer = $('convo-composer');
  const input = $('convo-input');
  const mic = $('convo-mic');
  const shared = $('convo-shared');
  const status = $('convo-status');
  const turnBtn = $('convo-turn');
  const bigMic = $('convo-bigmic');
  const typeBtn = $('convo-type');
  const optsDlg = setupDialog($('convo-dialog'));
  const speakSwitch = $('convo-speak');
  let split = !!saved.split;
  let active = null;          // whose turn it is (phones: never null)
  let typing = false;         // phones: composer open
  let stopDictation = null;
  let messages = [];

  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ a: people.a.lang, b: people.b.lang, split })); } catch { /* */ }
  };
  const phoneShared = () => isPhone() && !split;

  function renderLangs() {
    for (const k of ['a', 'b']) {
      const p = people[k];
      const name = langName(p.lang);
      document.querySelectorAll(`[data-person-lang="${k}"]`).forEach((b) => {
        b.querySelector('.pill-label').textContent = name;
        b.setAttribute('aria-label', `Person ${k === 'a' ? 1 : 2} language: ${name}. Change`);
      });
      p.btn.querySelector('.speak-lang').textContent = name;
      p.btn.setAttribute('aria-label', `${name} speaker (person ${k === 'a' ? 1 : 2}). Tap to speak or type`);
      const log = p.pane.querySelector('.convo-log');
      log.dataset.empty = k === 'a'
        ? `Tap ${name} below, then type, paste or speak.`
        : `Tap ${langName(people.b.lang)} to answer.`;
      log.lang = p.lang;
    }
    shared.dataset.empty = `Take turns: ${langName(people.a.lang)} speaks first, then ${langName(people.b.lang)}.`;
    renderTurn();
  }

  /** Phone bottom row: whose turn it is, status line, mic state. */
  function renderTurn() {
    const k = active || 'a';
    const name = langName(people[k].lang);
    $('convo-turn-label').textContent = name;
    turnBtn.setAttribute('aria-label', `Speaking now: ${name}. Switch to ${langName(people[other(k)].lang)}`);
    bigMic.setAttribute('aria-label', stopDictation ? 'Stop listening' : `Speak ${name}`);
    bigMic.setAttribute('aria-pressed', String(!!stopDictation));
    typeBtn.setAttribute('aria-pressed', String(typing));
    if (!stopDictation) status.textContent = canDictate() ? `Tap mic to start (${name})` : `Tap the keyboard to type in ${name}`;
  }

  function syncComposer({ focus = true } = {}) {
    composer.hidden = phoneShared() ? !typing : !active;
    if (composer.hidden || !active) return;
    const name = langName(people[active].lang);
    input.placeholder = `Type in ${name}…`;
    input.lang = people[active].lang;
    input.dir = isRtl(people[active].lang) ? 'rtl' : 'auto';
    $('convo-input-label').textContent = `Message in ${name}`;
    if (focus) input.focus();
  }

  function setActive(k, { toggle = true, focus = true } = {}) {
    stopDictation?.();
    active = toggle && active === k ? null : k;
    if (phoneShared() && !active) active = k;           // phones always have a current speaker
    for (const key of ['a', 'b']) people[key].btn.setAttribute('aria-pressed', String(active === key && !phoneShared()));
    syncComposer({ focus });
    renderTurn();
  }

  function render() {
    for (const k of ['a', 'b']) {
      const log = people[k].pane.querySelector('.convo-log');
      log.innerHTML = messages.map((m) => {
        const mine = m.from === k;
        const big = mine ? m.text : (m.translated ?? '…');
        const small = mine ? (m.translated ?? '') : m.text;
        const bigLang = mine ? people[m.from].lang : m.toLang;
        const smallLang = mine ? m.toLang : people[m.from].lang;
        return `<li class="msg ${mine ? 'mine' : 'theirs'} ${m.translated == null && !m.error ? 'pending' : ''}">
          <span class="big" lang="${bigLang}" dir="${isRtl(bigLang) ? 'rtl' : 'auto'}">${escapeHtml(big)}</span>
          ${small ? `<span class="small" lang="${smallLang}">${escapeHtml(small)}</span>` : ''}
          ${m.error && !mine ? `<span class="err">${escapeHtml(m.error)}</span>` : ''}
        </li>`;
      }).join('');
      log.scrollTop = log.scrollHeight;
    }
    shared.innerHTML = messages.map((m) => {
      const fromLang = m.fromLang;
      return `<li class="cmsg from-${m.from} ${m.translated == null && !m.error ? 'pending' : ''}">
        <span class="orig" lang="${fromLang}" dir="${isRtl(fromLang) ? 'rtl' : 'auto'}">${escapeHtml(m.text)}</span>
        <span class="trans" lang="${m.toLang}" dir="${isRtl(m.toLang) ? 'rtl' : 'auto'}">${escapeHtml(m.translated ?? '…')}</span>
        ${m.error ? `<span class="err">${escapeHtml(m.error)}</span>` : ''}
      </li>`;
    }).join('');
    shared.parentElement.scrollTop = shared.parentElement.scrollHeight;
  }

  async function send(text) {
    if (!active || !text.trim()) return;
    const from = active;
    const to = other(from);
    const m = { from, fromLang: people[from].lang, text: text.trim(), toLang: people[to].lang, translated: null, error: null };
    messages.push(m);
    input.value = '';
    autosize();
    render();
    if (phoneShared()) status.textContent = 'Translating…';
    try {
      const res = await translate(m.text, people[from].lang, people[to].lang);
      m.translated = res.text;
      render();
      if (settings.get().speakConversation) speak(res.text, people[to].lang).catch(() => {});
    } catch (e) {
      const { title, message } = describeError(e);
      m.error = `${title}. ${message}`;
      render();
    }
    // alternate turns like a real conversation
    setActive(to, { toggle: false, focus: !phoneShared() || typing });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  function listen(btn) {
    if (stopDictation) { stopDictation(); return; }
    if (!canDictate()) {
      toast(dictationMessage('UNSUPPORTED'), { duration: 6000 });
      if (phoneShared()) { typing = true; syncComposer(); renderTurn(); }
      return;
    }
    if (!active) return;
    const lang = people[active].lang;
    btn.setAttribute('aria-pressed', 'true');
    const done = () => { stopDictation = null; btn.setAttribute('aria-pressed', 'false'); renderTurn(); };
    stopDictation = dictate(lang, {
      onText: (t) => {
        if (phoneShared() && !typing) status.textContent = t || `Listening (${langName(lang)})…`;
        else { input.value = t; autosize(); }
      },
      onEnd: (finalText) => { done(); if (finalText) send(finalText); },
      onError: (e) => { done(); const m = dictationMessage(e); if (m) toast(m, { duration: 6000 }); },
    });
    if (phoneShared()) { renderTurn(); status.textContent = `Listening (${langName(lang)})…`; }
  }

  /* ---- wide layout + split screen ---- */
  people.a.btn.addEventListener('click', () => setActive('a'));
  people.b.btn.addEventListener('click', () => setActive('b'));
  mic.addEventListener('click', () => listen(mic));

  /* ---- phone shared layout ---- */
  turnBtn.addEventListener('click', () => setActive(other(active || 'a'), { toggle: false, focus: typing }));
  bigMic.addEventListener('click', () => listen(bigMic));
  typeBtn.addEventListener('click', () => { typing = !typing; syncComposer(); renderTurn(); if (!typing) typeBtn.focus(); });
  $('convo-swap').addEventListener('click', () => {
    [people.a.lang, people.b.lang] = [people.b.lang, people.a.lang];
    persist(); renderLangs(); syncComposer({ focus: false });
  });
  $('convo-options').addEventListener('click', () => {
    speakSwitch.checked = !!settings.get().speakConversation;
    splitSwitch.checked = split;
    openDialog(optsDlg);
  });
  speakSwitch.addEventListener('change', () => settings.set({ speakConversation: speakSwitch.checked }));
  $('convo-clear-all').addEventListener('click', () => { clearAll(); toast('Conversation cleared'); });

  // face-to-face split screen (keeps the earlier phone layout available)
  const splitRow = document.createElement('label');
  splitRow.className = 'switch-row';
  splitRow.innerHTML = '<span>Face-to-face split screen</span><input type="checkbox" role="switch">';
  speakSwitch.closest('.switch-row').after(splitRow);
  const splitSwitch = splitRow.querySelector('input');
  splitSwitch.addEventListener('change', () => { split = splitSwitch.checked; persist(); applyLayout(); });

  function applyLayout() {
    view.classList.toggle('split', split);
    if (phoneShared() && !active) active = 'a';
    for (const key of ['a', 'b']) people[key].btn.setAttribute('aria-pressed', String(active === key && !phoneShared()));
    syncComposer({ focus: false });
    renderTurn();
  }
  onLayoutChange(applyLayout);

  function clearAll() { messages = []; stopSpeaking(); render(); }

  document.querySelectorAll('[data-person-lang]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.personLang;
    const code = await pickLanguage({ side: 'target', selected: people[k].lang, heading: `Person ${k === 'a' ? 1 : 2} speaks` });
    if (!code) return;
    people[k].lang = code;
    persist();
    renderLangs();
    if (active === k) syncComposer({ focus: false }); // refresh placeholder
  }));
  composer.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    if (e.key === 'Escape') {
      if (phoneShared()) { typing = false; syncComposer(); renderTurn(); typeBtn.focus(); } else setActive(active);
    }
  });
  input.addEventListener('input', autosize);
  $('convo-clear').addEventListener('click', clearAll);
  $('convo-rotate').addEventListener('click', (e) => {
    const on = people.b.pane.classList.toggle('flipped');
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });

  renderLangs();
  render();
  applyLayout();

  return {
    onShow() { renderLangs(); applyLayout(); },
    onHide() { stopDictation?.(); stopSpeaking(); },
  };
}
