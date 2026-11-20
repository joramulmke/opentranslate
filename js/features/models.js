// Downloadable on-device models that run with transformers.js (speech recognition, handwriting):
// one place that loads them, knows whether they are downloaded, how big they are, where they come
// from, and can delete them. transformers.js keeps the files in Cache Storage ("transformers-cache").
import { settings } from '../store.js';

export const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const CACHE = 'transformers-cache';

/** Where a download comes from, shown next to every download. */
export const SOURCES = {
  huggingface: { name: 'Hugging Face', host: 'huggingface.co' },
  mozilla: { name: 'Mozilla', host: 'firefox-settings-attachments.cdn.mozilla.net' },
  jsdelivr: { name: 'jsDelivr', host: 'cdn.jsdelivr.net' },
};

export const HF_MODELS = {
  whisper: {
    repo: 'Xenova/whisper-base', title: 'Whisper base', sizeMB: 80, licence: 'MIT', source: 'huggingface',
    task: 'automatic-speech-recognition', options: { dtype: 'q8' },
    what: 'speech model', okKey: 'sttModelOk',
  },
  trocr: {
    repo: 'Xenova/trocr-small-handwritten', title: 'TrOCR small, handwritten', sizeMB: 130, licence: 'MIT', source: 'huggingface',
    task: 'image-to-text',
    // full-precision encoder + 8-bit decoder: as accurate as all-fp32 in tests, ~130 MB instead of ~250 MB
    options: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    what: 'handwriting model', okKey: 'hwrModelOk',
  },
};
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

/** Look in the cache which models are downloaded (both model halves are there). */
export async function refreshModels() {
  for (const key of Object.keys(HF_MODELS)) {
    try {
      const files = await cachedFiles(key);
      const onnx = files.filter((f) => /\.onnx$/.test(f.req.url));
      if (onnx.length >= 2) present.set(key, files.reduce((a, f) => a + f.bytes, 0)); else present.delete(key);
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
  if (!pipes.has(key)) {
    const job = { progress: 0 };
    const p = (async () => {
      const { pipeline } = await transformers();
      const files = {};
      const cached = present.has(key);
      if (!cached) { jobs.set(key, job); emit(); }
      job.onStatus?.(cached ? `Loading ${m.what}…` : `Downloading ${m.what} ${fromText(key)}…`);
      const pipe = await pipeline(m.task, m.repo, {
        ...m.options,
        progress_callback: (ev) => {
          if (ev.status !== 'progress' || !ev.total) return;
          files[ev.file] = [ev.loaded, ev.total];
          const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
          job.progress = l / t;
          job.onStatus?.(cached ? `Loading ${m.what}… ${Math.round(job.progress * 100)}%`
            : `Downloading ${m.what} ${fromText(key)}… ${Math.round(job.progress * 100)}%`);
          job.onProgress?.(job.progress);
          emit('progress');
        },
      });
      return pipe;
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

/** Download ahead of time (Settings). Counts as a yes to the "download?" question. */
export async function downloadModel(key, { onProgress } = {}) {
  settings.set({ [HF_MODELS[key].okKey]: true });
  await getPipeline(key, { onProgress });
}

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
