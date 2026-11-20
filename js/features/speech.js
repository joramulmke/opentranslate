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

/**
 * Speak text. Resolves when finished or stopped. Rejects with Error('NO_VOICE') if
 * the device has no voice for that language (the UI shows a message).
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
    u.rate = 0.95;
    u.onstart = () => onStart?.();
    const finish = () => { if (currentUtterance === u) currentUtterance = null; onEnd?.(); resolve(); };
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
// Brave exposes the API but blocks the online speech service behind it, so every attempt fails with "network".
const isBrave = () => !!navigator.brave;
export const canDictate = () => !!Recognition && !isBrave();

/** Why voice input isn't available / stopped, in words a user can act on. Empty string = say nothing. */
export function dictationMessage(errOrCode) {
  const code = typeof errOrCode === 'string' ? errOrCode : errOrCode?.message;
  const browserHint = 'Use Chrome, Edge or Safari for voice input, or type instead.';
  switch (code) {
    case 'UNSUPPORTED': case 'NO_SR': return isBrave()
      ? `Brave blocks the online speech service voice input needs. ${browserHint}`
      : `This browser has no speech recognition. ${browserHint}`;
    case 'network': return `Voice input needs the browser's online speech service, which isn't reachable here. ${browserHint}`;
    case 'not-allowed': case 'service-not-allowed': return 'Microphone access is blocked. Allow it in the browser’s site settings.';
    case 'audio-capture': return 'No microphone found.';
    case 'no-speech': return "Didn't catch that. Tap the mic and try again.";
    case 'language-not-supported': return 'Voice input does not support this language in this browser.';
    case 'aborted': return '';
    default: return `Voice input stopped (${code || 'unknown error'}).`;
  }
}

/**
 * Start dictation. Returns a stop() function.
 * onText(text, isFinal) gets the running transcript.
 */
export function dictate(lang, { onText, onEnd, onError } = {}) {
  if (!Recognition) { onError?.(new Error('NO_SR')); return () => {}; }
  const r = new Recognition();
  r.lang = lang && lang !== 'auto' ? (lang === 'zh' ? 'zh-CN' : lang) : navigator.language || 'en-US';
  r.interimResults = true;
  r.continuous = false;
  let finalText = '';
  r.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    onText?.((finalText + interim).trim(), !interim);
  };
  r.onerror = (ev) => onError?.(new Error(ev.error || 'SR_ERROR'));
  r.onend = () => onEnd?.(finalText.trim());
  try { r.start(); } catch (e) { onError?.(e); }
  return () => { try { r.stop(); } catch { /* already stopped */ } };
}
