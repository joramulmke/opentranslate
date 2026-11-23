// Handwriting tab: draw on a pad, OCR the strokes (Tesseract, single-line mode),
// pick/edit the recognized text, then translate it.
import { state, subscribe, detect, translate, describeError, langName } from '../state.js';
import { settings } from '../store.js';
import { isRtl } from '../languages.js';
import { createLangBar } from '../ui/langbar.js';
import { toast } from '../ui/snackbar.js';
import { escapeHtml } from '../ui/langpicker.js';
import { recognizeHandwriting, engineLabel } from './hwr.js';
import { speak } from './speech.js';
import { icon } from '../ui/icons.js';

const $ = (id) => document.getElementById(id);
const AUTO_RECOGNIZE_MS = 1100;

export function initHandwriting({ sendToText }) {
  const el = {
    view: $('view-handwriting'), canvas: $('hand-canvas'), hint: $('pad-hint'), text: $('hand-text'),
    textClear: $('hand-text-clear'), candidates: $('hand-candidates'), status: $('hand-status'),
    translateBtn: $('hand-translate'), result: $('hand-result'), out: $('hand-out'),
    speakBtn: $('hand-speak'), copyBtn: $('hand-copy'), openBtn: $('hand-open'),
    undo: $('pad-undo'), clear: $('pad-clear'), width: $('pad-width'), recognizeBtn: $('pad-recognize'),
    paste: $('hand-paste'), space: $('pad-space'), backspace: $('pad-backspace'), enter: $('pad-enter'),
    expand: $('pad-expand'), padWrap: $('pad-wrap'),
  };
  createLangBar(el.view.querySelector('[data-langbar]'));

  const ctx = el.canvas.getContext('2d');
  let strokes = [];          // [{ w, pts: [{x,y,p}] }]
  let current = null;
  let timer = null;
  let job = 0;
  let lastResult = null;

  /** Show/hide controls that depend on the recognized text. */
  function renderText() {
    const has = !!el.text.value.length;
    el.textClear.hidden = !has;
    el.paste.hidden = has;
    el.backspace.disabled = !has;
    el.enter.classList.toggle('ready', !!el.text.value.trim());
  }
  el.text.addEventListener('input', renderText);

  /* ---------- drawing ---------- */
  function resize() {
    const r = el.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    el.canvas.width = Math.round(r.width * dpr);
    el.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  new ResizeObserver(resize).observe(el.canvas);

  const inkColor = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1f1f1f';

  function drawStroke(c, s, color, scale = 1, ox = 0, oy = 0) {
    const pts = s.pts;
    if (!pts.length) return;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = s.w * scale;
    if (pts.length === 1) {
      c.beginPath();
      c.arc((pts[0].x - ox) * scale, (pts[0].y - oy) * scale, (s.w * scale) / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.beginPath();
    c.moveTo((pts[0].x - ox) * scale, (pts[0].y - oy) * scale);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      c.quadraticCurveTo((pts[i].x - ox) * scale, (pts[i].y - oy) * scale, (mx - ox) * scale, (my - oy) * scale);
    }
    const last = pts[pts.length - 1];
    c.lineTo((last.x - ox) * scale, (last.y - oy) * scale);
    c.stroke();
  }

  function redraw() {
    const r = el.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const color = inkColor();
    strokes.forEach((s) => drawStroke(ctx, s, color));
    if (current) drawStroke(ctx, current, color);
    el.hint.hidden = strokes.length > 0 || !!current;
    el.undo.disabled = !strokes.length;
    el.clear.disabled = !strokes.length;
    el.recognizeBtn.disabled = !strokes.length;
  }

  const point = (e) => {
    const r = el.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
  };

  el.canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    el.canvas.setPointerCapture(e.pointerId);
    clearTimeout(timer);
    const base = Number(el.width.value);
    current = { w: e.pointerType === 'pen' ? base * (0.6 + (e.pressure || 0.5)) : base, pts: [point(e)] };
    redraw();
  });
  el.canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) current.pts.push(point(ev));
    redraw();
  });
  const end = () => {
    if (!current) return;
    strokes.push(current);
    current = null;
    redraw();
    clearTimeout(timer);
    timer = setTimeout(runRecognition, AUTO_RECOGNIZE_MS);
  };
  el.canvas.addEventListener('pointerup', end);
  el.canvas.addEventListener('pointercancel', end);

  el.undo.addEventListener('click', () => { strokes.pop(); redraw(); clearTimeout(timer); if (strokes.length) timer = setTimeout(runRecognition, AUTO_RECOGNIZE_MS); else clearCandidates(); });
  // screen readers say "6 pixels", not just "6"
  el.width.addEventListener('input', () => el.width.setAttribute('aria-valuetext', `${el.width.value} pixels`));
  el.clear.addEventListener('click', () => { strokes = []; redraw(); clearCandidates(); clearTimeout(timer); ++job; status(''); });
  el.recognizeBtn.addEventListener('click', () => { clearTimeout(timer); runRecognition(); });
  window.addEventListener('keydown', (e) => {
    if (el.view.hidden) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && document.activeElement !== el.text) { e.preventDefault(); el.undo.click(); }
  });

  /* ---------- recognition ---------- */
  function status(t) { el.status.textContent = t; }
  function clearCandidates() { el.candidates.innerHTML = ''; }

  /** Render strokes black-on-white, cropped and scaled for Tesseract. */
  function snapshot() {
    const all = strokes.flatMap((s) => s.pts.map((p) => ({ ...p, w: s.w })));
    const pad = 24;
    const x0 = Math.min(...all.map((p) => p.x - p.w)), y0 = Math.min(...all.map((p) => p.y - p.w));
    const x1 = Math.max(...all.map((p) => p.x + p.w)), y1 = Math.max(...all.map((p) => p.y + p.w));
    const h = y1 - y0;
    const scale = Math.max(0.3, Math.min(3, 110 / Math.max(h, 1)));   // aim for ~110 px tall text
    const c = document.createElement('canvas');
    c.width = Math.ceil((x1 - x0) * scale + pad * 2);
    c.height = Math.ceil(h * scale + pad * 2);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.translate(pad, pad);
    strokes.forEach((s) => drawStroke(g, { ...s, w: Math.max(s.w, 5) }, '#000', scale, x0, y0));
    return c;
  }

  async function runRecognition() {
    if (!strokes.length) return;
    const id = ++job;
    status('Recognizing…');
    const lang = state.source === 'auto' ? (state.detected?.language || 'en') : state.source;
    try {
      const res = await recognizeHandwriting(snapshot(), {
        lang, single: strokes.length <= 3,
        onStatus: (t) => id === job && status(t),
      });
      if (id !== job) return;
      const cands = [];
      const add = (t) => { t = (t || '').replace(/\s+/g, ' ').trim(); if (t && !cands.includes(t)) cands.push(t); };
      res.candidates.forEach(add);
      if (cands[0] && res.engine === 'tesseract') { add(cands[0].toLowerCase()); add(cands[0][0].toUpperCase() + cands[0].slice(1).toLowerCase()); }
      if (res.note) toast(res.note, { duration: 6000 });
      if (!cands.length) {
        el.candidates.innerHTML = '';
        status("Couldn't read that. Try writing larger.");
        return;
      }
      status(`Tap a suggestion to use it · ${engineLabel[res.engine]}`);
      el.candidates.innerHTML = cands.slice(0, 4).map((c, i) =>
        `<button type="button" class="chip" data-text="${escapeHtml(c)}" lang="${lang}">${escapeHtml(c)}</button>`).join('');
    } catch (e) {
      if (id !== job) return;
      status('');
      toast(e.message || 'Recognition failed');
    }
  }

  el.candidates.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    commit(chip.dataset.text);
  });

  function commit(text) {
    const cur = el.text.value.replace(/\s+$/, '');
    el.text.value = cur ? `${cur} ${text}` : text;
    renderText();
    strokes = [];
    redraw();
    clearCandidates();
    status('');
    if (settings.get().liveTranslate) doTranslate();
  }

  /* ---------- translation ---------- */
  let tReq = 0;
  async function doTranslate() {
    const text = el.text.value.trim();
    if (!text) { el.result.hidden = true; return; }
    const id = ++tReq;
    el.translateBtn.disabled = true;
    try {
      let source = state.source;
      if (source === 'auto') source = (await detect(text).catch(() => null))?.language || 'auto';
      const res = await translate(text, source, state.target);
      if (id !== tReq) return;
      lastResult = { text: res.text, target: state.target, input: text, source };
      if (res.note) toast(res.note);   // e.g. Classic stood in for Advanced
      el.result.hidden = false;
      el.out.textContent = res.text;
      el.out.lang = state.target;
      el.out.dir = isRtl(state.target) ? 'rtl' : 'ltr';
    } catch (e) {
      if (id !== tReq) return;
      const { title, message } = describeError(e);
      el.result.hidden = false;
      el.out.textContent = `${title}. ${message}`;
      el.out.removeAttribute('lang');
      lastResult = null;
    } finally {
      if (id === tReq) el.translateBtn.disabled = false;
    }
  }

  el.translateBtn.addEventListener('click', doTranslate);
  el.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doTranslate(); } });
  el.textClear.addEventListener('click', () => { el.text.value = ''; el.result.hidden = true; lastResult = null; renderText(); el.text.focus(); });

  /* ---------- key row: space · backspace · enter, plus paste and expand ---------- */
  el.space.addEventListener('click', () => { if (el.text.value && !/\s$/.test(el.text.value)) el.text.value += ' '; renderText(); });
  el.backspace.addEventListener('click', () => {
    el.text.value = [...el.text.value].slice(0, -1).join('');
    if (!el.text.value.trim()) { el.result.hidden = true; lastResult = null; }
    renderText();
  });
  el.enter.addEventListener('click', doTranslate);
  el.paste.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast('Clipboard is empty'); return; }
      el.text.value = t; renderText(); doTranslate();
    } catch { toast('Paste is blocked here. Long-press the text box and choose Paste.'); el.text.focus(); }
  });
  el.expand.addEventListener('click', () => {
    const on = el.padWrap.classList.toggle('expanded');
    el.expand.setAttribute('aria-pressed', String(on));
    el.expand.setAttribute('aria-label', on ? 'Shrink writing area' : 'Enlarge writing area');
    el.expand.innerHTML = icon(on ? 'fullscreenExit' : 'fullscreen');
    requestAnimationFrame(resize);
  });
  el.speakBtn.addEventListener('click', () => lastResult && speak(lastResult.text, lastResult.target).catch(() => toast(`No ${langName(lastResult.target)} voice on this device`)));
  el.copyBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    try { await navigator.clipboard.writeText(lastResult.text); toast('Translation copied'); } catch { toast('Copy failed'); }
  });
  el.openBtn.addEventListener('click', () => {
    const t = el.text.value.trim();
    if (t) sendToText(t, lastResult?.source && lastResult.source !== 'auto' ? { source: lastResult.source } : {});
  });

  let lastPair = `${state.source}>${state.target}`;
  subscribe(() => {
    const pair = `${state.source}>${state.target}`;
    if (pair !== lastPair) { lastPair = pair; if (!el.view.hidden && el.text.value.trim() && !el.result.hidden) doTranslate(); }
  });

  // redraw ink when the theme flips
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  redraw();
  renderText();

  return {
    onShow() { renderText(); requestAnimationFrame(resize); },
    onHide() { clearTimeout(timer); },
    getText: () => el.text.value,
    /** Carry text over from the keyboard input (pen button). */
    setText(t) {
      if (t === el.text.value) return;
      el.text.value = t || '';
      el.result.hidden = true; lastResult = null;
      renderText();
      if (el.text.value.trim()) doTranslate();
    },
  };
}
