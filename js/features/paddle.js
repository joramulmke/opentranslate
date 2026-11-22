// PP-OCRv6 (PaddlePaddle, Apache-2.0): reads text in photos with two small models that run in the browser
// with ONNX Runtime: one finds the text lines (detection), one reads each line (recognition: Latin-script
// languages, Chinese, Japanese and Greek in one model; no Cyrillic, Arabic, Indic, Thai or Korean script). Downloaded once from Hugging Face (huggingface.co/PaddlePaddle) and kept in Cache
// Storage ("ot-paddle-v1"). Same result shape as Tesseract (ocr.js), so camera and handwriting can use either.
import { ORT_FILES, ORT_MB, loadOrt, cachedFile } from './ort.js';

const CACHE = 'ot-paddle-v1';
const HF = 'https://huggingface.co/PaddlePaddle/';
const DET = `${HF}PP-OCRv6_small_det_onnx/resolve/main/inference.onnx`;
const REC = `${HF}PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx`;
const DICT = `${HF}PP-OCRv6_small_rec_onnx/resolve/main/inference.yml`;
const MODEL_FILES = [DET, REC, DICT];
export const PADDLE = {
  title: 'PP-OCRv6 small', sizeMB: 31, licence: 'Apache-2.0', scripts: 'Latin-script languages, Chinese, Japanese and Greek',
  page: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx', repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx + _rec_onnx',
};
// Languages whose script the recognition model has (checked against its character list).
const LATIN = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'nn', 'fi', 'pl', 'cs', 'sk', 'sl', 'hr', 'bs', 'ro', 'hu', 'tr',
  'id', 'ms', 'tl', 'sw', 'ca', 'ga', 'et', 'lv', 'lt', 'eo', 'af', 'sq', 'eu', 'gl', 'cy', 'is', 'az', 'uz', 'vi', 'mt', 'lb']);
const OTHER = new Set(['zh', 'zh-Hant', 'ja', 'el']);
/** Can PP-OCRv6 read text in this language? (unknown / auto: yes, it's the common case) */
export const paddleReads = (lang) => !lang || lang === 'auto' || LATIN.has(String(lang).split('-')[0]) || OTHER.has(lang) || OTHER.has(String(lang).split('-')[0]);

// detection settings from the model's inference.yml
const DET_LIMIT = 960;
const THRESH = 0.2; const BOX_THRESH = 0.45; const UNCLIP = 1.4;
const MEAN = [0.485, 0.456, 0.406]; const STD = [0.229, 0.224, 0.225];
const REC_H = 48; const REC_MAX_W = 3200;

const listeners = new Set();
export const onPaddleChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what = 'state') => listeners.forEach((fn) => fn(what));

let bytes = 0;            // downloaded (0 = not downloaded)
let job = null;           // { progress, promise } while downloading
export const paddleState = () => (job ? 'downloading' : bytes ? 'ready' : 'none');
export const paddleProgress = () => job?.progress ?? 0;
export const paddleBytes = () => bytes;

/** Whether the models (and the runtime) are in the cache. */
export async function refreshPaddle() {
  bytes = 0;
  if (typeof caches === 'undefined') { emit(); return; }
  try {
    const c = await caches.open(CACHE);
    let total = 0; let models = 0;
    for (const req of await c.keys()) {
      const res = await c.match(req);
      const n = Number(res?.headers.get('content-length')) || (res ? (await res.clone().blob()).size : 0);
      total += n;
      if (MODEL_FILES.includes(req.url)) models++;
    }
    bytes = models === MODEL_FILES.length ? total : 0;
  } catch { bytes = 0; }
  emit();
}

/** Download the two models (and the runtime, unless the offline voices already have it). */
export function downloadPaddle({ onProgress } = {}) {
  if (job) return job.promise;
  job = { progress: 0 };
  job.promise = (async () => {
    const total = (PADDLE.sizeMB + ORT_MB) * 1e6;
    let done = 0;
    for (const u of [...ORT_FILES, ...MODEL_FILES]) {
      const r = await cachedFile(u, CACHE, (n) => { job.progress = Math.min(0.99, (done + n) / total); onProgress?.(job.progress); emit('progress'); });
      done += Number(r.headers.get('content-length')) || 0;
    }
  })().finally(async () => { job = null; await refreshPaddle(); });
  emit();
  return job.promise;
}

export async function deletePaddle() {
  sessions = null;
  try { await caches.delete(CACHE); } catch { /* no cache storage */ }
  await refreshPaddle();
}

/* ------------------------------------------------------------ models */

let sessions = null;   // Promise<{ ort, det, rec, dict }>

/** The character list of the recognition model (one per line of its inference.yml). */
function parseDict(yml) {
  const lines = yml.slice(yml.indexOf('character_dict:')).split('\n').slice(1);
  const out = [];
  for (const l of lines) {
    if (!l.startsWith('  - ')) break;
    let v = l.slice(4);
    if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(v)) v = JSON.parse(v);
    out.push(v);
  }
  return out;
}

function load() {
  sessions ??= (async () => {
    if (paddleState() !== 'ready') throw Object.assign(new Error('PP-OCRv6 isn’t downloaded yet.'), { code: 'NEEDS_DOWNLOAD' });
    const ort = await loadOrt(CACHE);
    const buf = async (u) => (await cachedFile(u, CACHE)).arrayBuffer();
    const opts = { executionProviders: ['wasm'] };
    const [det, rec, yml] = await Promise.all([
      ort.InferenceSession.create(await buf(DET), opts), ort.InferenceSession.create(await buf(REC), opts),
      cachedFile(DICT, CACHE).then((r) => r.text()),
    ]);
    return { ort, det, rec, dict: parseDict(yml) };
  })();
  sessions.catch(() => { sessions = null; });
  return sessions;
}

/* ------------------------------------------------------------ image helpers */

const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

/** Draw an image (canvas, img or blob) onto a canvas. */
async function toCanvas(image) {
  if (image instanceof HTMLCanvasElement) return image;
  const src = image instanceof Blob ? await createImageBitmap(image) : image;
  const c = canvasOf(src.width || src.naturalWidth, src.height || src.naturalHeight);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/** Pixels of a canvas region as a 1×3×H×W tensor, blue-green-red like PaddleOCR, normalised per channel. */
function tensorOf(ort, source, sx, sy, sw, sh, w, h, mean, std) {
  const c = canvasOf(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(3 * w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    out[i] = (px[p + 2] / 255 - mean[0]) / std[0];               // B
    out[w * h + i] = (px[p + 1] / 255 - mean[1]) / std[1];       // G
    out[2 * w * h + i] = (px[p] / 255 - mean[2]) / std[2];       // R
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

/* ------------------------------------------------------------ detection */

/** Text line boxes in image pixels: [{ x0, y0, x1, y1, score }]. */
async function detect(m, img) {
  const W = img.width; const H = img.height;
  const scale = Math.min(1, DET_LIMIT / Math.max(W, H));
  const w = Math.max(32, Math.round((W * scale) / 32) * 32);
  const h = Math.max(32, Math.round((H * scale) / 32) * 32);
  const input = tensorOf(m.ort, img, 0, 0, W, H, w, h, MEAN, STD);
  const out = await m.det.run({ [m.det.inputNames[0]]: input });
  const prob = out[m.det.outputNames[0]].data;   // 1×1×h×w
  // connected regions above the threshold (iterative flood fill)
  const seen = new Uint8Array(w * h);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= THRESH) continue;
    let x0 = w; let y0 = h; let x1 = 0; let y1 = 0; let sum = 0; let n = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w; const y = (i - x) / w;
      sum += prob[i]; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || prob[j] <= THRESH) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || sum / n < BOX_THRESH) continue;
    // the model marks a shrunken core of each line: grow it back ("unclip")
    const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
    boxes.push({
      x0: Math.max(0, (x0 - d) * (W / w)), y0: Math.max(0, (y0 - d) * (H / h)),
      x1: Math.min(W, (x1 + 1 + d) * (W / w)), y1: Math.min(H, (y1 + 1 + d) * (H / h)), score: sum / n,
    });
  }
  // reading order: top to bottom, then left to right within a line
  return boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < Math.min(a.y1 - a.y0, b.y1 - b.y0) / 2 ? a.x0 - b.x0 : a.y0 - b.y0));
}

/* ------------------------------------------------------------ recognition */

/** Read one line box: greedy CTC decoding (index 0 = blank, last = space). */
async function read(m, img, b) {
  const bw = b.x1 - b.x0; const bh = b.y1 - b.y0;
  const w = Math.max(8, Math.min(REC_MAX_W, Math.ceil((REC_H * bw) / bh)));
  const input = tensorOf(m.ort, img, b.x0, b.y0, bw, bh, w, REC_H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const out = await m.rec.run({ [m.rec.inputNames[0]]: input });
  const t = out[m.rec.outputNames[0]];
  const [, T, C] = t.dims;
  let text = ''; let last = -1; let conf = 0; let n = 0;
  for (let i = 0; i < T; i++) {
    let best = 0; let bp = -Infinity;
    for (let c = 0; c < C; c++) { const v = t.data[i * C + c]; if (v > bp) { bp = v; best = c; } }
    if (best !== 0 && best !== last) {
      text += best === C - 1 && C - 1 > m.dict.length ? ' ' : (m.dict[best - 1] ?? '');
      conf += bp; n++;
    }
    last = best;
  }
  return { text: text.trim(), confidence: n ? (conf / n) * 100 : 0 };
}

/**
 * Same shape as ocr.js recognize(): { text, confidence, lines: [{ text, bbox: { x0, y0, x1, y1 }, confidence }], words: [] }.
 * single: the image is one line of text (handwriting), so detection is skipped.
 */
export async function recognizePaddle(image, { single = false, onProgress } = {}) {
  onProgress?.({ status: 'starting', progress: 0 });
  const m = await load();
  const img = await toCanvas(image);
  const boxes = single ? [{ x0: 0, y0: 0, x1: img.width, y1: img.height }] : await detect(m, img);
  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    onProgress?.({ status: 'recognizing text', progress: (i + 1) / boxes.length });
    const r = await read(m, img, boxes[i]);
    if (r.text) lines.push({ text: r.text, bbox: { x0: boxes[i].x0, y0: boxes[i].y0, x1: boxes[i].x1, y1: boxes[i].y1 }, confidence: r.confidence });
  }
  const confidence = lines.length ? lines.reduce((a, l) => a + l.confidence, 0) / lines.length : 0;
  return { text: lines.map((l) => l.text).join('\n'), confidence, lines, words: [] };
}

refreshPaddle();
