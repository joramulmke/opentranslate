// On-device AI (Advanced mode): a language model that runs in the browser, nothing you type leaves the device.
//   - WebLLM (https://github.com/mlc-ai/web-llm, Apache-2.0) on the graphics chip (WebGPU), in a Web Worker:
//     any model of its catalogue (llmcatalog.js), or your own MLC-compiled model by URL. Downloaded once from
//     Hugging Face and kept in Cache Storage; after that it works without internet.
//   - Gemini Nano, built into Chrome (Prompt API): Chrome downloads and manages the model itself.
import { keepDownloadsSafe } from './persist.js';
import { registerProvider, ProviderError, OpenAICompatibleProvider } from '../providers.js';
import { LLM_CATALOG, LLM_CURATED, prettyName } from './llmcatalog.js';
import { bgDownload, bgResume } from './bgfetch.js';

export const NANO = 'gemini-nano';
export const NANO_INTERNALS = 'chrome://on-device-internals';
/** Languages Gemini Nano reads and writes (Chrome 149, per Chrome's docs). Chrome is asked per pair anyway. */
export const NANO_LANGS = ['en', 'es', 'ja', 'de', 'fr'];
const NANO_MIN_CHROME = 148;   // first Chrome that offers the Prompt API to web pages (not only extensions)
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
    // elsewhere it stays in the list (so people know it exists) but can't be picked
    { group: 'Built into this browser', options: [nanoUsable()
      ? { value: NANO, label: `Gemini Nano (Chrome) · downloaded and managed by Chrome · ${NANO_LANGS.length} languages` }
      : { value: NANO, label: `Gemini Nano · ${!nanoSupported() && chromeMajor() && chromeMajor() < NANO_MIN_CHROME ? `needs Chrome ${NANO_MIN_CHROME} or later` : nanoSupported() ? "didn't start in this Chrome" : 'only in Chrome on computers'}`, disabled: true }] },
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
/** Keys of the downloaded WebLLM models (Gemini Nano is Chrome's, not ours). */
export const downloadedLlms = () => Object.keys(readStore()).filter((k) => readStore()[k] && k !== NANO);
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

/** Chrome's major version, or 0 when this isn't Chrome (Edge, Opera and Brave say Chrome too, and that's fine). */
const chromeMajor = () => {
  const b = globalThis.navigator?.userAgentData?.brands?.find((x) => /Chromium|Google Chrome/.test(x.brand));
  return Number(b?.version) || Number(String(globalThis.navigator?.userAgent || '').match(/Chrome\/(\d+)/)?.[1]) || 0;
};

// "Chrome said downloadable, but the model can't start here" (e.g. "the service is not running"):
// remembered in this browser so Gemini Nano isn't offered again until Chrome reports it ready.
const BROKEN = 'ot.nano.broken.v1';
const readBroken = () => { try { return JSON.parse(localStorage.getItem(BROKEN)); } catch { return null; } };
const setBroken = (msg) => { try { if (msg) localStorage.setItem(BROKEN, JSON.stringify({ msg, at: Date.now() })); else localStorage.removeItem(BROKEN); } catch { /* private mode */ } };

/** Can Gemini Nano be offered here: the API exists and it didn't fail before. */
export const nanoUsable = () => nanoSupported() && !readBroken();

/** Why Gemini Nano isn't offered here, in words a user can act on ('' when it is). */
export function nanoReason() {
  const v = chromeMajor();
  if (!nanoSupported()) {
    if (v && v < NANO_MIN_CHROME) return `Gemini Nano needs Chrome ${NANO_MIN_CHROME} or later; this is Chrome ${v}. Update Chrome (menu › Help › About Google Chrome), or pick a WebLLM model.`;
    if (v) return "This browser doesn't offer Gemini Nano to web pages. It's built into Chrome on Windows, macOS, Linux and Chromebook Plus, not on phones. Pick a WebLLM model instead.";
    return "Gemini Nano is built into Chrome on computers only, so it can't run in this browser. Open OpenTranslate in Chrome to use it, or pick a WebLLM model.";
  }
  const b = readBroken();
  if (b) {
    return `Gemini Nano didn't start in this Chrome: “${b.msg}”. Chrome needs at least 22 GB of free disk space, a graphics chip with more than 4 GB of memory `
      + `(or 16 GB of RAM and 4 CPU cores), and may still be setting it up. Paste ${NANO_INTERNALS} into the address bar and open “Model Status” and “Broker State” to see why. `
      + "It's offered again once Chrome reports it ready.";
  }
  return '';
}

export async function refreshNano() {
  if (!nanoSupported()) { nanoState = 'unavailable'; return nanoState; }
  try { nanoState = await LM().availability(); } catch { nanoState = 'unavailable'; }
  if (nanoState === 'available' && readBroken()) setBroken(null);   // fixed since: offer it again
  emit();
  return nanoState;
}
refreshNano();

/** Can Gemini Nano translate source → target? Chrome answers per language (it only knows a few). */
async function nanoPair(source, target) {
  const lang = (c) => String(c).split('-')[0];
  try {
    return await LM().availability({
      ...(source && source !== 'auto' ? { expectedInputs: [{ type: 'text', languages: [lang(source)] }] } : {}),
      expectedOutputs: [{ type: 'text', languages: [lang(target)] }],
    });
  } catch { return 'unavailable'; }
}
const nanoLangNames = () => { try { const d = new Intl.DisplayNames(['en'], { type: 'language' }); return NANO_LANGS.map((c) => d.of(c)).join(', '); } catch { return NANO_LANGS.join(', '); } };

/** Chrome's errors about Gemini Nano, in words a user can act on. */
function nanoError(e) {
  const msg = String(e?.message || e).replace(/\.\s*$/, '');
  if (e?.name === 'NotAllowedError') return new ProviderError('NEEDS_DOWNLOAD', 'Chrome only downloads Gemini Nano after a click. Press Download again.');
  if (/not running|service|crash|unavailable|not supported|NotSupported/i.test(msg) || e?.name === 'NotSupportedError' || e?.name === 'InvalidStateError') {
    setBroken(msg);
    emit();
    return new ProviderError('BROWSER_BLOCKED', nanoReason(), { copy: NANO_INTERNALS });
  }
  return new ProviderError('SERVER', `Gemini Nano didn't start: ${msg}`);
}

async function nanoChat(system, user, outLang) {
  const opts = { initialPrompts: [{ role: 'system', content: system }],
    ...(outLang ? { expectedOutputs: [{ type: 'text', languages: [outLang] }] } : {}) };
  let session;
  try { session = await LM().create(opts); } catch (e) {
    if (e?.name === 'NotSupportedError' && outLang && !/not running|service/i.test(e?.message || '')) throw new ProviderError('UNSUPPORTED_PAIR', `Gemini Nano can't write ${outLang} yet.`);
    throw nanoError(e);
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
  keepDownloadsSafe();   // first download: ask to keep downloads safe (doesn't wait)
  const spec = specOf(key);
  const job = { progress: 0, phase: 'download' };
  job.promise = (async () => {
    if (spec.kind === 'nano') {
      if (!nanoSupported()) throw new ProviderError('BROWSER_BLOCKED', nanoReason());
      // Chrome downloads the model when a session is first created (needs a click, which this is)
      let s;
      try {
        s = await LM().create({ monitor(m) { m.addEventListener('downloadprogress', (e) => { job.progress = e.loaded; onProgress?.(e.loaded); emit('progress'); }); } });
      } catch (e) { await refreshNano(); throw nanoError(e); }
      s.destroy?.();
      await refreshNano();
      return;
    }
    const t = await target(spec);
    // keeps going when the app is closed, where the browser can (Chrome on Android): only the download,
    // the model is put on the graphics chip at the first translation
    const files = await call('plan', t).catch(() => null);
    const bg = files?.length ? await bgDownload(`llm:${key}`, {
      title: `${spec.title} (on-device AI)`, doneTitle: `${spec.title} is ready to use offline`,
      failTitle: `${spec.title} didn't finish downloading. Open OpenTranslate to try again.`,
      files: files.map((f) => ({ ...f, cache: 'webllm/model' })), estimate: spec.sizeMB * 1e6, data: { key },
    }) : null;
    if (bg) {
      job.cancel = bg.cancel;
      bg.onProgress = (p) => { job.progress = p; onProgress?.(p); emit('progress'); };
      await bg.promise;
      mark(key, true);
      return;
    }
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
  for (const j of jobs.values()) j.cancel?.();          // background downloads
  if ([...jobs].some(([k, j]) => k !== NANO && !j.cancel)) stopWorker(new ProviderError('SERVER', 'Download cancelled.'));
}

// background downloads from an earlier visit: still running (show the progress) or finished meanwhile
bgResume('llm:', (key, bg) => {
  if (jobs.has(key)) return;
  const job = { progress: bg.progress(), phase: 'download', cancel: bg.cancel };
  bg.onProgress = (p) => { job.progress = p; emit('progress'); };
  job.promise = bg.promise.then(() => mark(key, true)).catch(() => {}).finally(() => { if (jobs.get(key) === job) jobs.delete(key); emit(); });
  jobs.set(key, job);
  emit();
});

export async function deleteModel(key) {
  if (key === NANO) return;   // Chrome manages Gemini Nano (chrome://on-device-internals)
  if (jobs.has(key)) cancelModelDownload();
  mark(key, false);
  emit();
  try { await call('delete', await target(specOf(key))); } catch { /* nothing cached / no WebGPU */ }
  loadedId = null;
}

const needsDownload = (spec) => new ProviderError('NEEDS_DOWNLOAD',
  spec.kind === 'nano'
    ? "Gemini Nano isn't on this device yet. Chrome downloads it from Google (a few GB, once) and keeps it up to date."
    : `The on-device AI model ${spec.title} isn't downloaded yet. It comes from ${spec.custom ? new URL(spec.custom.url).host : 'Hugging Face (huggingface.co/mlc-ai)'}.`,
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
    this.readPhoto = undefined;
    this.transcribe = undefined;
    this.sttModel = '';
    this._target = null;
  }

  /** For the fallback chain: usable right now without a download? */
  ready() { return this.spec.kind === 'nano' ? nanoState === 'available' && !readBroken() : gpuOk !== false && isDownloaded(this.key); }

  async translate(text, source, target) {
    if (this.spec.kind === 'nano' && nanoState === 'available' && target) {
      const st = await nanoPair(source, target);
      if (st === 'unavailable') {
        let name = target; try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(target.split('-')[0]); } catch { /* code */ }
        throw new ProviderError('UNSUPPORTED_PAIR', `Gemini Nano can't translate into ${name}. It handles ${nanoLangNames()}.`);
      }
    }
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
      if (!nanoUsable()) return { ok: false, message: nanoReason() };
      if (st === 'unavailable') return { ok: false, message: "Chrome says Gemini Nano can't run on this device: it needs at least 22 GB of free disk space and a graphics chip with more than 4 GB of memory (or 16 GB of RAM and 4 CPU cores)." };
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
