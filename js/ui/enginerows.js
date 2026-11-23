// Settings › Translation services: the Speech recognition, Read aloud, Handwriting and Camera text groups.
// Each engine is a row: the radio picks which one is tried first (the others follow in list order);
// downloadable models show their size, status and source, with Download / Delete.
import { settings } from '../store.js';
import { state, errorText } from '../state.js';
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
import { PADDLE, paddleState, paddleProgress, paddleBytes, downloadPaddle, deletePaddle, onPaddleChange, ocrQuality } from '../features/paddle.js';
import { ORT_MB } from '../features/ort.js';
import { langName } from '../state.js';
import { tagLine, infoButton, details, PRIVATE, sends, OFFLINE, ONLINE, NO_DOWNLOAD, READY, download, downloading, quality, UNAVAILABLE } from './tags.js';

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;

/** "From <link>" line under a row; links open in a new tab and say so. */
export const sourceLine = (id, html) => `<p class="svc-src" id="${id}">${html}</p>`;
export const extLink = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}<span class="visually-hidden"> (opens in a new tab)</span></a>`;

const aiEntries = () => settings.get().entries.filter((e) => e.type === 'openai');
const hostOf = (e) => { try { return new URL(e.config.baseUrl).host; } catch { return e.config?.baseUrl || 'your AI service'; } };

/* ------------------------------------------------------------ rows */

/** Size tag of a Hugging Face model: its download, progress, or Ready. */
function modelSize(key) {
  const st = modelState(key);
  return st === 'downloading' ? downloading(modelProgress(key)) : st === 'ready' ? READY : download(HF_MODELS[key].sizeMB);
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

const modelSource = (key) => details(
  `From ${extLink(modelPage(key), `Hugging Face: ${HF_MODELS[key].repo}`)}.`,
  `${HF_MODELS[key].licence} licence. Runs in your browser with transformers.js (from jsDelivr); nothing you say, write or photograph leaves this device.`,
  modelState(key) === 'ready' ? `Uses ${formatMB(modelBytes(key) || HF_MODELS[key].sizeMB * 1e6)} on this device. Delete it under Storage at the top of Settings or with the delete button.` : '');

/** Which Whisper size to use: tiny, base, small, large-v3 turbo (with size, and which are downloaded). */
function whisperPicker() {
  const opts = WHISPER_SIZES.map((k) => {
    const m = HF_MODELS[k];
    const st = modelState(k) === 'ready' ? ' · downloaded' : '';
    const can = modelRunsHere(k);
    return `<option value="${k}" ${k === whisperKey() ? 'selected' : ''} ${can ? '' : 'disabled'}>${esc(`${m.title.replace('Whisper ', '')} · ${m.sizeMB} MB · ${can ? m.note : 'needs WebGPU with 16-bit support'}${st}`)}</option>`;
  }).join('');
  return `<label class="svc-model"><span>Model<span class="visually-hidden"> size for speech recognition on this device</span></span><select data-act="whisper-size" aria-describedby="eng-speech-ondevice-sub">${opts}</select></label>`;
}

// tag lines are rebuilt on progress ticks (focus stays put): id -> () => tags
const tagFns = new Map();

function row({ group, value, title, tags, line = '', info = '', checked, disabled, actions = '', extra = '' }) {
  const id = `eng-${group}-${value}`;
  tagFns.set(`${id}-tags`, tags);
  return `<li class="svc-row" data-engine="${group}:${value}">
    <label class="svc-pick"><input type="radio" name="eng-${group}" value="${value}" aria-describedby="${id}-tags${line ? ` ${id}-sub` : ''}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="svc-copy"><strong>${esc(title)}</strong>${tagLine(`${id}-tags`, tags())}<small id="${id}-sub">${esc(line)}</small></span></label>
    <span class="svc-actions">${infoButton(id, title, info)}${actions}</span>
    ${extra}</li>`;
}

/** Progress: only the tag lines change. */
function refreshTags() {
  for (const [id, fn] of tagFns) {
    const el = $(id);
    if (el) el.outerHTML = tagLine(id, fn()) || `<span id="${id}"></span>`;
  }
}

const elevenLine = (e, what) => (e ? `${e.label} · ${what}` : 'Add ElevenLabs under Cloud voice services and press Test connection');
const elevenTags = (e) => () => (e ? [sends('api.elevenlabs.io'), ONLINE, NO_DOWNLOAD, quality('Best')] : [UNAVAILABLE]);
const elevenInfo = (e, what) => (e ? details(`Not a download: ${what} goes to ElevenLabs (api.elevenlabs.io) with your key, which stays in this browser.`, `Uses ${esc(e.label)}. Edit it under Cloud voice services.`) : '');
const WHISPER_QUALITY = { 'whisper-tiny': 'Fastest', whisper: 'Good', 'whisper-small': 'Good', 'whisper-turbo': 'Best' };

function speechRows() {
  const stt = aiEntries().find((e) => e.config?.sttModel && e.config?.audio === 'on');
  const eleven = elevenEntry('audio');
  const usable = { browser: browserSpeechAvailable(), api: !!stt && canRecord(), elevenlabs: !!eleven && canRecord(), ondevice: canRecord() };
  const pref = settings.get().speechEngine || 'browser';
  const first = [pref, ...SPEECH_ENGINES].find((e) => usable[e]);
  const wk = whisperKey();
  return [
    row({ group: 'speech', value: 'browser', title: 'Browser speech (Web Speech)', checked: first === 'browser', disabled: !usable.browser,
      tags: () => (usable.browser ? [sends('the browser maker'), ONLINE, NO_DOWNLOAD, quality('Fastest')] : [UNAVAILABLE]),
      line: usable.browser ? 'Live text while you speak' : 'Not available in this browser',
      info: details('Not a download: your voice goes to the browser maker’s speech service (Google for Chrome, Microsoft for Edge, Apple for Safari).', 'Shows the words live while you speak.') }),
    row({ group: 'speech', value: 'api', title: 'Cloud-AI (Whisper API)', checked: first === 'api', disabled: !usable.api,
      tags: () => (stt ? [sends(hostOf(stt)), ONLINE, NO_DOWNLOAD] : [UNAVAILABLE]),
      line: stt ? `${stt.label} · ${stt.config.sttModel}` : 'Edit an AI model under Advanced: fill in a speech-to-text model and press Test connection',
      info: stt ? details(`Not a download: your voice goes to ${esc(hostOf(stt))}.`, `Uses ${esc(stt.label)} with the model ${esc(stt.config.sttModel)}.`) : '' }),
    row({ group: 'speech', value: 'elevenlabs', title: 'Cloud-AI (ElevenLabs)', checked: first === 'elevenlabs', disabled: !usable.elevenlabs,
      tags: elevenTags(eleven), line: elevenLine(eleven, `Scribe (${eleven?.config?.sttModel || 'scribe_v1'})`), info: elevenInfo(eleven, 'your voice') }),
    row({ group: 'speech', value: 'ondevice', title: `On this device (${HF_MODELS[wk].title})`, checked: first === 'ondevice', disabled: !usable.ondevice,
      tags: () => [PRIVATE, OFFLINE, modelSize(whisperKey()), quality(WHISPER_QUALITY[whisperKey()])],
      line: HF_MODELS[wk].note ? HF_MODELS[wk].note.replace(/^./, (c) => c.toUpperCase()) : '',
      info: modelSource(wk), actions: modelButton(wk), extra: whisperPicker() }),
  ].join('');
}

/* Read aloud: system voices, Piper voices on this device, the AI service, ElevenLabs */
const systemVoices = () => (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices?.() || [] : []);

function piperSize() {
  if (kokoroState() === 'downloading') return downloading(kokoroProgress());
  const busy = piperVoices().find((v) => voiceState(v.lang) === 'downloading');
  if (busy) return downloading(voiceProgress(busy.lang));
  return downloadedVoices().length || kokoroState() === 'ready' ? READY : { kind: 'size', text: 'About 63 MB per language' };
}
function piperLine() {
  const n = downloadedVoices().length;
  const k = kokoroState() === 'ready';
  if (!n && !k) return `No voices yet · plus ${ENGINE_MB} MB voice engine, once`;
  return [k && `Kokoro (${Object.keys(KOKORO_LANGS).length} languages)`, n && `${n} Piper voice${n > 1 ? 's' : ''}`].filter(Boolean).join(' + ') + ` · ${formatMB(piperBytes() + (k ? kokoroSize() : 0))}`;
}
const piperSourceHtml = () => `Voices from ${extLink(PIPER_SOURCE.page, 'Hugging Face: rhasspy/piper-voices')}, each with its own licence (see its model card) · engine ${extLink(PIPER_SOURCE.engine, 'Piper')} with eSpeak NG (GPL-3.0) and ONNX Runtime, from jsDelivr`;
const piperInfo = () => details(
  `Piper: ${extLink(PIPER_SOURCE.page, 'voices from Hugging Face (rhasspy/piper-voices)')}, each with its own licence (see its model card).`,
  `Kokoro: ${extLink(KOKORO_INFO.page, 'one model from Hugging Face')} (${KOKORO_INFO.licence} licence) with more natural voices for ${Object.keys(KOKORO_LANGS).length} languages.`,
  `Engine: ${extLink(PIPER_SOURCE.engine, 'Piper')} with eSpeak NG (GPL-3.0) and ONNX Runtime, from jsDelivr. Everything runs in your browser; the text never leaves this device.`,
  'Pick and download voices with the download button.');

function ttsRows() {
  const api = ttsApiEntry();
  const eleven = elevenEntry('tts');
  const nSys = systemVoices().length;
  const usable = { system: typeof speechSynthesis !== 'undefined', ondevice: typeof caches !== 'undefined', api: !!api, elevenlabs: !!eleven };
  const pref = settings.get().ttsEngine || 'system';
  const first = [pref, ...TTS_ENGINES].find((e) => usable[e]);
  tagFns.set('eng-tts-ondevice-tags', () => [PRIVATE, OFFLINE, piperSize(), quality(kokoroState() === 'ready' ? 'Best' : 'Good')]);
  return [
    row({ group: 'tts', value: 'system', title: 'Built-in voices (system)', checked: first === 'system', disabled: !usable.system,
      tags: () => (usable.system ? [NO_DOWNLOAD] : [UNAVAILABLE]),
      line: !usable.system ? 'Not available in this browser' : `${nSys ? `${nSys} voices · ` : ''}quality depends on the device`,
      info: details('The voices that come with your device or browser. Most run on the device; some browser voices (for example Google’s in Chrome) send the text to the browser maker and need internet.') }),
    `<li class="svc-row" data-engine="tts:ondevice">
      <label class="svc-pick"><input type="radio" name="eng-tts" value="ondevice" aria-describedby="eng-tts-ondevice-tags eng-tts-ondevice-sub" ${first === 'ondevice' ? 'checked' : ''} ${usable.ondevice ? '' : 'disabled'}>
        <span class="svc-copy"><strong>Natural voices (Piper)</strong>${tagLine('eng-tts-ondevice-tags', tagFns.get('eng-tts-ondevice-tags')())}<small id="eng-tts-ondevice-sub">${esc(piperLine())}</small></span></label>
      <span class="svc-actions">${infoButton('eng-tts-ondevice', 'Natural voices (Piper)', piperInfo())}<button class="icon-btn sm" type="button" data-act="voice-manage" aria-label="Manage offline voices" aria-describedby="eng-tts-ondevice-sub">${icon('download')}</button></span></li>`,
    row({ group: 'tts', value: 'api', title: `Cloud-AI (${api?.config.ttsModel || 'AI model'})`, checked: first === 'api', disabled: !usable.api,
      tags: () => (api ? [sends(hostOf(api)), ONLINE, NO_DOWNLOAD] : [UNAVAILABLE]),
      line: api ? `${api.label} · voice ${api.config.ttsVoice || 'alloy'}` : 'Edit an AI model under Advanced: fill in a text-to-speech model and press Test connection',
      info: api ? details(`Not a download: the text goes to ${esc(hostOf(api))}.`, `Uses ${esc(api.label)} with the model ${esc(api.config.ttsModel)}.`) : '' }),
    row({ group: 'tts', value: 'elevenlabs', title: 'Cloud-AI (ElevenLabs)', checked: first === 'elevenlabs', disabled: !usable.elevenlabs,
      tags: elevenTags(eleven), line: elevenLine(eleven, eleven?.config?.ttsModel === 'eleven_multilingual_v2' ? 'Multilingual v2' : 'Flash v2.5'), info: elevenInfo(eleven, 'the text') }),
  ].join('');
}

const visionTags = (ai) => () => (ai ? [sends(hostOf(ai)), ONLINE, NO_DOWNLOAD, quality('Best')] : [UNAVAILABLE]);
const NEEDS_VISION = 'Needs an AI model that can read images: edit it under Advanced and press Test connection';

function hwrRows() {
  const ai = aiEntries().find((e) => e.config?.vision === 'on') || null;
  const usable = { vision: !!ai, ondevice: true, paddle: true, tesseract: true };
  const pref = hwrPref();
  const first = [pref, ...HWR_ENGINES].find((e) => usable[e]);
  return [
    row({ group: 'hwr', value: 'vision', title: 'Advanced (AI vision)', checked: first === 'vision', disabled: !usable.vision,
      tags: visionTags(ai), line: ai ? `${ai.label} · any script, cursive` : NEEDS_VISION,
      info: ai ? details(`Not a download: the drawing goes to ${esc(hostOf(ai))}.`, `Uses ${esc(ai.label)}. Also used in Advanced mode when another engine is picked.`) : '' }),
    row({ group: 'hwr', value: 'ondevice', title: 'On-device model (TrOCR)', checked: first === 'ondevice',
      tags: () => [PRIVATE, OFFLINE, modelSize('trocr'), quality('Good')], line: 'Handwriting · Latin script only',
      info: modelSource('trocr'), actions: modelButton('trocr') }),
    row({ group: 'hwr', value: 'paddle', title: 'Many languages (PP-OCRv6)', checked: first === 'paddle',
      tags: () => [PRIVATE, OFFLINE, paddleSize(), quality('Good')], line: 'Neat handwriting and print · Latin script, Chinese, Japanese, Greek',
      info: paddleInfo(), actions: paddleButton() }),
    row({ group: 'hwr', value: 'tesseract', title: 'Basic (Tesseract)', checked: first === 'tesseract',
      tags: () => [PRIVATE, OFFLINE, ocrSize(), quality('Fastest')], line: 'Neat printed letters · uses the camera text languages',
      info: ocrInfo() }),
  ].join('');
}

let ocrFiles = new Map();          // tesseract code -> bytes
const ocrJobs = new Map();         // tesseract code -> progress 0..1
const ocrSum = () => [...ocrFiles.values()].reduce((a, b) => a + b, 0);
const ocrSourceHtml = () => `Language files from ${extLink(OCR_SOURCE.page, 'jsDelivr (@tesseract.js-data)')}, trained by the Tesseract project · ${OCR_SOURCE.licence} licence · engine Tesseract.js from jsDelivr`;
const ocrSize = () => (ocrFiles.size ? READY : download('Small'));
const ocrInfo = () => details(
  `Language files from ${extLink(OCR_SOURCE.page, 'jsDelivr (@tesseract.js-data)')}, trained by the Tesseract project · ${OCR_SOURCE.licence} licence.`,
  'Engine Tesseract.js from jsDelivr. Runs in your browser; photos never leave this device.',
  ocrFiles.size ? `${ocrFiles.size} language${ocrFiles.size > 1 ? 's' : ''} downloaded (${formatMB(ocrSum())}).` : 'Each language is downloaded the first time it’s used, or ahead of time with the download button.');

/* PP-OCRv6: one download (two models), shared by Camera text and Handwriting */
function paddleSize() {
  const st = paddleState();
  return st === 'downloading' ? downloading(paddleProgress()) : st === 'ready' ? READY : download(PADDLE.sizeMB + ORT_MB);
}
const paddleInfo = () => details(
  `From ${extLink(PADDLE.page, 'Hugging Face: PaddlePaddle/PP-OCRv6_small')} (a detection and a recognition model) · ${PADDLE.licence} licence.`,
  `Engine ONNX Runtime from jsDelivr (${ORT_MB} MB, shared with the voices). Runs in your browser; images never leave this device.`,
  'Reads Latin script, Chinese, Japanese and Greek; other languages use Basic (Tesseract). Shared by Camera text and Handwriting.');
function paddleButton() {
  const st = paddleState();
  if (st === 'downloading') return `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-disabled="true" aria-label="Downloading PP-OCRv6, ${Math.round(paddleProgress() * 100)}%">${icon('download')}</button>`;
  return st === 'ready'
    ? `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-label="Delete the PP-OCRv6 download (${formatMB(paddleBytes())})">${icon('delete')}</button>`
    : `<button class="icon-btn sm" type="button" data-act="paddle-dl" aria-label="Download PP-OCRv6 (${PADDLE.sizeMB + ORT_MB} MB) from Hugging Face">${icon('download')}</button>`;
}

function ocrRows() {
  const n = ocrFiles.size;
  const ai = aiEntries().find((e) => e.config?.vision === 'on') || null;
  const first = ocrPref() === 'vision' && !ai ? 'tesseract' : ocrPref();
  return row({ group: 'ocr', value: 'tesseract', title: 'Basic (Tesseract)', checked: first === 'tesseract',
    tags: () => [PRIVATE, OFFLINE, ocrSize(), quality('Fastest')],
    line: n ? `${n} language${n > 1 ? 's' : ''} · ${formatMB(ocrSum())}` : 'Each language downloads the first time it’s used',
    info: ocrInfo(),
    actions: `<button class="icon-btn sm" type="button" data-act="ocr-manage" aria-label="Manage camera text languages" aria-describedby="eng-ocr-tesseract-sub">${icon('download')}</button>` })
    + row({ group: 'ocr', value: 'paddle', title: 'Many languages (PP-OCRv6)', checked: first === 'paddle',
      tags: () => [PRIVATE, OFFLINE, paddleSize(), quality('Good')], line: 'Better on photos · Latin script, Chinese, Japanese, Greek',
      info: paddleInfo(), actions: paddleButton(), extra: qualitySelect() })
    + row({ group: 'ocr', value: 'florence', title: 'On-device AI vision (Florence-2)', checked: first === 'florence',
      tags: () => [PRIVATE, OFFLINE, modelSize('florence'), quality('Good')], line: 'Signs, menus and labels · describes photos without text · Latin script · slower',
      info: modelSource('florence'), actions: modelButton('florence') })
    + row({ group: 'ocr', value: 'vision', title: 'Advanced (AI vision)', checked: first === 'vision' && !!ai, disabled: !ai,
      tags: visionTags(ai), line: ai ? `${ai.label} · any script, angled and curved text` : NEEDS_VISION,
      info: ai ? details(`Not a download: each photo goes to ${esc(hostOf(ai))}.`, "If it doesn't answer, the photo is read on this device instead.") : '' });
}

/** Camera text: Accurate (sharper photo, small print kept apart) or Fast (quicker on older phones). */
function qualitySelect() {
  const q = ocrQuality();
  const opt = (v, label) => `<option value="${v}" ${v === q ? 'selected' : ''}>${esc(label)}</option>`;
  return `<label class="svc-model"><span>Reading<span class="visually-hidden"> of camera text with PP-OCRv6</span></span><select data-act="ocr-quality" aria-describedby="eng-ocr-paddle-sub">${opt('accurate', 'Accurate · best for book pages, takes a few seconds longer')}${opt('fast', 'Fast · quicker, for signs and menus')}</select></label>`;
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
  downloadPaddle().then(() => toast('PP-OCRv6 is downloaded and works without internet.'), (e) => toast(`Download failed: ${errorText(e)}`));
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

/** Progress ticks only change the tags and the button's label, so focus stays put. */
function renderProgress() {
  refreshTags();
  for (const key of [whisperKey(), 'trocr', 'florence']) {
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
  downloadModel(key).then(() => toast(`${m.title} is downloaded and works without internet.`), (e) => toast(`Download failed: ${errorText(e)}`));
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
      toast(`Download failed: ${errorText(e)}`);
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
    return `<li class="kokoro-voice"><label><span><span class="visually-hidden">Kokoro voice for </span>${esc(langLabel(l))}</span>
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
  } catch (e) { toast(`Download failed: ${errorText(e)}`); }
}

async function onKokoroVoice(sel) {
  const { kokoroLang: lang } = sel.dataset;
  settings.set({ kokoroVoices: { ...(settings.get().kokoroVoices || {}), [lang]: sel.value } });
  if (!kokoroVoiceReady(sel.value)) {
    try { await downloadKokoroVoice(sel.value); toast(`${kokoroVoiceName(sel.value)} is ready for ${langLabel(lang)}.`); } catch (e) { toast(`Download failed: ${errorText(e)}`); }
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
    } catch (e) { toast(`Download failed: ${errorText(e)}`); }
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
      if (e.target.matches('[data-act="ocr-quality"]')) {
        settings.set({ ocrQuality: e.target.value });
        renderEngines();
        document.querySelector('[data-act="ocr-quality"]')?.focus();
        return;
      }
      if (!e.target.matches('input[type=radio]')) return;
      const [group, value] = e.target.closest('[data-engine]').dataset.engine.split(':');
      // choosing the on-device model again also resets an earlier "Not now" to its download question
      if (group === 'speech') settings.set({ speechEngine: value, ...(value === 'ondevice' ? { sttModelOk: null } : {}) });
      // choosing Piper again also forgets earlier "Not now" answers to its download question
      if (group === 'tts') settings.set({ ttsEngine: value, ...(value === 'ondevice' ? { ttsDeclined: [] } : {}) });
      if (group === 'ocr') settings.set({ ocrEngine: value, ...(value === 'paddle' ? { paddleOk: null } : {}), ...(value === 'florence' ? { visionModelOk: null } : {}) });
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
    refreshTags();
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
