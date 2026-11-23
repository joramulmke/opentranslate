import { canRecord, record, transcribe, speechOrder } from './stt.js';
import { toast } from '../ui/snackbar.js';
import { settings } from '../store.js';
import { createProvider } from '../providers.js';
import { langName, errorText } from '../state.js';
import { sheet } from './permissions.js';
import { voiceFor as piperVoice, offerFor, synthesize, downloadVoice, downloadSize, voiceLabel, kokoroFor } from './piper.js';
// Read-aloud with the engines chosen in Settings › Voice › Read aloud:
//   system     the device's own voices (speechSynthesis)
//   ondevice   Piper voices downloaded to this browser (piper.js)
//   api        your AI service's /audio/speech
//   elevenlabs your ElevenLabs account
// The chosen engine is tried first, then the others in this order.
// Dictation (SpeechRecognition, where the browser has it) is further down.

let voices = [];
const loadVoices = () => { voices = window.speechSynthesis?.getVoices() || []; };
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

const systemTts = () => 'speechSynthesis' in window;
/** Can anything read aloud here? (system voices, or an audio element for the other engines) */
export const canSpeak = () => systemTts() || typeof window.Audio === 'function';

function systemVoice(lang) {
  if (!voices.length) loadVoices();
  const base = lang.split('-')[0].toLowerCase();
  const alias = { zh: ['zh-cn', 'zh'], 'zh-hant': ['zh-tw', 'zh-hk'], no: ['nb', 'no'], he: ['he', 'iw'], tl: ['fil', 'tl'] };
  const wanted = alias[lang.toLowerCase()] || alias[base] || [base];
  return voices.find((v) => wanted.some((w) => v.lang.toLowerCase().replace('_', '-').startsWith(w)));
}
/** Does the device have its own voice for this language? */
export const hasSystemVoice = (lang) => systemTts() && !!systemVoice(lang);

/* ------------------------------------------------------------ engines */

export const TTS_ENGINES = ['system', 'ondevice', 'api', 'elevenlabs'];
export function ttsOrder() {
  const pref = TTS_ENGINES.includes(settings.get().ttsEngine) ? settings.get().ttsEngine : 'system';
  return [pref, ...TTS_ENGINES.filter((e) => e !== pref)];
}
/** The AI service entry that reads aloud (a text-to-speech model the test confirmed and left on). */
export const ttsApiEntry = () => settings.get().entries.find((e) => e.type === 'openai' && e.config?.ttsModel && e.config?.tts === 'on') || null;
/** The ElevenLabs entry, when its voice was confirmed by a test. */
export const elevenEntry = (what = 'tts') => settings.get().entries.find((e) => e.type === 'elevenlabs' && e.config?.[what] === 'on') || null;

/** Ask once per language whether to download an offline voice. Resolves to true when it is there. */
async function offerVoice(lang) {
  const v = offerFor(lang);
  const s = settings.get();
  if (!v || (s.ttsDeclined || []).includes(v.lang) || typeof caches === 'undefined') return false;
  const name = voiceLabel(v.lang, langName);
  const ok = await sheet({
    iconName: 'volume', title: `Download a ${name} voice?`,
    body: `To read ${name} aloud, download a natural-sounding voice (${downloadSize(v)}) from Hugging Face (huggingface.co/rhasspy/piper-voices). It runs privately in your browser and works without internet. You can delete it in Settings › Voice › Read aloud.`,
    allowLabel: 'Download', cancelLabel: 'Not now',
  });
  if (!ok) { settings.set({ ttsDeclined: [...(s.ttsDeclined || []), v.lang] }); return false; }
  toast(`Downloading the ${name} voice…`);
  try { await downloadVoice(v.lang); } catch (e) { toast(`Download failed: ${errorText(e)}`); return false; }
  toast(`The ${name} voice is downloaded and works without internet.`);
  return true;
}

/* ------------------------------------------------------------ playback */

let current = null;          // { stop } of what is playing
let player = null;           // the <audio> used for engines that return a recording
const recent = new Map();    // engine|lang|text -> Blob (replays don't synthesize or pay again)

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

/** Can a voice read this language right now, without downloading one first? */
export function canReadAloud(lang) {
  if (!lang || lang === 'auto') return false;
  return hasSystemVoice(lang) || (systemTts() && !voices.length) || !!piperVoice(lang)
    || !!kokoroFor(lang, settings.get().kokoroVoices || {}) || !!ttsApiEntry() || !!elevenEntry('tts');
}

// Word highlight (IDEAS #16): onWord(start, end) gives the character range of the word being spoken,
// onWord(-1, -1) clears it. Only where the timing is exact: system voices that report word boundaries,
// and ElevenLabs (its timestamps). Other voices just play.
const wordEnd = (text, i) => { const m = /^[^\s]+/.exec(text.slice(i)); return i + (m ? m[0].length : 0); };

function playSystem(text, lang, slow, onStart, onWord) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'zh' ? 'zh-CN' : lang === 'zh-Hant' ? 'zh-TW' : lang;
    const v = systemVoice(lang);
    if (v) u.voice = v;
    u.rate = slow ? SLOW_RATE : NORMAL_RATE;
    const me = { stop: () => speechSynthesis.cancel() };
    u.onstart = () => onStart();
    u.onboundary = (ev) => {
      if (!onWord || ev.name !== 'word' || current !== me) return;
      const i = ev.charIndex;
      // some voices leave out charLength; then the word runs to the next space
      onWord(i, ev.charLength ? i + ev.charLength : wordEnd(text, i));
    };
    u.onend = () => { onWord?.(-1, -1); resolve(current === me); };
    u.onerror = () => { onWord?.(-1, -1); resolve(false); };
    current = me;
    speechSynthesis.speak(u);
  });
}

function playBlob(blob, slow, onStart, words, onWord) {
  return new Promise((resolve) => {
    player ??= new Audio();
    const url = URL.createObjectURL(blob);
    const me = { stop: () => { player.pause(); finish(false); } };
    let ended = false;
    let frame = 0;
    let shown = -1;
    // words: [{ start, end, t }] (t = seconds into the recording); currentTime follows the playback rate
    const follow = () => {
      if (ended) return;
      const now = player.currentTime;
      let k = -1;
      for (let i = 0; i < words.length && words[i].t <= now; i++) k = i;
      if (k !== shown) { shown = k; if (k >= 0) onWord(words[k].start, words[k].end); }
      frame = requestAnimationFrame(follow);
    };
    const finish = (completed) => {
      if (ended) return; ended = true;
      cancelAnimationFrame(frame);
      if (words?.length && onWord) onWord(-1, -1);
      player.onended = player.onerror = player.onplaying = null;
      URL.revokeObjectURL(url);
      resolve(completed && current === me);
    };
    player.src = url;
    player.playbackRate = slow ? SLOW_RATE / NORMAL_RATE : 1;   // recordings are made at normal speed
    if ('preservesPitch' in player) player.preservesPitch = true;
    player.onplaying = () => { onStart(); if (words?.length && onWord && !frame) follow(); };
    player.onended = () => finish(true);
    player.onerror = () => finish(false);
    current = me;
    player.play().catch(() => finish(false));
  });
}

/** A recording of text from one engine (kept for a quick replay). */
async function recording(engine, text, lang, make) {
  const key = `${engine}|${lang}|${text}`;
  if (recent.has(key)) return recent.get(key);
  const blob = await make();
  recent.set(key, blob);
  if (recent.size > 8) recent.delete(recent.keys().next().value);
  return blob;
}

/** The first engine (in Settings order) that can read this language, and how. */
async function pickEngine(text, lang) {
  let lastError = null;
  for (const engine of ttsOrder()) {
    try {
      if (engine === 'system') {
        // some engines load their voices late: with no list at all, let the browser try
        if (systemTts() && (systemVoice(lang) || !voices.length)) return { engine };
      } else if (engine === 'ondevice') {
        // Kokoro (when downloaded and it speaks the language), else the language's Piper voice
        const picked = settings.get().kokoroVoices || {};
        const k = kokoroFor(lang, picked);
        if (k || piperVoice(lang) || await offerVoice(lang)) {
          return { engine, blob: await recording(k ? `kokoro:${k.voice}` : engine, text, lang, () => synthesize(text, lang, picked)) };
        }
      } else if (engine === 'api') {
        const e = ttsApiEntry();
        if (e) return { engine, blob: await recording(engine, text, lang, () => createProvider('openai', e.config).speak(text, lang)) };
      } else if (engine === 'elevenlabs') {
        const e = elevenEntry('tts');
        if (e) {
          // with word timings (same price): { blob, words }
          const r = await recording(engine, text, lang, () => createProvider('elevenlabs', e.config).speakTimed(text, lang));
          return { engine, blob: r.blob, words: r.words };
        }
      }
    } catch (err) { lastError = err; }   // this engine failed: try the next one
  }
  if (lastError) console.warn('read aloud:', lastError);
  throw new Error(canSpeak() ? 'NO_VOICE' : 'NO_TTS');
}

/**
 * Speak text. Resolves when finished or stopped. Rejects with Error('NO_VOICE') if no engine
 * can read that language (the UI shows a message), or Error('NO_TTS') if nothing can play sound.
 * onStart(slow) says whether this is the slow replay.
 */
export async function speak(text, lang, { onStart, onEnd, onWord, normalSpeed = false } = {}) {
  stopSpeaking();
  const token = {};
  current = token;
  let pick;
  try { pick = await pickEngine(text, lang); } catch (e) { if (current === token) current = null; throw e; }
  if (current !== token) { onEnd?.(); return; }       // stopped (or replaced) while preparing
  const slow = !normalSpeed && nextIsSlow(text, lang);
  const started = () => { if (slow) toast('Playing slower. Play again for normal speed.'); onStart?.(slow); };
  const completed = pick.engine === 'system' ? await playSystem(text, lang, slow, started, onWord) : await playBlob(pick.blob, slow, started, pick.words, onWord);
  // only a play that reached the end counts (not one stopped by the person)
  lastPlay = completed ? { key: `${lang}\u0000${text}`, end: Date.now(), slow } : null;
  current = null;
  onEnd?.();
}

export function stopSpeaking() {
  if (systemTts() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  const c = current;
  current = null;
  c?.stop?.();
}
export const isSpeaking = () => !!current;

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
