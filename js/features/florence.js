// Florence-2 base (Microsoft, MIT licence) on this device, with transformers.js: a small image model that
// reads the text in a photo with the place of each line (signs, menus, labels, short texts), and describes a
// photo that has no text in it. Downloaded once from Hugging Face (models.js); photos never leave the device.
// Same result shape as Tesseract and PP-OCRv6 (ocr.js), so the camera can show it the same way.
import { getPipeline, modelState, fromText, HF_MODELS } from './models.js';
import { latinScript } from './paddle.js';
import { settings } from '../store.js';
import { sheet } from './permissions.js';

/** Florence-2 reads Latin script; other scripts go to the other engines. Unknown / auto: yes. */
export const florenceReads = (lang) => !lang || lang === 'auto' || latinScript(lang);

/** Ask once before the download (like the other on-device models). true = ready to use. */
export async function florenceAllowed() {
  const s = settings.get();
  if (modelState('florence') === 'ready' || s.visionModelOk === true) return true;
  if (s.visionModelOk === false) return false;
  const ok = await sheet({
    iconName: 'camera', title: 'Download Florence-2?',
    body: `Read photos with an on-device image model (about ${HF_MODELS.florence.sizeMB} MB, once, ${fromText('florence')}). It reads signs, menus and labels in Latin-script languages, and describes photos without text. It runs privately in your browser; it is slower than the other options, especially on phones. You can delete it in Settings › Text recognition.`,
    allowLabel: 'Download', cancelLabel: 'Not now',
  });
  settings.set({ visionModelOk: ok });
  return ok;
}

/** One task (e.g. '<OCR_WITH_REGION>') on a canvas: Florence-2's parsed answer. */
async function run(f, img, task, maxTokens) {
  const { model, processor, tokenizer, lib } = f;
  const image = lib.RawImage.fromCanvas(img).rgb();
  const text = tokenizer(processor.construct_prompts(task));
  const vision = await processor(image);
  const ids = await model.generate({ ...text, ...vision, max_new_tokens: maxTokens });
  const out = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
  return processor.post_process_generation(out, task, image.size)[task];
}

/** A line's four corners (top-left, top-right, bottom-right, bottom-left) as a turned box. */
function boxOfQuad(q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const w = Math.hypot(x1 - x0, y1 - y0); const h = Math.hypot(x3 - x0, y3 - y0);
  return { cx: (x0 + x1 + x2 + x3) / 4, cy: (y0 + y1 + y2 + y3) / 4, w, h, angle: Math.atan2(y1 - y0, x1 - x0) };
}

const canvasOf = async (image) => {
  if (image instanceof HTMLCanvasElement) return image;
  const src = image instanceof Blob ? await createImageBitmap(image) : image;
  const c = Object.assign(document.createElement('canvas'), { width: src.width || src.naturalWidth, height: src.height || src.naturalHeight });
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
};

/**
 * Read the text in a photo; a photo without text is described instead (then lang is 'en': the
 * description is English, whatever the photo's language).
 * Returns { text, confidence, lines: [{ text, bbox, quad, box, confidence }], words: [], lang?, note? }.
 */
export async function recognizeFlorence(image, { onProgress } = {}) {
  onProgress?.({ status: 'florence-load', progress: 0 });
  const f = await getPipeline('florence', { onProgress: (p) => onProgress?.({ status: 'florence-download', progress: p }) });
  const img = await canvasOf(image);
  onProgress?.({ status: 'florence', progress: 0 });
  const ocr = await run(f, img, '<OCR_WITH_REGION>', 1024);
  const lines = (ocr?.labels || []).map((label, i) => {
    const q = ocr.quad_boxes[i];
    const quad = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
    const xs = quad.map((p) => p[0]); const ys = quad.map((p) => p[1]);
    return {
      text: label.trim(), confidence: 100, quad, box: boxOfQuad(q),
      bbox: { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(img.width, Math.max(...xs)), y1: Math.min(img.height, Math.max(...ys)) },
    };
  }).filter((l) => /[\p{L}\p{N}]/u.test(l.text));
  if (lines.length) return { text: lines.map((l) => l.text).join('\n'), confidence: 100, lines, words: [] };
  // no text: say what's in the photo
  onProgress?.({ status: 'florence-describe', progress: 0 });
  const caption = String(await run(f, img, '<MORE_DETAILED_CAPTION>', 256) || '').trim();
  if (!caption) return { text: '', confidence: 0, lines: [], words: [] };
  return {
    text: caption, confidence: 100, lang: 'en', words: [],
    // shown as one block over the lower part of the photo, which stays visible above it
    description: true,
    lines: [{ text: caption, confidence: 100, bbox: { x0: img.width * 0.04, y0: img.height * 0.6, x1: img.width * 0.96, y1: img.height * 0.96 } }],
    note: 'No text found in the photo, so Florence-2 describes it instead.',
  };
}
