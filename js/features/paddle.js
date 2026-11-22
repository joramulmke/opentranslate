// PP-OCRv6 (PaddlePaddle, Apache-2.0): reads text in photos with two small models that run in the browser
// with ONNX Runtime: one finds the text lines (detection), one reads each line (recognition: Latin-script
// languages, Chinese, Japanese and Greek in one model; no Cyrillic, Arabic, Indic, Thai or Korean script). Downloaded once from Hugging Face (huggingface.co/PaddlePaddle) and kept in Cache
// Storage ("ot-paddle-v1"). Same result shape as Tesseract (ocr.js), so camera and handwriting can use either.
// Photos of book pages are rarely flat and straight: each line gets a box turned along it (and following it
// where the page bends), the page may lie sideways or upside down, and the lines are read column by column.
import { ORT_FILES, ORT_MB, loadOrt, cachedFile, haveFile } from './ort.js';
import { bgDownload, bgResume } from './bgfetch.js';
import { settings } from '../store.js';

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
/** Latin-script language (also what Florence-2 reads). */
export const latinScript = (lang) => LATIN.has(String(lang).split('-')[0]);
/** Can PP-OCRv6 read text in this language? (unknown / auto: yes, it's the common case) */
export const paddleReads = (lang) => !lang || lang === 'auto' || LATIN.has(String(lang).split('-')[0]) || OTHER.has(lang) || OTHER.has(String(lang).split('-')[0]);

// detection settings from the model's inference.yml. The longer side of the photo is scaled to OCR_QUALITIES
// before detection: Accurate keeps the small print of a book page apart, Fast is quicker on older phones.
export const OCR_QUALITIES = { accurate: 1920, fast: 960 };
export const ocrQuality = () => (settings.get().ocrQuality in OCR_QUALITIES ? settings.get().ocrQuality : 'accurate');
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
  // count into a local and swap at the end: the state stays as it was while the cache is read
  // (resetting it first made the Settings rows flicker to "download" on every refresh)
  let found = 0;
  if (typeof caches !== 'undefined') {
    try {
      const c = await caches.open(CACHE);
      let total = 0; let models = 0;
      for (const req of await c.keys()) {
        const res = await c.match(req);
        const n = Number(res?.headers.get('content-length')) || (res ? (await res.clone().blob()).size : 0);
        total += n;
        if (MODEL_FILES.includes(req.url)) models++;
      }
      found = models === MODEL_FILES.length ? total : 0;
    } catch { found = 0; }
  }
  if (found === bytes) return;
  bytes = found;
  emit();
}

/** Download the two models (and the runtime, unless the offline voices already have it). */
export function downloadPaddle({ onProgress } = {}) {
  if (job) return job.promise;
  job = { progress: 0 };
  job.promise = (async () => {
    const total = (PADDLE.sizeMB + ORT_MB) * 1e6;
    const files = [];
    for (const url of [...ORT_FILES, ...MODEL_FILES]) if (!(await haveFile(url, CACHE))) files.push({ url, cache: CACHE });
    const bg = await bgDownload('paddle', {
      title: 'Text recognition (PP-OCRv6)', doneTitle: 'Text recognition (PP-OCRv6) is ready',
      failTitle: "Text recognition didn't finish downloading. Open OpenTranslate to try again.", files, estimate: total,
    });
    if (bg) {
      bg.onProgress = (p) => { job.progress = p; onProgress?.(p); emit('progress'); };
      await bg.promise;
      return;
    }
    let done = 0;
    for (const u of [...ORT_FILES, ...MODEL_FILES]) {
      const r = await cachedFile(u, CACHE, (n) => { job.progress = Math.min(0.99, (done + n) / total); onProgress?.(job.progress); emit('progress'); });
      done += Number(r.headers.get('content-length')) || 0;
    }
  })().finally(async () => { job = null; await refreshPaddle(); });
  emit();
  return job.promise;
}

// a background download from an earlier visit: still running (show the progress) or finished meanwhile
bgResume('paddle', (_, bg) => {
  if (job) return;
  job = { progress: bg.progress(), promise: bg.promise.catch(() => {}).finally(async () => { job = null; await refreshPaddle(); }) };
  bg.onProgress = (p) => { if (job) job.progress = p; emit('progress'); };
  emit();
});

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

/** A canvas as a 1×3×H×W tensor, blue-green-red like PaddleOCR, normalised per channel. */
function tensorOf(ort, c, mean, std) {
  const { width: w, height: h } = c;
  const px = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = new Float32Array(3 * w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    out[i] = (px[p + 2] / 255 - mean[0]) / std[0];               // B
    out[w * h + i] = (px[p + 1] / 255 - mean[1]) / std[1];       // G
    out[2 * w * h + i] = (px[p] / 255 - mean[2]) / std[2];       // R
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

/** A white canvas of w×h; draw(g) paints onto it. */
function paint(w, h, draw) {
  const c = canvasOf(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  draw(g);
  return c;
}

/** The four corners of a turned box { cx, cy, w, h, angle }: top-left, top-right, bottom-right, bottom-left. */
const cornersOf = ({ cx, cy, w, h, angle }) => {
  const ux = Math.cos(angle); const uy = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + (a * w * ux - b * h * uy) / 2, cy + (a * w * uy + b * h * ux) / 2]);
};

/* ------------------------------------------------------------ detection */

/**
 * Text line boxes in image pixels, turned to follow each line: [{ cx, cy, w, h, angle, score }], unsorted.
 * A straight rectangle around a slanted line also takes in the lines above and below it, which the
 * reader then mixes up; so each line gets the narrowest box along its own direction (principal axis of
 * its pixels), like PaddleOCR's minimum-area rectangles.
 */
async function detect(m, img) {
  const W = img.width; const H = img.height;
  const scale = Math.min(1, OCR_QUALITIES[ocrQuality()] / Math.max(W, H));
  const w = Math.max(32, Math.round((W * scale) / 32) * 32);
  const h = Math.max(32, Math.round((H * scale) / 32) * 32);
  const input = tensorOf(m.ort, paint(w, h, (g) => g.drawImage(img, 0, 0, W, H, 0, 0, w, h)), MEAN, STD);
  const out = await m.det.run({ [m.det.inputNames[0]]: input });
  const prob = out[m.det.outputNames[0]].data;   // 1×1×h×w
  const sx = W / w; const sy = H / h;
  const boxes = [];
  for (const { px, sum } of regions(prob, w, h, THRESH)) {
    const b = fitBox(px, sum, w, sx, sy);
    if (b) boxes.push(b);
  }
  return boxes;
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);

/** Connected regions above threshold t (4-neighbour flood fill), as lists of pixel indices. */
function regions(prob, w, h, t) {
  const seen = new Uint8Array(w * h);
  const ok = (j) => !seen[j] && prob[j] > t;
  const queue = new Int32Array(w * h);
  const found = [];
  for (let start = 0; start < w * h; start++) {
    if (!ok(start)) continue;
    let n = 0; let top = 0; let sum = 0;
    queue[top++] = start; seen[start] = 1;
    while (n < top) {
      const i = queue[n++];
      const x = i % w;
      sum += prob[i];
      if (x > 0 && ok(i - 1)) { seen[i - 1] = 1; queue[top++] = i - 1; }
      if (x < w - 1 && ok(i + 1)) { seen[i + 1] = 1; queue[top++] = i + 1; }
      if (i >= w && ok(i - w)) { seen[i - w] = 1; queue[top++] = i - w; }
      if (i < w * (h - 1) && ok(i + w)) { seen[i + w] = 1; queue[top++] = i + w; }
    }
    found.push({ px: queue.slice(0, n), sum });
  }
  return found;
}

/**
 * The turned box of one region, in image pixels: the narrowest box along the direction of its pixels
 * (principal axis), grown back by the "unclip" margin. null for specks and unsure regions.
 */
function fitBox(px, sum, w, sx, sy) {
  const n = px.length;
  if (n < 6 || sum / n < BOX_THRESH) return null;
  let mx = 0; let my = 0;
  for (let k = 0; k < n; k++) { const x = px[k] % w; mx += x; my += (px[k] - x) / w; }
  mx = (mx / n + 0.5) * sx; my = (my / n + 0.5) * sy;
  let cxx = 0; let cyy = 0; let cxy = 0;
  for (let k = 0; k < n; k++) {
    const x = px[k] % w;
    const dx = (x + 0.5) * sx - mx; const dy = ((px[k] - x) / w + 0.5) * sy - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(angle); const uy = Math.sin(angle);
  let a0 = Infinity; let a1 = -Infinity; let b0 = Infinity; let b1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = px[k] % w;
    const dx = (x + 0.5) * sx - mx; const dy = ((px[k] - x) / w + 0.5) * sy - my;
    const a = dx * ux + dy * uy; const b = dy * ux - dx * uy;
    if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  const step = Math.hypot(sx * ux, sy * uy);      // one detection pixel, in image pixels
  let bw = a1 - a0 + step; let bh = b1 - b0 + step;
  if (Math.min(bw, bh) < 3 * step) return null;
  // A line on a bent page is curved, and a straight box around it is much too thick. So the middle of the
  // line is followed in short pieces (the centre between its top and bottom in each piece); the box is
  // then only as thick as the line around that curve, and read() straightens it.
  let bend = null; let cb = (b0 + b1) / 2;
  const K = Math.min(48, Math.floor((a1 - a0) / (8 * step)));
  if (K >= 3 && bw > 4 * bh) {
    const lo = new Float64Array(K).fill(Infinity); const hi = new Float64Array(K).fill(-Infinity);
    const bin = (a1 - a0) / K;
    const at = new Float64Array(n); const bt = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const x = px[k] % w;
      const dx = (x + 0.5) * sx - mx; const dy = ((px[k] - x) / w + 0.5) * sy - my;
      at[k] = dx * ux + dy * uy; bt[k] = dy * ux - dx * uy;
      const j = Math.min(K - 1, Math.floor((at[k] - a0) / bin));
      if (bt[k] < lo[j]) lo[j] = bt[k]; if (bt[k] > hi[j]) hi[j] = bt[k];
    }
    let mid = Array.from(lo, (l, j) => (l <= hi[j] ? (l + hi[j]) / 2 : NaN));
    // pieces without pixels (gaps between words) take their neighbours' value; then smooth twice
    for (let j = 0; j < K; j++) {
      if (!Number.isNaN(mid[j])) continue;
      let p = j - 1; while (p >= 0 && Number.isNaN(mid[p])) p--;
      let q = j + 1; while (q < K && Number.isNaN(mid[q])) q++;
      mid[j] = p < 0 ? mid[q] : q >= K ? mid[p] : mid[p] + ((mid[q] - mid[p]) * (j - p)) / (q - p);
    }
    for (let pass = 0; pass < 2; pass++) mid = mid.map((v, j) => (mid[Math.max(0, j - 1)] + v + mid[Math.min(K - 1, j + 1)]) / 3);
    const curve = (a) => {
      const t = Math.max(0, Math.min(K - 1, (a - a0) / bin - 0.5));
      const j = Math.min(K - 2, Math.floor(t));
      return mid[j] + (mid[j + 1] - mid[j]) * (t - j);
    };
    let r0 = Infinity; let r1 = -Infinity;
    for (let k = 0; k < n; k++) { const r = bt[k] - curve(at[k]); if (r < r0) r0 = r; if (r > r1) r1 = r; }
    const thin = r1 - r0 + step;
    if (thin * 1.15 < bh) {
      bh = thin; cb = 0;
      const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
      const from = a0 - step / 2 - d; const len = bw + 2 * d;
      bend = Array.from({ length: K }, (_, k) => curve(from + (k / (K - 1)) * len) + (r0 + r1) / 2);
    }
  }
  // the model marks a shrunken core of each line: grow it back ("unclip")
  const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
  const ca = (a0 + a1) / 2;
  bw += 2 * d; bh += 2 * d;
  return { cx: mx + ca * ux - cb * uy, cy: my + ca * uy + cb * ux, w: bw, h: bh, angle, bend, score: sum / n };
}

/** A box's bend when the box is turned half around: the other end first, the other side up. */
const turned = (bend) => bend && [...bend].reverse().map((v) => -v);

/** An angle brought within half a turn of ref: (ref - π, ref + π]. */
const near = (a, ref) => a - 2 * Math.PI * Math.round((a - ref) / (2 * Math.PI));

/**
 * Turn every box the same way as the page, which may lie sideways or upside down in the photo.
 * The page's direction is the median of the wide boxes (short words and marks don't tip it); a box more
 * than 45° off it is a short word whose own direction is unreliable, so it follows the page. Which way
 * round (a line read from its start or its end) is decided by reading the widest lines both ways.
 * Returns the boxes in reading order; reads holds the lines already read (box -> result).
 */
async function orient(m, img, boxes) {
  const reads = new Map();
  if (!boxes.length) return { boxes, reads };
  const wide = boxes.filter((b) => b.w > 2 * b.h);
  const ref = wide.length ? wide : boxes;
  // the angles' direction modulo half a turn: average on the doubled angle so 89° and -89° agree
  let tilt = 0.5 * Math.atan2(ref.reduce((a, b) => a + Math.sin(2 * b.angle), 0), ref.reduce((a, b) => a + Math.cos(2 * b.angle), 0));
  tilt = median(ref.map((b) => { const a = near(b.angle, tilt); return Math.abs(a - tilt) > Math.PI / 2 ? near(a + Math.PI, tilt) : a; }));
  for (const b of boxes) {
    b.angle = near(b.angle, tilt);
    if (Math.abs(b.angle - tilt) > Math.PI / 2) { b.angle = near(b.angle + Math.PI, tilt); b.bend = turned(b.bend); }
    if (Math.abs(b.angle - tilt) > Math.PI / 4) { b.angle = tilt; [b.w, b.h] = [b.h, b.w]; b.bend = null; }
  }
  // which way round: the widest lines, read as they are and turned half around (until it's clear)
  const sample = [...boxes].sort((a, b) => b.w / b.h - a.w / a.h).slice(0, 5);
  let ahead = 0; let back = 0;
  const flipped = new Map();
  for (const b of sample) {
    const r = await read(m, img, b);
    const rf = await read(m, img, { ...b, angle: b.angle + Math.PI, bend: turned(b.bend) });
    reads.set(b, r); flipped.set(b, rf);
    ahead += r.confidence * r.text.length; back += rf.confidence * rf.text.length;
    if (flipped.size >= 2 && Math.max(ahead, back) > 1.5 * Math.min(ahead, back)) break;
  }
  if (back > ahead) {
    tilt += Math.PI;
    for (const b of boxes) {
      b.angle += Math.PI; b.bend = turned(b.bend);
      if (flipped.has(b)) reads.set(b, flipped.get(b));
    }
  }
  // reading order along the page's own direction: column by column (e.g. the edge of the facing page
  // apart from this one), and within a column top to bottom, then left to right within a line
  const tx = Math.cos(tilt); const ty = Math.sin(tilt);
  for (const b of boxes) {
    b.along = b.cx * tx + b.cy * ty; b.across = b.cy * tx - b.cx * ty;
    const da = b.angle - tilt;
    b.reach = Math.abs((b.w / 2) * Math.cos(da)) + Math.abs((b.h / 2) * Math.sin(da));   // half its length along the page
  }
  const columns = [];
  for (const b of [...boxes].sort((p, q) => (p.along - p.reach) - (q.along - q.reach))) {
    const col = columns[columns.length - 1];
    if (col && b.along - b.reach < col.end) { col.boxes.push(b); col.end = Math.max(col.end, b.along + b.reach); } else columns.push({ end: b.along + b.reach, boxes: [b] });
  }
  const inColumn = (a, b) => (Math.abs(a.across - b.across) < Math.min(a.h, b.h) / 2 ? a.along - b.along : a.across - b.across);
  return { boxes: columns.flatMap((c) => c.boxes.sort(inColumn)), reads };
}

/* ------------------------------------------------------------ recognition */

/**
 * The line of box b, cut out of img and turned level into a canvas of w×h. A curved line (b.bend: the
 * offsets of its middle across the box, evenly spaced along it) is straightened in narrow strips, each
 * moved and turned to follow the curve.
 */
function cutLine(img, b, w, h) {
  const ux = Math.cos(b.angle); const uy = Math.sin(b.angle);
  const vx = -uy; const vy = ux;
  const kx = w / b.w; const ky = h / b.h;
  const K = b.bend?.length || 0;
  const off = (a) => {
    if (!K) return 0;
    const t = Math.max(0, Math.min(K - 1, ((a + b.w / 2) / b.w) * (K - 1)));
    const j = Math.min(K - 2, Math.floor(t));
    return b.bend[j] + (b.bend[j + 1] - b.bend[j]) * (t - j);
  };
  const strips = K ? Math.max(1, Math.ceil(w / 32)) : 1;
  return paint(w, h, (g) => {
    for (let i = 0; i < strips; i++) {
      const o0 = (i * w) / strips; const o1 = ((i + 1) * w) / strips;
      const am = (o0 + o1) / 2 / kx - b.w / 2; const half = (o1 - o0) / kx / 2;
      const c = off(am); const sl = K ? (off(am + half) - off(am - half)) / (2 * half) : 0;
      // output pixel o -> image point P0 + o.x * e1 + o.y * e2 (box frame a, b; across offset c + sl·(a - am))
      const e1x = (ux + sl * vx) / kx; const e1y = (uy + sl * vy) / kx;
      const e2x = vx / ky; const e2y = vy / ky;
      const p0x = b.cx + (c - sl * am) * vx - (b.w / 2) * (ux + sl * vx) - (b.h / 2) * vx;
      const p0y = b.cy + (c - sl * am) * vy - (b.w / 2) * (uy + sl * vy) - (b.h / 2) * vy;
      const det = e1x * e2y - e2x * e1y;
      const ia = e2y / det; const ib = -e1y / det; const ic = -e2x / det; const id = e1x / det;
      g.save();
      if (strips > 1) { g.beginPath(); g.rect(o0 - 0.5, 0, o1 - o0 + 1, h); g.clip(); }
      g.setTransform(ia, ib, ic, id, -(ia * p0x + ic * p0y), -(ib * p0x + id * p0y));
      g.drawImage(img, 0, 0);
      g.restore();
    }
  });
}

async function read(m, img, b) {
  const w = Math.max(8, Math.min(REC_MAX_W, Math.ceil((REC_H * b.w) / b.h)));
  const crop = cutLine(img, b, w, REC_H);
  const input = tensorOf(m.ort, crop, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
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
 * Each line also has its turned box: quad (four corners) and box { cx, cy, w, h, angle } (angle in radians).
 * single: the image is one line of text (handwriting), so detection is skipped.
 */
export async function recognizePaddle(image, { single = false, onProgress } = {}) {
  onProgress?.({ status: 'starting', progress: 0 });
  const m = await load();
  const img = await toCanvas(image);
  const { boxes, reads } = single
    ? { boxes: [{ cx: img.width / 2, cy: img.height / 2, w: img.width, h: img.height, angle: 0 }], reads: new Map() }
    : await orient(m, img, await detect(m, img));
  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    onProgress?.({ status: 'recognizing text', progress: (i + 1) / boxes.length });
    const b = boxes[i];
    const r = reads.get(b) || await read(m, img, b);
    if (!r.text) continue;
    const quad = cornersOf(b);
    const xs = quad.map((q) => q[0]); const ys = quad.map((q) => q[1]);
    lines.push({
      text: r.text, confidence: r.confidence, quad, box: { cx: b.cx, cy: b.cy, w: b.w, h: b.h, angle: b.angle },
      bbox: { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(img.width, Math.max(...xs)), y1: Math.min(img.height, Math.max(...ys)) },
    });
  }
  // stray marks (page edges, dirt) can come out as one or two characters of another script, e.g. a
  // Chinese character on an English page: such short lines in a script the rest of the page doesn't use go
  const kept = single ? lines : dropStrays(lines);
  const confidence = kept.length ? kept.reduce((a, l) => a + l.confidence, 0) / kept.length : 0;
  return { text: kept.map((l) => l.text).join('\n'), confidence, lines: kept, words: [] };
}

const SCRIPTS = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Greek'].map((n) => [n, new RegExp(`\\p{Script=${n}}`, 'gu')]);
const scriptCounts = (t) => Object.fromEntries(SCRIPTS.map(([n, re]) => [n, (t.match(re) || []).length]));
/** Lines of at most two letters, all in scripts that make up less than a tenth of the page's letters. */
function dropStrays(lines) {
  const total = scriptCounts(lines.map((l) => l.text).join(''));
  const all = Object.values(total).reduce((a, b) => a + b, 0);
  return lines.filter((l) => {
    const c = scriptCounts(l.text);
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    return n > 2 || !n || Object.entries(c).some(([k, v]) => v && total[k] >= all / 10);
  });
}

refreshPaddle();
