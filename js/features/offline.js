// On-device translation: Firefox's Bergamot engine (vendor/bergamot, MPL-2.0) running in a
// Web Worker, with Mozilla's open translation models downloaded per language ("language packs").
// A pack = English ↔ that language. Other pairs go through English (de → en → fr).
// Models are stored in Cache Storage and work without a network once downloaded.
import { registerProvider, ProviderError } from '../providers.js';
import { STATIC_LANGUAGES } from '../languages.js';

const RECORDS = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records';
const FILES = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const CACHE = 'ot-offline-models-v1';
const INDEX_KEY = 'ot.offline.v1';
const WORKER_URL = new URL('../../vendor/bergamot/translator-worker.js', import.meta.url);
const FRANC = 'https://cdn.jsdelivr.net/npm/franc-min@6.2.0/+esm';
const MAX_MAJOR = 2;          // newer model generations may need a newer engine build
const MAX_LOADED = 2;         // the engine's memory is capped at 2 GB; a pivot needs two models
const PIVOT = 'en';

// Mozilla's model server answers HTTP 406 to every browser whose User-Agent contains "Chrome"
// (Chrome, Edge, Brave, Opera, Chrome on Android), and a page can't change that header. Those browsers
// get the same files from a byte-for-byte mirror on Hugging Face. The model list still comes from
// Mozilla (it serves every browser) and decides which version to use; every downloaded file is checked
// against the SHA-256 in that list, so the mirror can't hand out anything else. Only versions the
// mirror has completely are offered.
export const usesMirror = /Chrome/.test(globalThis.navigator?.userAgent || '');
export const MIRROR = { repo: 'midudev/firefox-translations', page: 'https://huggingface.co/midudev/firefox-translations' };
const MIRROR_TREE = `https://huggingface.co/api/models/${MIRROR.repo}/tree/main?recursive=true`;
const MIRROR_FILES = `https://huggingface.co/${MIRROR.repo}/resolve/main/`;
/** Where the model files come from in this browser, for every message that names the source. */
export const MODEL_SOURCE = usesMirror
  ? { name: 'Hugging Face', where: `Hugging Face (huggingface.co/${MIRROR.repo}, a mirror of Mozilla's models)` }
  : { name: 'Mozilla', where: 'Mozilla (firefox-settings-attachments.cdn.mozilla.net)' };
/** true only when this browser has no way to get the files (Chromium and the mirror is gone). */
export let downloadsBlocked = false;
export const BLOCKED_REASON = "This browser can't download offline languages: Mozilla's model server doesn't serve Chrome, Edge, Brave or other Chromium-based browsers, and the mirror on Hugging Face isn't available. Open OpenTranslate in Safari or Firefox to use them, or translate with a LibreTranslate server.";
/** True when the on-device service can't do anything here (blocked browser, nothing downloaded). */
export const offlineUnusable = () => downloadsBlocked && !installedLanguages().length;

// App language codes ↔ model codes
const TO_FX = { zh: 'zh-Hans', no: 'nb' };
const FROM_FX = Object.fromEntries(Object.entries(TO_FX).map(([a, b]) => [b, a]));
const fx = (code) => TO_FX[code] || code;
const app = (code) => FROM_FX[code] || code;

// Known languages (refreshed from the model list when online), so the list works offline too.
const KNOWN = 'af ar az be bg bn bs ca cs da de el es et eu fa fi fr gl gu he hi hr hu id is it ja kn ko lt lv ml mr ms mt nb nl nn pl pt ro ru sk sl sq sr sv ta te th tl tr ug uk ur vi zh-Hans zh-Hant'.split(' ');

/* ------------------------------------------------------------ change events */

const listeners = new Set();
export const onOfflineChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener bug */ } });

/* ------------------------------------------------------------ installed index (sync) */
// { pairs: { 'en|de': { from, to, version, files: [{ part, name, url, size, hash }] } } }

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || { pairs: {} }; } catch { return { pairs: {} }; }
}
function writeIndex(ix) { try { localStorage.setItem(INDEX_KEY, JSON.stringify(ix)); } catch { /* quota */ } }

const pairKey = (from, to) => `${from}|${to}`;

/** App codes of the languages whose pack is fully downloaded (English is always there). */
export function installedLanguages() {
  const { pairs } = readIndex();
  const out = new Set();
  for (const p of Object.values(pairs)) out.add(app(p.from === PIVOT ? p.to : p.from));
  return [...out].filter((l) => packComplete(l, pairs));
}

function packComplete(lang, pairs = readIndex().pairs) {
  const l = fx(lang);
  const need = (registryCache?.packs.get(l)?.pairs) || [pairKey(PIVOT, l), pairKey(l, PIVOT)];
  return need.every((k) => pairs[k]);
}

/** Which models translate source → target (app codes), or null if a pack is missing. */
function route(source, target, pairs = readIndex().pairs) {
  const [s, t] = [fx(source), fx(target)];
  if (s === t) return [];
  if (pairs[pairKey(s, t)]) return [pairs[pairKey(s, t)]];
  if (s !== PIVOT && t !== PIVOT && pairs[pairKey(s, PIVOT)] && pairs[pairKey(PIVOT, t)]) {
    return [pairs[pairKey(s, PIVOT)], pairs[pairKey(PIVOT, t)]];
  }
  return null;
}

/** Packs (app codes) that must be downloaded for source → target. */
export function missingFor(source, target) {
  return [source, target].filter((l) => l && l !== 'auto' && l !== PIVOT && !packComplete(l));
}

export const canTranslate = (source, target) => source !== 'auto' && !!route(source, target);

/* ------------------------------------------------------------ model list (registry) */

let registryCache = null;
let registryReq = null;

// Model records carry Firefox targeting rules; evaluate them like a desktop/Android release build.
const ENV = { 'appinfo.OS': /Android/i.test(navigator.userAgent || '') ? 'Android' : 'Darwin', channel: 'release' };
function filterOk(expr) {
  if (!expr || !expr.trim()) return true;
  return expr.split('||').some((or) => or.split('&&').every((c) => {
    const m = c.trim().match(/^env\.([\w.]+)\s*(==|!=)\s*'([^']*)'$/);
    return !!m && (ENV[m[1]] === m[3]) === (m[2] === '==');
  }));
}
const vkey = (v) => { const [a, b] = String(v).split('.'); return [/a/.test(v) ? 0 : 1, parseInt(a) || 0, parseInt(b) || 0, parseInt(String(v).split('a')[1] || 0)]; };
const newer = (a, b) => { const [x, y] = [vkey(a), vkey(b)]; for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/**
 * mirror: Map of SHA-256 -> file path in the mirror (Chromium browsers), or null (files from Mozilla).
 * With a mirror, a model version counts only if the mirror has every one of its files.
 */
function buildRegistry(records, mirror = null) {
  const versions = new Map();   // "from|to@version" -> { from, to, version, files, complete }
  for (const r of records) {
    if (!filterOk(r.filter_expression) || vkey(r.version)[1] > MAX_MAJOR || !r.attachment) continue;
    const id = `${pairKey(r.fromLang, r.toLang)}@${r.version}`;
    const v = versions.get(id) || { from: r.fromLang, to: r.toLang, version: r.version, files: [], complete: true };
    const path = mirror?.get(r.attachment.hash);
    if (mirror && !path) v.complete = false;
    v.files.push({ part: r.fileType, name: r.name, size: r.attachment.size, hash: r.attachment.hash,
      url: path ? MIRROR_FILES + path.split('/').map(encodeURIComponent).join('/') : FILES + r.attachment.location });
    versions.set(id, v);
  }
  const best = new Map();
  for (const v of versions.values()) {
    if (!v.complete) continue;
    const k = pairKey(v.from, v.to);
    if (!best.has(k) || newer(v.version, best.get(k).version)) best.set(k, { from: v.from, to: v.to, version: v.version, files: v.files });
  }
  const packs = new Map();
  for (const [k, m] of best) {
    if (m.from !== PIVOT && m.to !== PIVOT) continue;
    const lang = m.from === PIVOT ? m.to : m.from;
    const p = packs.get(lang) || { lang, pairs: [], size: 0 };
    p.pairs.push(k); p.size += m.files.reduce((a, f) => a + f.size, 0);
    packs.set(lang, p);
  }
  return { models: best, packs };
}

/** JSON from the network (kept for offline use), or the copy from last time. */
async function cachedJson(cache, url, load) {
  try {
    const data = await load();
    cache.put(url, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })).catch(() => {});
    return data;
  } catch (e) {
    const hit = await cache.match(url);
    if (!hit) throw e;
    return hit.json();
  }
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return { data: await res.json(), next: res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] };
}

/** The mirror's files as SHA-256 -> path (Hugging Face lists each file's SHA-256). */
async function loadMirror(cache) {
  let list;
  try {
    list = await cachedJson(cache, MIRROR_TREE, async () => {
      const all = []; let url = MIRROR_TREE;
      while (url) { const { data, next } = await getJson(url); all.push(...data); url = next; }
      return all;
    });
  } catch (e) {
    // the mirror is gone (not just offline): say so instead of offering downloads that can't work
    if (e?.status === 401 || e?.status === 404) { downloadsBlocked = true; emit(); throw new ProviderError('BROWSER_BLOCKED', BLOCKED_REASON, e); }
    throw new ProviderError('NETWORK', "Can't load the list of offline languages. Connect to the internet once.", e);
  }
  return new Map(list.filter((f) => f.type === 'file' && f.lfs?.oid).map((f) => [f.lfs.oid, f.path]));
}

/** The list of downloadable languages (needs the network once; then cached). */
export function loadRegistry() {
  if (registryCache) return Promise.resolve(registryCache);
  registryReq ??= (async () => {
    const cache = await caches.open(CACHE);
    let data;
    try {
      data = await cachedJson(cache, RECORDS, async () => (await getJson(RECORDS)).data);
    } catch (e) {
      throw new ProviderError('NETWORK', "Can't load the list of offline languages. Connect to the internet once.", e);
    }
    const mirror = usesMirror ? await loadMirror(cache) : null;
    registryCache = buildRegistry(data.data || [], mirror);
    emit();
    return registryCache;
  })();
  registryReq.catch(() => { registryReq = null; });
  return registryReq;
}

/** Download size of a language pack in bytes (null until the model list is loaded). */
export const packSize = (lang) => registryCache?.packs.get(fx(lang))?.size ?? null;

/** App codes of every language that can be translated on this device (after download). */
export function offlineLanguages() {
  const codes = registryCache ? [...registryCache.packs.keys()] : KNOWN;
  return [PIVOT, ...codes.map(app)];
}

/* ------------------------------------------------------------ downloads */

const downloads = new Map();   // app code -> { loaded, total, abort }

/** @returns {'ready'|'downloading'|'none'} */
export function packState(lang) {
  if (lang === PIVOT) return 'ready';
  if (downloads.has(lang)) return 'downloading';
  return packComplete(lang) ? 'ready' : 'none';
}
export const packProgress = (lang) => {
  const d = downloads.get(lang);
  return d && d.total ? d.loaded / d.total : 0;
};

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchFile(cache, file, signal, onBytes) {
  const res = await fetch(file.url, { credentials: 'omit', signal });
  if (!res.ok) throw new ProviderError('NETWORK', `Download failed (HTTP ${res.status}).`);
  const reader = res.body?.getReader?.();
  let buf;
  if (reader) {
    const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.length; onBytes(value.length);
    }
    buf = new Uint8Array(n); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    buf = buf.buffer;
  } else {
    buf = await res.arrayBuffer(); onBytes(buf.byteLength);
  }
  if (file.hash && (await sha256Hex(buf)) !== file.hash) throw new ProviderError('BAD_RESPONSE', `The downloaded file ${file.name} is damaged. Try again.`);
  await cache.put(file.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
}

/** Download a language pack (English ↔ lang). Resolves when it's ready to use. */
export async function downloadPack(lang) {
  if (downloadsBlocked) throw new ProviderError('BROWSER_BLOCKED', BLOCKED_REASON);
  if (lang === PIVOT || packState(lang) === 'ready') return;
  if (downloads.has(lang)) return downloads.get(lang).promise;
  const ctrl = new AbortController();
  const d = { loaded: 0, total: 0, abort: () => ctrl.abort() };
  downloads.set(lang, d);
  emit();
  d.promise = (async () => {
    try {
      const reg = await loadRegistry();
      const pack = reg.packs.get(fx(lang));
      if (!pack) throw new ProviderError('UNSUPPORTED_PAIR', `There's no offline model for this language yet.`);
      const models = pack.pairs.map((k) => reg.models.get(k));
      d.total = pack.size;
      const cache = await caches.open(CACHE);
      let tick = 0;
      for (const m of models) {
        for (const f of m.files) {
          if (await cache.match(f.url)) { d.loaded += f.size; continue; }
          await fetchFile(cache, f, ctrl.signal, (n) => {
            d.loaded += n;
            if (++tick % 20 === 0) emit();
          });
        }
      }
      const ix = readIndex();
      for (const m of models) ix.pairs[pairKey(m.from, m.to)] = m;
      writeIndex(ix);
    } catch (e) {
      if (e?.name === 'AbortError') throw new ProviderError('NETWORK', 'Download cancelled.');
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('NETWORK', `Download failed: ${e?.message || e}`, e);
    } finally {
      downloads.delete(lang);
      emit();
    }
  })();
  return d.promise;
}

export function cancelDownload(lang) { downloads.get(lang)?.abort(); }

/** Remove a language pack from this device. */
export async function deletePack(lang) {
  const l = fx(lang);
  const ix = readIndex();
  const cache = await caches.open(CACHE);
  for (const k of [pairKey(PIVOT, l), pairKey(l, PIVOT)]) {
    const m = ix.pairs[k];
    if (!m) continue;
    await Promise.all(m.files.map((f) => cache.delete(f.url)));
    delete ix.pairs[k];
    await engineFree(m.from, m.to);
  }
  writeIndex(ix);
  emit();
}

/** Bytes used by downloaded packs. */
export function usedBytes() {
  return Object.values(readIndex().pairs).reduce((a, m) => a + m.files.reduce((b, f) => b + f.size, 0), 0);
}

/* ------------------------------------------------------------ the engine (worker) */

let engine = null;     // Promise<{ call, worker }>
let loaded = [];       // pair keys loaded in the worker, least recently used first
let queue = Promise.resolve();
const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

function startEngine() {
  if (engine) return engine;
  engine = (async () => {
    const worker = new Worker(WORKER_URL);
    let id = 0;
    const pending = new Map();
    const call = (name, ...args) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      worker.postMessage({ id, name, args });
    });
    worker.addEventListener('message', ({ data: { id: rid, result, error } }) => {
      const p = pending.get(rid);
      if (!p) return;
      pending.delete(rid);
      if (error !== undefined) p.reject(Object.assign(new Error(error.message), error)); else p.resolve(result);
    });
    worker.addEventListener('error', (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Translation engine crashed'));
      pending.clear();
    });
    await call('initialize', { cacheSize: 0, useNativeIntGemm: false });
    return { call, worker };
  })();
  engine.catch(() => { engine = null; });
  return engine;
}

function resetEngine() {
  engine?.then(({ worker }) => worker.terminate()).catch(() => {});
  engine = null;
  loaded = [];
}

async function buffersFor(m) {
  const cache = await caches.open(CACHE);
  const out = {};
  for (const f of m.files) {
    const hit = await cache.match(f.url);
    if (!hit) throw new ProviderError('NO_PROVIDER', 'A downloaded language is incomplete. Download it again in Settings.');
    out[f.part] = await hit.arrayBuffer();
  }
  const vocabs = out.vocab ? [out.vocab] : [out.srcvocab, out.trgvocab];
  const model = m.files.find((f) => f.part === 'model');
  return {
    model: out.model, shortlist: out.lex, vocabs, qualityModel: null,
    config: model?.name?.endsWith('intgemm8.bin') ? { 'gemm-precision': 'int8shiftAll' } : {},
  };
}

async function ensureLoaded(call, m) {
  const k = pairKey(m.from, m.to);
  const i = loaded.indexOf(k);
  if (i >= 0) { loaded.splice(i, 1); loaded.push(k); return; }
  while (loaded.length >= MAX_LOADED) {
    const [from, to] = loaded.shift().split('|');
    await call('freeTranslationModel', { from, to });
  }
  await call('loadTranslationModel', { from: m.from, to: m.to }, await buffersFor(m));
  loaded.push(k);
}

function engineFree(from, to) {
  const k = pairKey(from, to);
  if (!loaded.includes(k) || !engine) return Promise.resolve();
  return serial(async () => {
    const { call } = await engine;
    await call('freeTranslationModel', { from, to });
    loaded = loaded.filter((x) => x !== k);
  });
}

async function runModels(models, lines, retry = true) {
  try {
    return await serial(async () => {
      const { call } = await startEngine();
      for (const m of models) await ensureLoaded(call, m);
      const res = await call('translate', {
        models: models.map(({ from, to }) => ({ from, to })),
        texts: lines.map((text) => ({ text, html: false, qualityScores: false })),
      });
      return res.map((r) => r.target.text);
    });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    resetEngine();   // e.g. out of memory: start a fresh engine once
    if (retry) return runModels(models, lines, false);
    throw new ProviderError('SERVER', `On-device translation failed: ${e?.message || e}`, e);
  }
}

/* ------------------------------------------------------------ language detection */

// franc (MIT) returns ISO 639-3 codes; map the ones we have models for.
const ISO3 = {
  afr: 'af', arb: 'ar', azj: 'az', bel: 'be', bul: 'bg', ben: 'bn', bos: 'bs', cat: 'ca', ces: 'cs', dan: 'da', deu: 'de',
  ell: 'el', eng: 'en', spa: 'es', est: 'et', eus: 'eu', pes: 'fa', fin: 'fi', fra: 'fr', glg: 'gl', guj: 'gu', heb: 'he',
  hin: 'hi', hrv: 'hr', hun: 'hu', ind: 'id', isl: 'is', ita: 'it', jpn: 'ja', kan: 'kn', kor: 'ko', lit: 'lt', lvs: 'lv',
  mal: 'ml', mar: 'mr', zlm: 'ms', mlt: 'mt', nob: 'no', nld: 'nl', nno: 'nn', pol: 'pl', por: 'pt', ron: 'ro', rus: 'ru',
  slk: 'sk', slv: 'sl', als: 'sq', srp: 'sr', swe: 'sv', tam: 'ta', tel: 'te', tha: 'th', tgl: 'tl', tur: 'tr', uig: 'ug',
  ukr: 'uk', urd: 'ur', vie: 'vi', cmn: 'zh',
};
let franc = null;
async function detectLang(text) {
  franc ??= import(/* webpackIgnore: true */ FRANC).then((m) => m.francAll || m.default?.francAll);
  franc.catch(() => { franc = null; });
  const francAll = await franc;
  // only the languages that can be translated here: far fewer mix-ups (German vs Dutch …)
  const usable = new Set([PIVOT, ...installedLanguages()]);
  let only = Object.keys(ISO3).filter((c) => usable.has(ISO3[c]));
  if (only.length < 2) only = Object.keys(ISO3);
  const [best] = francAll(text, { only, minLength: 3 }).filter(([c]) => ISO3[c]);
  if (!best || best[0] === 'und') return { language: PIVOT, confidence: 0 };
  return { language: ISO3[best[0]], confidence: Math.max(0, Math.min(1, best[1])) };
}

/* ------------------------------------------------------------ provider */

let names = null;
try { names = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser */ }
const nameOf = (code) => STATIC_LANGUAGES.find((l) => l.code === code)?.name || names?.of(code) || code;

registerProvider({
  id: 'offline',
  label: 'On this device',
  builtIn: true,
  description: 'Translates in your browser with open models from the Firefox project. Download the languages you need once; after that it works without internet, and nothing you type leaves this device.',
  fields: [],
  create() {
    return {
      name: 'On this device',
      isOffline: true,
      async languages() {
        loadRegistry().catch(() => {});
        return offlineLanguages().map((code) => ({ code, name: nameOf(code) }));
      },
      /** For the fallback chain: can this pair be done right now without downloading? */
      ready: (source, target) => source === 'auto' ? installedLanguages().length > 0 : canTranslate(source, target),
      async detect(text) { return detectLang(text); },
      async translate(text, source, target) {
        let detected;
        if (!source || source === 'auto') { detected = (await detectLang(text)).language; source = detected; }
        const missing = missingFor(source, target);
        if (missing.length && downloadsBlocked) throw new ProviderError('BROWSER_BLOCKED', BLOCKED_REASON);
        if (missing.length) {
          await loadRegistry().catch(() => {});
          const size = missing.reduce((a, l) => a + (packSize(l) || 0), 0);
          throw new ProviderError('NEEDS_DOWNLOAD',
            `${missing.map(nameOf).join(' and ')} ${missing.length > 1 ? "aren't" : "isn't"} downloaded to this device yet. ${missing.length > 1 ? 'They come' : 'It comes'} from ${MODEL_SOURCE.where}.`,
            { langs: missing, size });
        }
        const models = route(source, target);
        if (!models) throw new ProviderError('UNSUPPORTED_PAIR', `There's no offline model for ${nameOf(source)} → ${nameOf(target)}.`);
        if (!models.length) return { text, detected };
        // translate line by line so line breaks survive
        const lines = text.split('\n');
        const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
        const out = await runModels(models, idx.map((i) => lines[i]));
        idx.forEach((li, j) => { lines[li] = out[j]; });
        return { text: lines.join('\n'), detected };
      },
      async test() {
        const n = installedLanguages().length;
        return n
          ? { ok: true, message: `Ready: ${n} language${n > 1 ? 's' : ''} downloaded, plus English.` }
          : { ok: false, message: 'No languages downloaded yet. Download one to translate offline.' };
      },
    };
  },
});
