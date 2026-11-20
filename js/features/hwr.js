// Handwriting recognition engines, best first:
//   1. AI vision  - Advanced mode on: the OpenAI-compatible model reads the drawing (any script, cursive)
//   2. On-device  - TrOCR handwriting model in the browser via transformers.js (Latin script; ~130 MB, once)
//   3. Basic      - Tesseract (print-like letters; also the fallback for non-Latin scripts)
import { state } from '../state.js';
import { settings } from '../store.js';
import { recognize as tesseract, ocrLangFor, describeOcrStatus } from './ocr.js';
import { sheet } from './permissions.js';

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
const MODEL = 'Xenova/trocr-small-handwritten';
const LATIN = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'pl', 'cs', 'sk', 'sl', 'hr', 'ro', 'hu', 'tr',
  'id', 'ms', 'tl', 'sw', 'ca', 'ga', 'et', 'lv', 'lt', 'eo', 'af', 'sq', 'eu', 'gl', 'cy', 'is', 'az', 'uz', 'vi']);

export const ENGINES = {
  auto: 'Automatic (best available)',
  vision: 'AI vision (Advanced model)',
  ondevice: 'On-device model',
  tesseract: 'Basic (Tesseract)',
};
export const engineLabel = { vision: 'AI vision', ondevice: 'On-device model', tesseract: 'Basic' };

let trocr = null; // Promise<pipeline>

function loadTrocr(onStatus) {
  if (!trocr) {
    trocr = (async () => {
      const { pipeline, env } = await import(/* webpackIgnore: true */ TRANSFORMERS);
      env.allowLocalModels = false;
      const files = {};
      // Full-precision encoder + 8-bit decoder: same accuracy as full fp32 in tests, ~130 MB instead of ~250 MB
      // (fully 8-bit is ~70 MB but misreads a lot: "good morning" -> "wood machines").
      return pipeline('image-to-text', MODEL, {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files[p.file] = [p.loaded, p.total];
            const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
            onStatus?.(`Downloading handwriting model… ${Math.round((l / t) * 100)}% (${Math.round(t / 1e6)} MB)`);
          }
        },
      });
    })();
    trocr.catch(() => { trocr = null; });
  }
  return trocr;
}

/** Ask once before the ~130 MB download. Stored so we never nag again. */
async function onDeviceAllowed() {
  const s = settings.get();
  if (s.hwrModelOk === true) return true;
  if (s.hwrModelOk === false) return false;
  const ok = await sheet({
    iconName: 'gesture', title: 'Better handwriting recognition?',
    body: 'Download an on-device handwriting model (about 130 MB, once). It runs privately in your browser and is kept in its cache for next time. Latin-script languages only.',
    allowLabel: 'Download', cancelLabel: 'Use basic',
  });
  settings.set({ hwrModelOk: ok });
  return ok;
}

const visionReady = () => state.mode === 'advanced' && typeof state.advanced?.recognizeImage === 'function';

function pickEngines(lang) {
  const pref = settings.get().hwrEngine || 'auto';
  const latin = LATIN.has(String(lang).split('-')[0]);
  if (pref === 'tesseract') return ['tesseract'];
  if (pref === 'vision') return [visionReady() ? 'vision' : null, 'tesseract'].filter(Boolean);
  if (pref === 'ondevice') return [latin ? 'ondevice' : null, 'tesseract'].filter(Boolean);
  return [visionReady() ? 'vision' : null, latin ? 'ondevice' : null, 'tesseract'].filter(Boolean);
}

async function runTesseract(canvas, lang, single, onStatus) {
  const res = await tesseract(canvas, { lang: ocrLangFor(lang), psm: single ? '8' : '7', onProgress: (m) => onStatus?.(describeOcrStatus(m)) });
  const out = [res.text];
  if (res.words.length === 1) (res.words[0].choices || []).forEach((c) => out.push(c.text));
  return out;
}

async function runTrocr(canvas, onStatus) {
  const pipe = await loadTrocr(onStatus);
  onStatus?.('Recognizing…');
  const url = canvas.toDataURL('image/png');
  let out;
  try { out = await pipe(url, { num_beams: 4, num_return_sequences: 3, max_new_tokens: 48 }); }
  catch { out = await pipe(url, { max_new_tokens: 48 }); }
  return (Array.isArray(out) ? out : [out]).map((o) => o?.generated_text || '');
}

/**
 * @param {HTMLCanvasElement} canvas  black ink on white, cropped
 * @returns {Promise<{ candidates: string[], engine: 'vision'|'ondevice'|'tesseract', note?: string }>}
 */
export async function recognizeHandwriting(canvas, { lang = 'en', single = false, onStatus } = {}) {
  let note;
  for (const engine of pickEngines(lang)) {
    try {
      let raw;
      if (engine === 'vision') {
        onStatus?.('Reading with AI vision…');
        raw = await state.advanced.recognizeImage(canvas.toDataURL('image/png'), lang);
      } else if (engine === 'ondevice') {
        if (!(await onDeviceAllowed())) continue;
        raw = await runTrocr(canvas, onStatus);
      } else {
        raw = await runTesseract(canvas, lang, single, onStatus);
      }
      const candidates = [...new Set(raw.map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (candidates.length) return { candidates, engine, note };
    } catch (e) {
      note = `${engineLabel[engine]} unavailable: ${e.message || e}`;
    }
  }
  return { candidates: [], engine: 'tesseract', note };
}
