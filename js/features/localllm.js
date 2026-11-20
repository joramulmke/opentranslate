// On-device AI (Advanced mode): a small language model that runs in the browser with WebLLM
// (https://github.com/mlc-ai/web-llm, Apache-2.0) on the graphics chip (WebGPU), in a Web Worker.
// The model is downloaded once from Hugging Face (huggingface.co/mlc-ai) and kept in Cache Storage;
// after that it works without internet, and nothing you type leaves the device.
import { registerProvider, ProviderError, OpenAICompatibleProvider } from '../providers.js';

/** Model choices. Sizes are the download; the graphics memory needed is a bit more. */
export const LLM_MODELS = {
  small: { name: 'Small', model: 'Qwen 2.5 1.5B', sizeMB: 880,
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  medium: { name: 'Medium', model: 'Llama 3.2 3B', sizeMB: 1820,
    f16: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', f32: 'Llama-3.2-3B-Instruct-q4f32_1-MLC' },
};
export const llmKey = (k) => (k in LLM_MODELS ? k : 'small');
export const llmTitle = (k) => { const m = LLM_MODELS[llmKey(k)]; return `${m.name} · ${m.model}`; };

/* ------------------------------------------------------------- WebGPU */

let gpuInfo = null;
/** { ok, f16, reason } — whether this browser and device can run the model at all. */
export function checkGpu() {
  gpuInfo ??= (async () => {
    if (!globalThis.navigator?.gpu) {
      return { ok: false, reason: "This browser can't run AI models on the device: it has no WebGPU. Use a recent Chrome or Edge on a computer, or Safari 26 or later." };
    }
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { ok: false, reason: "WebGPU is turned off in this browser, or your graphics chip isn't supported." };
      return { ok: true, f16: a.features.has('shader-f16') };
    } catch (e) { return { ok: false, reason: `WebGPU isn't working here: ${e.message}` }; }
  })();
  return gpuInfo;
}
/** Synchronous answer once checkGpu() has run: true / false / null (not checked yet). */
let gpuOk = null;
checkGpu().then((g) => { gpuOk = g.ok; emit(); });
export const gpuUsable = () => gpuOk;

const modelId = async (key) => {
  const g = await checkGpu();
  if (!g.ok) throw new ProviderError('BROWSER_BLOCKED', g.reason);
  return LLM_MODELS[llmKey(key)][g.f16 ? 'f16' : 'f32'];
};

/* ------------------------------------------------------- downloaded flags */

const STORE = 'ot.llm.v1';
const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const writeStore = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ } };
export const isDownloaded = (key) => !!readStore()[llmKey(key)];
const mark = (key, on) => { const s = readStore(); if (on) s[llmKey(key)] = true; else delete s[llmKey(key)]; writeStore(s); };

const listeners = new Set();
export const onLlmChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function emit(what = 'state') { listeners.forEach((fn) => fn(what)); }

/* ------------------------------------------------------------- worker */

let worker = null;
let seq = 0;
const pending = new Map();   // id -> { resolve, reject, onProgress }

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if ('progress' in data) { p.onProgress?.(data); return; }
    pending.delete(data.id);
    if ('error' in data) p.reject(toProviderError(data.error)); else p.resolve(data.ok);
  };
  worker.onerror = (e) => { e.preventDefault?.(); stopWorker(new ProviderError('SERVER', `The on-device model stopped: ${e.message || "it couldn't start"}.`)); };
  return worker;
}

function stopWorker(err) {
  worker?.terminate();
  worker = null;
  loadedId = null;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

function call(op, payload, onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, op, ...payload });
  });
}

function toProviderError(msg) {
  if (/memory|allocat|OOM|too large/i.test(msg)) return new ProviderError('SERVER', `Not enough graphics memory for this model. Try the small one. (${msg})`);
  if (/fetch|network|Failed to load/i.test(msg)) return new ProviderError('NETWORK', `Couldn't download the model: ${msg}`);
  if (/device.*lost/i.test(msg)) return new ProviderError('SERVER', 'The graphics chip reset. Try again.');
  return new ProviderError('SERVER', msg);
}

/* -------------------------------------------------- download / remove */

const jobs = new Map();    // key -> { progress, phase, promise }
let loadedId = null;       // model id known to be on the GPU in this session

/** 'ready' | 'downloading' | 'none' */
export const llmState = (key) => (jobs.has(llmKey(key)) ? 'downloading' : isDownloaded(key) ? 'ready' : 'none');
export const llmProgress = (key) => jobs.get(llmKey(key))?.progress ?? 0;

/** Download the model (and load it, so the first translation is quick). Resolves when ready. */
export function downloadModel(key, { onProgress } = {}) {
  key = llmKey(key);
  const running = jobs.get(key);
  if (running) return running.promise;
  const job = { progress: 0, phase: 'download' };
  job.promise = (async () => {
    const id = await modelId(key);
    await call('load', { model: id }, (r) => {
      // WebLLM reports fetching first, then loading onto the GPU
      job.phase = /fetch/i.test(r.text || '') ? 'download' : 'load';
      job.progress = Math.max(0, Math.min(1, r.progress || 0));
      onProgress?.(job.progress);
      emit('progress');
    });
    loadedId = id;
    mark(key, true);
  })().finally(() => { jobs.delete(key); emit(); });
  jobs.set(key, job);
  emit();
  return job.promise;
}

/** Stop a running download. What was already fetched stays cached, so it resumes later. */
export function cancelModelDownload() {
  if (!jobs.size) return;
  stopWorker(new ProviderError('SERVER', 'Download cancelled.'));
}

export async function deleteModel(key) {
  key = llmKey(key);
  if (jobs.has(key)) cancelModelDownload();
  mark(key, false);
  emit();
  try { await call('delete', { model: await modelId(key) }); } catch { /* nothing cached / no WebGPU */ }
  loadedId = null;
}

const needsDownload = (key) => new ProviderError('NEEDS_DOWNLOAD',
  `The ${LLM_MODELS[key].name.toLowerCase()} on-device AI model isn't downloaded yet. It comes from Hugging Face (huggingface.co/mlc-ai).`,
  { size: LLM_MODELS[key].sizeMB * 1e6, download: (onProgress) => downloadModel(key, { onProgress }) });

async function chat(key, messages, maxTokens) {
  key = llmKey(key);
  if (!isDownloaded(key)) throw needsDownload(key);
  const id = await modelId(key);
  if (loadedId !== id) {
    // the browser may have cleared the files to free space: don't start a silent 1 GB download
    if (!(await call('has', { model: id }))) { mark(key, false); emit(); throw needsDownload(key); }
    loadedId = id;
  }
  return call('chat', { model: id, messages, maxTokens });
}

/* ------------------------------------------------------------ provider */

class LocalLLMProvider extends OpenAICompatibleProvider {
  constructor({ model }) {
    super({ baseUrl: '', model: '' });
    this.key = llmKey(model);
    this.name = 'On-device AI';
    this.isOnDevice = true;
    // small text models: no handwriting (vision) and no speech-to-text
    this.recognizeImage = undefined;
    this.transcribe = undefined;
    this.sttModel = '';
  }

  /** For the fallback chain: usable right now without a download? */
  ready() { return gpuOk !== false && isDownloaded(this.key); }

  async _chat(system, user, maxTokens) {
    const out = await chat(this.key, [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens);
    return String(out).replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  }

  async listModels() { return []; }

  async test() {
    const g = await checkGpu();
    if (!g.ok) return { ok: false, message: g.reason };
    if (!isDownloaded(this.key)) return { ok: false, message: `Not downloaded yet (${LLM_MODELS[this.key].sizeMB} MB).` };
    const r = await this.translate('Good morning', 'en', 'es');
    return { ok: true, message: `Ready. “Good morning” → “${r.text}”` };
  }
}

registerProvider({
  id: 'webllm',
  kind: 'advanced',
  label: 'On-device AI',
  description: 'A small AI model that runs in this browser on your graphics chip (WebGPU). Downloaded once from Hugging Face; after that it works without internet, and nothing you type leaves this device. Translations are less fluent than large online models.',
  fields: [
    { key: 'model', label: 'Model', type: 'select', default: 'small',
      help: 'Small is faster and works on more devices. Medium translates better but needs about 3 GB of graphics memory.',
      options: Object.entries(LLM_MODELS).map(([value, m]) => ({ value, label: `${m.name}: ${m.model} (${(m.sizeMB / 1000).toFixed(1)} GB download)` })) },
  ],
  create: (cfg) => new LocalLLMProvider(cfg),
});
