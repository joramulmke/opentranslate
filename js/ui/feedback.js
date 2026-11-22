// Menu → Feedback: a short step-by-step wizard (one question per screen) that ends in a pre-filled
// GitHub issue. Nothing is sent from here: the last step opens GitHub's "New issue" page in a new tab,
// where the person can still edit everything before submitting. Technical details (version, browser,
// services, language pair) are always added and shown before sending. Never the text being translated.
import { state, langName } from '../state.js';
import { setupDialog, openDialog } from './sheet.js';

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
let a = {};   // answers

const kind = () => KINDS.find((k) => k[0] === a.kind);
// Round 4 (bug details) only for bugs
const steps = () => ['what', 'area', 'kind', ...(a.kind === 'bug' ? ['bug'] : []), 'review'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const radios = (name, list, value) => list.map(([v, label, sub]) =>
  `<label class="radio-row"><input type="radio" name="${name}" value="${v}" ${v === value ? 'checked' : ''}>
    <span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`).join('');

let version = null;
async function readVersion() {
  if (version) return version;
  try {
    const v = await (await fetch('version.json')).json();
    version = v?.commit && v.commit !== 'dev' ? `${v.commit.slice(0, 7)}${v.date ? ` (${v.date.slice(0, 10)})` : ''}` : 'dev';
  } catch { version = 'unknown'; }
  return version;
}

function diagnostics() {
  const lang = (c) => (c === 'auto' ? 'Detect language' : `${langName(c)} (${c})`);
  const standalone = matchMedia('(display-mode: standalone)').matches;
  return [
    ['App version', version || 'unknown'],
    ['Browser', navigator.userAgent],
    ['Screen', `${innerWidth}×${innerHeight}, ${standalone ? 'installed app' : 'browser tab'}`],
    ['Mode', state.mode === 'advanced' ? 'Advanced (AI)' : 'Classic'],
    ['Service', state.provider?.name || `none (${state.providerError?.message || 'not set up'})`],
    ['Languages', `${lang(state.source)} → ${lang(state.target)}`],
    ['Online', navigator.onLine ? 'yes' : 'no'],
  ];
}

function title() {
  const first = a.what.trim().split('\n')[0].trim();
  const short = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  const prefix = { bug: 'Bug', idea: 'Idea', quality: 'Translation', other: 'Feedback' }[a.kind];
  return `${prefix}: ${short}`;
}

function body(what = a.what.trim()) {
  const area = AREAS.find((x) => x[0] === a.area)?.[1];
  const out = [`### What happened / idea\n${what}`, `### Part of the app\n${area}`, `### Kind\n${kind()[1]}`];
  if (a.kind === 'bug') {
    out.push(`### What I expected\n${a.expected?.trim() || '_not given_'}`);
    out.push(`### How often\n${REPEAT.find((r) => r[0] === a.repeat)?.[1] || '_not given_'}`);
  }
  out.push(`### Technical details\n${diagnostics().map(([k, v]) => `- **${k}:** ${v}`).join('\n')}`);
  out.push('_Sent from OpenTranslate › Menu › Feedback_');
  return out.join('\n\n');
}

function issueUrl() {
  const build = (text) => {
    const p = new URLSearchParams({ title: title(), body: body(text) });
    const label = kind()[3];
    if (label) p.set('labels', label);   // applied only if the sender may label; ignored otherwise
    return `${REPO}/issues/new?${p}`;
  };
  let text = a.what.trim();
  let url = build(text);
  while (url.length > MAX_URL && text.length > 200) {
    text = `${text.slice(0, Math.floor(text.length * 0.8))}…\n\n_(shortened, please paste the rest here)_`;
    url = build(text);
  }
  return url;
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
      <details class="fb-diag"><summary>Technical details (added to help fix problems)</summary>
        <dl class="fb-summary">${diagnostics().map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <p class="field-help">The text you translate is never included.</p></details>`;
  }
  // focus the question (screen readers read it), or the text box on the first step
  const field = box.querySelector('textarea, input:checked') || box.querySelector('input');
  (id === 'what' ? $('fb-what') : field && id !== 'review' ? field : $('fb-q'))?.focus();
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

export function initFeedback({ currentTab }) {
  dlg = setupDialog($('feedback-dialog'));
  getTab = currentTab;
  $('fb-next').addEventListener('click', () => go(1));
  $('fb-back').addEventListener('click', () => go(-1));
  $('fb-send').addEventListener('click', () => {
    window.open(issueUrl(), '_blank', 'noopener');
    a = {};   // sent: start fresh next time
    $('fb-step').innerHTML = `<h3 class="fb-q" id="fb-q" tabindex="-1">Thank you!</h3>
      <p class="field-help fb-note">GitHub opened in a new tab. Check your answers there and press
        “Create”. If nothing opened, your browser may have blocked the new tab.</p>`;
    $('fb-progress').textContent = 'Done';
    $('fb-bar').style.setProperty('--p', '100%');
    $('fb-back').hidden = $('fb-send').hidden = true;
    $('fb-q').focus();
  });
  // Enter on a choice = Next (in text boxes, Enter is a new line)
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type="radio"]')) { e.preventDefault(); go(1); }
  });
}

export function openFeedback() {
  readVersion();
  // an unfinished draft is kept until it's sent; the part of the app starts at the open tab
  if (!a.area) a.area = AREAS.some((x) => x[0] === getTab?.()) ? getTab() : 'text';
  step = 0;
  openDialog(dlg);
  render();
}
