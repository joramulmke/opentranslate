// OCR via Tesseract.js, loaded lazily from a CDN on first use (camera + handwriting).
import { TESSERACT_LANGS } from '../languages.js';

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
  if (/loading language traineddata/.test(m.status)) return `Downloading language model… ${pct}%`;
  if (/recognizing text/.test(m.status)) return `Reading text… ${pct}%`;
  return 'Preparing…';
}
