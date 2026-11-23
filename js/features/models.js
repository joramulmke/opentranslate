// Downloadable on-device models that run with transformers.js (speech recognition, handwriting, camera text):
// one place that loads them, knows whether they are downloaded, how big they are, where they come
// from, and can delete them. transformers.js keeps the files in Cache Storage ("transformers-cache").
import { keepDownloadsSafe } from './persist.js';
import { settings } from '../store.js';
import { bgDownload, bgResume } from './bgfetch.js';

export const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const CACHE = 'transformers-cache';

/** Where a download comes from, shown next to every download. */
export const SOURCES = {
  huggingface: { name: 'Hugging Face', host: 'huggingface.co' },
  mozilla: { name: 'Mozilla', host: 'firefox-settings-attachments.cdn.mozilla.net' },
  jsdelivr: { name: 'jsDelivr', host: 'cdn.jsdelivr.net' },
};

export const HF_MODELS = {
  // speech recognition: four sizes, picked in Settings (key 'whisper' = base, kept for earlier downloads)
  'whisper-tiny': {
    repo: 'Xenova/whisper-tiny', title: 'Whisper tiny', sizeMB: 41, licence: 'MIT', source: 'huggingface',
    task: 'automatic-speech-recognition', options: { dtype: 'q8' },
    what: 'speech model', okKey: 'sttModelOk', note: 'fastest, rough',
  },
  whisper: {
    repo: 'Xenova/whisper-base', title: 'Whisper base', sizeMB: 80, licence: 'MIT', source: 'huggingface',
    task: 'automatic-speech-recognition', options: { dtype: 'q8' },
    what: 'speech model', okKey: 'sttModelOk', note: 'good balance',
  },
  'whisper-small': {
    repo: 'Xenova/whisper-small', title: 'Whisper small', sizeMB: 250, licence: 'MIT', source: 'huggingface',
    task: 'automatic-speech-recognition', options: { dtype: 'q8' },
    what: 'speech model', okKey: 'sttModelOk', note: 'clearly better outside English',
  },
  'whisper-turbo': {
    repo: 'onnx-community/whisper-large-v3-turbo', title: 'Whisper large-v3 turbo', sizeMB: 563, licence: 'MIT', source: 'huggingface',
    task: 'automatic-speech-recognition', options: { device: 'webgpu', dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } },
    what: 'speech model', okKey: 'sttModelOk', note: 'best, needs WebGPU', webgpu: true,
  },
  trocr: {
    repo: 'Xenova/trocr-small-handwritten', title: 'TrOCR small, handwritten', sizeMB: 130, licence: 'MIT', source: 'huggingface',
    task: 'image-to-text',
    // full-precision encoder + 8-bit decoder: as accurate as all-fp32 in tests, ~130 MB instead of ~250 MB
    options: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    what: 'handwriting model', okKey: 'hwrModelOk',
  },
  // camera text: reads signs, menus and short texts with their place in the photo, and describes a photo
  // without text. Four parts (image encoder, word embeddings, encoder, decoder), all 8-bit.
  florence: {
    repo: 'onnx-community/Florence-2-base-ft', title: 'Florence-2 base', sizeMB: 270, licence: 'MIT', source: 'huggingface',
    model: 'Florence2ForConditionalGeneration', parts: ['embed_tokens', 'vision_encoder', 'encoder_model', 'decoder_model_merged'],
    options: { dtype: 'q8' },
    what: 'image model', okKey: 'visionModelOk',
  },
};
const partsOf = (key) => HF_MODELS[key].parts || ['encoder_model', 'decoder_model_merged'];
export const WHISPER_SIZES = ['whisper-tiny', 'whisper', 'whisper-small', 'whisper-turbo'];
/** The Whisper size picked in Settings (base by default). */
export const whisperKey = () => (WHISPER_SIZES.includes(settings.get().whisperModel) ? settings.get().whisperModel : 'whisper');
/** Can this browser run the model? (large-v3 turbo needs WebGPU with 16-bit floats) */
let f16 = null;
globalThis.navigator?.gpu?.requestAdapter?.().then((a) => { f16 = !!a?.features?.has('shader-f16'); emit(); }, () => { f16 = false; });
export const modelRunsHere = (key) => !HF_MODELS[key].webgpu || f16 === true;

export const modelPage = (key) => `https://huggingface.co/${HF_MODELS[key].repo}`;
/** "from Hugging Face (huggingface.co/Xenova/whisper-base)" */
export const fromText = (key) => `from Hugging Face (huggingface.co/${HF_MODELS[key].repo})`;

const listeners = new Set();
export const onModelsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what = 'state') => listeners.forEach((fn) => fn(what));

const present = new Map();   // key -> bytes (downloaded) ; missing = not downloaded
const jobs = new Map();      // key -> { progress }
const pipes = new Map();     // key -> Promise<pipeline>
let lib = null;

export const modelState = (key) => (jobs.has(key) ? 'downloading' : present.has(key) ? 'ready' : 'none');
export const modelProgress = (key) => jobs.get(key)?.progress ?? 0;
export const modelBytes = (key) => present.get(key) || 0;

export function transformers() {
  lib ??= import(/* webpackIgnore: true */ TRANSFORMERS).then((m) => { m.env.allowLocalModels = false; return m; });
  lib.catch(() => { lib = null; });
  return lib;
}

/** The cached files of one model: [{ req, bytes }]. */
async function cachedFiles(key) {
  if (typeof caches === 'undefined') return [];
  const c = await caches.open(CACHE);
  const marker = `/${HF_MODELS[key].repo}/`;
  const reqs = (await c.keys()).filter((r) => r.url.includes(marker));
  return Promise.all(reqs.map(async (req) => {
    const res = await c.match(req);
    const len = Number(res?.headers.get('content-length')) || (res ? (await res.clone().blob()).size : 0);
    return { req, bytes: len };
  }));
}

/** Look in the cache which models are downloaded (all model parts are there). */
export async function refreshModels() {
  for (const key of Object.keys(HF_MODELS)) {
    try {
      const files = await cachedFiles(key);
      const onnx = files.filter((f) => /\.onnx$/.test(f.req.url));
      if (onnx.length >= partsOf(key).length) present.set(key, files.reduce((a, f) => a + f.bytes, 0)); else present.delete(key);
    } catch { present.delete(key); }
  }
  emit();
}

/**
 * The ready-to-use pipeline; downloads the model first if needed.
 * onStatus(text) gets human-readable progress, onProgress(0..1) the fraction.
 */
export function getPipeline(key, { onStatus, onProgress } = {}) {
  const m = HF_MODELS[key];
  if (!modelRunsHere(key)) return Promise.reject(new Error(`${m.title} needs WebGPU with 16-bit support (a recent Chrome or Edge on a computer). Pick a smaller Whisper model.`));
  if (!pipes.has(key)) {
    const job = { progress: 0 };
    const p = (async () => {
      const lib = await transformers();
      const files = {};
      const cached = present.has(key);
      if (!cached) { jobs.set(key, job); emit(); }
      job.onStatus?.(cached ? `Loading ${m.what}…` : `Downloading ${m.what} ${fromText(key)}…`);
      const progress_callback = (ev) => {
        if (ev.status !== 'progress' || !ev.total) return;
        files[ev.file] = [ev.loaded, ev.total];
        const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
        job.progress = l / t;
        job.onStatus?.(cached ? `Loading ${m.what}… ${Math.round(job.progress * 100)}%`
          : `Downloading ${m.what} ${fromText(key)}… ${Math.round(job.progress * 100)}%`);
        job.onProgress?.(job.progress);
        emit('progress');
      };
      if (!m.model) return lib.pipeline(m.task, m.repo, { ...m.options, progress_callback });
      // a model without a ready-made pipeline (Florence-2): the model, its image processor and tokenizer
      const [model, processor, tokenizer] = await Promise.all([
        lib[m.model].from_pretrained(m.repo, { ...m.options, progress_callback }),
        lib.AutoProcessor.from_pretrained(m.repo, { progress_callback }),
        lib.AutoTokenizer.from_pretrained(m.repo, { progress_callback }),
      ]);
      return { model, processor, tokenizer, lib, dispose: () => model.dispose() };
    })();
    job.promise = p;
    pipes.set(key, p);
    p.then(() => refreshModels(), () => { pipes.delete(key); })
      .finally(() => { if (jobs.get(key) === job) { jobs.delete(key); emit(); } });
    pipes.get(key).job = job;
  }
  const job = pipes.get(key).job;
  job.onStatus = onStatus;
  job.onProgress = onProgress;
  return pipes.get(key);
}

// transformers.js file names: <part><suffix>.onnx in onnx/, the suffix from the precision (dtype)
const SUFFIX = { fp32: '', fp16: '_fp16', int8: '_int8', uint8: '_uint8', q8: '_quantized', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };

/**
 * The files transformers.js will ask for, as it names and caches them (Hugging Face URL as the key):
 * the JSON files next to the model (configs, tokenizer) and both model halves in the chosen precision.
 * Read from the model's file list, so nothing has to start; null when the list can't be loaded.
 */
async function modelFiles(key) {
  const m = HF_MODELS[key];
  try {
    const res = await fetch(`https://huggingface.co/api/models/${m.repo}/tree/main?recursive=true`, { credentials: 'omit' });
    if (!res.ok) return null;
    const tree = await res.json();
    const dtype = (part) => (typeof m.options?.dtype === 'string' ? m.options.dtype : m.options?.dtype?.[part]) || (m.options?.device === 'webgpu' ? 'fp32' : 'q8');
    const parts = partsOf(key);
    const wanted = (path) => (!path.includes('/') && path.endsWith('.json'))
      || parts.some((part) => path === `onnx/${part}${SUFFIX[dtype(part)]}.onnx` || path === `onnx/${part}${SUFFIX[dtype(part)]}.onnx_data`);
    const files = tree.filter((f) => f.type === 'file' && wanted(f.path))
      .map((f) => ({ url: `https://huggingface.co/${m.repo}/resolve/main/${f.path}`, cache: CACHE, size: f.lfs?.size || f.size }));
    return files.filter((f) => /\.onnx$/.test(f.url)).length === parts.length ? files : null;
  } catch { return null; }
}

/** Download ahead of time (Settings). Counts as a yes to the "download?" question. */
export async function downloadModel(key, { onProgress } = {}) {
  const m = HF_MODELS[key];
  settings.set({ [m.okKey]: true });
  if (present.has(key) || jobs.has(key) || pipes.has(key) || !modelRunsHere(key)) { await getPipeline(key, { onProgress }); return; }
  // keeps going when the app is closed, where the browser can (Chrome on Android); it isn't loaded yet then
  keepDownloadsSafe();   // first download: ask to keep downloads safe (doesn't wait)
  const job = { progress: 0 };
  jobs.set(key, job); emit();
  try {
    const files = await modelFiles(key);
    const c = files && await caches.open(CACHE);
    const todo = [];
    for (const f of files || []) if (!(await c.match(f.url))) todo.push(f);
    const bg = todo.length ? await bgDownload(`model:${key}`, {
      title: `${m.title} (${m.what})`, doneTitle: `${m.title} is ready to use offline`,
      failTitle: `${m.title} didn't finish downloading. Open OpenTranslate to try again.`, files: todo, estimate: m.sizeMB * 1e6,
    }) : null;
    if (bg) {
      bg.onProgress = (p) => { job.progress = p; onProgress?.(p); emit('progress'); };
      await bg.promise;
      await refreshModels();
      return;
    }
  } finally {
    jobs.delete(key); emit();
  }
  await getPipeline(key, { onProgress });
}

// background downloads from an earlier visit: still running (show the progress) or finished meanwhile
bgResume('model:', (key, bg) => {
  if (!HF_MODELS[key] || jobs.has(key)) return;
  const job = { progress: bg.progress() };
  bg.onProgress = (p) => { job.progress = p; emit('progress'); };
  jobs.set(key, job);
  bg.promise.catch(() => {}).finally(async () => { if (jobs.get(key) === job) jobs.delete(key); await refreshModels(); });
  emit();
});

export async function deleteModel(key) {
  const p = pipes.get(key);
  pipes.delete(key);
  try { (await p)?.dispose?.(); } catch { /* not loaded */ }
  try {
    const c = await caches.open(CACHE);
    for (const f of await cachedFiles(key)) await c.delete(f.req);
  } catch { /* no cache storage */ }
  present.delete(key);
  settings.set({ [HF_MODELS[key].okKey]: null });   // ask again before downloading it next time
  emit();
}

refreshModels();
