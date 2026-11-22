// Technical details for Menu › Feedback: system, translation services, engines used first, downloads.
// Only names and settings: never API keys, server addresses, or the text being translated.
import { state, kindOf, langName } from '../state.js';
import { settings, entryLabel } from '../store.js';
import { installedLanguages } from '../features/offline.js';
import { ocrDownloaded } from '../features/ocr.js';
import { HF_MODELS, modelState, refreshModels, whisperKey } from '../features/models.js';
import { downloadedVoices, refreshVoices, kokoroState } from '../features/piper.js';
import { paddleState, refreshPaddle } from '../features/paddle.js';
import { downloadedLlms, llmTitle, nanoAvailability } from '../features/localllm.js';
import { engineLabel as HWR_LABEL } from '../features/hwr.js';

const within = (ms, p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((ok) => setTimeout(ok, ms))]);

/* ------------------------------------------------------------ OS and browser */
function fromUA(ua) {
  let os = 'Unknown';
  let m;
  const ipadDesktop = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;   // iPadOS asks for desktop pages
  if ((m = ua.match(/Android ([\d.]+)/))) os = `Android ${m[1]}`;
  else if ((m = ua.match(/(iPhone|iPad|iPod).*? OS ([\d_]+)/))) os = `${m[1] === 'iPad' ? 'iPadOS' : 'iOS'} ${m[2].replace(/_/g, '.')}`;
  else if (ipadDesktop) os = 'iPadOS';
  else if ((m = ua.match(/Mac OS X ([\d_.]+)/))) os = `macOS ${m[1].replace(/_/g, '.')}`;
  else if ((m = ua.match(/Windows NT ([\d.]+)/))) os = { '10.0': 'Windows 10 or 11', '6.3': 'Windows 8.1', '6.1': 'Windows 7' }[m[1]] || `Windows NT ${m[1]}`;
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  const B = [[/EdgA?\/([\d.]+)/, 'Edge'], [/EdgiOS\/([\d.]+)/, 'Edge'], [/OPR\/([\d.]+)/, 'Opera'],
    [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'], [/Vivaldi\/([\d.]+)/, 'Vivaldi'], [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/Firefox\/([\d.]+)/, 'Firefox'], [/CriOS\/([\d.]+)/, 'Chrome'], [/Chrome\/([\d.]+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari']];
  let browser = 'Unknown';
  for (const [re, name] of B) if ((m = ua.match(re))) { browser = `${name} ${m[1]}`; break; }
  return { os, browser };
}

async function system() {
  const ua = navigator.userAgent;
  let { os, browser } = fromUA(ua);
  // Chromium browsers hide the real versions in the user agent; ask for them
  const d = navigator.userAgentData;
  if (d?.getHighEntropyValues) {
    const h = await within(800, d.getHighEntropyValues(['platformVersion', 'fullVersionList', 'model']));
    if (h) {
      const v = h.platformVersion || '';
      const major = parseInt(v, 10);
      if (h.platform === 'Windows' || d.platform === 'Windows') os = major >= 13 ? `Windows 11 (${v})` : major > 0 ? `Windows 10 (${v})` : 'Windows';
      else if (d.platform === 'macOS' && v) os = `macOS ${v}`;
      else if (d.platform === 'Android' && v) os = `Android ${v}`;
      else if (d.platform && v) os = `${d.platform} ${v}`;
      if (h.model) os += `, ${h.model}`;
      const brands = (h.fullVersionList || []).filter((b) => !/Not.?A.?Brand/i.test(b.brand));
      const best = brands.find((b) => b.brand !== 'Chromium') || brands[0];
      if (best) browser = `${best.brand.replace('Google ', '').replace('Microsoft ', '')} ${best.version}`;
    }
  }
  if (navigator.brave) browser = browser.replace(/^(Chrome|Unknown)/, 'Brave (Chromium)');
  const standalone = matchMedia('(display-mode: standalone)').matches;
  return [
    ['OS', os],
    ['Browser', browser],
    ['Screen', `${innerWidth}×${innerHeight} (×${devicePixelRatio}), ${standalone ? 'installed app' : 'browser tab'}`],
    ['WebGPU', 'gpu' in navigator ? 'yes' : 'no'],
    ['Online', navigator.onLine ? 'yes' : 'no'],
    ['User agent', ua],
  ];
}

/* ------------------------------------------------------- translation services */
const PRESET = { openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', ollama: 'Ollama', lmstudio: 'LM Studio' };
// no server addresses: own servers would otherwise end up in a public issue
function safeLabel(e) {
  const c = e.config || {};
  if (e.type === 'libretranslate') return 'LibreTranslate';
  if (e.type === 'openai') return [PRESET[c.preset] || 'OpenAI-compatible API', c.model].filter(Boolean).join(' · ');
  return entryLabel(e.type, c);
}

function services() {
  const s = settings.get();
  const list = s.entries || [];
  const group = (kind, active) => {
    const of = list.filter((e) => kindOf(e) === kind);
    const first = active ?? of[0]?.id;
    return of.length ? of.map((e) => `${safeLabel(e)}${e.id === first ? ' **(used first)**' : ''}`).join(', ') : 'none';
  };
  const lang = (c) => (c === 'auto' ? 'Detect language' : `${langName(c)} (${c})`);
  return [
    ['Mode', state.mode === 'advanced' ? 'Advanced (AI)' : 'Classic'],
    ['Translating with', state.provider?.name || `none (${state.providerError?.message || 'not set up'})`],
    ['Languages', `${lang(state.source)} → ${lang(state.target)}`],
    ['AI services', group('advanced', s.activeAdvanced)],
    ['Classic services', group('classic', s.activeClassic)],
    ['Voice services', group('voice', null)],
  ];
}

/* ---------------------------------------------------- engines used first */
function engines() {
  const s = settings.get();
  const SPEECH = { browser: 'Browser speech service', api: 'AI service', elevenlabs: 'ElevenLabs', ondevice: 'On-device (Whisper)' };
  const TTS = { system: 'System voices', ondevice: 'On-device voices (Piper/Kokoro)', api: 'AI service', elevenlabs: 'ElevenLabs' };
  const OCR = { tesseract: 'Tesseract', paddle: 'PP-OCRv6', florence: 'Florence-2 (on-device AI)', vision: 'AI vision' };
  return [
    ['Voice input', SPEECH[s.speechEngine] || s.speechEngine],
    ['Whisper size', HF_MODELS[whisperKey()]?.title || s.whisperModel],
    ['Read aloud', TTS[s.ttsEngine] || s.ttsEngine],
    ['Camera text', OCR[s.ocrEngine] || s.ocrEngine],
    ['Camera quality', s.ocrQuality === 'fast' ? 'Fast' : 'Accurate'],
    ['Handwriting', HWR_LABEL[s.hwrEngine] || s.hwrEngine],
    ['Translate as you type', s.liveTranslate ? 'on' : 'off'],
  ];
}

/* ---------------------------------------------------------------- downloads */
async function downloads() {
  // these lists are filled when Settings is opened; refresh them here, but never wait long
  await Promise.all([within(3000, refreshModels()), within(3000, refreshVoices()), within(3000, refreshPaddle())]);
  const ocr = await within(2000, ocrDownloaded());
  const names = (codes) => (codes.length ? codes.map((c) => langName(c) || c).join(', ') : 'none');
  const models = Object.keys(HF_MODELS).filter((k) => modelState(k) === 'ready').map((k) => HF_MODELS[k].title);
  if (paddleState() === 'ready') models.push('PP-OCRv6');
  if (kokoroState() === 'ready') models.push('Kokoro 82M');
  const llms = downloadedLlms().map((k) => { try { return llmTitle(k); } catch { return k; } });
  if (nanoAvailability() === 'available') llms.push('Gemini Nano (Chrome)');
  return [
    ['Offline languages', names(installedLanguages())],
    ['Camera text languages', ocr?.size ? [...ocr.keys()].join(', ') : 'none'],
    ['Piper voices', names(downloadedVoices())],
    ['Models', models.join(', ') || 'none'],
    ['On-device AI models', llms.join(', ') || 'none'],
  ];
}

// version.json is stamped by the deploy (.github/workflows/deploy.yml) with the commit and its date
const REPO = 'https://github.com/joramulmke/opentranslate';
let version = null;
async function appVersion() {
  if (version) return version;
  try {
    const v = await (await fetch('version.json')).json();
    if (!v?.commit || v.commit === 'dev') {
      version = [['App version', 'dev (local copy without a version stamp)']];
    } else {
      const d = v.date ? new Date(v.date) : null;
      const when = d && !Number.isNaN(+d) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'date unknown';
      version = [['App version', `${v.commit.slice(0, 7)} · ${when}`], ['Commit', `${REPO}/commit/${v.commit}`]];
    }
  } catch { version = [['App version', 'unknown (version.json not readable)']]; }
  return version;
}

/** [{ title, rows: [[name, value]] }] */
export async function collectDiagnostics() {
  const [ver, sys, dl] = await Promise.all([appVersion(), system(), downloads().catch(() => [['Downloads', 'could not be read']])]);
  return [
    { title: 'System', rows: [...ver, ...sys] },
    { title: 'Translation', rows: services() },
    { title: 'Engines used first', rows: engines() },
    { title: 'Downloads', rows: dl },
  ];
}
