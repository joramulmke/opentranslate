import { canRecord, record, transcribe, speechOrder } from './stt.js';
import { toast } from '../ui/snackbar.js';
// Text-to-speech (speechSynthesis) and dictation (SpeechRecognition, where the browser has it).

let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

export const canSpeak = () => 'speechSynthesis' in window;

function voiceFor(lang) {
  if (!voices.length) loadVoices();
  const base = lang.split('-')[0].toLowerCase();
  const alias = { zh: ['zh-cn', 'zh'], 'zh-hant': ['zh-tw', 'zh-hk'], no: ['nb', 'no'], he: ['he', 'iw'], tl: ['fil', 'tl'] };
  const wanted = alias[lang.toLowerCase()] || alias[base] || [base];
  return voices.find((v) => wanted.some((w) => v.lang.toLowerCase().replace('_', '-').startsWith(w)));
}

let currentUtterance = null;

// Pronunciation practice: playing the same text again shortly after it finished plays it slower;
// the next replay is normal speed again.
export const NORMAL_RATE = 0.95;
export const SLOW_RATE = 0.6;
const REPLAY_WINDOW = 10000;
let lastPlay = null;   // { key, end, slow } of the last utterance that played to the end

/** Will speak(text, lang) right now play slowly? (for button labels) */
export function nextIsSlow(text, lang) {
  return !!lastPlay && lastPlay.key === `${lang}\u0000${text}` && Date.now() - lastPlay.end < REPLAY_WINDOW && !lastPlay.slow;
}

/**
 * Speak text. Resolves when finished or stopped. Rejects with Error('NO_VOICE') if
 * the device has no voice for that language (the UI shows a message).
 * onStart(slow) says whether this is the slow replay.
 */
export function speak(text, lang, { onStart, onEnd } = {}) {
  return new Promise((resolve, reject) => {
    if (!canSpeak()) return reject(new Error('NO_TTS'));
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'zh' ? 'zh-CN' : lang === 'zh-Hant' ? 'zh-TW' : lang;
    const v = voiceFor(lang);
    // Some engines have voices that load late; if we have a list and nothing matches, bail.
    if (!v && voices.length) return reject(new Error('NO_VOICE'));
    if (v) u.voice = v;
    const slow = nextIsSlow(text, lang);
    u.rate = slow ? SLOW_RATE : NORMAL_RATE;
    u.onstart = () => { if (slow) toast('Playing slower. Play again for normal speed.'); onStart?.(slow); };
    const finish = (e) => {
      // only a play that reached the end counts (not one stopped by the person)
      const completed = currentUtterance === u && e?.type === 'end';
      if (currentUtterance === u) currentUtterance = null;
      lastPlay = completed ? { key: `${lang}\u0000${text}`, end: Date.now(), slow } : null;
      onEnd?.(); resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    currentUtterance = u;
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (canSpeak() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  currentUtterance = null;
}
export const isSpeaking = () => !!currentUtterance;

/* ---------------- dictation ---------------- */
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
// Brave exposes SpeechRecognition but leaves out the (Google) speech service behind it: every attempt
// fails with "network". The microphone itself works, so there we record and transcribe ourselves.
const isBrave = () => !!navigator.brave;
let browserServiceBroken = false;
export const browserSpeechAvailable = () => !!Recognition && !isBrave() && !browserServiceBroken;
// the browser's service only when it's the chosen speech engine (Settings) and works here
const useBrowserService = () => browserSpeechAvailable() && speechOrder()[0] === 'browser';

export const canDictate = () => useBrowserService() || canRecord();

/** Why voice input isn't available / stopped, in words a user can act on. Empty string = say nothing. */
export function dictationMessage(errOrCode) {
  const code = typeof errOrCode === 'string' ? errOrCode : errOrCode?.message;
  switch (code) {
    case 'UNSUPPORTED': case 'NO_SR': return 'This browser can’t record audio. Type instead.';
    case 'NO_ENGINE': return 'Voice input needs the on-device speech model or a speech model in Advanced settings.';
    case 'network': return "The browser's speech service isn't reachable. Try again.";
    case 'not-allowed': case 'service-not-allowed': case 'NotAllowedError': return 'Microphone access is blocked. Allow it in the browser’s site settings.';
    case 'audio-capture': case 'NotFoundError': return 'No microphone found.';
    case 'no-speech': return "Didn't catch that. Tap the mic and try again.";
    case 'language-not-supported': return 'Voice input does not support this language in this browser.';
    case 'aborted': return '';
    default: return `Voice input stopped (${code || 'unknown error'}).`;
  }
}

/**
 * Start dictation. Returns a stop() function.
 * onText(text, isFinal) gets the running transcript; onState('listening'|'transcribing'|status text) reports progress.
 */
export function dictate(lang, cbs = {}) {
  let stop = () => {};
  if (useBrowserService()) {
    stop = browserDictate(lang, {
      ...cbs,
      onError: (e) => {
        // e.g. Chromium builds without Google's speech key: switch to recording, for this and later attempts
        if (e.message === 'network' && canRecord()) { browserServiceBroken = true; stop = recordDictate(lang, cbs); return; }
        cbs.onError?.(e);
      },
    });
  } else if (canRecord()) {
    stop = recordDictate(lang, cbs);
  } else {
    cbs.onError?.(new Error('UNSUPPORTED'));
  }
  return () => stop();
}

function browserDictate(lang, { onText, onEnd, onError, onState } = {}) {
  const r = new Recognition();
  r.lang = lang && lang !== 'auto' ? (lang === 'zh' ? 'zh-CN' : lang) : navigator.language || 'en-US';
  r.interimResults = true;
  r.continuous = false;
  let finalText = '';
  let failed = false;
  r.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    onText?.((finalText + interim).trim(), !interim);
  };
  r.onerror = (ev) => { failed = true; onError?.(new Error(ev.error || 'SR_ERROR')); };
  r.onend = () => { if (!failed) onEnd?.(finalText.trim()); };
  onState?.('listening');
  try { r.start(); } catch (e) { failed = true; onError?.(e); }
  return () => { try { r.stop(); } catch { /* already stopped */ } };
}

function recordDictate(lang, { onText, onEnd, onError, onState, autoLang } = {}) {
  let rec;
  try { rec = record(); } catch (e) { onError?.(e); return () => {}; }
  onState?.('listening');
  (async () => {
    try {
      const { blob, heard } = await rec.done;
      if (!heard) { onError?.(new Error('no-speech')); return; }
      onState?.('transcribing');
      const { text } = await transcribe(blob, autoLang ? undefined : lang, { onStatus: (t) => onState?.(t) });
      if (!text) { onError?.(new Error('no-speech')); return; }
      onText?.(text, true);
      onEnd?.(text);
    } catch (e) {
      onError?.(new Error(e?.name === 'NotAllowedError' || e?.name === 'NotFoundError' ? e.name : (e?.message || 'SR_ERROR')));
    }
  })();
  return () => rec.stop();
}
