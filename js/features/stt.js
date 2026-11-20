// Speech-to-text for browsers without a speech service (Brave, Firefox) or when it fails:
// record the microphone ourselves (like any video-call site), stop on silence, then transcribe with
//   1. Advanced mode: your OpenAI-compatible /audio/transcriptions endpoint (Whisper), if a speech model is set
//   2. On-device Whisper in the browser via transformers.js (asks once before the download)
import { state } from '../state.js';
import { settings } from '../store.js';
import { sheet } from './permissions.js';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
export const WHISPER = { model: 'Xenova/whisper-base', dtype: 'q8', sizeMB: 80 };

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

let whisper = null;
let TensorCls = null;
function loadWhisper(onStatus) {
  if (!whisper) {
    whisper = (async () => {
      const { pipeline, env, Tensor } = await import(/* webpackIgnore: true */ TRANSFORMERS);
      TensorCls = Tensor;
      env.allowLocalModels = false;
      const files = {};
      return pipeline('automatic-speech-recognition', WHISPER.model, {
        dtype: WHISPER.dtype,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files[p.file] = [p.loaded, p.total];
            const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
            onStatus?.(`Downloading speech model… ${Math.round((l / t) * 100)}%`);
          }
        },
      });
    })();
    whisper.catch(() => { whisper = null; });
  }
  return whisper;
}

/**
 * Whisper language identification. transformers.js 3.0 has no auto-detect (without a language it
 * outputs an English translation), so: one decoder step from <|startoftranscript|>, best language token.
 */
async function detectLanguage(asr, pcm) {
  const ids = asr.tokenizer.model.tokens_to_ids;
  const sot = ids.get('<|startoftranscript|>');
  const { input_features } = await asr.processor(pcm);
  const out = await asr.model({ input_features, decoder_input_ids: new TensorCls('int64', [BigInt(sot)], [1, 1]) });
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
  if (s.sttModelOk === true) return true;
  if (s.sttModelOk === false) return false;
  const ok = await sheet({
    iconName: 'mic', title: 'Voice input on this device?',
    body: `This browser has no built-in speech service. Download a speech-recognition model (about ${WHISPER.sizeMB} MB, once) that runs privately in your browser? It understands many languages.`,
    allowLabel: 'Download', cancelLabel: 'Not now',
  });
  settings.set({ sttModelOk: ok });
  return ok;
}

const apiReady = () => state.mode === 'advanced' && typeof state.advanced?.transcribe === 'function' && !!state.advanced.sttModel;

/**
 * Transcribe a recording with the best available engine.
 * @returns {Promise<{ text: string, engine: 'api'|'ondevice' }>}
 */
export async function transcribe(blob, lang, { onStatus } = {}) {
  const code = lang && lang !== 'auto' ? String(lang).split('-')[0] : undefined;
  let apiError = null;
  if (apiReady()) {
    try {
      onStatus?.('Transcribing…');
      return { text: await state.advanced.transcribe(blob, code), engine: 'api' }; // API Whisper detects the language itself
    } catch (e) { apiError = e; }
  }
  if (!(await onDeviceAllowed())) {
    const err = new Error(apiError ? `Speech API failed: ${apiError.message}` : 'NO_ENGINE');
    throw err;
  }
  const asr = await loadWhisper(onStatus);
  onStatus?.('Transcribing…');
  const pcm = await toPcm16k(blob);
  const language = code || await detectLanguage(asr, pcm);
  const out = await asr(pcm, { task: 'transcribe', chunk_length_s: 30, language });
  return { text: String(out?.text || '').trim(), engine: 'ondevice', language };
}
