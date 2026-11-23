// OCR via Tesseract.js, loaded lazily from a CDN on first use (camera + handwriting).
// Language files come from jsDelivr (npm package @tesseract.js-data/<lang>, from the Tesseract project's
// trained data) and Tesseract.js keeps them in IndexedDB ("keyval-store"), so each is downloaded once.
import { keepDownloadsSafe } from './persist.js';
import { TESSERACT_LANGS } from '../languages.js';
import { settings } from '../store.js';
import { sheet } from './permissions.js';
import { PADDLE, paddleState, downloadPaddle, recognizePaddle, paddleReads } from './paddle.js';
import { ORT_MB } from './ort.js';
import { recognizeFlorence, florenceReads, florenceAllowed } from './florence.js';
import { state } from '../state.js';

/** Camera text engines (Settings › Text recognition › Camera text): the chosen one first, Tesseract last. */
export const OCR_ENGINES = ['tesseract', 'paddle', 'florence', 'vision'];
export const ocrPref = () => (OCR_ENGINES.includes(settings.get().ocrEngine) ? settings.get().ocrEngine : 'tesseract');

/** PP-OCRv6 chosen but not downloaded: ask once (like the other on-device models). true = ready to use. */
export async function paddleAllowed() {
  if (paddleState() === 'ready') return true;
  const s = settings.get();
  if (s.paddleOk === false) return false;
  const ok = await sheet({
    iconName: 'camera', title: 'Download PP-OCRv6?',
    body: `Better text recognition for photos (${PADDLE.scripts}): download PP-OCRv6 (about ${PADDLE.sizeMB} MB, plus ${ORT_MB} MB for its engine unless the offline voices already have it), once, from Hugging Face (huggingface.co/PaddlePaddle). It runs privately in your browser. You can delete it in Settings › Text recognition.`,
    allowLabel: 'Download', cancelLabel: 'Use Tesseract',
  });
  settings.set({ paddleOk: ok });
  if (!ok) return false;
  await downloadPaddle();
  return true;
}

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
export async function recognize(image, opts = {}) {
  // AI vision only when chosen: the photo goes to the AI service, so it's never used without asking
  if (ocrPref() === 'vision') {
    if (typeof state.advanced?.readPhoto === 'function') {
      try {
        opts.onProgress?.({ status: 'vision', progress: 0 });
        return await recognizeVision(image, opts.iso);
      } catch (e) {
        opts.onProgress?.({ status: 'fallback-vision', progress: 0 });
        const res = await recognizeLocal(image, opts);
        return { ...res, note: `AI vision didn't work (${e.message || e}), so it was read on this device instead.` };
      }
    }
    const res = await recognizeLocal(image, opts);
    return { ...res, note: 'AI vision needs an AI model that can read images (Settings › Translation › Advanced), so this was read on the device.' };
  }
  // Florence-2 on this device (Latin script; asks before its download), else PP-OCRv6 or Tesseract
  if (ocrPref() === 'florence' && florenceReads(opts.iso)) {
    try {
      if (await florenceAllowed()) return await recognizeFlorence(image, { onProgress: opts.onProgress });
    } catch (e) {
      opts.onProgress?.({ status: 'fallback-florence', progress: 0 });
      const res = await recognizeLocal(image, opts);
      const why = String(e.message || e).replace(/[^\p{L}\p{N}\p{P} ]+/gu, ' ').slice(0, 80);
      return { ...res, note: `Florence-2 didn't work (${why}), so the photo was read another way.` };
    }
  }
  return recognizeLocal(image, opts);
}

/** The photo, at most 1600 px on its longer side, as JPEG (smaller upload, same readability). */
function photoUrl(image) {
  const w = image.width || image.naturalWidth, h = image.height || image.naturalHeight;
  const k = Math.min(1, 1600 / Math.max(w, h));
  if (k === 1 && typeof image.toDataURL === 'function') return image.toDataURL('image/jpeg', 0.9);
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

/** AI vision in the shape Tesseract returns. Without a usable box for every line, the text is one block over the whole photo. */
async function recognizeVision(image, iso) {
  const w = image.width || image.naturalWidth, h = image.height || image.naturalHeight;
  const lines = await state.advanced.readPhoto(photoUrl(image), iso);
  const boxed = lines.length && lines.every((l) => l.box);
  const out = boxed
    ? lines.map((l) => ({ text: l.text, confidence: 100,
      bbox: { x0: l.box[0] / 1000 * w, y0: l.box[1] / 1000 * h, x1: l.box[2] / 1000 * w, y1: l.box[3] / 1000 * h } }))
    : lines.length ? [{ text: lines.map((l) => l.text).join('\n'), confidence: 100, bbox: { x0: 0, y0: 0, x1: w, y1: h } }] : [];
  return { text: out.map((l) => l.text).join('\n'), confidence: 100, lines: out, words: [] };
}

async function recognizeLocal(image, opts) {
  // PP-OCRv6 has no Cyrillic, Arabic, Indic, Thai or Korean script: Tesseract reads those
  // (also when AI vision didn't work and PP-OCRv6 is already downloaded)
  const paddle = ocrPref() === 'paddle' || (['vision', 'florence'].includes(ocrPref()) && paddleState() === 'ready');
  if (paddle && paddleReads(opts.iso)) {
    try {
      if (await paddleAllowed()) return await recognizePaddle(image, { onProgress: opts.onProgress });
    } catch (e) {
      // PP-OCRv6 failed (e.g. download interrupted): Tesseract still reads the photo
      opts.onProgress?.({ status: 'fallback', progress: 0, note: e.message });
    }
  }
  return recognizeTesseract(image, opts);
}

/** Tesseract only (also Basic handwriting). */
export async function recognizeTesseract(image, { lang = 'eng', psm = '3', onProgress = () => {} } = {}) {
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
  if (m.status === 'starting') return 'Starting PP-OCRv6…';
  if (m.status === 'fallback') return 'PP-OCRv6 didn’t work, reading with Tesseract…';
  if (m.status === 'vision') return 'Reading with AI vision…';
  if (m.status === 'fallback-vision') return 'AI vision didn’t work, reading on this device…';
  if (m.status === 'florence-load') return 'Starting Florence-2…';
  if (m.status === 'florence-download') return `Downloading Florence-2 from Hugging Face (huggingface.co)… ${pct}%`;
  if (m.status === 'florence') return 'Reading with Florence-2…';
  if (m.status === 'florence-describe') return 'No text found, describing the photo…';
  if (m.status === 'fallback-florence') return 'Florence-2 didn’t work, reading another way…';
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
  keepDownloadsSafe();   // first download: ask to keep downloads safe (doesn't wait)
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
