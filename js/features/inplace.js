// Translation drawn over the original text (IDEAS #1), used by camera text and by a PDF's "Original
// layout" (#9):
//  - groupLines: lines that belong together (a paragraph) are translated as one text,
//  - spreadText: …and the translation is spread back over those lines by length,
//  - lineColors: each line's background and text colour, taken from the picture,
//  - drawTranslated: the picture with the translation drawn in (to save, share or put in a PDF).

/** A line's box as { cx, cy, w, h, angle }: a turned box (PP-OCRv6) as it is, else from the bbox. */
export function boxOf(l) {
  if (l.box) return l.box;
  const b = l.bbox;
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, w: b.x1 - b.x0, h: b.y1 - b.y0, angle: 0 };
}

/**
 * Lines (in reading order) grouped into paragraphs: a line joins the one before when it is just below it,
 * about as tall, overlapping it sideways and turned the same way.
 * @returns {number[][]} indices into lines
 */
export function groupLines(lines) {
  const groups = [];
  let cur = null;
  lines.forEach((l, i) => {
    const prev = cur && boxOf(lines[cur[cur.length - 1]]);
    const b = boxOf(l);
    let joins = false;
    if (prev && Math.abs((prev.angle || 0) - (b.angle || 0)) < 0.05 && !(prev.angle || b.angle)) {
      const h = Math.max(prev.h, b.h);
      const gap = (b.cy - b.h / 2) - (prev.cy + prev.h / 2);
      const sameSize = Math.min(prev.h, b.h) / h > 0.7;
      const left = (x) => x.cx - x.w / 2;
      const right = (x) => x.cx + x.w / 2;
      const overlap = Math.min(right(prev), right(b)) - Math.max(left(prev), left(b));
      const sameLeft = Math.abs(left(prev) - left(b)) < 1.5 * h;
      joins = gap > -0.3 * h && gap < 0.9 * h && sameSize && overlap > 0 && (sameLeft || overlap > 0.5 * Math.min(prev.w, b.w));
    }
    if (joins) cur.push(i); else { cur = [i]; groups.push(cur); }
  });
  return groups;
}

const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** The lines of a paragraph as one text: "trans-" + "lation" becomes "translation". */
export function joinLines(texts) {
  let out = '';
  for (const t of texts.map((s) => s.trim())) {
    if (!out) { out = t; continue; }
    if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t;
    else if (NO_SPACES.test(out.slice(-1)) && NO_SPACES.test(t[0] || '')) out += t;
    else out += ' ' + t;
  }
  return out;
}

/**
 * A translated paragraph spread over n lines, each getting a share as long as its original line.
 * Breaks between words (or between characters for Chinese, Japanese and Thai).
 */
export function spreadText(text, lengths) {
  const n = lengths.length;
  if (n <= 1) return [text.trim()];
  const words = NO_SPACES.test(text) && !/\s/.test(text.trim()) ? [...text.trim()] : text.trim().split(/\s+/);
  const sep = words.length && words[0].length === 1 && NO_SPACES.test(words[0]) ? '' : ' ';
  const total = lengths.reduce((a, b) => a + Math.max(1, b), 0);
  const size = words.reduce((a, w) => a + w.length + sep.length, 0);
  const out = Array.from({ length: n }, () => []);
  let line = 0; let used = 0; let goal = (Math.max(1, lengths[0]) / total) * size;
  words.forEach((w, k) => {
    const left = words.length - k;
    // next line when this word would go past the line's share (closer to the goal without it),
    // but leave enough words for the lines still to come
    const after = used + w.length + sep.length;
    if (line < n - 1 && out[line].length && (Math.abs(used - goal) < Math.abs(after - goal) || left <= n - 1 - line)) {
      line++;
      goal += (Math.max(1, lengths[line]) / total) * size;
    }
    out[line].push(w);
    used += w.length + sep.length;
  });
  return out.map((ws) => ws.join(sep));
}

/* ---------------- colours ---------------- */

const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1] ?? 0; };
const medianColor = (px) => [0, 1, 2].map((c) => median(px.map((p) => p[c])));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const css = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;

/**
 * Each line's colours from the picture: the background just around its box, and the text colour (the
 * pixels inside the box that differ most from it). The text colour always stands out from the background.
 * @param {ImageData} img
 * @returns {Array<{ bg: number[], fg: number[] }>}
 */
export function lineColors(img, lines) {
  const { width: W, height: H, data } = img;
  const at = (x, y) => {
    const i = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return lines.map((l) => {
    const b = l.bbox || (() => { const r = boxOf(l); return { x0: r.cx - r.w / 2, y0: r.cy - r.h / 2, x1: r.cx + r.w / 2, y1: r.cy + r.h / 2 }; })();
    const w = b.x1 - b.x0; const h = b.y1 - b.y0;
    const pad = Math.max(2, h * 0.12);
    const ring = [];
    const N = 24;
    for (let k = 0; k <= N; k++) {
      const x = b.x0 + (w * k) / N; const y = b.y0 + (h * k) / N;
      ring.push(at(x, b.y0 - pad), at(x, b.y1 + pad));
      if (k % 3 === 0) ring.push(at(b.x0 - pad, y), at(b.x1 + pad, y));
    }
    const bg = medianColor(ring);
    const inside = [];
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 40; xx++) inside.push(at(b.x0 + ((xx + 0.5) * w) / 40, b.y0 + ((yy + 0.5) * h) / 8));
    inside.sort((p, q) => dist(q, bg) - dist(p, bg));
    let fg = medianColor(inside.slice(0, Math.max(3, inside.length * 0.12)));
    if (contrast(fg, bg) < 3.5) fg = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? [17, 17, 17] : [250, 250, 250];
    return { bg, fg };
  });
}

/* ---------------- drawing ---------------- */

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';

/** Words wrapped to fit maxWidth with the context's current font. */
function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = NO_SPACES.test(para) && !/\s/.test(para) ? [...para] : para.split(/\s+/);
    const sep = words.length && NO_SPACES.test(words[0]) && words[0].length === 1 ? '' : ' ';
    let line = '';
    for (const w of words) {
      const next = line ? line + sep + w : w;
      if (line && ctx.measureText(next).width > maxWidth) { out.push(line); line = w; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * Draw the translation into a canvas that already shows the picture.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} lines  OCR lines (bbox or box)
 * @param {string[]|null} texts  one text per line, or null: block is drawn over all of them
 * @param {Array<{bg,fg}>} colors  per line (block: the first is used)
 * @param {string} [block]  the whole translation, when texts is null
 * @param {{rtl?: boolean}} [opts]  rtl: Arabic, Hebrew… start at the right edge and run right to left
 */
export function drawTranslated(ctx, lines, texts, colors, block = '', { rtl = false } = {}) {
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  if (texts) {
    lines.forEach((l, i) => {
      const r = boxOf(l);
      const { bg, fg } = colors[i] || { bg: [250, 248, 255], fg: [26, 27, 32] };
      ctx.save();
      ctx.translate(r.cx, r.cy);
      if (r.angle) ctx.rotate(r.angle);
      ctx.fillStyle = css(bg);
      const grow = Math.max(1, r.h * 0.06);
      ctx.fillRect(-r.w / 2 - grow, -r.h / 2 - grow, r.w + 2 * grow, r.h + 2 * grow);
      const text = texts[i] || '';
      let size = r.h * 0.78;
      ctx.font = `${size}px ${FONT}`;
      let width = ctx.measureText(text).width;
      if (width > r.w) {
        size = Math.max(r.h * 0.5, size * (r.w / width));
        ctx.font = `${size}px ${FONT}`;
        width = ctx.measureText(text).width;
      }
      ctx.fillStyle = css(fg);
      if (width > r.w) ctx.scale(r.w / width, 1);   // still too long: squeeze it
      const x = (rtl ? r.w / 2 : -r.w / 2) * (width > r.w ? width / r.w : 1);   // the start edge, in squeezed units
      ctx.fillText(text, x, r.h * 0.04);
      ctx.restore();
    });
  } else if (lines.length) {
    const bs = lines.map((l) => { const r = boxOf(l); return { x0: r.cx - r.w / 2, y0: r.cy - r.h / 2, x1: r.cx + r.w / 2, y1: r.cy + r.h / 2 }; });
    const u = bs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const { bg, fg } = colors[0] || { bg: [250, 248, 255], fg: [26, 27, 32] };
    const w = u.x1 - u.x0; const h = u.y1 - u.y0;
    const lineH = median(lines.map((l) => boxOf(l).h)) || 20;
    let size = lineH * 0.8; let rows;
    for (;;) {
      ctx.font = `${size}px ${FONT}`;
      rows = wrap(ctx, block, w - size * 0.4);
      if (rows.length * size * 1.25 <= h || size < 8) break;
      size *= 0.9;
    }
    ctx.fillStyle = css(bg);
    ctx.fillRect(u.x0, u.y0, w, Math.max(h, rows.length * size * 1.25));
    ctx.fillStyle = css(fg);
    rows.forEach((row, k) => ctx.fillText(row, rtl ? u.x1 - size * 0.2 : u.x0 + size * 0.2, u.y0 + size * 1.25 * (k + 0.5)));
  }
  ctx.restore();
}
