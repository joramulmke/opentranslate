// Camera tab: live preview, capture or import, OCR, translated text overlaid on the photo.
import { state, subscribe, detect, translate, describeError, langName, fallbackNote } from '../state.js';
import { createLangBar } from '../ui/langbar.js';
import { toast, copyToClipboard, hide as hideToast } from '../ui/snackbar.js';
import { recognize, ocrLangFor, describeOcrStatus } from './ocr.js';
import { ocrQuality } from './paddle.js';
import { escapeHtml } from '../ui/langpicker.js';
import { icon } from '../ui/icons.js';
import { permissionState, onPermissionChange, blockedSteps, cameraCopy } from './permissions.js';
import { groupLines, joinLines, spreadText, lineColors, drawTranslated, css } from './inplace.js';
import { isPhone, canShareFile, sendFiles, today, slugWords } from '../ui/sendfile.js';

const $ = (id) => document.getElementById(id);
// Settings › Text recognition › Reading: Accurate keeps more detail of small print (a book page), Fast is quicker
const CAPTURE = {
  accurate: { side: 2560, video: { width: { ideal: 3840 }, height: { ideal: 2160 } } },
  fast: { side: 1600, video: { width: { ideal: 1920 }, height: { ideal: 1080 } } },
};
const capture = () => CAPTURE[ocrQuality()];

export function initCamera({ sendToText }) {
  const el = {
    view: $('view-camera'), video: $('cam-video'), wrap: $('shot-wrap'), shot: $('shot'), img: $('shot-img'),
    overlays: $('shot-overlays'), empty: $('cam-empty'), emptyTitle: $('cam-empty-title'), emptyMsg: $('cam-empty-msg'),
    status: $('cam-status'), statusText: $('cam-status-text'), hint: $('cam-hint'), controls: $('cam-controls'),
    shutter: $('cam-shutter'), importBtn: $('cam-import'), import2: $('cam-import-2'), retry: $('cam-retry'),
    file: $('cam-file'), retake: $('cam-retake'), toggleOrig: $('cam-toggle-orig'), openText: $('cam-open-text'),
    stage: $('camera-stage'), strip: $('shot-strip'), share: $('cam-share'),
  };
  createLangBar(el.view.querySelector('[data-langbar]'), { variant: 'dark' });

  let stream = null;
  let visible = false;
  let shot = null;     // { w, h, ocrText, ocrSource, lines, translated, src, done, pair }
  let job = 0;
  let album = [];      // several photos: [{ source: Blob|canvas, shot, thumb }]
  let albumAt = 0;

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
        video: { facingMode: { ideal: 'environment' }, ...capture().video }, audio: false,
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
      if (denied) return showBlockedState();
      showEmpty(
        missing ? 'No camera found' : 'Camera unavailable',
        missing ? 'This device has no camera we can use. You can import a photo instead.'
          : `The camera could not start (${e.name || e.message}). You can import a photo instead.`,
      );
    }
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    el.video.srcObject = null;
  }

  /** Explain before the browser asks; the button then triggers the real prompt. */
  async function gate() {
    const st = await permissionState('camera');
    if (!visible || shot) return;
    if (st === 'granted') return startStream();
    if (st === 'denied') return showBlockedState();
    showEmpty(cameraCopy.title, cameraCopy.body, { iconName: 'camera', retryLabel: 'Allow camera' });
  }

  function showBlockedState() {
    showEmpty('Camera is blocked', 'Your browser is blocking the camera for this site. You can still import a photo. To turn the camera on:',
      { iconName: 'videocamOff', retryLabel: 'Try again', steps: blockedSteps('camera') });
  }

  function showEmpty(title, msg, { iconName = 'videocamOff', retryLabel = 'Try again', steps = [] } = {}) {
    stopStream();
    el.empty.hidden = false;
    $('cam-empty-icon').innerHTML = icon(iconName);
    $('cam-empty-steps').innerHTML = steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    $('cam-empty-steps').hidden = !steps.length;
    el.retry.textContent = retryLabel;
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
    el.share.hidden = !after;
    resetZoom();
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
    resetZoom();
    if (shot.lineTexts) requestAnimationFrame(fitBoxes);
  }
  new ResizeObserver(fitShot).observe(el.wrap);

  async function processCanvas(canvas) {
    const id = ++job;
    stopStream();
    shot = { w: canvas.width, h: canvas.height, lines: [], ocrText: '', translated: null, src: canvas.toDataURL('image/jpeg', 0.9) };
    if (album[albumAt] && !album[albumAt].shot) album[albumAt].shot = shot;
    el.img.src = shot.src;
    el.toggleOrig.setAttribute('aria-pressed', 'false');
    setMode(true);
    requestAnimationFrame(fitShot);
    status('Starting text recognition…');

    const ocrSource = state.source === 'auto' ? (state.detected?.language || 'en') : state.source;
    let ocr;
    try {
      ocr = await recognize(canvas, { lang: ocrLangFor(ocrSource), iso: state.source === 'auto' ? null : ocrSource, psm: '3', onProgress: (m) => id === job && status(describeOcrStatus(m)) });
    } catch (e) {
      if (id !== job) return;
      shot.failed = true;   // read again when shown again; "Save all" goes on without it
      status('');
      toast(e.message || 'Text recognition failed');
      return;
    }
    if (id !== job) return;
    shot.lines = ocr.lines.filter((l) => l.confidence > 30 && /[\p{L}\p{N}]/u.test(l.text));
    shot.ocrText = shot.lines.map((l) => l.text).join('\n');
    try { shot.colors = lineColors(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), shot.lines); } catch { shot.colors = []; }
    shot.note = ocr.note || '';   // e.g. AI vision didn't work and the device read the photo
    shot.lang = ocr.lang || null;  // e.g. a Florence-2 description is English, whatever the photo's language
    shot.description = !!ocr.description;
    if (!shot.ocrText) { shot.done = true; status(''); toast(`No text found. Try moving closer or improving the light.${shot.note ? ' ' + shot.note : ''}`); return; }
    await translateShot(id);
  }

  async function translateShot(id) {
    status(`Translating to ${langName(state.target)}…`);
    shot.jpeg = null; shot.jpegBlob = null;
    try {
      let source = shot.lang || state.source;
      if (source === 'auto') {
        const d = await detect(shot.ocrText).catch(() => null);
        source = d?.language || 'auto';
      }
      shot.ocrSource = source;
      // lines that belong together are translated as one sentence, then spread back over their lines
      const groups = shot.description ? null : groupLines(shot.lines);
      const text = groups ? groups.map((g) => joinLines(g.map((i) => shot.lines[i].text))).join('\n') : shot.ocrText;
      const res = await translate(text, source, state.target);
      if (id !== job) return;
      shot.translated = res.text;
      shot.lineTexts = null;
      if (groups) {
        let parts = res.text.split('\n').map((t) => t.trim()).filter(Boolean);
        if (groups.length === 1 && parts.length > 1) parts = [parts.join(' ')];
        if (parts.length === groups.length) {
          shot.lineTexts = [];
          groups.forEach((g, k) => spreadText(parts[k], g.map((i) => shot.lines[i].text.length)).forEach((t, j) => { shot.lineTexts[g[j]] = t; }));
        }
      }
      shot.done = true; shot.pair = `${state.source}>${state.target}`;
      // ready before Share is tapped: a phone opens its share sheet only right after the tap
      const sh = shot; sh.jpeg = translatedPhoto(sh).then((b) => (sh.jpegBlob = b));
      const note = [shot.note, fallbackNote(res)].filter(Boolean).join(' ');   // e.g. Classic stood in for Advanced
      if (note) toast(note);
      drawOverlays();
      status('');
    } catch (e) {
      if (id !== job) return;
      shot.done = true; shot.pair = null;
      status('');
      drawOverlays(true);
      const { title, message } = describeError(e);
      toast(`${title}: ${message}${shot.note ? ' ' + shot.note : ''}`);
    }
  }

  function drawOverlays(originalOnly = false) {
    const { w, h, lines } = shot;
    const showOrig = originalOnly || el.toggleOrig.getAttribute('aria-pressed') === 'true';
    const tLines = shot.lineTexts;
    const perLine = !!tLines;
    const colors = shot.colors || [];
    const boxes = perLine || showOrig
      ? lines.map((l, i) => ({ bbox: l.bbox, box: l.box, text: showOrig ? l.text : tLines[i], c: colors[i] }))
      : [{ bbox: union(lines.map((l) => l.bbox)), text: shot.translated, c: colors[0] }];
    el.overlays.innerHTML = boxes.map(({ bbox, box, text, c }, i) => {
      // a turned line (PP-OCRv6 on a slanted or sideways page) is covered by a box turned the same way
      const r = box || { cx: (bbox.x0 + bbox.x1) / 2, cy: (bbox.y0 + bbox.y1) / 2, w: bbox.x1 - bbox.x0, h: bbox.y1 - bbox.y0, angle: 0 };
      const left = ((r.cx - r.w / 2) / w) * 100, top = ((r.cy - r.h / 2) / h) * 100;
      const width = (r.w / w) * 100, height = (r.h / h) * 100;
      const hh = perLine || showOrig ? height : Math.min(height, 6);
      const paint = !showOrig && c ? `background:${css(c.bg)};color:${css(c.fg)};box-shadow:none;` : '';
      return `<div class="ocr-box ${showOrig ? 'orig' : ''}" lang="${showOrig ? (shot.ocrSource || '') : state.target}"
        style="${paint}left:${left}%;top:${top}%;width:${width}%;${perLine || showOrig ? `height:${height}%` : `min-height:${height}%;white-space:normal;align-items:flex-start`};--h:${hh};${r.angle ? `rotate:${r.angle.toFixed(4)}rad;` : ''}animation-delay:${i * 25}ms"
        ><span>${escapeHtml(text || '')}</span></div>`;
    }).join('');
    if (perLine && !showOrig) requestAnimationFrame(fitBoxes);
  }

  /** A translation longer than its line gets a smaller font (down to half), then is squeezed sideways. */
  function fitBoxes() {
    for (const b of el.overlays.querySelectorAll('.ocr-box')) {
      b.style.removeProperty('--fit'); b.style.removeProperty('--squeeze');
      const over = b.scrollWidth / Math.max(1, b.clientWidth);
      if (over <= 1.01) continue;
      const fit = Math.max(0.5, 1 / over);
      b.style.setProperty('--fit', fit.toFixed(3));
      const left = b.scrollWidth / Math.max(1, b.clientWidth);
      if (left > 1.01) b.style.setProperty('--squeeze', (1 / left).toFixed(3));
    }
  }

  /** A photo with the translation drawn in, as a JPEG. */
  async function translatedPhoto(sh = shot) {
    const img = new Image();
    img.src = sh.src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = sh.w; c.height = sh.h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (sh.translated) drawTranslated(ctx, sh.lines, sh.lineTexts, sh.colors || [], sh.translated);
    return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  }

  /* Share (phones) or Save (computers): a small menu with this photo, all photos (when there are
     several; on computers as one .zip or separately) and the translated text (Share text on phones,
     Copy text on computers). IDEAS #5. The words say what will really happen: a phone that can't share
     pictures saves them. */
  const shareMenu = $('cam-share-menu');
  const sharesPhotos = () => canShareFile('photo.jpg');
  const setShareLabel = () => {
    const share = sharesPhotos();
    el.share.querySelector('span').textContent = share ? 'Share' : 'Save';
    el.share.setAttribute('aria-label', share ? 'Share translated photo or text' : 'Save translated photo or copy text');
    const ic = el.share.querySelector('svg, i');
    if (ic && ic.dataset.shareIcon !== String(share)) { ic.outerHTML = icon(share ? 'share' : 'download'); el.share.firstElementChild.dataset.shareIcon = String(share); }
  };
  setShareLabel();
  matchMedia('(pointer: coarse)').addEventListener?.('change', setShareLabel);
  shareMenu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const verb = sharesPhotos() ? 'Share' : 'Save';
    const n = album.length;
    const item = (act, ic, label) => `<button type="button" role="menuitem" data-share="${act}">${icon(ic)}<span>${escapeHtml(label)}</span></button>`;
    shareMenu.innerHTML = [
      item('photo', 'image', n > 1 ? `${verb} this photo` : `${verb} photo`),
      n > 1 && verb === 'Share' ? item('all', 'photos', `Share all ${n} photos`) : '',
      n > 1 && verb === 'Save' ? item('zip', 'photos', `Save all ${n} photos (.zip)`) : '',
      n > 1 && verb === 'Save' ? item('all', 'photos', `Save all ${n} photos separately`) : '',
      isPhone() && navigator.share ? item('text', 'share', 'Share text') : item('copy', 'copy', 'Copy text'),
    ].join('');
  });
  // keyboard: the first item gets focus, arrows move, Tab leaves; Escape closes (the popover does that)
  shareMenu.addEventListener('toggle', (e) => {
    if (e.newState === 'open') { el.share.setAttribute('aria-expanded', 'true'); shareMenu.querySelector('[role="menuitem"]')?.focus(); return; }
    el.share.setAttribute('aria-expanded', 'false');
    if (!document.activeElement || document.activeElement === document.body || shareMenu.contains(document.activeElement)) el.share.focus();
  });
  shareMenu.addEventListener('keydown', (e) => {
    const list = [...shareMenu.querySelectorAll('[role="menuitem"]')];
    const i = list.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); list[(to + list.length) % list.length].focus(); }
    if (e.key === 'Tab') shareMenu.hidePopover?.();
  });
  shareMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    shareMenu.hidePopover?.();
    ({ photo: sharePhoto, all: () => shareAll(false), zip: () => shareAll(true), text: () => shareText(false), copy: () => shareText(true) })[b.dataset.share]();
  });
  function notReady() {
    if (shot?.translated) return false;
    toast(shot?.done ? 'There is no translation to share.' : 'Still translating…');
    return true;
  }
  /** e.g. pharmacy-please-ring-en-2026-11-23.jpg; `taken` keeps names apart (-2, -3). */
  function photoName(sh, taken = new Set(), ext = 'jpg') {
    const base = [slugWords(sh?.translated) || 'translated', state.target, today()].join('-');
    let name = `${base}.${ext}`;
    for (let k = 2; taken.has(name); k++) name = `${base}-${k}.${ext}`;
    taken.add(name);
    return name;
  }
  async function sharePhoto() {
    if (notReady()) return;
    const sh = shot;
    // usually made already, right after translating: then the share sheet opens straight from the tap
    const blob = sh.jpegBlob || await (sh.jpeg ||= translatedPhoto(sh));
    await sendFiles([new File([blob], photoName(sh), { type: 'image/jpeg' })], 'translated photo');
  }
  /** Wait until photo i is read and translated into the current language (or failed); false when stopped. */
  function settled(i, list, stop) {
    const pair = () => `${state.source}>${state.target}`;
    return new Promise((ok) => {
      const t0 = Date.now();
      const tick = () => {
        const sh = album[i]?.shot;
        if (album !== list || stop.cancelled) return ok(false);
        if (sh?.failed) return ok(true);
        if (sh?.done && (!sh.ocrText || sh.pair === pair() || sh.pair === null)) return ok(true);
        if (Date.now() - t0 > 180000) return ok(false);
        setTimeout(tick, 200);
      };
      tick();
    });
  }
  let sharingAll = null;
  async function shareAll(zip) {
    if (sharingAll) return;
    const stop = sharingAll = { cancelled: false };
    const list = album; const back = albumAt; const files = []; const taken = new Set();
    const progress = (i) => toast(`Reading photo ${i + 1} of ${list.length}…`, { action: 'Cancel', onAction: () => { stop.cancelled = true; } });
    try {
      for (let i = 0; i < list.length; i++) {
        if (album !== list || stop.cancelled) break;
        const sh = list[i].shot;
        if (!(sh?.done && (!sh.ocrText || sh.pair === `${state.source}>${state.target}`))) {
          progress(i);
          status(`Reading photo ${i + 1} of ${list.length}…`);
          await showPhoto(i);
          if (!(await settled(i, list, stop))) break;
        }
        const s2 = list[i].shot;
        if (s2?.translated) files.push(new File([s2.jpegBlob || await (s2.jpeg ||= translatedPhoto(s2))], photoName(s2, taken), { type: 'image/jpeg' }));
      }
      if (album !== list) return;
      if (albumAt !== back) await showPhoto(back);
      if (stop.cancelled) { status(''); toast('Stopped. Nothing was shared.'); return; }
      hideToast();
      if (!files.length) { toast('None of the photos has a translation to share.'); return; }
      if (files.length < list.length) toast(`${list.length - files.length} of the photos had no text to translate.`);
      // the .zip maker comes from the internet the first time; offline, the photos are saved one by one
      const zipSync = zip && await import('./doctranslate.js').then((m) => m.zipLib()).then((z) => z.zipSync).catch(() => null);
      if (zipSync) {
        const parts = {};
        for (const f of files) parts[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];   // JPEGs don't shrink
        const name = `translated-photos-${state.target}-${today()}.zip`;
        await sendFiles([new File([zipSync(parts)], name, { type: 'application/zip' })], `${files.length} translated photos (.zip)`);
        return;
      }
      await sendFiles(files, files.length > 1 ? 'translated photos' : 'translated photo', zip ? 'The .zip needs internet the first time, so ' : '');
    } catch (e) {
      toast(e.message || 'The photos could not be saved.');
    } finally { if (sharingAll === stop) sharingAll = null; }
  }
  async function shareText(copy) {
    if (notReady()) return;
    const text = shot.translated.trim();
    if (copy) { copyToClipboard(text, 'Translation copied'); return; }
    try { await navigator.share({ text }); } catch (e) { if (e.name !== 'AbortError') copyToClipboard(text, 'Sharing didn’t work, translation copied'); }
  }

  /* Zoom: pinch, Ctrl + wheel (or a trackpad pinch), double-tap, or + / − keys; drag to move. */
  const zoom = { s: 1, x: 0, y: 0 };
  let zoomedBox = null;   // the box tapped to zoom to it
  const pointers = new Map();
  function applyZoom() {
    const w = el.shot.offsetWidth; const h = el.shot.offsetHeight;   // size without the zoom
    zoom.s = Math.min(5, Math.max(1, zoom.s));
    // keep the photo covering where it was: no empty space at its edges
    zoom.x = Math.min(0, Math.max(w * (1 - zoom.s), zoom.x));
    zoom.y = Math.min(0, Math.max(h * (1 - zoom.s), zoom.y));
    if (zoom.s === 1) { zoom.x = 0; zoom.y = 0; }
    el.shot.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    el.wrap.classList.toggle('zoomed', zoom.s > 1);
  }
  function resetZoom() { zoomedBox = null; zoom.s = 1; zoom.x = 0; zoom.y = 0; el.shot.style.transform = ''; el.wrap.classList.remove('zoomed'); }
  /** Zoom to s, keeping the screen point (px, py) where it is. */
  function zoomAt(s, px, py) {
    const r = el.shot.getBoundingClientRect();
    const left = r.left - zoom.x; const top = r.top - zoom.y;
    const qx = (px - left - zoom.x) / zoom.s; const qy = (py - top - zoom.y) / zoom.s;
    const ns = Math.min(5, Math.max(1, s));
    zoom.x = px - left - ns * qx; zoom.y = py - top - ns * qy; zoom.s = ns;
    applyZoom();
  }
  el.wrap.addEventListener('wheel', (e) => {
    if (!shot || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomAt(zoom.s * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
  }, { passive: false });
  // Double taps are seen here (phones may not send dblclick). A tap on a box waits a moment: a second tap
  // makes it a double tap (zoom the photo), not two box taps.
  let boxTap = 0;
  let lastTap = null;
  let doubleAt = 0;
  el.wrap.addEventListener('dblclick', (e) => { if (shot && performance.now() - doubleAt > 500) zoomAt(zoom.s > 1 ? 1 : 2.5, e.clientX, e.clientY); });
  /** Tap a box: zoom in until its line fills the screen; tap it again to zoom back out. */
  function zoomToBox(box) {
    if (zoomedBox === box && zoom.s > 1) { resetZoom(); zoomedBox = null; return; }
    const r = box.getBoundingClientRect();
    const sr = el.shot.getBoundingClientRect();
    const wr = el.wrap.getBoundingClientRect();
    const cs = getComputedStyle(el.wrap);
    const top = wr.top + parseFloat(cs.paddingTop); const bottom = wr.bottom - parseFloat(cs.paddingBottom);
    const qx = (r.left + r.width / 2 - sr.left) / zoom.s; const qy = (r.top + r.height / 2 - sr.top) / zoom.s;
    const w = r.width / zoom.s; const h = r.height / zoom.s;
    const ns = Math.min(5, Math.max(1.5, Math.min((0.92 * wr.width) / w, (0.5 * (bottom - top)) / h)));
    const left = sr.left - zoom.x; const topL = sr.top - zoom.y;
    zoom.s = ns;
    zoom.x = wr.left + wr.width / 2 - left - ns * qx;
    zoom.y = (top + bottom) / 2 - topL - ns * qy;
    applyZoom();
    zoomedBox = box;
  }
  let tap = null;   // a press that may be a tap on a box
  el.wrap.addEventListener('pointerdown', (e) => {
    if (!shot || e.target.closest('button')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tap = pointers.size === 1 ? { box: e.target.closest('.ocr-box'), x: e.clientX, y: e.clientY } : null;
    el.wrap.setPointerCapture?.(e.pointerId);
  });
  el.wrap.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const pts = [...pointers.values()];
    if (pointers.size === 2) {
      const [a, b] = pts;
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d0 > 10) zoomAt(zoom.s * (d1 / d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (pointers.size === 1 && zoom.s > 1) {
      zoom.x += e.clientX - p.x; zoom.y += e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      applyZoom();
    } else { p.x = e.clientX; p.y = e.clientY; }
  });
  const lift = (e) => pointers.delete(e.pointerId);
  el.wrap.addEventListener('pointerup', (e) => {
    const t = tap; tap = null;
    lift(e);
    if (!t || !shot || Math.hypot(e.clientX - t.x, e.clientY - t.y) >= 10) return;
    const now = performance.now();
    if (lastTap && now - lastTap.at < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      clearTimeout(boxTap); boxTap = 0; lastTap = null; doubleAt = now;
      zoomAt(zoom.s > 1 ? 1 : 2.5, e.clientX, e.clientY);
      return;
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY };
    if (t.box) boxTap = setTimeout(() => { boxTap = 0; if (el.overlays.contains(t.box)) zoomToBox(t.box); }, 350);
  });
  el.wrap.addEventListener('pointercancel', lift);
  el.view.addEventListener('keydown', (e) => {
    if (!shot || e.target.closest('input, textarea, [role="menu"], dialog')) return;
    const r = el.shot.getBoundingClientRect();
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    if (e.key === '+' || e.key === '=') zoomAt(zoom.s * 1.25, cx, cy);
    else if (e.key === '-') zoomAt(zoom.s / 1.25, cx, cy);
    else if (e.key === '0') resetZoom();
    else return;
    e.preventDefault();
  });

  const union = (bs) => bs.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));

  function toCanvas(source, sw, sh) {
    const scale = Math.min(1, capture().side / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  el.shutter.addEventListener('click', async () => {
    const v = el.video;
    if (!v.videoWidth || el.shutter.disabled) return;
    clearAlbum();
    el.view.animate([{ filter: 'brightness(2)' }, { filter: 'none' }], { duration: 180 });
    el.shutter.disabled = true;
    const photo = await takePhoto(v);
    el.shutter.disabled = false;
    if (!visible) return;
    processCanvas(photo ? toCanvas(photo, photo.width, photo.height) : toCanvas(v, v.videoWidth, v.videoHeight));
  });

  /**
   * Accurate: a real photo from the camera (Image Capture, Chrome on Android), often several times sharper
   * than a frame of the preview. Only used when it's the same way up as the preview (some cameras hand it
   * over turned); otherwise, and in other browsers, null: the preview frame is used.
   */
  async function takePhoto(v) {
    const track = stream?.getVideoTracks()[0];
    if (ocrQuality() !== 'accurate' || typeof ImageCapture !== 'function' || !track) return null;
    try {
      const blob = await Promise.race([new ImageCapture(track).takePhoto(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]);
      const bmp = await createImageBitmap(blob);
      const sameWay = (bmp.width >= bmp.height) === (v.videoWidth >= v.videoHeight);
      if (sameWay && bmp.width * bmp.height > v.videoWidth * v.videoHeight) return bmp;
      bmp.close();
    } catch { /* no photo: the preview frame will do */ }
    return null;
  }

  const pickFile = () => el.file.click();
  el.importBtn.addEventListener('click', pickFile);
  el.import2.addEventListener('click', pickFile);
  /* Several photos (shared, imported, or the pages of a scanned PDF): a strip of thumbnails to switch
     between them. Each keeps its own result; one that wasn't finished is read again when it's shown. */
  function clearAlbum() {
    for (const a of album) if (a.thumb?.startsWith('blob:')) URL.revokeObjectURL(a.thumb);
    album = []; albumAt = 0;
    renderStrip();
  }
  function thumbOf(source) {
    if (source instanceof Blob) return URL.createObjectURL(source);
    const c = document.createElement('canvas');
    const k = 112 / Math.max(source.width, source.height);
    c.width = Math.max(1, Math.round(source.width * k)); c.height = Math.max(1, Math.round(source.height * k));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }
  function renderStrip() {
    const many = album.length > 1;
    el.strip.hidden = !many;
    el.stage.classList.toggle('has-strip', many);
    if (!many) { el.strip.replaceChildren(); return; }
    el.strip.innerHTML = album.map((a, i) => `<button type="button" class="shot-thumb" data-i="${i}" aria-label="Photo ${i + 1} of ${album.length}"${i === albumAt ? ' aria-current="true"' : ''}><img alt="" src="${a.thumb}"></button>`).join('');
    el.strip.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  async function showPhoto(i) {
    const a = album[i];
    if (!a) return false;
    albumAt = i;
    renderStrip();
    el.empty.hidden = true;
    if (a.shot?.done) {
      ++job;
      stopStream();
      shot = a.shot;
      el.img.src = shot.src;
      el.toggleOrig.setAttribute('aria-pressed', 'false');
      setMode(true);
      status('');
      requestAnimationFrame(fitShot);
      if (shot.lines.length) drawOverlays(!shot.translated);
      if (shot.ocrText && shot.pair !== `${state.source}>${state.target}`) translateShot(++job);
      return true;
    }
    a.shot = null;
    try {
      const src = a.source instanceof Blob ? await createImageBitmap(a.source) : a.source;
      if (albumAt !== i) return true;
      processCanvas(toCanvas(src, src.width, src.height));
      return true;
    } catch {
      toast(album.length > 1 ? `Photo ${i + 1} could not be opened as an image` : 'That file could not be opened as an image');
      return false;
    }
  }
  /** Imported or shared photos (Blobs) or drawn pages (canvases): read them like taken ones. Up to 10. */
  async function openImages(list) {
    clearAlbum();
    album = [...list].slice(0, 10).map((source) => ({ source, shot: null, thumb: '' }));
    if (album.length > 1) for (const a of album) a.thumb = thumbOf(a.source);
    const ok = await showPhoto(0);
    if (!ok) clearAlbum();
    return ok;
  }
  el.strip.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b && Number(b.dataset.i) !== albumAt) showPhoto(Number(b.dataset.i));
  });
  el.strip.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d || album.length < 2) return;
    e.preventDefault();
    const i = (albumAt + d + album.length) % album.length;
    showPhoto(i).then(() => el.strip.querySelector(`[data-i="${i}"]`)?.focus());
  });
  el.file.addEventListener('change', async () => {
    const files = [...(el.file.files || [])];
    el.file.value = '';
    if (files.length) openImages(files);
  });
  el.retry.addEventListener('click', startStream);
  // If the user unblocks the camera in site settings while the tab is open, start right away.
  onPermissionChange('camera', (st) => { if (st === 'granted' && visible && !shot && !stream) startStream(); });
  el.retake.addEventListener('click', () => { ++job; shot = null; clearAlbum(); setMode(false); startStream(); });
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
    openImages,
    openImage: (f) => openImages([f]),
    onShow() { visible = true; if (!shot) { setMode(false); gate(); } },
    onHide() { visible = false; stopStream(); },
  };
}
