// Camera tab: live preview, capture or import, OCR, translated text overlaid on the photo.
import { state, subscribe, detect, translate, describeError, langName } from '../state.js';
import { createLangBar } from '../ui/langbar.js';
import { toast } from '../ui/snackbar.js';
import { recognize, ocrLangFor, describeOcrStatus } from './ocr.js';
import { escapeHtml } from '../ui/langpicker.js';

const $ = (id) => document.getElementById(id);
const MAX_OCR_SIDE = 1600;

export function initCamera({ sendToText }) {
  const el = {
    view: $('view-camera'), video: $('cam-video'), wrap: $('shot-wrap'), shot: $('shot'), img: $('shot-img'),
    overlays: $('shot-overlays'), empty: $('cam-empty'), emptyTitle: $('cam-empty-title'), emptyMsg: $('cam-empty-msg'),
    status: $('cam-status'), statusText: $('cam-status-text'), hint: $('cam-hint'), controls: $('cam-controls'),
    shutter: $('cam-shutter'), importBtn: $('cam-import'), import2: $('cam-import-2'), retry: $('cam-retry'),
    file: $('cam-file'), retake: $('cam-retake'), toggleOrig: $('cam-toggle-orig'), openText: $('cam-open-text'),
  };
  createLangBar(el.view.querySelector('[data-langbar]'), { variant: 'dark' });

  let stream = null;
  let visible = false;
  let shot = null;     // { w, h, ocrText, ocrSource, lines, translated }
  let job = 0;

  async function startStream() {
    stopStream();
    el.empty.hidden = true;
    el.shutter.disabled = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      return showEmpty('Camera unavailable', window.isSecureContext
        ? 'This browser does not support camera access. You can still import a photo.'
        : 'Camera access needs a secure page (https:// or localhost). You can still import a photo.');
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      if (!visible || shot) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      el.video.srcObject = s;
      await el.video.play().catch(() => {});
      el.shutter.disabled = false;
      el.hint.hidden = false;
    } catch (e) {
      const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError';
      const missing = e.name === 'NotFoundError' || e.name === 'OverconstrainedError';
      showEmpty(
        denied ? 'Camera permission needed' : missing ? 'No camera found' : 'Camera unavailable',
        denied ? 'Allow camera access in your browser’s site settings, then try again. Or import a photo instead.'
          : missing ? 'This device has no camera we can use. You can import a photo instead.'
            : `The camera could not start (${e.name || e.message}). You can import a photo instead.`,
      );
    }
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    el.video.srcObject = null;
  }

  function showEmpty(title, msg) {
    stopStream();
    el.empty.hidden = false;
    el.emptyTitle.textContent = title;
    el.emptyMsg.textContent = msg;
    el.shutter.disabled = true;
    el.hint.hidden = true;
  }

  function setMode(after) {
    el.controls.classList.toggle('after', after);
    el.shutter.hidden = after;
    el.retake.hidden = !after;
    el.toggleOrig.hidden = !after;
    el.openText.hidden = !after;
    el.wrap.hidden = !after;
    el.video.hidden = after;
    el.hint.hidden = after || !stream;
    if (!after) { el.status.hidden = true; el.overlays.innerHTML = ''; }
  }

  function status(text) {
    el.status.hidden = !text;
    if (text) el.statusText.textContent = text;
  }

  function fitShot() {
    if (!shot) return;
    const box = el.wrap.getBoundingClientRect();
    const cs = getComputedStyle(el.wrap);
    const availW = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const scale = Math.min(availW / shot.w, availH / shot.h);
    el.shot.style.width = `${Math.floor(shot.w * scale)}px`;
    el.shot.style.height = `${Math.floor(shot.h * scale)}px`;
  }
  new ResizeObserver(fitShot).observe(el.wrap);

  async function processCanvas(canvas) {
    const id = ++job;
    stopStream();
    shot = { w: canvas.width, h: canvas.height, lines: [], ocrText: '', translated: null };
    el.img.src = canvas.toDataURL('image/jpeg', 0.9);
    el.toggleOrig.setAttribute('aria-pressed', 'false');
    setMode(true);
    requestAnimationFrame(fitShot);
    status('Starting text recognition…');

    const ocrSource = state.source === 'auto' ? (state.detected?.language || 'en') : state.source;
    let ocr;
    try {
      ocr = await recognize(canvas, { lang: ocrLangFor(ocrSource), psm: '3', onProgress: (m) => id === job && status(describeOcrStatus(m)) });
    } catch (e) {
      if (id !== job) return;
      status('');
      toast(e.message || 'Text recognition failed');
      return;
    }
    if (id !== job) return;
    shot.lines = ocr.lines.filter((l) => l.confidence > 30 && /[\p{L}\p{N}]/u.test(l.text));
    shot.ocrText = shot.lines.map((l) => l.text).join('\n');
    if (!shot.ocrText) { status(''); toast('No text found. Try moving closer or improving the light.'); return; }
    await translateShot(id);
  }

  async function translateShot(id) {
    status(`Translating to ${langName(state.target)}…`);
    try {
      let source = state.source;
      if (source === 'auto') {
        const d = await detect(shot.ocrText).catch(() => null);
        source = d?.language || 'auto';
      }
      shot.ocrSource = source;
      const res = await translate(shot.ocrText, source, state.target);
      if (id !== job) return;
      shot.translated = res.text;
      drawOverlays();
      status('');
    } catch (e) {
      if (id !== job) return;
      status('');
      drawOverlays(true);
      const { title, message } = describeError(e);
      toast(`${title}: ${message}`);
    }
  }

  function drawOverlays(originalOnly = false) {
    const { w, h, lines } = shot;
    const showOrig = originalOnly || el.toggleOrig.getAttribute('aria-pressed') === 'true';
    const tLines = (shot.translated || '').split('\n');
    const perLine = tLines.length === lines.length;
    const boxes = perLine || showOrig
      ? lines.map((l, i) => ({ bbox: l.bbox, text: showOrig ? l.text : tLines[i] }))
      : [{ bbox: union(lines.map((l) => l.bbox)), text: shot.translated }];
    el.overlays.innerHTML = boxes.map(({ bbox, text }, i) => {
      const left = (bbox.x0 / w) * 100, top = (bbox.y0 / h) * 100;
      const width = ((bbox.x1 - bbox.x0) / w) * 100, height = ((bbox.y1 - bbox.y0) / h) * 100;
      const hh = perLine || showOrig ? height : Math.min(height, 6);
      return `<div class="ocr-box ${showOrig ? 'orig' : ''}" lang="${showOrig ? (shot.ocrSource || '') : state.target}"
        style="left:${left}%;top:${top}%;width:${width}%;${perLine || showOrig ? `height:${height}%` : `min-height:${height}%;white-space:normal;align-items:flex-start`};--h:${hh};animation-delay:${i * 25}ms"
        >${escapeHtml(text || '')}</div>`;
    }).join('');
  }

  const union = (bs) => bs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));

  function toCanvas(source, sw, sh) {
    const scale = Math.min(1, MAX_OCR_SIDE / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  el.shutter.addEventListener('click', () => {
    const v = el.video;
    if (!v.videoWidth) return;
    el.view.animate([{ filter: 'brightness(2)' }, { filter: 'none' }], { duration: 180 });
    processCanvas(toCanvas(v, v.videoWidth, v.videoHeight));
  });

  const pickFile = () => el.file.click();
  el.importBtn.addEventListener('click', pickFile);
  el.import2.addEventListener('click', pickFile);
  el.file.addEventListener('change', async () => {
    const f = el.file.files?.[0];
    el.file.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      el.empty.hidden = true;
      processCanvas(toCanvas(bmp, bmp.width, bmp.height));
    } catch {
      toast('That file could not be opened as an image');
    }
  });
  el.retry.addEventListener('click', startStream);
  el.retake.addEventListener('click', () => { ++job; shot = null; setMode(false); startStream(); });
  el.toggleOrig.addEventListener('click', () => {
    const on = el.toggleOrig.getAttribute('aria-pressed') !== 'true';
    el.toggleOrig.setAttribute('aria-pressed', String(on));
    el.toggleOrig.querySelector('span').textContent = on ? 'Translated' : 'Original';
    el.toggleOrig.setAttribute('aria-label', on ? 'Show translation' : 'Show original text');
    if (shot?.lines.length) drawOverlays();
  });
  el.openText.addEventListener('click', () => {
    if (!shot?.ocrText) { toast('No text to open'); return; }
    sendToText(shot.ocrText, shot.ocrSource && shot.ocrSource !== 'auto' ? { source: shot.ocrSource } : {});
  });

  // keep overlays in sync if the target language changes while a photo is shown
  let lastPair = `${state.source}>${state.target}`;
  subscribe(() => {
    const pair = `${state.source}>${state.target}`;
    if (pair === lastPair) return;
    lastPair = pair;
    if (visible && shot?.ocrText) translateShot(++job);
  });

  return {
    onShow() { visible = true; if (!shot) { setMode(false); startStream(); } },
    onHide() { visible = false; stopStream(); },
  };
}
