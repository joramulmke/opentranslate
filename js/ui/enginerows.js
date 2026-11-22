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
import { HF_MODELS, modelState, modelProgress, modelBytes, downloadModel, deleteModel, onModelsChange, modelPage, WHISPER_SIZES, whisperKey, modelRunsHere } from '../features/models.js';
import { SPEECH_ENGINES } from '../features/stt.js';
import { canRecord } from '../features/stt.js';
import { browserSpeechAvailable, TTS_ENGINES, ttsApiEntry, elevenEntry } from '../features/speech.js';
import { piperVoices, voiceState, voiceProgress, voiceBytes, piperBytes, downloadedVoices, downloadVoice, deleteVoice, onVoicesChange, voiceLabel, voicePage, downloadSize, PIPER_SOURCE, ENGINE_MB,
  KOKORO_INFO, KOKORO_LANGS, kokoroState, kokoroProgress, kokoroSize, kokoroVoice, kokoroVoiceName, kokoroVoiceReady, downloadKokoro, downloadKokoroVoice, deleteKokoro } from '../features/piper.js';
import { HWR_ENGINES, hwrPref } from '../features/hwr.js';
import { ocrLanguages, ocrDownloaded, ocrDownload, ocrDelete, OCR_SOURCE, OCR_ENGINES, ocrPref } from '../features/ocr.js';
import { PADDLE, paddleState, paddleProgress, paddleBytes, downloadPaddle, deletePaddle, onPaddleChange } from '../features/paddle.js';
import { ORT_MB } from '../features/ort.js';
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

/** Which Whisper size to use: tiny, base, small, large-v3 turbo (with size, and which are downloaded). */
function whisperPicker() {
  const opts = WHISPER_SIZES.map((k) => {
    const m = HF_MODELS[k];
    const st = modelState(k) === 'ready' ? ' · downloaded' : '';
    const can = modelRunsHere(k);
    return `<option value="${k}" ${k === whisperKey() ? 'selected' : ''} ${can ? '' : 'disabled'}>${esc(`${m.title.replace('Whisper ', '')} · ${m.sizeMB} MB · ${can ? m.note : 'needs WebGPU with 16-bit support'}${st}`)}</option>`;
  }).join('');
  return `<label class="svc-model"><span>Model</span><select data-act="whisper-size" aria-describedby="eng-speech-ondevice-sub">${opts}</select></label>`;
}

function row({ group, value, title, sub, src, checked, disabled, actions = '', extra = '' }) {
  const id = `eng-${group}-${value}`;
  return `<li class="svc-row" data-engine="${group}:${value}">
    <label class="svc-pick"><input type="radio" name="eng-${group}" value="${value}" aria-describedby="${id}-sub${src ? ` ${id}-src` : ''}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="svc-copy"><strong>${esc(title)}</strong><small id="${id}-sub">${esc(sub)}</small></span></label>
    <span class="svc-actions">${actions}</span>
    ${extra}
    ${src ? sourceLine(`${id}-src`, src) : ''}</li>`;
}

const elevenSub = (e, what) => (e ? `${e.label} · ${what}` : 'Add ElevenLabs under Cloud voice services and press Test connection');
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
    row({ group: 'speech', value: 'ondevice', title: `On this device (${HF_MODELS[whisperKey()].title})`, checked: first === 'ondevice', disabled: !usable.ondevice,
      sub: modelSub(whisperKey(), ' · private'), src: modelSource(whisperKey()), actions: modelButton(whisperKey()), extra: whisperPicker() }),
  ].join('');
}

/* Read aloud: system voices, Piper voices on this device, the AI service, ElevenLabs */
const systemVoices = () => (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices?.() || [] : []);

function piperSub() {
  const n = downloadedVoices().length;
  if (kokoroState() === 'downloading') return `Downloading Kokoro… ${Math.round(kokoroProgress() * 100)}%`;
  if (kokoroState() === 'ready') return `Kokoro (${Object.keys(KOKORO_LANGS).length} languages)${n ? ` + ${n} Piper voice${n > 1 ? 's' : ''}` : ''} · ${formatMB(piperBytes() + kokoroSize())} · private, works without internet`;
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
  const usable = { vision: !!ai, ondevice: true, paddle: true, tesseract: true };
  const pref = hwrPref();
  const first = [pref, ...HWR_ENGINES].find((e) => usable[e]);
  return [
    row({ group: 'hwr', value: 'vision', title: 'AI vision', checked: first === 'vision', disabled: !usable.vision,
      sub: ai ? `${ai.label} reads the drawing · any script` : 'Needs an AI model that can read images: edit it under Advanced and press Test connection',
      src: ai ? `Not a download: the drawing goes to ${esc(hostOf(ai))}.` : '' }),
    row({ group: 'hwr', value: 'ondevice', title: 'On-device model (TrOCR)', checked: first === 'ondevice',
      sub: modelSub('trocr', ' · Latin script only'), src: modelSource('trocr'), actions: modelButton('trocr') }),
    row({ group: 'hwr', value: 'paddle', title: 'PP-OCRv6', checked: first === 'paddle',
      sub: `${paddleSub()} · neat handwriting and print · Latin script, Chinese, Japanese, Greek`, src: paddleSource(), actions: paddleButton() }),
    row({ group: 'hwr', value: 'tesseract', title: 'Basic (Tesseract)', checked: first === 'tesseract',
      sub: 'Neat printed letters · uses the camera text languages below' }),
  ].join('');
}

let ocrFiles = new Map();          // tesseract code -> bytes
const ocrJobs = new Map();         // tesseract code -> progress 0..1
const ocrSum = () => [...ocrFiles.values()].reduce((a, b) => a + b, 0);
const ocrSourceHtml = () => `Language files from ${extLink(OCR_SOURCE.page, 'jsDelivr (@tesseract.js-data)')}, trained by the Tesseract project · ${OCR_SOURCE.licence} licence · engine Tesseract.js from jsDelivr`;

/* PP-OCRv6: one download (two models), shared by Camera text and Handwriting */
function paddleSub() {
  const st = paddleState();
  if (st === 'downloading') return `Downloading… ${Math.round(paddleProgress() * 100)}%`;
  if (st === 'ready') return `Downloaded · ${formatMB(paddleBytes())} · runs on this device`;
  return `Not downloaded (${PADDLE.sizeMB} MB + ${ORT_MB} MB engine)`;
}
const paddleSource = () => `From ${extLink(PADDLE.page, 'Hugging Face: PaddlePaddle/PP-OCRv6_small')} (detection and recognition models) · ${PADDLE.licence} licence · engine ONNX Runtime from jsDelivr`;
function paddleButton() {
  const st = paddleState();
  if (st === 'downloading') return `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-disabled="true" aria-label="Downloading PP-OCRv6, ${Math.round(paddleProgress() * 100)}%">${icon('download')}</button>`;
  return st === 'ready'
    ? `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-label="Delete the PP-OCRv6 download (${formatMB(paddleBytes())})">${icon('delete')}</button>`
    : `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-label="Download PP-OCRv6 (${PADDLE.sizeMB + ORT_MB} MB) from Hugging Face">${icon('download')}</button>`;
}

function ocrRows() {
  const n = ocrFiles.size;
  const sub = n ? `${n} language${n > 1 ? 's' : ''} · ${formatMB(ocrSum())} · each downloaded the first time it's used` : 'No languages downloaded yet · each downloads the first time it’s used';
  const ai = aiEntries().find((e) => e.config?.vision === 'on') || null;
  const first = ocrPref() === 'vision' && !ai ? 'tesseract' : ocrPref();
  return `<li class="svc-row" data-engine="ocr:tesseract">
    <label class="svc-pick"><input type="radio" name="eng-ocr" value="tesseract" aria-describedby="eng-ocr-sub eng-ocr-src" ${first === 'tesseract' ? 'checked' : ''}>
      <span class="svc-copy"><strong>Tesseract</strong><small id="eng-ocr-sub">${esc(sub)}</small></span></label>
    <span class="svc-actions"><button class="icon-btn sm" type="button" data-act="ocr-manage" aria-label="Manage camera text languages" aria-describedby="eng-ocr-sub">${icon('download')}</button></span>
    ${sourceLine('eng-ocr-src', ocrSourceHtml())}</li>`
    + row({ group: 'ocr', value: 'paddle', title: 'PP-OCRv6', checked: first === 'paddle',
      sub: `${paddleSub()} · better on photos · Latin script, Chinese, Japanese, Greek (others use Tesseract)`, src: paddleSource(), actions: paddleButton() })
    + row({ group: 'ocr', value: 'vision', title: 'AI vision', checked: first === 'vision' && !!ai, disabled: !ai,
      sub: ai ? `${ai.label} reads the photo · any script, angled and curved text` : 'Needs an AI model that can read images: edit it under Advanced and press Test connection',
      src: ai ? `Not a download: each photo goes to ${esc(hostOf(ai))}. If it doesn't answer, the photo is read on this device.` : '' });
}

async function onPaddleButton() {
  const st = paddleState();
  if (st === 'downloading') return;
  if (st === 'ready') {
    const ok = await sheet({
      iconName: 'delete', title: 'Delete PP-OCRv6?',
      body: `This frees ${formatMB(paddleBytes())}. Camera text and handwriting use Tesseract until you download it again.`,
      allowLabel: 'Delete', cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await deletePaddle();
    settings.set({ paddleOk: null });
    toast('Deleted PP-OCRv6');
    return;
  }
  settings.set({ paddleOk: true });
  toast(`Downloading PP-OCRv6 (${PADDLE.sizeMB + ORT_MB} MB) from Hugging Face…`);
  downloadPaddle().then(() => toast('PP-OCRv6 is downloaded and works without internet.'), (e) => toast(`Download failed: ${e.message}`));
}

/* ------------------------------------------------------------ render */

export function renderEngines() {
  const had = document.activeElement?.closest?.('[data-engine]');
  const hadKey = had?.dataset.engine;
  const hadSel = document.activeElement?.matches?.('input') ? 'input' : document.activeElement?.dataset?.model ? '[data-model]' : document.activeElement?.dataset?.act ? `[data-act="${document.activeElement.dataset.act}"]` : null;
  $('svc-speech').innerHTML = speechRows();
  $('svc-tts').innerHTML = ttsRows();
  $('svc-hwr').innerHTML = hwrRows();
  $('svc-ocr').innerHTML = ocrRows();
  if (hadKey && hadSel && !document.activeElement?.closest?.('[data-engine]')) {
    const r = document.querySelector(`[data-engine="${hadKey}"]`);
    (r?.querySelector(`${hadSel}:not(:disabled)`) || r?.querySelector('input:not(:disabled)'))?.focus();
  }
}

/** Progress ticks only change the row's subtitle and the button's label, so focus stays put. */
function renderProgress() {
  const ps = $('eng-tts-ondevice-sub');
  if (ps) ps.textContent = piperSub();
  for (const [key, group] of [[whisperKey(), 'speech'], ['trocr', 'hwr']]) {
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
  $('voice-usage').textContent = n || kokoroSize() ? `${n} Piper voice${n === 1 ? '' : 's'}${kokoroSize() ? ' and Kokoro' : ''} · ${formatMB(piperBytes() + kokoroSize())} used on this device (voices and engine)` : 'Nothing downloaded yet.';
  renderKokoro();
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

/* Kokoro: one model for 7 languages, with a voice picker per language */
const langLabel = (l) => voiceLabel(l, langName);
function renderKokoro() {
  const st = kokoroState();
  const picked = settings.get().kokoroVoices || {};
  $('kokoro-sub').textContent = st === 'downloading' ? `Downloading… ${Math.round(kokoroProgress() * 100)}%`
    : st === 'ready' ? `Downloaded · ${formatMB(kokoroSize())} · used first for its languages`
      : `${KOKORO_INFO.sizeMB} MB${downloadedVoices().length ? '' : ` + ${ENGINE_MB} MB voice engine, once`} · ${Object.keys(KOKORO_LANGS).map(langLabel).join(', ')}`;
  const focused = document.activeElement?.id === 'kokoro-dl';
  $('kokoro-btn').innerHTML = st === 'downloading'
    ? `<button type="button" class="icon-btn lang-dl" id="kokoro-dl" aria-disabled="true" aria-label="Downloading Kokoro, ${Math.round(kokoroProgress() * 100)}%">${icon('download')}</button>`
    : st === 'ready'
      ? `<button type="button" class="icon-btn lang-dl" id="kokoro-dl" aria-label="Delete Kokoro (${formatMB(kokoroSize())})">${icon('delete')}</button>`
      : `<button type="button" class="icon-btn lang-dl" id="kokoro-dl" aria-label="Download Kokoro (${KOKORO_INFO.sizeMB} MB) from Hugging Face" aria-describedby="kokoro-sub">${icon('download')}</button>`;
  if (focused) $('kokoro-dl').focus();
  $('kokoro-src').innerHTML = `From ${extLink(KOKORO_INFO.page, 'Hugging Face: onnx-community/Kokoro-82M-v1.0-ONNX')} · Kokoro 82M by hexgrad, ${KOKORO_INFO.licence} licence · pronunciation from eSpeak NG, so some words can sound off · not for Japanese and Chinese`;
  // voice pickers only once Kokoro is here (choosing a voice may download it: 0.5 MB)
  const hadSel = document.activeElement?.dataset?.kokoroLang;
  $('kokoro-voices').hidden = st !== 'ready';
  $('kokoro-voices').innerHTML = st !== 'ready' ? '' : Object.entries(KOKORO_LANGS).map(([l, L]) => {
    const cur = kokoroVoice(l, picked);
    return `<li class="kokoro-voice"><label><span>${esc(langLabel(l))}</span>
      <select data-kokoro-lang="${l}">${L.voices.map((id) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(kokoroVoiceName(id))}${kokoroVoiceReady(id) ? '' : ' · 0.5 MB download'}</option>`).join('')}</select></label></li>`;
  }).join('');
  if (hadSel) document.querySelector(`[data-kokoro-lang="${hadSel}"]`)?.focus();
}

async function onKokoroButton() {
  const st = kokoroState();
  if (st === 'downloading') return;
  if (st === 'ready') {
    const ok = await sheet({
      iconName: 'delete', title: 'Delete Kokoro?',
      body: `This frees ${formatMB(kokoroSize())}. Read-aloud uses the Piper voices or the device's voices until you download it again.`,
      allowLabel: 'Delete', cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await deleteKokoro();
    toast('Deleted Kokoro');
    return;
  }
  try {
    await downloadKokoro({ picked: settings.get().kokoroVoices || {} });
    toast('Kokoro is downloaded and works without internet.');
  } catch (e) { toast(`Download failed: ${e.message || e}`); }
}

async function onKokoroVoice(sel) {
  const { kokoroLang: lang } = sel.dataset;
  settings.set({ kokoroVoices: { ...(settings.get().kokoroVoices || {}), [lang]: sel.value } });
  if (!kokoroVoiceReady(sel.value)) {
    try { await downloadKokoroVoice(sel.value); toast(`${kokoroVoiceName(sel.value)} is ready for ${langLabel(lang)}.`); } catch (e) { toast(`Download failed: ${e.message || e}`); }
  } else toast(`${kokoroVoiceName(sel.value)} reads ${langLabel(lang)} now.`);
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
      if (e.target.matches('[data-act="whisper-size"]')) {
        // another size: asked again before its download; the old one stays until deleted
        settings.set({ whisperModel: e.target.value, sttModelOk: modelState(e.target.value) === 'ready' ? true : null });
        renderEngines();
        document.querySelector('[data-act="whisper-size"]')?.focus();
        return;
      }
      if (!e.target.matches('input[type=radio]')) return;
      const [group, value] = e.target.closest('[data-engine]').dataset.engine.split(':');
      // choosing the on-device model again also resets an earlier "Not now" to its download question
      if (group === 'speech') settings.set({ speechEngine: value, ...(value === 'ondevice' ? { sttModelOk: null } : {}) });
      // choosing Piper again also forgets earlier "Not now" answers to its download question
      if (group === 'tts') settings.set({ ttsEngine: value, ...(value === 'ondevice' ? { ttsDeclined: [] } : {}) });
      if (group === 'ocr') settings.set({ ocrEngine: value, ...(value === 'paddle' ? { paddleOk: null } : {}) });
      if (group === 'hwr' && value === 'paddle') settings.set({ paddleOk: null });
      if (group === 'hwr') settings.set({ hwrEngine: value, ...(value === 'ondevice' ? { hwrModelOk: null } : {}) });
      renderEngines();
    });
    $(id).addEventListener('click', (e) => {
      const m = e.target.closest('[data-model]');
      if (m) { onModelButton(m.dataset.model); return; }
      if (e.target.closest('[data-act="ocr-manage"]')) openOcrManager({ onOpen: closeOthers });
      if (e.target.closest('[data-act="voice-manage"]')) openVoiceManager({ onOpen: closeOthers });
      if (e.target.closest('[data-act="paddle-dl"]')) onPaddleButton();
    });
  }
  $('ocr-list').addEventListener('click', (e) => { const b = e.target.closest('[data-ocr]'); if (b) onOcrButton(b.dataset.ocr); });
  $('ocr-search').addEventListener('input', () => renderOcrManager());
  $('voice-list').addEventListener('click', (e) => { const b = e.target.closest('[data-voice]'); if (b) onVoiceButton(b.dataset.voice); });
  $('kokoro-btn').addEventListener('click', () => onKokoroButton());
  $('kokoro-voices').addEventListener('change', (e) => { if (e.target.matches('[data-kokoro-lang]')) onKokoroVoice(e.target); });
  $('voice-search').addEventListener('input', () => renderVoiceManager());
  $('btn-voice-done').addEventListener('click', () => closeVoiceManager());
  $('voice-manager').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.id === 'voice-search' && e.target.value) { e.target.value = ''; renderVoiceManager(); } else closeVoiceManager();
  });
  onPaddleChange((what) => {
    if (!isOpen()) return;
    if (what !== 'progress') { renderEngines(); return; }
    // progress: only the subtitles and button labels change, so focus stays put
    if ($('eng-ocr-paddle-sub')) $('eng-ocr-paddle-sub').textContent = `${paddleSub()} · better on photos · Latin script, Chinese, Japanese, Greek (others use Tesseract)`;
    if ($('eng-hwr-paddle-sub')) $('eng-hwr-paddle-sub').textContent = `${paddleSub()} · neat handwriting and print · Latin script, Chinese, Japanese, Greek`;
    document.querySelectorAll('[data-act="paddle-dl"]').forEach((b) => b.setAttribute('aria-label', `Downloading PP-OCRv6, ${Math.round(paddleProgress() * 100)}%`));
  });
  onVoicesChange(() => {
    if (!isOpen()) return;
    renderVoiceManager();
    // while a voice downloads only the subtitle changes, so focus stays put
    if (kokoroState() === 'downloading' || piperVoices().some((v) => voiceState(v.lang) === 'downloading')) renderProgress(); else renderEngines();
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
