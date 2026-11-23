// "Translate a file or website" (⋮ menu, home-screen shortcut, files opened with or shared to the app):
// IDEAS #9. Pick or drop a file, or paste a link; big ones ask first; progress with Stop; then download.
import { state, langName, describeError, errorText } from '../state.js';
import { settings } from '../store.js';
import { siteValue, loadSiteConfig } from '../siteconfig.js';
import { setupDialog, openDialog } from './sheet.js';
import { toast, copyToClipboard } from './snackbar.js';
import { icon } from './icons.js';
import { isPhone, canShareFile, sendFiles, today, slugWords } from './sendfile.js';
import { DEFAULT_PROXY, ASK_ABOVE, ACCEPT, FORMATS, extOf, outName, openDocument, translateTexts, sourceFor, fetchPage, openPage, workerCode } from '../features/doctranslate.js';

const $ = (id) => document.getElementById(id);
const nf = (n) => n.toLocaleString('en');

let el = null;
let dlg = null;
let run = 0;          // the job shown; an older one stops when it sees a newer number
let stopped = false;
let cleanup = () => {};

/** The proxy for websites: the one set in Settings, else this site's (change-me.txt web_proxy; "none" for
 * none), else the app's own. */
function siteProxy() {
  const v = siteValue('web_proxy');
  if (/^(none|off|false|no)$/i.test(v || '')) return '';
  return v || DEFAULT_PROXY;
}
const proxyFor = () => settings.get().webProxy || siteProxy();

export function initDocs() {
  el = {
    pair: $('docs-pair'), start: $('docs-start'), drop: $('docs-drop'), pick: $('docs-pick'), file: $('docs-file'),
    web: $('docs-web'), url: $('docs-url'), proxyNote: $('docs-proxy-note'), work: $('docs-work'), name: $('docs-name'),
    ask: $('docs-ask'), askText: $('docs-ask-text'), go: $('docs-go'), cancel: $('docs-cancel'),
    progress: $('docs-progress'), bar: $('docs-bar'), progressText: $('docs-progress-text'), stop: $('docs-stop'),
    done: $('docs-done'), doneText: $('docs-done-text'), actions: $('docs-actions'), views: $('docs-views'),
    tabPage: $('docs-tab-page'), tabLayout: $('docs-tab-layout'), pageview: $('docs-pageview'), layout: $('docs-layout'),
    frame: $('docs-frame'), again: $('docs-again'),
  };
  dlg = setupDialog($('docs-dialog'), { onClose: () => { run++; stopped = true; cleanup(); } });
  el.file.accept = ACCEPT;
  el.pick.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { const f = el.file.files?.[0]; el.file.value = ''; if (f) translateFile(f); });
  for (const t of ['dragenter', 'dragover']) el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) el.drop.addEventListener(t, () => el.drop.classList.remove('over'));
  el.drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) translateFile(f); });
  el.web.addEventListener('submit', (e) => {
    e.preventDefault();
    let u = el.url.value.trim();
    if (!u) { el.url.focus(); return; }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { u = new URL(u).href; } catch { toast('That isn’t a web address.'); return; }
    translateWebsite(u);
  });
  el.stop.addEventListener('click', () => { stopped = true; el.progressText.textContent = 'Stopping…'; });
  el.again.addEventListener('click', showStart);
  el.tabPage.addEventListener('click', () => showView('page'));
  el.tabLayout.addEventListener('click', () => showView('layout'));

  // Settings › Websites: the proxy, and the guide to make one
  const proxy = $('web-proxy');
  proxy.value = settings.get().webProxy || '';
  // this site's proxy (change-me.txt) is known once the site settings are read
  loadSiteConfig().catch(() => {}).then(() => {
    const p = siteProxy();
    if (!p) return;
    proxy.placeholder = p;
    $('web-proxy-note').textContent = 'Empty: the proxy shown greyed is used. {url} is replaced with the page’s link.';
    if (!el.start.hidden) proxyNote();
  });
  proxy.addEventListener('change', () => settings.set({ webProxy: proxy.value.trim() }));
  $('proxy-origin').textContent = location.origin;
  $('proxy-code').textContent = workerCode(location.origin);
  $('proxy-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(workerCode(location.origin)); toast('Code copied'); } catch { toast('Couldn’t copy. Select the code and copy it.'); }
  });
}

/** Open the sheet; with a file or a link, start translating it at once. */
export function openDocs({ file = null, url = '' } = {}) {
  openDialog(dlg);
  if (file) translateFile(file);
  else if (url) { el.url.value = url; translateWebsite(url); } else showStart();
}

function pairText() {
  const from = state.source === 'auto' ? 'the language it’s in' : langName(state.source);
  return `From ${from} to ${langName(state.target)}. Change the languages in the Text tab.`;
}

function showStart() {
  run++; cleanup(); cleanup = () => {};
  el.pair.textContent = pairText();
  el.start.hidden = false; el.work.hidden = true;
  proxyNote();
}

function proxyNote() {
  el.proxyNote.textContent = settings.get().webProxy
    ? 'Pages are fetched through your proxy (Settings › Websites).'
    : proxyFor() ? 'Pages are fetched through OpenTranslate’s proxy (Settings › Websites).'
    : 'Most websites need your own proxy first: Settings › Websites.';
}

function showWork(name) {
  el.pair.textContent = pairText();
  el.start.hidden = true; el.work.hidden = false;
  el.name.textContent = name;
  for (const x of [el.ask, el.progress, el.done, el.views, el.frame, el.again]) x.hidden = true;
  el.actions.replaceChildren();
  el.pageview.replaceChildren(); el.layout.replaceChildren();
  el.frame.removeAttribute('srcdoc');
}

function status(text, value = null) {
  el.progress.hidden = false;
  el.progressText.textContent = text;
  if (value == null) el.bar.removeAttribute('value'); else el.bar.value = value;
}

/** Big jobs: show the size and the service and wait for Translate. */
function confirmSize(chars) {
  if (chars <= ASK_ABOVE) return Promise.resolve(true);
  const service = state.provider?.entryLabel || state.provider?.name || 'your translation service';
  el.progress.hidden = true;
  el.ask.hidden = false;
  el.askText.textContent = `About ${nf(chars)} characters (around ${nf(Math.max(1, Math.round(chars / 2500)))} pages) will be translated with ${service}. Paid services charge for this, and it can take a while.`;
  el.go.focus();
  return new Promise((resolve) => {
    const done = (ok) => { el.go.onclick = el.cancel.onclick = null; el.ask.hidden = true; resolve(ok); };
    el.go.onclick = () => done(true);
    el.cancel.onclick = () => done(false);
  });
}

/** Translate the texts with progress and Stop; null when stopped or failed (and said so). */
async function translateAll(texts, id) {
  const chars = texts.reduce((a, t) => a + t.length, 0);
  if (!(await confirmSize(chars))) { if (id === run) showStart(); return null; }
  if (id !== run) return null;
  stopped = false;
  status('Translating…', 0);
  el.stop.hidden = false;
  try {
    const source = await sourceFor(texts);
    const out = await translateTexts(texts, {
      source, target: state.target, stopped: () => stopped || id !== run,
      onProgress: (d, t) => { if (id === run) status(`Translating… ${Math.round((100 * d) / Math.max(1, t))}%`, d / Math.max(1, t)); },
    });
    return { out, source };
  } catch (e) {
    if (id !== run) return null;
    el.progress.hidden = true;
    el.again.hidden = false;
    if (e.code === 'STOPPED') { el.done.hidden = false; el.doneText.textContent = 'Stopped. Nothing was saved.'; return null; }
    const { title, message } = describeError(e);
    el.done.hidden = false;
    el.doneText.textContent = `${title}: ${message}`;
    return null;
  }
}

function fail(id, e) {
  if (id !== run) return;
  el.progress.hidden = true;
  el.done.hidden = false;
  el.doneText.textContent = errorText(e, 'This couldn’t be opened.');
  el.again.hidden = false;
}

/** A download button, or Share on phones that can share this kind of file. `label` may be
 *  (share) => text, so the words say what will really happen. */
function offer(label, blob, name) {
  const share = canShareFile(name);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-filled';
  b.innerHTML = `${icon(share ? 'share' : 'download')}<span></span>`;
  b.querySelector('span').textContent = typeof label === 'function' ? label(share) : label;
  b.addEventListener('click', () => save(blob, name));
  el.actions.append(b);
  return b;
}
async function save(blob, name) {
  const data = blob instanceof Blob ? blob : await blob();
  if (!data.size) return;
  await sendFiles([new File([data], name, { type: data.type })], name);
}

/* ---------------- files ---------------- */

async function translateFile(file) {
  const id = ++run;
  cleanup(); cleanup = () => {};
  showWork(file.name);
  const ext = extOf(file.name);
  if (!(ext in FORMATS)) { fail(id, new Error(`“.${ext || '?'}” files can’t be translated here. ${el.start.querySelector('.docs-formats').textContent}.`)); return; }
  status('Opening…');
  el.stop.hidden = true;
  if (ext === 'pdf') { await translatePdf(file, id); return; }
  let doc;
  try { doc = await openDocument(file, state.target); } catch (e) { fail(id, e); return; }
  if (id !== run) return;
  if (!doc.texts.length) { fail(id, new Error('No text to translate was found in this file.')); return; }
  const r = await translateAll(doc.texts, id);
  if (!r || id !== run) return;
  status('Saving…');
  let blob;
  try { blob = await doc.build(r.out); } catch (e) { fail(id, e); return; }
  if (id !== run) return;
  el.progress.hidden = true;
  el.done.hidden = false; el.again.hidden = false;
  const name = outName(file.name, state.target);
  el.doneText.textContent = `Translated to ${langName(state.target)}: ${doc.label}, ${nf(doc.texts.length)} ${doc.texts.length === 1 ? 'piece' : 'pieces'} of text.`
    + (['docx', 'pptx', 'odt', 'odp'].includes(ext) ? ' Formatting inside a paragraph (e.g. one bold word) now covers the whole paragraph.' : '');
  offer((share) => `${share ? 'Share' : 'Download'} ${name}`, blob, name).focus();
}

/* ---------------- PDF: page view and original layout ---------------- */

async function translatePdf(file, id) {
  let pdf;
  try {
    const { openPdfDocument } = await import('../features/pdfdoc.js');
    pdf = await openPdfDocument(file, (t) => id === run && status(t));
  } catch (e) { fail(id, e); return; }
  if (id !== run) { pdf.close(); return; }
  cleanup = () => pdf.close();
  if (!pdf.texts.length) { fail(id, new Error('This PDF has no text, only pictures (a scan?). Open it with the camera’s Import to read it page by page.')); return; }
  const r = await translateAll(pdf.texts, id);
  if (!r || id !== run) return;
  const { pageViewHtml, translatedHtml, translatedText, imagesToPdf } = await import('../features/pdfdoc.js');
  el.progress.hidden = true;
  el.done.hidden = false; el.again.hidden = false;
  const empty = pdf.pages.filter((p) => !p.lines.length).length;
  el.doneText.textContent = `Translated to ${langName(state.target)}: ${pdf.pages.length === 1 ? '1 page' : `${nf(pdf.pages.length)} pages`}.`
    + (empty ? ` ${empty === 1 ? '1 page has' : `${empty} pages have`} no text (pictures or scans) and stay as they are.` : '');
  const base = file.name.replace(/\.pdf$/i, '');
  const title = `${base} (${langName(state.target)})`;
  el.pageview.innerHTML = pageViewHtml(pdf, r.out, { source: r.source, target: state.target });
  el.views.hidden = false;
  showView('page');
  offer('Web page (.html)', new Blob([translatedHtml(pdf, r.out, { title, target: state.target })], { type: 'text/html' }), `${base}.${state.target}.html`);
  offer('Text (.txt)', new Blob([translatedText(pdf, r.out)], { type: 'text/plain' }), `${base}.${state.target}.txt`);
  // original layout: pages drawn one after another when that view (or its PDF) is wanted
  const perPage = pdf.pages.map(() => []);
  pdf.where.forEach(([i], k) => perPage[i].push(r.out[k]));
  const jpegs = [];
  let drawing = null;
  const drawAll = () => (drawing ||= (async () => {
    for (let i = 0; i < pdf.pages.length; i++) {
      if (id !== run) return false;
      const fig = document.createElement('figure');
      fig.className = 'docs-layout-page';
      fig.innerHTML = `<div class="docs-layout-wait"><span class="spinner" aria-hidden="true"></span>Drawing page ${i + 1} of ${pdf.pages.length}…</div>`;
      el.layout.append(fig);
      const canvas = await pdf.drawPage(i, perPage[i], state.target);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
      jpegs[i] = { blob, w: canvas.width, h: canvas.height, wPt: pdf.pages[i].width, hPt: pdf.pages[i].height };
      const img = new Image();
      img.alt = `Page ${i + 1}, translated, as a picture`;
      img.src = URL.createObjectURL(blob);
      fig.replaceChildren(img);
    }
    return true;
  })());
  el.tabLayout.onclick = () => { showView('layout'); drawAll(); };
  const pdfBtn = offer('PDF in the original layout', async () => {
    pdfBtn.disabled = true;
    const label = pdfBtn.querySelector('span').textContent;
    pdfBtn.querySelector('span').textContent = 'Drawing pages…';
    try {
      if (!(await drawAll())) return new Blob([]);
      const pages = await Promise.all(jpegs.map(async (j) => ({ ...j, jpeg: new Uint8Array(await j.blob.arrayBuffer()) })));
      return imagesToPdf(pages);
    } finally { pdfBtn.disabled = false; pdfBtn.querySelector('span').textContent = label; }
  }, `${base}.${state.target}.pdf`);
  pdfBtn.classList.replace('btn-filled', 'btn-tonal');
  cleanup = () => { pdf.close(); el.layout.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src)); };
}

function showView(which) {
  const page = which === 'page';
  el.tabPage.setAttribute('aria-selected', String(page)); el.tabPage.setAttribute('aria-pressed', String(page));
  el.tabLayout.setAttribute('aria-selected', String(!page)); el.tabLayout.setAttribute('aria-pressed', String(!page));
  el.pageview.hidden = !page; el.layout.hidden = page;
}

/* ---------------- websites ---------------- */

async function translateWebsite(url) {
  const id = ++run;
  cleanup(); cleanup = () => {};
  showWork(url);
  el.stop.hidden = true;
  status('Loading the page…');
  let page;
  try {
    const { html, url: finalUrl } = await fetchPage(url, proxyFor());
    if (id !== run) return;
    page = openPage(html, finalUrl, state.target);
    page.url = finalUrl;
  } catch (e) { fail(id, e); return; }
  if (!page.texts.length) { fail(id, new Error('No text to translate was found on this page.')); return; }
  el.name.textContent = page.title() || url;
  const r = await translateAll(page.texts, id);
  if (!r || id !== run) return;
  const html = page.build(r.out);
  el.progress.hidden = true;
  el.done.hidden = false; el.again.hidden = false;
  el.doneText.textContent = `Translated to ${langName(state.target)}. Links open translated too. The site’s own scripts are off, so menus or videos may not work.`;
  el.frame.hidden = false;
  el.frame.onload = () => hookLinks(page.url);
  el.frame.srcdoc = html;
  const host = (() => { try { return new URL(page.url).hostname.replace(/^www\./, ''); } catch { return 'page'; } })();
  // like photos: the translated title's first words (else the site) + language + date
  const fileName = `${[slugWords(page.title()) || host.replace(/\./g, '-'), state.target, today()].join('-')}.html`;
  offer((share) => (share ? 'Share page (.html)' : 'Download (.html)'), new Blob([html], { type: 'text/html' }), fileName);
  // the translated text alone (IDEAS #5): Share text on phones, Copy text on computers
  const share = isPhone() && navigator.share;
  const tb = document.createElement('button');
  tb.type = 'button'; tb.className = 'btn btn-tonal';
  tb.innerHTML = `${icon(share ? 'share' : 'copy')}<span>${share ? 'Share text' : 'Copy text'}</span>`;
  tb.addEventListener('click', async () => {
    const text = pageText();
    if (!text) { toast('There is no text to share.'); return; }
    if (!share) { copyToClipboard(text, 'Translation copied'); return; }
    try { await navigator.share({ title: el.name.textContent, text }); } catch (e) { if (e.name !== 'AbortError') copyToClipboard(text, 'Sharing didn’t work, translation copied'); }
  });
  el.actions.append(tb);
  const orig = document.createElement('a');
  orig.className = 'btn btn-text'; orig.href = page.url; orig.target = '_blank'; orig.rel = 'noopener noreferrer';
  orig.textContent = 'Open the original ↗';
  el.actions.append(orig);
}

/** The translated page's text, as it reads on screen (blank lines between blocks). */
function pageText() {
  const body = el.frame.contentDocument?.body;
  if (!body) return '';
  return (body.innerText || body.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** In the translated page, a tapped link is translated too; links within the page just scroll. */
function hookLinks(pageUrl) {
  const d = el.frame.contentDocument;
  if (!d) return;
  d.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    let to;
    try { to = new URL(a.getAttribute('href'), pageUrl); } catch { return; }
    e.preventDefault();
    if (to.href.split('#')[0] === pageUrl.split('#')[0] && to.hash) { d.getElementById(decodeURIComponent(to.hash.slice(1)))?.scrollIntoView(); return; }
    if (!/^https?:$/.test(to.protocol)) return;
    el.url.value = to.href;
    translateWebsite(to.href);
  });
  d.addEventListener('submit', (e) => e.preventDefault());
}
