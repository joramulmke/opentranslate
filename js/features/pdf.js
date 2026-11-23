// Read a PDF that was shared or opened with the app. pdf.js (Mozilla's PDF reader) is loaded only when a
// PDF arrives, from jsDelivr like the voice engine; the PDF itself never leaves the device.
// Pages with text give text; pages without (scans, photos of pages) are drawn as pictures for camera text.
const VERSION = '6.5.438';
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/`;
const SCAN_SIDE = 2000;   // longest side of a scanned page drawn for text recognition, in pixels
let lib = null;

function load() {
  lib ||= import(`${BASE}build/pdf.min.mjs`).then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;
    return m;
  }).catch((e) => {
    lib = null;
    throw new Error(`The PDF reader could not be loaded. Check the internet connection and try again. (${e.message || e})`);
  });
  return lib;
}

/** Open a PDF with pdf.js. Call task.destroy() when done. */
export async function openPdf(blob, onStatus = () => {}) {
  onStatus('Loading the PDF reader…');
  const pdfjs = await load();
  onStatus('Reading the PDF…');
  let task;
  let doc;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      cMapUrl: `${BASE}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${BASE}standard_fonts/`, wasmUrl: `${BASE}wasm/`, iccUrl: `${BASE}iccs/`,
      isEvalSupported: false, enableXfa: false,
    });
    doc = await task.promise;
  } catch (e) {
    task?.destroy();
    if (e?.name === 'PasswordException') throw new Error('This PDF is protected with a password, so it can’t be read here.');
    throw new Error('This file could not be read as a PDF.');
  }
  return { task, doc };
}

const hasWords = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length >= 15;

/** Pages drawn as pictures for camera text (scans, photos of pages): canvases, in page order. */
async function draw(doc, nums, onStatus) {
  const out = [];
  for (const n of nums) {
    onStatus(`Preparing page ${n} of ${doc.numPages}…`);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, SCAN_SIDE / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    page.cleanup();
    out.push(canvas);
  }
  return out;
}

/**
 * Read a PDF.
 * @param {Blob} blob
 * @param {{ maxChars?: number, maxScans?: number, onStatus?: (text: string) => void }} opts
 * @returns {Promise<{ text: string, pages: number, textPages: number, cut: boolean, scans: HTMLCanvasElement[], scanPages: number, emptyPages: number[] }>}
 *   text: the text of the pages that have some (up to maxChars); scans: drawn pages without text, only
 *   when the PDF has no text at all (up to maxScans; scanPages counts them all); emptyPages: the numbers
 *   of the pages without text that were looked at (for drawPages, when the PDF has text and scans).
 */
export async function readPdf(blob, { maxChars = 5000, maxScans = 10, onStatus = () => {} } = {}) {
  const { task, doc } = await openPdf(blob, onStatus);
  try {
    const parts = [];
    const empty = [];
    let length = 0;
    let cut = false;
    for (let n = 1; n <= doc.numPages; n++) {
      if (length >= maxChars) { cut = true; break; }
      onStatus(`Reading page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (hasWords(text)) { parts.push(text); length += text.length + 2; } else empty.push(n);
      page.cleanup();
    }
    let text = parts.join('\n\n');
    if (text.length > maxChars) { text = text.slice(0, maxChars); cut = true; }
    // a scan: draw the pages for camera text
    const scans = parts.length ? [] : await draw(doc, empty.slice(0, maxScans), onStatus);
    return { text, pages: doc.numPages, textPages: parts.length, cut, scans, scanPages: parts.length ? 0 : empty.length, emptyPages: empty };
  } finally {
    task.destroy();
  }
}

/** Some pages of a PDF drawn as pictures for camera text (a PDF with text pages and scanned pages). */
export async function drawPages(blob, nums, { onStatus = () => {} } = {}) {
  const { task, doc } = await openPdf(blob, onStatus);
  try { return await draw(doc, nums, onStatus); } finally { task.destroy(); }
}
