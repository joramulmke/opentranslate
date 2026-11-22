// Speech-to-text when the browser's speech service isn't used (not chosen, Brave, Firefox, or it fails):
// record the microphone ourselves (like any video-call site), stop on silence, then transcribe with
//   - your AI service's /audio/transcriptions endpoint (Whisper), if a speech model is set
//   - ElevenLabs (Scribe), if an ElevenLabs key is added
//   - on-device Whisper in the browser via transformers.js (asks once before the download)
// in the order chosen in Settings › Translation services › Speech recognition.
import { state } from '../state.js';
import { settings } from '../store.js';
import { sheet } from './permissions.js';
import { HF_MODELS, getPipeline, transformers, modelState, fromText, whisperKey } from './models.js';
import { createProvider } from '../providers.js';



/** Speech engines in the order to try: the chosen one first, then the others. */
export const SPEECH_ENGINES = ['browser', 'api', 'elevenlabs', 'ondevice'];
export function speechOrder() {
  const pref = SPEECH_ENGINES.includes(settings.get().speechEngine) ? settings.get().speechEngine : 'browser';
  return [pref, ...SPEECH_ENGINES.filter((e) => e !== pref)];
}

export const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder === 'function';

const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/**
 * Record until stop() or ~1.5 s of silence after speech (max 30 s, gives up after 7 s without speech).
 * @returns {{ done: Promise<{ blob: Blob, heard: boolean }>, stop: () => void, cancel: () => void }}
 */
export function record({ onLevel } = {}) {
  let stopFn = () => {}; let cancelled = false;
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = MIME.find((m) => MediaRecorder.isTypeSupported?.(m));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let heard = false; let lastLoud = performance.now(); const t0 = performance.now();
    const finished = new Promise((resolve) => { rec.onstop = resolve; });
    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
      onLevel?.(rms);
      const now = performance.now();
      if (rms > 0.02) { heard = true; lastLoud = now; }
      if ((heard && now - lastLoud > 1500) || (!heard && now - t0 > 7000) || now - t0 > 30000) stopFn();
    }, 100);
    stopFn = () => { if (rec.state !== 'inactive') rec.stop(); };
    rec.start(250);
    await finished;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    return { blob: new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }), heard: heard && !cancelled };
  })();
  return { done, stop: () => stopFn(), cancel: () => { cancelled = true; stopFn(); } };
}

/** Decode any recorded blob to 16 kHz mono Float32 (what Whisper expects). */
async function toPcm16k(blob) {
  const data = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audio = await ctx.decodeAudioData(data);
    const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally { ctx.close().catch(() => {}); }
}


/**
 * Whisper language identification. transformers.js 3.0 has no auto-detect (without a language it
 * outputs an English translation), so: one decoder step from <|startoftranscript|>, best language token.
 */
async function detectLanguage(asr, pcm) {
  const ids = asr.tokenizer.model.tokens_to_ids;
  const sot = ids.get('<|startoftranscript|>');
  const { input_features } = await asr.processor(pcm);
  const { Tensor } = await transformers();
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', [BigInt(sot)], [1, 1]) });
  const V = out.logits.dims.at(-1);
  const row = out.logits.data.slice(out.logits.data.length - V);
  let best = 'en'; let bv = -Infinity;
  for (const [tok, id] of ids) {
    if (!/^<\|[a-z]{2,3}\|>$/.test(tok) || row[id] <= bv) continue;
    bv = row[id]; best = tok.slice(2, -2);
  }
  return best;
}

async function onDeviceAllowed() {
  const s = settings.get();
  const key = whisperKey();
  const m = HF_MODELS[key];
  if (modelState(key) === 'ready' || s.sttModelOk === true) return true;
  if (s.sttModelOk === false) return false;
  const ok = await sheet({
    iconName: 'mic', title: 'Voice input on this device?',
    body: `Download a speech-recognition model (${m.title}, about ${m.sizeMB} MB, once, ${fromText(key)})? It runs privately in your browser and understands many languages. You can pick a smaller or larger one, or delete it, in Settings › Voice › Speech recognition.`,
    allowLabel: 'Download', cancelLabel: 'Not now',
  });
  settings.set({ sttModelOk: ok });
  return ok;
}

// your AI service: when it's the chosen engine, or as a fallback in Advanced mode
const apiReady = () => (settings.get().speechEngine === 'api' || state.mode === 'advanced')
  && typeof state.advanced?.transcribe === 'function' && !!state.advanced.sttModel;

// ElevenLabs: when its speech recognition was confirmed by a test and left on
const elevenEntry = () => settings.get().entries.find((e) => e.type === 'elevenlabs' && e.config?.audio === 'on') || null;

/**
 * Transcribe a recording with the best available engine.
 * @returns {Promise<{ text: string, engine: 'api'|'elevenlabs'|'ondevice' }>}
 */
export async function transcribe(blob, lang, { onStatus } = {}) {
  const code = lang && lang !== 'auto' ? String(lang).split('-')[0] : undefined;
  let apiError = null;
  const api = async () => {
    if (!apiReady()) return null;
    try {
      onStatus?.('Transcribing…');
      return { text: await state.advanced.transcribe(blob, code), engine: 'api' }; // API Whisper detects the language itself
    } catch (e) { apiError = e; return null; }
  };
  const eleven = async () => {
    const e = elevenEntry();
    if (!e) return null;
    try {
      onStatus?.('Transcribing…');
      return { text: await createProvider('elevenlabs', e.config).transcribe(blob, code), engine: 'elevenlabs' };
    } catch (err) { apiError = err; return null; }
  };
  const cloud = { api, elevenlabs: eleven };
  const order = speechOrder().filter((e) => e !== 'browser');
  // cloud engines chosen before the on-device model are tried first
  for (const e of order) {
    if (e === 'ondevice') break;
    const r = await cloud[e](); if (r) return r;
  }
  if (!(await onDeviceAllowed())) {
    // no on-device model: the cloud engines after it are still worth a try
    for (const e of order.slice(order.indexOf('ondevice') + 1)) { const r = await cloud[e](); if (r) return r; }
    throw new Error(apiError ? `Speech service failed: ${apiError.message}` : 'NO_ENGINE');
  }
  const asr = await getPipeline(whisperKey(), { onStatus });
  onStatus?.('Transcribing…');
  const pcm = await toPcm16k(blob);
  const language = code || await detectLanguage(asr, pcm);
  const out = await asr(pcm, { task: 'transcribe', chunk_length_s: 30, language });
  return { text: String(out?.text || '').trim(), engine: 'ondevice', language };
}
