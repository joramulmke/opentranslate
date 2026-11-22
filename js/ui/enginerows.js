// Settings › Translation services: the Speech recognition, Read aloud, Handwriting and Camera text groups.
// Each engine is a row: the radio picks which one is tried first (the others follow in list order);
// downloadable models show their size, status and source, with Download / Delete.
import { settings } from '../store.js';
import { state } from '../state.js';
import { escapeHtml } from './langpicker.js';
import { icon } from './icons.js';
import { toast } from './snackbar.js';
import { formatMB } from './offlineui.js';
import { sheet } from '../features/permissions.js';
import { HF_MODELS, modelState, modelProgress, modelBytes, downloadModel, deleteModel, onModelsChange, modelPage } from '../features/models.js';
import { SPEECH_ENGINES } from '../features/stt.js';
import { canRecord } from '../features/stt.js';
import { browserSpeechAvailable, TTS_ENGINES, ttsApiEntry, elevenEntry } from '../features/speech.js';
import { piperVoices, voiceState, voiceProgress, voiceBytes, piperBytes, downloadedVoices, downloadVoice, deleteVoice, onVoicesChange, voiceLabel, voicePage, downloadSize, PIPER_SOURCE, ENGINE_MB } from '../features/piper.js';
import { HWR_ENGINES, hwrPref } from '../features/hwr.js';
import { ocrLanguages, ocrDownloaded, ocrDownload, ocrDelete, OCR_SOURCE } from '../features/ocr.js';
import { langName } from '../state.js';

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;

/** "From <link>" line under a row; links open in a new tab and say so. */
export const sourceLine = (id, html) => `<p class="svc-src" id="${id}">${html}</p>`;
export const extLink = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}<span class="visually-hidden"> (opens in a new tab)</span></a>`;

const aiEntries = () => settings.get().entries.filter((e) => e.type === 'openai');
const hostOf = (e) => { try { return new URL(e.config.baseUrl).host; } catch { return e.config?.baseUrl || 'your AI service'; } };

/* ------------------------------------------------------------ rows */

function modelSub(key, extra = '') {
  const m = HF_MODELS[key];
  const st = modelState(key);
  if (st === 'downloading') return `Downloading… ${Math.round(modelProgress(key) * 100)}%`;
  if (st === 'ready') return `Downloaded · ${formatMB(modelBytes(key) || m.sizeMB * 1e6)} · runs on this device${extra}`;
  return `Not downloaded (${m.sizeMB} MB)${extra}`;
}

function modelButton(key) {
  const m = HF_MODELS[key];
  const st = modelState(key);
  if (st === 'downloading') {
    // transformers.js can't stop a download half-way, so there is nothing to press while it runs
    return `<button class="icon-btn sm" type="button" data-model="${key}" aria-disabled="true" aria-label="Downloading ${esc(m.title)}, ${Math.round(modelProgress(key) * 100)}%">${icon('download')}</button>`;
  }
  return st === 'ready'
    ? `<button class="icon-btn sm" type="button" data-model="${key}" aria-label="Delete the ${esc(m.title)} download (${formatMB(modelBytes(key) || m.sizeMB * 1e6)})">${icon('delete')}</button>`
    : `<button class="icon-btn sm" type="button" data-model="${key}" aria-label="Download ${esc(m.title)} (${m.sizeMB} MB) from Hugging Face">${icon('download')}</button>`;
}

const modelSource = (key) => `From ${extLink(modelPage(key), `Hugging Face: ${HF_MODELS[key].repo}`)} · ${HF_MODELS[key].licence} licence · runs with transformers.js from jsDelivr`;

function row({ group, value, title, sub, src, checked, disabled, actions = '' }) {
  const id = `eng-${group}-${value}`;
  return `<li class="svc-row" data-engine="${group}:${value}">
    <label class="svc-pick"><input type="radio" name="eng-${group}" value="${value}" aria-describedby="${id}-sub${src ? ` ${id}-src` : ''}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="svc-copy"><strong>${esc(title)}</strong><small id="${id}-sub">${esc(sub)}</small></span></label>
    <span class="svc-actions">${actions}</span>
    ${src ? sourceLine(`${id}-src`, src) : ''}</li>`;
}

const elevenSub = (e, what) => (e ? `${e.label} · ${what}` : 'Add ElevenLabs under Voice services and press Test connection');
const elevenSrc = (e) => (e ? 'Not a download: the text or your voice goes to api.elevenlabs.io.' : '');

function speechRows() {
  const stt = aiEntries().find((e) => e.config?.sttModel && e.config?.audio === 'on');
  const eleven = elevenEntry('audio');
  const usable = { browser: browserSpeechAvailable(), api: !!stt && canRecord(), elevenlabs: !!eleven && canRecord(), ondevice: canRecord() };
  const pref = settings.get().speechEngine || 'browser';
  const first = [pref, ...SPEECH_ENGINES].find((e) => usable[e]);
  return [
    row({ group: 'speech', value: 'browser', title: "Browser's speech service", checked: first === 'browser', disabled: !usable.browser,
      sub: usable.browser ? 'Live text while you speak · nothing to download' : 'Not available in this browser',
      src: 'Not a download: your voice goes to the browser maker’s service (Google for Chrome, Microsoft for Edge, Apple for Safari).' }),
    row({ group: 'speech', value: 'api', title: 'AI service (Whisper API)', checked: first === 'api', disabled: !usable.api,
      sub: stt ? `${stt.label} · ${stt.config.sttModel}` : 'Edit an AI model under Advanced: fill in a speech-to-text model and press Test connection',
      src: stt ? `Not a download: your voice goes to ${esc(hostOf(stt))}.` : '' }),
    row({ group: 'speech', value: 'elevenlabs', title: 'ElevenLabs (Scribe)', checked: first === 'elevenlabs', disabled: !usable.elevenlabs,
      sub: elevenSub(eleven, eleven?.config?.sttModel || 'scribe_v1'), src: elevenSrc(eleven) }),
    row({ group: 'speech', value: 'ondevice', title: 'On this device (Whisper)', checked: first === 'ondevice', disabled: !usable.ondevice,
      sub: modelSub('whisper', ' · private'), src: modelSource('whisper'), actions: modelButton('whisper') }),
  ].join('');
}

/* Read aloud: system voices, Piper voices on this device, the AI service, ElevenLabs */
const systemVoices = () => (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices?.() || [] : []);

function piperSub() {
  const n = downloadedVoices().length;
  const busy = piperVoices().find((v) => voiceState(v.lang) === 'downloading');
  if (busy) return `Downloading ${voiceLabel(busy.lang, langName)}… ${Math.round(voiceProgress(busy.lang) * 100)}%`;
  return n ? `${n} voice${n > 1 ? 's' : ''} · ${formatMB(piperBytes())} · private, works without internet`
    : `No voices yet · about 63 MB per language, plus ${ENGINE_MB} MB once`;
}
const piperSourceHtml = () => `Voices from ${extLink(PIPER_SOURCE.page, 'Hugging Face: rhasspy/piper-voices')}, each with its own licence (see its model card) · engine ${extLink(PIPER_SOURCE.engine, 'Piper')} with eSpeak NG (GPL-3.0) and ONNX Runtime, from jsDelivr`;

function ttsRows() {
  const api = ttsApiEntry();
  const eleven = elevenEntry('tts');
  const nSys = systemVoices().length;
  const usable = { system: typeof speechSynthesis !== 'undefined', ondevice: typeof caches !== 'undefined', api: !!api, elevenlabs: !!eleven };
  const pref = settings.get().ttsEngine || 'system';
  const first = [pref, ...TTS_ENGINES].find((e) => usable[e]);
  return [
    row({ group: 'tts', value: 'system', title: 'Voices of this device', checked: first === 'system', disabled: !usable.system,
      sub: !usable.system ? 'Not available in this browser' : nSys ? `${nSys} voices · nothing to download · quality depends on the device` : 'Nothing to download · quality depends on the device' }),
    `<li class="svc-row" data-engine="tts:ondevice">
      <label class="svc-pick"><input type="radio" name="eng-tts" value="ondevice" aria-describedby="eng-tts-ondevice-sub eng-tts-ondevice-src" ${first === 'ondevice' ? 'checked' : ''} ${usable.ondevice ? '' : 'disabled'}>
        <span class="svc-copy"><strong>Natural voices on this device (Piper)</strong><small id="eng-tts-ondevice-sub">${esc(piperSub())}</small></span></label>
      <span class="svc-actions"><button class="icon-btn sm" type="button" data-act="voice-manage" aria-label="Manage offline voices" aria-describedby="eng-tts-ondevice-sub">${icon('download')}</button></span>
      ${sourceLine('eng-tts-ondevice-src', piperSourceHtml())}</li>`,
    row({ group: 'tts', value: 'api', title: 'AI service', checked: first === 'api', disabled: !usable.api,
      sub: api ? `${api.label} · ${api.config.ttsModel} · ${api.config.ttsVoice || 'alloy'}` : 'Edit an AI model under Advanced: fill in a text-to-speech model and press Test connection',
      src: api ? `Not a download: the text goes to ${esc(hostOf(api))}.` : '' }),
    row({ group: 'tts', value: 'elevenlabs', title: 'ElevenLabs', checked: first === 'elevenlabs', disabled: !usable.elevenlabs,
      sub: elevenSub(eleven, eleven?.config?.ttsModel === 'eleven_multilingual_v2' ? 'Multilingual v2' : 'Flash v2.5'), src: elevenSrc(eleven) }),
  ].join('');
}

function hwrRows() {
  const ai = aiEntries().find((e) => e.config?.vision === 'on') || null;
  const usable = { vision: !!ai, ondevice: true, tesseract: true };
  const pref = hwrPref();
  const first = [pref, ...HWR_ENGINES].find((e) => usable[e]);
  return [
    row({ group: 'hwr', value: 'vision', title: 'AI vision', checked: first === 'vision', disabled: !usable.vision,
      sub: ai ? `${ai.label} reads the drawing · any script` : 'Needs an AI model that can read images: edit it under Advanced and press Test connection',
      src: ai ? `Not a download: the drawing goes to ${esc(hostOf(ai))}.` : '' }),
    row({ group: 'hwr', value: 'ondevice', title: 'On-device model (TrOCR)', checked: first === 'ondevice',
      sub: modelSub('trocr', ' · Latin script only'), src: modelSource('trocr'), actions: modelButton('trocr') }),
    row({ group: 'hwr', value: 'tesseract', title: 'Basic (Tesseract)', checked: first === 'tesseract',
      sub: 'Neat printed letters · uses the camera text languages below' }),
  ].join('');
}

let ocrFiles = new Map();          // tesseract code -> bytes
const ocrJobs = new Map();         // tesseract code -> progress 0..1
const ocrSum = () => [...ocrFiles.values()].reduce((a, b) => a + b, 0);
const ocrSourceHtml = () => `Language files from ${extLink(OCR_SOURCE.page, 'jsDelivr (@tesseract.js-data)')}, trained by the Tesseract project · ${OCR_SOURCE.licence} licence · engine Tesseract.js from jsDelivr`;

function ocrRow() {
  const n = ocrFiles.size;
  const sub = n ? `${n} language${n > 1 ? 's' : ''} · ${formatMB(ocrSum())} · each downloaded the first time it's used` : 'No languages downloaded yet · each downloads the first time it’s used';
  return `<li class="svc-row" data-engine="ocr:tesseract">
    <span class="svc-pick svc-pick-static"><span class="svc-copy"><strong>Tesseract</strong><small id="eng-ocr-sub">${esc(sub)}</small></span></span>
    <span class="svc-actions"><button class="icon-btn sm" type="button" data-act="ocr-manage" aria-label="Manage camera text languages" aria-describedby="eng-ocr-sub">${icon('download')}</button></span>
    ${sourceLine('eng-ocr-src', ocrSourceHtml())}</li>`;
}

/* ------------------------------------------------------------ render */

export function renderEngines() {
  const had = document.activeElement?.closest?.('[data-engine]');
  const hadKey = had?.dataset.engine;
  const hadSel = document.activeElement?.matches?.('input') ? 'input' : document.activeElement?.dataset?.model ? '[data-model]' : document.activeElement?.dataset?.act ? `[data-act="${document.activeElement.dataset.act}"]` : null;
  $('svc-speech').innerHTML = speechRows();
  $('svc-tts').innerHTML = ttsRows();
  $('svc-hwr').innerHTML = hwrRows();
  $('svc-ocr').innerHTML = ocrRow();
  if (hadKey && hadSel && !document.activeElement?.closest?.('[data-engine]')) {
    const r = document.querySelector(`[data-engine="${hadKey}"]`);
    (r?.querySelector(`${hadSel}:not(:disabled)`) || r?.querySelector('input:not(:disabled)'))?.focus();
  }
}

/** Progress ticks only change the row's subtitle and the button's label, so focus stays put. */
function renderProgress() {
  const ps = $('eng-tts-ondevice-sub');
  if (ps) ps.textContent = piperSub();
  for (const [key, group] of [['whisper', 'speech'], ['trocr', 'hwr']]) {
    const sub = $(`eng-${group}-ondevice-sub`);
    if (sub && modelState(key) === 'downloading') sub.textContent = modelSub(key);
    const b = document.querySelector(`[data-model="${key}"]`);
    if (b && modelState(key) === 'downloading') b.setAttribute('aria-label', `Downloading ${HF_MODELS[key].title}, ${Math.round(modelProgress(key) * 100)}%`);
  }
}

async function onModelButton(key) {
  const m = HF_MODELS[key];
  const st = modelState(key);
  if (st === 'downloading') return;
  if (st === 'ready') {
    const ok = await sheet({
      iconName: 'delete', title: `Delete ${m.title}?`,
      body: `This frees ${formatMB(modelBytes(key) || m.sizeMB * 1e6)}. The ${m.what} is downloaded again (after asking) the next time it's needed.`,
      allowLabel: 'Delete', cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await deleteModel(key);
    toast(`Deleted ${m.title}`);
    return;
  }
  toast(`Downloading ${m.title} (${m.sizeMB} MB) from Hugging Face…`);
  downloadModel(key).then(() => toast(`${m.title} is downloaded and works without internet.`), (e) => toast(`Download failed: ${e.message}`));
}

/* ------------------------------------------------------- OCR manager */

export function openOcrManager({ onOpen } = {}) {
  onOpen?.();
  $('ocr-search').value = '';
  $('ocr-manager').hidden = false;
  document.querySelectorAll('.svc-add').forEach((r) => { r.hidden = true; });
  $('ocr-source').innerHTML = ocrSourceHtml();
  renderOcrManager();
  ocrDownloaded().then((m) => { ocrFiles = m; renderOcrManager(); renderEngines(); }).catch(() => {});
  requestAnimationFrame(() => { $('ocr-manager').scrollIntoView({ block: 'start' }); $('ocr-search').focus(); });
}

export function closeOcrManager({ silent = false } = {}) {
  if ($('ocr-manager').hidden) return;
  $('ocr-manager').hidden = true;
  document.querySelectorAll('.svc-add').forEach((r) => { r.hidden = false; });
  renderEngines();
  if (!silent) document.querySelector('[data-act="ocr-manage"]')?.focus();
}

function ocrButton(code, name) {
  if (ocrJobs.has(code)) return `<button type="button" class="icon-btn lang-dl" data-ocr="${code}" aria-disabled="true" aria-label="Downloading ${esc(name)}, ${Math.round(ocrJobs.get(code) * 100)}%">${icon('download')}</button>`;
  return ocrFiles.has(code)
    ? `<button type="button" class="icon-btn lang-dl" data-ocr="${code}" aria-label="Delete ${esc(name)} (${formatMB(ocrFiles.get(code))})">${icon('delete')}</button>`
    : `<button type="button" class="icon-btn lang-dl" data-ocr="${code}" aria-label="Download ${esc(name)} for camera text">${icon('download')}</button>`;
}

function renderOcrManager() {
  const q = $('ocr-search').value.trim().toLowerCase();
  const n = ocrFiles.size;
  $('ocr-usage').textContent = n ? `${n} downloaded · ${formatMB(ocrSum())} used on this device` : 'Nothing downloaded yet.';
  const rank = (c) => (ocrFiles.has(c) ? 0 : ocrJobs.has(c) ? 1 : 2);
  const rows = ocrLanguages().map(({ code, iso }) => ({ code, name: langName(iso) }))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.startsWith(q))
    .sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name));
  const focused = document.activeElement?.closest?.('#ocr-list [data-ocr]')?.dataset.ocr;
  $('ocr-list').innerHTML = rows.length ? rows.map(({ code, name }) => {
    const sub = ocrJobs.has(code) ? `Downloading… ${Math.round(ocrJobs.get(code) * 100)}%` : ocrFiles.has(code) ? `Downloaded · ${formatMB(ocrFiles.get(code))}` : 'Not downloaded';
    return `<li class="offline-row"><span class="offline-copy"><span>${esc(name)}</span><small>${sub}</small></span>${ocrButton(code, name)}</li>`;
  }).join('') : '<li class="svc-empty">No languages match.</li>';
  if (focused) $('ocr-list').querySelector(`[data-ocr="${focused}"]`)?.focus();
}

async function onOcrButton(code) {
  if (ocrJobs.has(code)) return;
  const iso = ocrLanguages().find((l) => l.code === code)?.iso;
  const name = langName(iso);
  if (ocrFiles.has(code)) {
    const ok = await sheet({
      iconName: 'delete', title: `Delete ${name}?`,
      body: `This frees ${formatMB(ocrFiles.get(code))}. It's downloaded again the next time camera text needs ${name}.`,
      allowLabel: 'Delete', cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await ocrDelete(code);
    ocrFiles.delete(code);
    toast(`Deleted ${name}`);
  } else {
    ocrJobs.set(code, 0);
    renderOcrManager();
    try {
      await ocrDownload(code, (p) => { ocrJobs.set(code, p); renderOcrManager(); });
      ocrFiles = await ocrDownloaded();
      toast(`${name} is downloaded for camera text`);
    } catch (e) {
      toast(`Download failed: ${e.message || e}`);
    } finally { ocrJobs.delete(code); }
  }
  if (!$('ocr-manager').hidden) renderOcrManager();
  renderEngines();
}

/* ----------------------------------------------------- offline voices */

export function openVoiceManager({ onOpen } = {}) {
  onOpen?.();
  $('voice-search').value = '';
  $('svc-tts').after($('voice-manager'));   // right under the Read aloud group it belongs to
  $('voice-manager').hidden = false;
  document.querySelectorAll('.svc-add').forEach((r) => { r.hidden = true; });
  $('voice-source').innerHTML = piperSourceHtml();
  renderVoiceManager();
  requestAnimationFrame(() => { $('voice-manager').scrollIntoView({ block: 'start' }); $('voice-search').focus(); });
}

export function closeVoiceManager({ silent = false } = {}) {
  if ($('voice-manager').hidden) return;
  $('voice-manager').hidden = true;
  document.querySelectorAll('.svc-add').forEach((r) => { r.hidden = false; });
  renderEngines();
  if (!silent) document.querySelector('[data-act="voice-manage"]')?.focus();
}

function voiceButton(v, name) {
  const st = voiceState(v.lang);
  if (st === 'downloading') return `<button type="button" class="icon-btn lang-dl" data-voice="${v.lang}" aria-disabled="true" aria-label="Downloading the ${esc(name)} voice, ${Math.round(voiceProgress(v.lang) * 100)}%">${icon('download')}</button>`;
  return st === 'ready'
    ? `<button type="button" class="icon-btn lang-dl" data-voice="${v.lang}" aria-label="Delete the ${esc(name)} voice (${formatMB(voiceBytes(v.lang))})">${icon('delete')}</button>`
    : `<button type="button" class="icon-btn lang-dl" data-voice="${v.lang}" aria-label="Download the ${esc(name)} voice (${esc(downloadSize(v))}) from Hugging Face">${icon('download')}</button>`;
}

function renderVoiceManager() {
  if ($('voice-manager').hidden) return;
  const q = $('voice-search').value.trim().toLowerCase();
  const n = downloadedVoices().length;
  $('voice-usage').textContent = n ? `${n} downloaded · ${formatMB(piperBytes())} used on this device (voices and engine)` : 'Nothing downloaded yet.';
  const rank = (l) => ({ ready: 0, downloading: 1, none: 2 }[voiceState(l)]);
  const rows = piperVoices().map((v) => ({ v, name: voiceLabel(v.lang, langName) }))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.v.lang.toLowerCase().startsWith(q))
    .sort((a, b) => rank(a.v.lang) - rank(b.v.lang) || a.name.localeCompare(b.name));
  const focused = document.activeElement?.closest?.('#voice-list [data-voice]')?.dataset.voice;
  $('voice-list').innerHTML = rows.length ? rows.map(({ v, name }) => {
    const st = voiceState(v.lang);
    const sub = st === 'downloading' ? `Downloading… ${Math.round(voiceProgress(v.lang) * 100)}%`
      : st === 'ready' ? `Downloaded · ${formatMB(voiceBytes(v.lang))} · voice “${esc(v.name)}”` : `${esc(downloadSize(v))} · voice “${esc(v.name)}”`;
    return `<li class="offline-row"><span class="offline-copy"><span>${esc(name)}</span><small>${sub} · ${extLink(voicePage(v), 'model card')}</small></span>${voiceButton(v, name)}</li>`;
  }).join('') : '<li class="svc-empty">No languages match.</li>';
  if (focused) $('voice-list').querySelector(`[data-voice="${focused}"]`)?.focus();
}

async function onVoiceButton(lang) {
  const v = piperVoices().find((x) => x.lang === lang);
  const name = voiceLabel(lang, langName);
  const st = voiceState(lang);
  if (!v || st === 'downloading') return;
  if (st === 'ready') {
    const last = downloadedVoices().length === 1;
    const ok = await sheet({
      iconName: 'delete', title: `Delete the ${name} voice?`,
      body: `This frees ${formatMB(voiceBytes(lang))}${last ? ` (and ${ENGINE_MB} MB for the voice engine, as it's the last voice)` : ''}. You can download it again at any time.`,
      allowLabel: 'Delete', cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await deleteVoice(lang);
    toast(`Deleted the ${name} voice`);
  } else {
    // downloading by hand is a yes to "Download a voice?" for that language
    settings.set({ ttsDeclined: (settings.get().ttsDeclined || []).filter((l) => l !== lang) });
    try {
      await downloadVoice(lang);
      toast(`The ${name} voice is downloaded and works without internet.`);
    } catch (e) { toast(`Download failed: ${e.message || e}`); }
  }
}

/* ------------------------------------------------------------- wiring */

export function initEngineRows({ isOpen, closeOthers }) {
  for (const id of ['svc-speech', 'svc-tts', 'svc-hwr', 'svc-ocr']) {
    $(id).addEventListener('change', (e) => {
      if (!e.target.matches('input[type=radio]')) return;
      const [group, value] = e.target.closest('[data-engine]').dataset.engine.split(':');
      // choosing the on-device model again also resets an earlier "Not now" to its download question
      if (group === 'speech') settings.set({ speechEngine: value, ...(value === 'ondevice' ? { sttModelOk: null } : {}) });
      // choosing Piper again also forgets earlier "Not now" answers to its download question
      if (group === 'tts') settings.set({ ttsEngine: value, ...(value === 'ondevice' ? { ttsDeclined: [] } : {}) });
      if (group === 'hwr') settings.set({ hwrEngine: value, ...(value === 'ondevice' ? { hwrModelOk: null } : {}) });
      renderEngines();
    });
    $(id).addEventListener('click', (e) => {
      const m = e.target.closest('[data-model]');
      if (m) { onModelButton(m.dataset.model); return; }
      if (e.target.closest('[data-act="ocr-manage"]')) openOcrManager({ onOpen: closeOthers });
      if (e.target.closest('[data-act="voice-manage"]')) openVoiceManager({ onOpen: closeOthers });
    });
  }
  $('ocr-list').addEventListener('click', (e) => { const b = e.target.closest('[data-ocr]'); if (b) onOcrButton(b.dataset.ocr); });
  $('ocr-search').addEventListener('input', () => renderOcrManager());
  $('voice-list').addEventListener('click', (e) => { const b = e.target.closest('[data-voice]'); if (b) onVoiceButton(b.dataset.voice); });
  $('voice-search').addEventListener('input', () => renderVoiceManager());
  $('btn-voice-done').addEventListener('click', () => closeVoiceManager());
  $('voice-manager').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.id === 'voice-search' && e.target.value) { e.target.value = ''; renderVoiceManager(); } else closeVoiceManager();
  });
  onVoicesChange(() => {
    if (!isOpen()) return;
    renderVoiceManager();
    // while a voice downloads only the subtitle changes, so focus stays put
    if (piperVoices().some((v) => voiceState(v.lang) === 'downloading')) renderProgress(); else renderEngines();
  });
  $('btn-ocr-done').addEventListener('click', () => closeOcrManager());
  $('ocr-manager').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.id === 'ocr-search' && e.target.value) { e.target.value = ''; renderOcrManager(); } else closeOcrManager();
  });
  onModelsChange((what) => { if (!isOpen()) return; if (what === 'progress') renderProgress(); else renderEngines(); });
  ocrDownloaded().then((m) => { ocrFiles = m; if (isOpen()) renderEngines(); }).catch(() => {});
}
