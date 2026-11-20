// Handwriting recognition engines (Settings › Translation services › Handwriting picks the first;
// the others follow in this order):
//   1. AI vision  - your AI model reads the drawing (any script, cursive); when chosen, or in Advanced mode
//   2. On-device  - TrOCR handwriting model in the browser via transformers.js (Latin script; ~130 MB, once)
//   3. Basic      - Tesseract (print-like letters; also the fallback for non-Latin scripts)
import { state } from '../state.js';
import { settings } from '../store.js';
import { recognize as tesseract, ocrLangFor, describeOcrStatus } from './ocr.js';
import { sheet } from './permissions.js';
import { getPipeline, modelState, fromText, HF_MODELS } from './models.js';
const LATIN = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'pl', 'cs', 'sk', 'sl', 'hr', 'ro', 'hu', 'tr',
  'id', 'ms', 'tl', 'sw', 'ca', 'ga', 'et', 'lv', 'lt', 'eo', 'af', 'sq', 'eu', 'gl', 'cy', 'is', 'az', 'uz', 'vi']);

export const HWR_ENGINES = ['vision', 'ondevice', 'tesseract'];
/** Saved choice; older versions saved 'auto', which meant the same order with AI vision first. */
export const hwrPref = () => (HWR_ENGINES.includes(settings.get().hwrEngine) ? settings.get().hwrEngine : 'vision');
export const engineLabel = { vision: 'AI vision', ondevice: 'On-device model', tesseract: 'Basic' };


/** Ask once before the ~130 MB download. Stored so we never nag again. */
async function onDeviceAllowed() {
  const s = settings.get();
  if (modelState('trocr') === 'ready' || s.hwrModelOk === true) return true;
  if (s.hwrModelOk === false) return false;
  const ok = await sheet({
    iconName: 'gesture', title: 'Better handwriting recognition?',
    body: `Download an on-device handwriting model (about ${HF_MODELS.trocr.sizeMB} MB, once, ${fromText('trocr')})? It runs privately in your browser. Latin-script languages only. You can delete it in Settings › Translation services.`,
    allowLabel: 'Download', cancelLabel: 'Use basic',
  });
  settings.set({ hwrModelOk: ok });
  return ok;
}

// the drawing goes to your AI service: when that's the chosen engine, or in Advanced mode
const visionReady = () => (hwrPref() === 'vision' || state.mode === 'advanced') && typeof state.advanced?.recognizeImage === 'function';

function pickEngines(lang) {
  const pref = hwrPref();
  const latin = LATIN.has(String(lang).split('-')[0]);
  const usable = { vision: visionReady(), ondevice: latin, tesseract: true };
  // Basic is always the last resort
  return [pref, ...HWR_ENGINES.filter((e) => e !== pref), 'tesseract'].filter((e, i, a) => usable[e] && a.indexOf(e) === i);
}

async function runTesseract(canvas, lang, single, onStatus) {
  const res = await tesseract(canvas, { lang: ocrLangFor(lang), psm: single ? '8' : '7', onProgress: (m) => onStatus?.(describeOcrStatus(m)) });
  const out = [res.text];
  if (res.words.length === 1) (res.words[0].choices || []).forEach((c) => out.push(c.text));
  return out;
}

async function runTrocr(canvas, onStatus) {
  const pipe = await getPipeline('trocr', { onStatus });
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
