// Translating a whole PDF (IDEAS #9), two ways:
//  - page view: the paragraphs of each page, translated, next to the original (download .html or .txt),
//  - original layout: each page drawn as a picture with the translation over its text, like camera text
//    (#1), saved as a new PDF. Pictures, so any script works; its text can't be selected.
import { openPdf } from './pdf.js';
import { isRtl } from '../languages.js';
import { groupLines, joinLines, spreadText, lineColors, drawTranslated } from './inplace.js';

const LAYOUT_SIDE = 1754;   // longest side of a drawn page in pixels (A4 at 150 dpi)

/**
 * Read a PDF's text as lines with their boxes, grouped into paragraphs.
 * @returns {Promise<{ pages: Array<{ n, width, height, lines, groups, heads }>, texts: string[], where: Array<[number, number]>, close: () => void, drawPage: Function }>}
 *   texts: one per paragraph (all pages); where[k] = [page index, group index]
 */
export async function openPdfDocument(file, onStatus = () => {}) {
  const { task, doc } = await openPdf(file, onStatus);
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onStatus(`Reading page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = [];
      let cur = null;
      const end = () => { if (cur && cur.text.trim()) { cur.text = cur.text.replace(/\s+/g, ' ').trim(); lines.push(cur); } cur = null; };
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        // the item's box in page coordinates, y from the top
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
        const w = it.width;
        if (cur && it.str.trim() && Math.abs(y - cur.base) > h * 0.6) end();
        if (it.str.trim() || cur) {
          if (!cur) cur = { text: '', bbox: { x0: x, y0: y - h * 0.85, x1: x + w, y1: y + h * 0.2 }, base: y, size: h };
          cur.text += it.str;
          cur.bbox.x0 = Math.min(cur.bbox.x0, x); cur.bbox.x1 = Math.max(cur.bbox.x1, x + w);
          cur.bbox.y0 = Math.min(cur.bbox.y0, y - h * 0.85); cur.bbox.y1 = Math.max(cur.bbox.y1, y + h * 0.2);
          cur.size = Math.max(cur.size, h);
        }
        if (it.hasEOL) end();
      }
      end();
      const groups = groupLines(lines);
      const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
      const body = sizes[sizes.length >> 1] || 10;
      const heads = groups.map((g) => g.length <= 3 && Math.min(...g.map((i) => lines[i].size)) > body * 1.25);
      pages.push({ n, width: vp.width, height: vp.height, lines, groups, heads });
      page.cleanup();
    }
  } catch (e) { task.destroy(); throw e; }
  const texts = []; const where = [];
  pages.forEach((p, i) => p.groups.forEach((g, j) => { texts.push(joinLines(g.map((k) => p.lines[k].text))); where.push([i, j]); }));
  return {
    pages, texts, where,
    close: () => task.destroy(),
    /** Draw page i at the layout size; with translations (one per paragraph of that page), drawn over its text. */
    async drawPage(i, translations = null, target = '') {
      const p = pages[i];
      const page = await doc.getPage(p.n);
      const scale = LAYOUT_SIDE / Math.max(p.width, p.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      if (translations && p.lines.length) {
        const lines = p.lines.map((l) => ({ text: l.text, bbox: { x0: l.bbox.x0 * scale, y0: l.bbox.y0 * scale, x1: l.bbox.x1 * scale, y1: l.bbox.y1 * scale } }));
        const colors = lineColors(ctx.getImageData(0, 0, canvas.width, canvas.height), lines);
        const perLine = [];
        p.groups.forEach((g, k) => spreadText(translations[k] || '', g.map((j) => lines[j].text.length)).forEach((t, m) => { perLine[g[m]] = t; }));
        drawTranslated(ctx, lines, perLine, colors, '', { rtl: isRtl(target) });
      }
      return canvas;
    },
  };
}

/** Arabic, Hebrew, Persian, Urdu… run right to left; an unknown source ('auto') is left to the browser. */
const dirOf = (code) => (isRtl(code) ? 'rtl' : code && code !== 'auto' ? 'ltr' : 'auto');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The page view's HTML (inside the app): each paragraph, original and translation. */
export function pageViewHtml(pdf, translated, { source, target }) {
  let k = 0;
  return pdf.pages.map((p) => {
    const rows = p.groups.map((g, j) => {
      const tag = p.heads[j] ? 'h4' : 'p';
      const html = `<div class="pdf-pair${p.heads[j] ? ' head' : ''}"><${tag} class="pdf-orig" lang="${esc(source)}" dir="${dirOf(source)}">${esc(pdf.texts[k])}</${tag}><${tag} class="pdf-tr" lang="${esc(target)}" dir="${dirOf(target)}">${esc(translated[k])}</${tag}></div>`;
      k++;
      return html;
    }).join('');
    return `<section class="pdf-page" aria-label="Page ${p.n}"><h3 class="pdf-page-n">Page ${p.n}</h3>${rows || '<p class="pdf-empty">No text on this page (a picture or a scan).</p>'}</section>`;
  }).join('');
}

/** The translation as a stand-alone web page (download). */
export function translatedHtml(pdf, translated, { title, target }) {
  let k = 0;
  const body = pdf.pages.map((p) => p.groups.map((g, j) => { const t = esc(translated[k++]); return p.heads[j] ? `<h2>${t}</h2>` : `<p>${t}</p>`; }).join('\n')).join('\n<hr>\n');
  return `<!DOCTYPE html>\n<html lang="${esc(target)}" dir="${dirOf(target)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:42em;margin:2em auto;padding:0 1em}hr{border:0;border-top:1px solid #ccc;margin:2em 0}</style></head>
<body>\n${body}\n</body></html>\n`;
}

/** The translation as plain text (download). */
export function translatedText(pdf, translated) {
  let k = 0;
  return pdf.pages.map((p) => p.groups.map(() => translated[k++]).join('\n\n')).join('\n\n\f\n\n') + '\n';
}

/**
 * A PDF made of page pictures (JPEG), each page the size of the original.
 * @param {Array<{ jpeg: Uint8Array, w: number, h: number, wPt: number, hPt: number }>} pages
 */
export function imagesToPdf(pages) {
  const enc = new TextEncoder();
  const chunks = []; const offsets = []; let size = 0;
  const add = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); size += b.length; };
  const obj = (n, body, stream) => {
    offsets[n] = size;
    add(`${n} 0 obj\n${body}\n`);
    if (stream) { add('stream\n'); add(stream); add('\nendstream\n'); }
    add('endobj\n');
  };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = 3 + i * 3;
    const draw = enc.encode(`q ${p.wPt.toFixed(2)} 0 0 ${p.hPt.toFixed(2)} 0 0 cm /Im0 Do Q`);
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.wPt.toFixed(2)} ${p.hPt.toFixed(2)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${draw.length} >>`, draw);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  add(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) add(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
