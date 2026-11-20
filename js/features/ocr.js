// OCR via Tesseract.js, loaded lazily from a CDN on first use (camera + handwriting).
// Language files come from jsDelivr (npm package @tesseract.js-data/<lang>, from the Tesseract project's
// trained data) and Tesseract.js keeps them in IndexedDB ("keyval-store"), so each is downloaded once.
import { TESSERACT_LANGS } from '../languages.js';

export const OCR_SOURCE = { host: 'cdn.jsdelivr.net/npm/@tesseract.js-data', page: 'https://github.com/naptha/tessdata', licence: 'Apache-2.0' };

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;
const workers = new Map(); // lang -> Promise<worker>

function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CDN;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR library failed to initialise')));
      s.onerror = () => { loading = null; reject(new Error('Could not download the OCR engine. It needs a network connection the first time.')); };
      document.head.append(s);
    });
  }
  return loading;
}

export const ocrLangFor = (code) => TESSERACT_LANGS[code] || TESSERACT_LANGS[String(code).split('-')[0]] || 'eng';

async function getWorker(lang, onProgress) {
  if (!workers.has(lang)) {
    const p = (async () => {
      const T = await loadLib();
      return T.createWorker(lang, 1, {
        logger: (m) => progressHandlers.forEach((fn) => fn(m)),
      });
    })();
    p.catch(() => workers.delete(lang));
    workers.set(lang, p);
  }
  progressHandlers.add(onProgress);
  try { return await workers.get(lang); } finally { /* handler removed after recognize */ }
}
const progressHandlers = new Set();

/**
 * @param {HTMLCanvasElement|HTMLImageElement|Blob} image
 * @param {{ lang?: string, psm?: '3'|'6'|'7'|'8'|'10', onProgress?: (p:{status:string,progress:number})=>void }} opts
 * @returns {Promise<{ text: string, lines: Array<{text:string,bbox:{x0:number,y0:number,x1:number,y1:number},confidence:number}>, words: any[] }>}
 */
export async function recognize(image, { lang = 'eng', psm = '3', onProgress = () => {} } = {}) {
  const worker = await getWorker(lang, onProgress);
  try {
    await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(image);
    return {
      text: (data.text || '').trim(),
      confidence: data.confidence,
      lines: (data.lines || []).filter((l) => l.text.trim()).map((l) => ({ text: l.text.trim(), bbox: l.bbox, confidence: l.confidence })),
      words: data.words || [],
    };
  } finally {
    progressHandlers.delete(onProgress);
  }
}

export function describeOcrStatus(m) {
  const pct = Math.round((m.progress || 0) * 100);
  if (/loading tesseract core|initializing tesseract|initializing api/.test(m.status)) return 'Starting text recognition…';
  if (/loading language traineddata/.test(m.status)) return `Downloading language file from jsDelivr (cdn.jsdelivr.net)… ${pct}%`;
  if (/recognizing text/.test(m.status)) return `Reading text… ${pct}%`;
  return 'Preparing…';
}

/* ---------- downloaded language files (Settings › Camera text) ---------- */

// Same database and store Tesseract.js uses (idb-keyval defaults); created the same way if missing.
function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('keyval-store');
    r.onupgradeneeded = () => r.result.createObjectStore('keyval');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const keyOf = (lang) => `./${lang}.traineddata`;

/** Downloaded OCR languages: Map(tesseract code -> bytes). */
export async function ocrDownloaded() {
  const out = new Map();
  if (typeof indexedDB === 'undefined') return out;
  const d = await db();
  if (!d.objectStoreNames.contains('keyval')) { d.close(); return out; }
  await new Promise((resolve, reject) => {
    const req = d.transaction('keyval', 'readonly').objectStore('keyval').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      const m = String(c.key).match(/^\.\/(.+)\.traineddata$/);
      if (m) out.set(m[1], c.value?.byteLength ?? c.value?.size ?? 0);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  d.close();
  return out;
}

/** Download one language now (for later use without internet). onProgress(0..1). */
export async function ocrDownload(lang, onProgress) {
  const handler = (m) => { if (/loading language traineddata/.test(m.status)) onProgress?.(m.progress || 0); };
  const had = workers.has(lang);
  await getWorker(lang, handler);
  progressHandlers.delete(handler);
  // only needed for the file; don't keep a worker in memory unless one was already running
  if (!had) { const w = await workers.get(lang); workers.delete(lang); w.terminate(); }
}

export async function ocrDelete(lang) {
  const w = workers.get(lang);
  workers.delete(lang);
  try { (await w)?.terminate(); } catch { /* not started */ }
  const d = await db();
  await new Promise((resolve, reject) => {
    const tx = d.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').delete(keyOf(lang));
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  d.close();
}

/** OCR languages as [{ code: tesseract code, iso: app language code }], one per file. */
export function ocrLanguages() {
  const seen = new Map();
  for (const [iso, code] of Object.entries(TESSERACT_LANGS)) if (!seen.has(code)) seen.set(code, iso);
  return [...seen].map(([code, iso]) => ({ code, iso }));
}
