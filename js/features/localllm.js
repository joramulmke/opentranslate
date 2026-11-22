// On-device AI (Advanced mode): a language model that runs in the browser, nothing you type leaves the device.
//   - WebLLM (https://github.com/mlc-ai/web-llm, Apache-2.0) on the graphics chip (WebGPU), in a Web Worker:
//     any model of its catalogue (llmcatalog.js), or your own MLC-compiled model by URL. Downloaded once from
//     Hugging Face and kept in Cache Storage; after that it works without internet.
//   - Gemini Nano, built into Chrome (Prompt API): Chrome downloads and manages the model itself.
import { registerProvider, ProviderError, OpenAICompatibleProvider } from '../providers.js';
import { LLM_CATALOG, LLM_CURATED, prettyName } from './llmcatalog.js';

export const NANO = 'gemini-nano';
export const CUSTOM = 'custom';
const DEFAULT = 'Qwen2.5-1.5B-Instruct';
// entries saved by earlier versions
const LEGACY = { small: 'Qwen2.5-1.5B-Instruct', medium: 'Llama-3.2-3B-Instruct' };

/* --------------------------------------------------------------- specs */

const customs = new Map();   // key -> spec of a model added by URL

/**
 * Everything about the model an entry uses:
 * { key, kind: 'webllm'|'nano', title, sizeMB, vram16, vram32, custom?: { url, lib } }.
 * key identifies the download (two entries with the same model share it).
 */
export function llmSpec(config = {}) {
  const m = LEGACY[config.model] || config.model || DEFAULT;
  if (m === NANO) return { key: NANO, kind: 'nano', title: 'Gemini Nano (built into Chrome)', sizeMB: 0 };
  if (m === CUSTOM || String(m).startsWith('custom:')) {
    const url = String(config.customUrl || '').trim().replace(/\/+$/, '');
    const key = `custom:${url}`;
    const name = url.split('/').filter(Boolean).pop() || 'Own model';
    const spec = { key, kind: 'webllm', title: name, sizeMB: Number(config.customSizeMB) || 0,
      vram16: Number(config.customVram) || 0, vram32: Number(config.customVram) || 0,
      custom: { url, lib: String(config.customLib || '').trim(), f16: !/f32/i.test(name) } };
    if (url) customs.set(key, spec);
    return spec;
  }
  const c = LLM_CATALOG.find((x) => x.key === m) || LLM_CATALOG.find((x) => x.key === DEFAULT);
  return { key: c.key, kind: 'webllm', title: prettyName(c.key), sizeMB: c.sizeMB, vram16: c.vram16, vram32: c.vram32 };
}
const specOf = (key) => customs.get(key) || llmSpec({ model: key });

/** Options for the model picker: [{ group, options: [{ value, label }] }]. */
export function llmOptions() {
  const gb = (mb) => `${(mb / 1000).toFixed(1)} GB`;
  const label = (c, note) => `${prettyName(c.key)} · ${gb(c.sizeMB)} download, ${gb(c.vram16 || c.vram32)} graphics memory${note ? ` · ${note}` : ''}`;
  const picked = new Set(LLM_CURATED.map(([k]) => k));
  return [
    { group: 'Recommended for translating', options: LLM_CURATED.map(([k, note]) => ({ value: k, label: label(LLM_CATALOG.find((c) => c.key === k), note) })) },
    { group: 'Built into this browser', options: [{ value: NANO, label: 'Gemini Nano (Chrome) · downloaded and managed by Chrome' }] },
    { group: 'All WebLLM models', options: LLM_CATALOG.filter((c) => !picked.has(c.key)).sort((a, b) => a.key.localeCompare(b.key, 'en', { sensitivity: 'base' }))
      .map((c) => ({ value: c.key, label: label(c) })) },
    { group: 'Your own model', options: [{ value: CUSTOM, label: 'Own model by URL (MLC format)…' }] },
  ];
}

/* ------------------------------------------------------------- WebGPU */

let gpuInfo = null;
/** { ok, f16, reason } — whether this browser and device can run WebLLM models at all. */
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

/** What the worker needs to load a WebLLM model: its id, and for own models the record to add. */
async function target(spec) {
  const g = await checkGpu();
  if (!g.ok) throw new ProviderError('BROWSER_BLOCKED', g.reason);
  if (spec.custom) {
    if (!/^https:\/\//.test(spec.custom.url) || !/^https:\/\/.+\.wasm$/.test(spec.custom.lib)) {
      throw new ProviderError('SERVER', 'Your own model needs an https:// model URL and an https:// model library ending in .wasm.');
    }
    // a plain id for WebLLM (it names caches and configs by it), unique per URL
    const id = `own-${spec.custom.url.replace(/^https:\/\//, '').replace(/[^a-z0-9.]+/gi, '-')}`.slice(0, 120);
    return { model: id, record: { model: spec.custom.url, model_id: id, model_lib: spec.custom.lib,
      ...(spec.vram16 ? { vram_required_MB: spec.vram16 } : {}), overrides: { context_window_size: 4096 } } };
  }
  const c = LLM_CATALOG.find((x) => x.key === spec.key);
  const f16 = g.f16 && c.vram16;
  if (!f16 && !c.vram32) throw new ProviderError('BROWSER_BLOCKED', `${prettyName(c.key)} needs 16-bit graphics (shader-f16), which this device doesn't have. Pick another model.`);
  return { model: `${c.key}-${f16 ? 'q4f16_1' : 'q4f32_1'}-MLC` };
}

/* ------------------------------------------------------- downloaded flags */

const STORE = 'ot.llm.v1';
const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const writeStore = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ } };
// earlier versions stored 'small' / 'medium'
{ const s = readStore(); let moved = false; for (const [o, n] of Object.entries(LEGACY)) if (s[o]) { s[n] = true; delete s[o]; moved = true; } if (moved) writeStore(s); }
let nanoState = 'unavailable';   // Chrome's answer: available | downloadable | downloading | unavailable
export const isDownloaded = (key) => (key === NANO ? nanoState === 'available' : !!readStore()[key]);
const mark = (key, on) => { const s = readStore(); if (on) s[key] = true; else delete s[key]; writeStore(s); };

const listeners = new Set();
export const onLlmChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function emit(what = 'state') { listeners.forEach((fn) => fn(what)); }

/* ---------------------------------------------------------- Gemini Nano */

const LM = () => globalThis.LanguageModel;
/** Is Gemini Nano there at all (Chrome with the Prompt API)? */
export const nanoSupported = () => typeof LM()?.availability === 'function';
export const nanoAvailability = () => nanoState;
export async function refreshNano() {
  if (!nanoSupported()) { nanoState = 'unavailable'; return nanoState; }
  try { nanoState = await LM().availability(); } catch { nanoState = 'unavailable'; }
  emit();
  return nanoState;
}
refreshNano();

async function nanoChat(system, user, outLang) {
  const opts = { initialPrompts: [{ role: 'system', content: system }],
    ...(outLang ? { expectedOutputs: [{ type: 'text', languages: [outLang] }] } : {}) };
  let session;
  try { session = await LM().create(opts); } catch (e) {
    if (e?.name === 'NotSupportedError') throw new ProviderError('UNSUPPORTED_PAIR', `Gemini Nano can't write ${outLang} yet.`);
    throw new ProviderError('SERVER', `Gemini Nano didn't start: ${e?.message || e}`);
  }
  try { return await session.prompt(user); } finally { session.destroy?.(); }
}

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
  if (/memory|allocat|OOM|too large/i.test(msg)) return new ProviderError('SERVER', `Not enough graphics memory for this model. Try a smaller one. (${msg})`);
  if (/fetch|network|Failed to load|404/i.test(msg)) return new ProviderError('NETWORK', `Couldn't download the model: ${msg}`);
  if (/device.*lost/i.test(msg)) return new ProviderError('SERVER', 'The graphics chip reset. Try again.');
  return new ProviderError('SERVER', msg);
}

/* -------------------------------------------------- download / remove */

const jobs = new Map();    // key -> { progress, phase, promise }
let loadedId = null;       // model id known to be on the GPU in this session

/** 'ready' | 'downloading' | 'none' */
export const llmState = (key) => (jobs.has(key) || (key === NANO && nanoState === 'downloading') ? 'downloading' : isDownloaded(key) ? 'ready' : 'none');
export const llmProgress = (key) => jobs.get(key)?.progress ?? 0;
export const llmTitle = (key) => specOf(key).title;

/** Download the model (and load it, so the first translation is quick). Resolves when ready. */
export function downloadModel(key, { onProgress } = {}) {
  const running = jobs.get(key);
  if (running) return running.promise;
  const spec = specOf(key);
  const job = { progress: 0, phase: 'download' };
  job.promise = (async () => {
    if (spec.kind === 'nano') {
      if (!nanoSupported()) throw new ProviderError('BROWSER_BLOCKED', 'Gemini Nano is only built into Chrome on computers.');
      // Chrome downloads the model when a session is first created (needs a click, which this is)
      const s = await LM().create({ monitor(m) { m.addEventListener('downloadprogress', (e) => { job.progress = e.loaded; onProgress?.(e.loaded); emit('progress'); }); } });
      s.destroy?.();
      await refreshNano();
      return;
    }
    const t = await target(spec);
    await call('load', t, (r) => {
      // WebLLM reports fetching first, then loading onto the GPU
      job.phase = /fetch/i.test(r.text || '') ? 'download' : 'load';
      job.progress = Math.max(0, Math.min(1, r.progress || 0));
      onProgress?.(job.progress);
      emit('progress');
    });
    loadedId = t.model;
    mark(key, true);
  })().finally(() => { jobs.delete(key); emit(); });
  jobs.set(key, job);
  emit();
  return job.promise;
}

/** Stop a running download. What was already fetched stays cached, so it resumes later. */
export function cancelModelDownload() {
  if (![...jobs.keys()].some((k) => k !== NANO)) return;
  stopWorker(new ProviderError('SERVER', 'Download cancelled.'));
}

export async function deleteModel(key) {
  if (key === NANO) return;   // Chrome manages Gemini Nano (chrome://on-device-internals)
  if (jobs.has(key)) cancelModelDownload();
  mark(key, false);
  emit();
  try { await call('delete', await target(specOf(key))); } catch { /* nothing cached / no WebGPU */ }
  loadedId = null;
}

const needsDownload = (spec) => new ProviderError('NEEDS_DOWNLOAD',
  `The on-device AI model ${spec.title} isn't downloaded yet. It comes from ${spec.custom ? new URL(spec.custom.url).host : 'Hugging Face (huggingface.co/mlc-ai)'}.`,
  { size: spec.sizeMB * 1e6, download: (onProgress) => downloadModel(spec.key, { onProgress }) });

async function chat(spec, messages, maxTokens) {
  if (!isDownloaded(spec.key)) throw needsDownload(spec);
  const t = await target(spec);
  if (loadedId !== t.model) {
    // the browser may have cleared the files to free space: don't start a silent download
    if (!(await call('has', t))) { mark(spec.key, false); emit(); throw needsDownload(spec); }
    loadedId = t.model;
  }
  // Qwen 3 models think first unless told not to; translating doesn't need it
  return call('chat', { ...t, messages, maxTokens, noThinking: /^Qwen3/i.test(spec.key) });
}

/* ------------------------------------------------------------ provider */

class LocalLLMProvider extends OpenAICompatibleProvider {
  constructor(config) {
    super({ baseUrl: '', model: '' });
    this.spec = llmSpec(config);
    this.key = this.spec.key;
    this.name = 'On-device AI';
    this.isOnDevice = true;
    // small text models: no handwriting (vision) and no speech-to-text
    this.recognizeImage = undefined;
    this.transcribe = undefined;
    this.sttModel = '';
    this._target = null;
  }

  /** For the fallback chain: usable right now without a download? */
  ready() { return this.spec.kind === 'nano' ? nanoState === 'available' : gpuOk !== false && isDownloaded(this.key); }

  async translate(text, source, target) {
    this._target = target;
    try { return await super.translate(text, source, target); } finally { this._target = null; }
  }

  async _chat(system, user, maxTokens) {
    const out = this.spec.kind === 'nano'
      ? await (nanoState === 'available' ? nanoChat(system, user, this._target?.split('-')[0]) : Promise.reject(needsDownload(this.spec)))
      : await chat(this.spec, [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens);
    return String(out).replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
  }

  async listModels() { return []; }

  async test() {
    if (this.spec.kind === 'nano') {
      const st = await refreshNano();
      if (st === 'unavailable') return { ok: false, message: nanoSupported() ? "Gemini Nano isn't available on this device (Chrome needs about 22 GB free disk space and a capable computer)." : 'Gemini Nano is only built into Chrome on computers.' };
      if (st !== 'available') return { ok: false, message: 'Chrome hasn’t downloaded Gemini Nano yet. Save, then use the download button.' };
    } else {
      const g = await checkGpu();
      if (!g.ok) return { ok: false, message: g.reason };
      if (this.spec.custom) await target(this.spec);   // checks the URLs
      if (!isDownloaded(this.key)) return { ok: false, message: `Not downloaded yet${this.spec.sizeMB ? ` (${this.spec.sizeMB} MB)` : ''}.` };
    }
    const r = await this.translate('Good morning', 'en', 'es');
    return { ok: true, message: `Ready. “Good morning” → “${r.text}”` };
  }
}

registerProvider({
  id: 'webllm',
  kind: 'advanced',
  label: 'On-device AI',
  description: 'An AI model that runs in this browser, on your graphics chip (WebGPU) or built into Chrome. Downloaded once; after that it works without internet, and nothing you type leaves this device. Translations are less fluent than large online models.',
  fields: [
    { key: 'model', label: 'Model', type: 'select', default: DEFAULT, filter: true, normalize: (v) => LEGACY[v] || v,
      help: 'Smaller models are faster and work on more devices; larger ones translate better but need more graphics memory. Type in the filter to search all models.',
      groups: llmOptions },
    { key: 'customUrl', label: 'Model URL', type: 'url', required: true, showIf: { model: CUSTOM }, placeholder: 'https://huggingface.co/you/Model-q4f16_1-MLC',
      help: 'A model compiled for WebLLM (MLC format), e.g. on Hugging Face. Its files are downloaded from there.' },
    { key: 'customLib', label: 'Model library (.wasm)', type: 'url', required: true, showIf: { model: CUSTOM }, placeholder: 'https://…/Model-q4f16_1-webgpu.wasm',
      help: 'The WebGPU library built for this model. WebLLM runs code from this file, so only use one you trust.' },
    { key: 'customVram', label: 'Graphics memory needed (MB)', type: 'number', showIf: { model: CUSTOM }, placeholder: 'e.g. 2500',
      help: 'Optional. Used to warn before loading a model that is too big.' },
  ],
  create: (cfg) => new LocalLLMProvider(cfg),
});
