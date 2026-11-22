// Menu → Feedback: a short step-by-step wizard (one question per screen) that ends in a pre-filled
// GitHub issue. Nothing is sent from here: the last step opens GitHub's "New issue" page in a new tab,
// where the person can still edit everything before submitting.
// - Technical details (js/ui/diagnostics.js) are always added and shown before sending.
// - A screenshot of the app as it was before the menu opened is drawn from the page (vendor/html-to-image,
//   no permission prompt). An issue link can't carry a file, so it goes to the clipboard to paste on GitHub;
//   the review step shows it with a switch to leave it out.
import { setupDialog, openDialog } from './sheet.js';
import { collectDiagnostics } from './diagnostics.js';

const REPO = 'https://github.com/joramulmke/opentranslate';
const MAX_URL = 7500;   // GitHub rejects very long "new issue" links
const $ = (id) => document.getElementById(id);

const AREAS = [
  ['text', 'Text'], ['camera', 'Camera'], ['conversation', 'Conversation'],
  ['handwriting', 'Handwriting'], ['settings', 'Settings & downloads'], ['other', 'Something else'],
];
const KINDS = [
  ['bug', 'Something doesn\'t work', 'A bug, an error or a crash', 'bug'],
  ['idea', 'An idea', 'A new feature or something that could be better', 'enhancement'],
  ['quality', 'Translation quality', 'A translation was wrong or odd', 'translation quality'],
  ['other', 'Something else', 'Praise, a question, anything', ''],
];
const REPEAT = [['always', 'Every time'], ['sometimes', 'Sometimes'], ['once', 'Only once so far']];

let dlg, getTab;
let step = 0;
let a = {};            // answers
let info = null;       // technical details, [{ title, rows }]
let shot = null;       // { blob, url } or { error }
let shotPending = false;

const kind = () => KINDS.find((k) => k[0] === a.kind);
// Round 4 (bug details) only for bugs
const steps = () => ['what', 'area', 'kind', ...(a.kind === 'bug' ? ['bug'] : []), 'review'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const radios = (name, list, value) => list.map(([v, label, sub]) =>
  `<label class="radio-row"><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}>
    <span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`).join('');
const mdEsc = (s) => String(s).replace(/\*\*/g, '');

/* ---------------------------------------------------------------- screenshot */
let lib = null;
function loadLib() {
  lib ??= new Promise((ok, fail) => {
    if (window.htmlToImage) return ok(window.htmlToImage);
    const s = document.createElement('script');
    s.src = 'vendor/html-to-image/html-to-image.js';
    s.onload = () => ok(window.htmlToImage);
    s.onerror = () => { lib = null; fail(new Error('screenshot library not loaded')); };
    document.head.append(s);
  });
  return lib;
}

// The visible part of the app, without dialogs (the menu, this sheet) and messages on top of it.
async function takeScreenshot() {
  const { toBlob } = await loadLib();
  // also leave out hidden views and empty media: an unloaded <img> or a camera <video> without a picture
  // would make the whole drawing fail
  const skip = (n) => {
    if (n.nodeType !== 1) return true;
    if (n.tagName === 'DIALOG' || n.id === 'snackbar' || n.id === 'boot-msg') return false;
    if (n.checkVisibility && !n.checkVisibility()) return false;
    if (n.tagName === 'VIDEO' && n.readyState < 2) return false;
    if (n.tagName === 'IMG' && !(n.complete && n.naturalWidth)) return false;
    return true;
  };
  const bg = getComputedStyle(document.body).backgroundColor;
  const blob = await toBlob(document.body, {
    filter: skip,
    imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    width: innerWidth, height: innerHeight,
    canvasWidth: innerWidth, canvasHeight: innerHeight,
    pixelRatio: Math.min(devicePixelRatio || 1, 2),
    backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#fff',
    style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
  });
  if (!blob) throw new Error('empty screenshot');
  return { blob, url: URL.createObjectURL(blob) };
}

/* ---------------------------------------------------------------- issue text */
function title() {
  const first = a.what.trim().split('\n')[0].trim();
  const short = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  const prefix = { bug: 'Bug', idea: 'Idea', quality: 'Translation', other: 'Feedback' }[a.kind];
  return `${prefix}: ${short}`;
}

function diagMarkdown(compact) {
  if (!info) return '_could not be collected_';
  return info.map(({ title: t, rows }) => {
    const list = rows
      .filter(([k]) => !(compact && k === 'User agent'))
      .map(([k, v]) => `- **${k}:** ${compact && String(v).length > 160 ? `${String(v).slice(0, 157)}…` : mdEsc(v)}`);
    return `**${t}**\n${list.join('\n')}`;
  }).join('\n\n');
}

function body(what, { compact = false, withShot = false } = {}) {
  const area = AREAS.find((x) => x[0] === a.area)?.[1];
  const out = [`### What happened / idea\n${what}`, `### Part of the app\n${area}`, `### Kind\n${kind()[1]}`];
  if (a.kind === 'bug') {
    out.push(`### What I expected\n${a.expected?.trim() || '_not given_'}`);
    out.push(`### How often\n${REPEAT.find((r) => r[0] === a.repeat)?.[1] || '_not given_'}`);
  }
  if (withShot) out.push('### Screenshot\n_The screenshot is on your clipboard: click here and paste it (Ctrl+V or ⌘V; on a phone, long-press › Paste)._\n');
  out.push(`### Technical details\n${diagMarkdown(compact)}`);
  out.push('_Sent from OpenTranslate › Menu › Feedback_');
  return out.join('\n\n');
}

function issueUrl(withShot) {
  const build = (text, compact) => {
    const p = new URLSearchParams({ title: title(), body: body(text, { compact, withShot }) });
    const label = kind()[3];
    if (label) p.set('labels', label);   // applied only if the sender may label; ignored otherwise
    return `${REPO}/issues/new?${p}`;
  };
  let text = a.what.trim();
  let compact = false;
  let url = build(text, compact);
  if (url.length > MAX_URL) { compact = true; url = build(text, compact); }
  while (url.length > MAX_URL && text.length > 200) {
    text = `${text.slice(0, Math.floor(text.length * 0.8))}…\n\n_(shortened, please paste the rest here)_`;
    url = build(text, compact);
  }
  return url;
}

/* ---------------------------------------------------------------- steps */
function shotHtml() {
  if (shot?.url) {
    return `<div class="fb-shot">
      <label class="switch-row"><span>Include screenshot<small>Of the screen before you opened the menu. It can show your text.</small></span>
        <input type="checkbox" id="fb-shot-on" role="switch" ${a.shotOn !== false ? 'checked' : ''}></label>
      <a href="${shot.url}" target="_blank" rel="noopener" class="fb-shot-img" ${a.shotOn === false ? 'hidden' : ''}>
        <img src="${shot.url}" alt="Screenshot of OpenTranslate before the menu was opened"></a></div>`;
  }
  if (shotPending) return '<p class="field-help fb-note" id="fb-shot-wait">Taking the screenshot…</p>';
  return `<p class="field-help fb-note">No screenshot: ${esc(shot?.error || 'not available')}.</p>`;
}

function diagHtml() {
  if (!info) return '<p class="field-help">Collecting…</p>';
  return info.map(({ title: t, rows }) => `<h4 class="fb-diag-head">${esc(t)}</h4>
    <dl class="fb-summary">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v).replace(/\*\*/g, ''))}</dd>`).join('')}</dl>`).join('');
}

function render() {
  const list = steps();
  const id = list[step];
  const n = list.length;
  $('fb-progress').textContent = `Step ${step + 1} of ${n}`;
  $('fb-bar').style.setProperty('--p', `${((step + 1) / n) * 100}%`);
  $('fb-back').hidden = step === 0;
  $('fb-next').hidden = id === 'review';
  $('fb-send').hidden = id !== 'review';
  $('fb-error').textContent = '';

  const box = $('fb-step');
  if (id === 'what') {
    box.innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">What happened, or what's your idea?</h3>
      <textarea id="fb-what" rows="6" aria-labelledby="fb-q" aria-describedby="fb-error"
        placeholder="Tell us in your own words. The first line becomes the title.">${esc(a.what || '')}</textarea>`;
  } else if (id === 'area') {
    box.innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">Which part of the app is it about?</h3>
      <div class="radio-list" role="radiogroup" aria-labelledby="fb-q">${radios('fb-area', AREAS, a.area)}</div>`;
  } else if (id === 'kind') {
    box.innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">What kind of feedback is it?</h3>
      <div class="radio-list" role="radiogroup" aria-labelledby="fb-q" aria-describedby="fb-error">${radios('fb-kind', KINDS, a.kind)}</div>`;
  } else if (id === 'bug') {
    box.innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">A bit more about the problem</h3>
      <label class="fb-label" for="fb-expected">What did you expect to happen instead?</label>
      <textarea id="fb-expected" rows="3" placeholder="Optional">${esc(a.expected || '')}</textarea>
      <p class="fb-label" id="fb-repeat-q">Does it happen every time?</p>
      <div class="radio-list" role="radiogroup" aria-labelledby="fb-repeat-q">${radios('fb-repeat', REPEAT, a.repeat)}</div>`;
  } else {
    box.innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">Check and send</h3>
      <p class="field-help fb-note">This opens a new issue on GitHub with your answers filled in. You can still change
        everything there before you submit it. You need a free GitHub account, and the issue is public.</p>
      <dl class="fb-summary">
        <dt>Title</dt><dd>${esc(title())}</dd>
        <dt>Part of the app</dt><dd>${esc(AREAS.find((x) => x[0] === a.area)[1])}</dd>
        <dt>Kind</dt><dd>${esc(kind()[1])}</dd>
        ${a.kind === 'bug' ? `<dt>Expected</dt><dd>${esc(a.expected?.trim() || '–')}</dd>
          <dt>How often</dt><dd>${esc(REPEAT.find((r) => r[0] === a.repeat)?.[1] || '–')}</dd>` : ''}
      </dl>
      <div id="fb-shot-box">${shotHtml()}</div>
      <details class="fb-diag"><summary>Technical details (always added, to help fix problems)</summary>
        <div id="fb-diag-box">${diagHtml()}</div>
        <p class="field-help">Never included: API keys, server addresses, or the text you translate.</p></details>`;
  }
  // focus the question (screen readers read it), or the text box on the first step
  const field = box.querySelector('textarea, input:checked') || box.querySelector('input');
  (id === 'what' ? $('fb-what') : field && id !== 'review' ? field : $('fb-q'))?.focus();
}

// async parts arrived: update the review step in place (keeps focus and the open details)
function refreshReview() {
  if (steps()[step] !== 'review' || !dlg.open) return;
  const s = $('fb-shot-box');
  if (s && !s.contains(document.activeElement)) s.innerHTML = shotHtml();
  const d = $('fb-diag-box');
  if (d) d.innerHTML = diagHtml();
}

function collect() {
  const id = steps()[step];
  const val = (name) => dlg.querySelector(`input[name="${name}"]:checked`)?.value;
  if (id === 'what') a.what = $('fb-what').value;
  if (id === 'area') a.area = val('fb-area') || a.area;
  if (id === 'kind') a.kind = val('fb-kind') || a.kind;
  if (id === 'bug') { a.expected = $('fb-expected').value; a.repeat = val('fb-repeat') || a.repeat; }
}

function validate() {
  const id = steps()[step];
  if (id === 'what' && !a.what?.trim()) return 'Please write a few words first.';
  if (id === 'kind' && !a.kind) return 'Please pick one.';
  return '';
}

function go(delta) {
  collect();
  if (delta > 0) {
    const err = validate();
    if (err) { $('fb-error').textContent = err; return; }
  }
  step = Math.max(0, Math.min(steps().length - 1, step + delta));
  render();
}

async function send() {
  const withShot = !!shot?.blob && a.shotOn !== false;
  let copied = false;
  if (withShot) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
      copied = true;
    } catch { /* Firefox/Safari may refuse: offer to save it instead */ }
  }
  const url = issueUrl(copied);
  window.open(url, '_blank', 'noopener');
  const saveName = `opentranslate-screenshot-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  $('fb-step').innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">Thank you!</h3>
    <p class="field-help fb-note">GitHub opened in a new tab. Check your answers there and press “Create”.
      If nothing opened, <a href="${esc(url)}" target="_blank" rel="noopener">open the issue here</a>.</p>
    ${copied ? '<p class="field-help fb-note"><strong>The screenshot is on your clipboard.</strong> Paste it into the issue where it says “Screenshot”.</p>' : ''}
    ${withShot && !copied ? `<p class="field-help fb-note">The screenshot couldn't be copied in this browser.
      <a href="${shot.url}" download="${saveName}">Save the screenshot</a> and drag it into the issue.</p>` : ''}`;
  $('fb-progress').textContent = 'Done';
  $('fb-bar').style.setProperty('--p', '100%');
  $('fb-back').hidden = $('fb-send').hidden = true;
  $('fb-q').focus();
  a = {};   // sent: start fresh next time
}

export function initFeedback({ currentTab }) {
  dlg = setupDialog($('feedback-dialog'));
  getTab = currentTab;
  $('fb-next').addEventListener('click', () => go(1));
  $('fb-back').addEventListener('click', () => go(-1));
  $('fb-send').addEventListener('click', send);
  dlg.addEventListener('change', (e) => {
    if (e.target.id !== 'fb-shot-on') return;
    a.shotOn = e.target.checked;
    dlg.querySelector('.fb-shot-img').hidden = !a.shotOn;
  });
  // Enter on a choice = Next (in text boxes, Enter is a new line)
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type="radio"]')) { e.preventDefault(); go(1); }
  });
}

export function openFeedback() {
  const fresh = !a.what;   // an unfinished draft keeps its answers and screenshot until it's sent
  if (fresh) {
    a = { area: AREAS.some((x) => x[0] === getTab?.()) ? getTab() : 'text' };
    if (shot?.url) URL.revokeObjectURL(shot.url);
    shot = null;
    shotPending = true;
    // the menu has closed and this sheet isn't drawn: the page looks as it did before the menu opened
    takeScreenshot()
      .then((s) => { shot = s; })
      .catch((e) => { shot = { error: 'it could not be taken in this browser' }; console.warn('[feedback] screenshot', e); })
      .finally(() => { shotPending = false; refreshReview(); });
  }
  info = null;
  collectDiagnostics()
    .then((d) => { info = d; }, (e) => { console.warn('[feedback] details', e); })
    .finally(refreshReview);
  step = 0;
  openDialog(dlg);
  render();
}
