// Offline voices for read-aloud: Piper (github.com/rhasspy/piper) running in the browser.
// One voice per language, downloaded from Hugging Face (rhasspy/piper-voices) when asked for.
// The engine is downloaded once, the first time a voice is: the ONNX runtime from jsDelivr
// (~11 MB) and the Piper phonemizer with its eSpeak NG pronunciation data from jsDelivr (~19 MB).
// Everything is kept in Cache Storage ("ot-piper-v1"), so read-aloud works without internet
// afterwards; deleting the last voice deletes the engine too.
const formatMB = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

const CACHE = 'ot-piper-v1';
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const PHONEMIZE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/';
const ENGINE = [
  ORT + 'ort.wasm.min.mjs', ORT + 'ort-wasm-simd-threaded.mjs', ORT + 'ort-wasm-simd-threaded.wasm',
  PHONEMIZE + 'piper_phonemize.js', PHONEMIZE + 'piper_phonemize.wasm', PHONEMIZE + 'piper_phonemize.data',
];
export const ENGINE_MB = 30;
export const PIPER_SOURCE = {
  page: 'https://huggingface.co/rhasspy/piper-voices',
  engine: 'https://github.com/rhasspy/piper',
};

// [language, file on Hugging Face, size in MB]. Medium quality where there is one. Hebrew, Japanese,
// Lithuanian and Thai voices need phonemizers that don't run in the browser, so they aren't offered.
const VOICES = [
  ['ar', 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx', 63],
  ['bg', 'bg/bg_BG/dimitar/medium/bg_BG-dimitar-medium.onnx', 63],
  ['bn', 'bn/bn_BD/google/medium/bn_BD-google-medium.onnx', 77],
  ['ca', 'ca/ca_ES/upc_ona/medium/ca_ES-upc_ona-medium.onnx', 63],
  ['cs', 'cs/cs_CZ/jirka/medium/cs_CZ-jirka-medium.onnx', 63],
  ['cy', 'cy/cy_GB/gwryw_gogleddol/medium/cy_GB-gwryw_gogleddol-medium.onnx', 64],
  ['da', 'da/da_DK/talesyntese/medium/da_DK-talesyntese-medium.onnx', 63],
  ['de', 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx', 63],
  ['el', 'el/el_GR/rapunzelina/medium/el_GR-rapunzelina-medium.onnx', 63],
  ['en', 'en/en_US/lessac/medium/en_US-lessac-medium.onnx', 63],
  ['en-GB', 'en/en_GB/alba/medium/en_GB-alba-medium.onnx', 63],
  ['es', 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', 63],
  ['es-MX', 'es/es_MX/ald/medium/es_MX-ald-medium.onnx', 63],
  ['et', 'et/et_EE/news/medium/et_EE-news-medium.onnx', 77],
  ['eu', 'eu/eu_ES/maider/medium/eu_ES-maider-medium.onnx', 63],
  ['fa', 'fa/fa_IR/gyro/medium/fa_IR-gyro-medium.onnx', 63],
  ['fi', 'fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx', 63],
  ['fr', 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx', 63],
  ['hi', 'hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx', 64],
  ['hu', 'hu/hu_HU/anna/medium/hu_HU-anna-medium.onnx', 63],
  ['hy', 'hy/hy_AM/gor/medium/hy_AM-gor-medium.onnx', 64],
  ['id', 'id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx', 63],
  ['is', 'is/is_IS/salka/medium/is_IS-salka-medium.onnx', 76],
  ['it', 'it/it_IT/paola/medium/it_IT-paola-medium.onnx', 63],
  ['ka', 'ka/ka_GE/natia/medium/ka_GE-natia-medium.onnx', 63],
  ['kk', 'kk/kk_KZ/issai/high/kk_KZ-issai-high.onnx', 128],
  ['ko', 'ko/ko_KR/kss/medium/ko_KR-kss-medium.onnx', 63],
  ['ku', 'ku/ku_TR/berfin_renas/medium/ku_TR-berfin_renas-medium.onnx', 77],
  ['lb', 'lb/lb_LU/marylux/medium/lb_LU-marylux-medium.onnx', 63],
  ['lv', 'lv/lv_LV/aivars/medium/lv_LV-aivars-medium.onnx', 64],
  ['ml', 'ml/ml_IN/meera/medium/ml_IN-meera-medium.onnx', 63],
  ['mr', 'mr/mr_IN/google/medium/mr_IN-google-medium.onnx', 77],
  ['ne', 'ne/ne_NP/chitwan/medium/ne_NP-chitwan-medium.onnx', 63],
  ['nl', 'nl/nl_NL/pim/medium/nl_NL-pim-medium.onnx', 63],
  ['nl-BE', 'nl/nl_BE/nathalie/medium/nl_BE-nathalie-medium.onnx', 63],
  ['no', 'no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx', 63],
  ['pl', 'pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx', 63],
  ['pt', 'pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx', 63],
  ['pt-PT', 'pt/pt_PT/tugão/medium/pt_PT-tugão-medium.onnx', 63],
  ['ro', 'ro/ro_RO/mihai/medium/ro_RO-mihai-medium.onnx', 63],
  ['ru', 'ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx', 63],
  ['sk', 'sk/sk_SK/lili/medium/sk_SK-lili-medium.onnx', 63],
  ['sl', 'sl/sl_SI/artur/medium/sl_SI-artur-medium.onnx', 63],
  ['sq', 'sq/sq_AL/edon/medium/sq_AL-edon-medium.onnx', 64],
  ['sr', 'sr/sr_RS/serbski_institut/medium/sr_RS-serbski_institut-medium.onnx', 77],
  ['sv', 'sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx', 63],
  ['sw', 'sw/sw_CD/lanfrica/medium/sw_CD-lanfrica-medium.onnx', 63],
  ['te', 'te/te_IN/maya/medium/te_IN-maya-medium.onnx', 63],
  ['tr', 'tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx', 63],
  ['uk', 'uk/uk_UA/lada/x_low/uk_UA-lada-x_low.onnx', 21],
  ['ur', 'ur/ur_PK/fasih/medium/ur_PK-fasih-medium.onnx', 65],
  ['vi', 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx', 63],
  ['zh', 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx', 63],
].map(([lang, file, sizeMB]) => ({ lang, file, sizeMB, name: file.split('/')[2].replace(/_/g, ' ') }));

const REGION = { en: 'US', 'en-GB': 'UK', es: 'Spain', 'es-MX': 'Mexico', pt: 'Brazil', 'pt-PT': 'Portugal', nl: 'Netherlands', 'nl-BE': 'Belgium' };
/** "English (US)", "German": the language name, with the region where there are two voices. */
export const voiceLabel = (lang, nameOf) => `${nameOf(lang.split('-')[0])}${REGION[lang] ? ` (${REGION[lang]})` : ''}`;
export const piperVoices = () => VOICES;
export const voicePage = (v) => `${PIPER_SOURCE.page}/tree/main/${v.file.split('/').slice(0, -1).join('/')}`;

const listeners = new Set();
export const onVoicesChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

const present = new Map();   // lang -> bytes of a downloaded voice
const jobs = new Map();      // lang -> progress 0..1
let engineBytes = 0;

export const voiceState = (lang) => (jobs.has(lang) ? 'downloading' : present.has(lang) ? 'ready' : 'none');
export const voiceProgress = (lang) => jobs.get(lang) ?? 0;
export const voiceBytes = (lang) => present.get(lang) || 0;
export const downloadedVoices = () => [...present.keys()];
/** Bytes used on this device: voices plus the engine. */
export const piperBytes = () => [...present.values()].reduce((a, b) => a + b, 0) + (present.size ? engineBytes : 0);

const canCache = () => typeof caches !== 'undefined';
const sizeOf = async (res) => Number(res.headers.get('content-length')) || (await res.clone().blob()).size;

/** Which voices (and engine files) are in the cache. */
export async function refreshVoices() {
  present.clear(); engineBytes = 0;
  if (!canCache()) { emit(); return; }
  try {
    const c = await caches.open(CACHE);
    for (const req of await c.keys()) {
      const res = await c.match(req);
      const bytes = res ? await sizeOf(res) : 0;
      const v = VOICES.find((x) => req.url === HF + encodeURI(x.file));
      if (v) present.set(v.lang, bytes);
      else if (!req.url.endsWith('.onnx.json')) engineBytes += bytes;
    }
  } catch { /* no cache storage */ }
  emit();
}

/** The downloaded voice to use for a language (exact match first, then same language). */
export function voiceFor(lang) {
  if (!lang || lang === 'auto') return null;
  const want = lang === 'nb' ? 'no' : lang === 'zh-Hant' ? 'zh' : lang;
  const base = want.split('-')[0];
  return VOICES.find((v) => v.lang === want && present.has(v.lang))
    || VOICES.find((v) => v.lang.split('-')[0] === base && present.has(v.lang)) || null;
}
/** The voice that would be downloaded for a language, or null when Piper has none. */
export function offerFor(lang) {
  if (!lang || lang === 'auto') return null;
  const want = lang === 'nb' ? 'no' : lang === 'zh-Hant' ? 'zh' : lang;
  return VOICES.find((v) => v.lang === want) || VOICES.find((v) => v.lang === want.split('-')[0]) || null;
}

/** Fetch a file into the cache (with progress), or return the cached copy. */
async function cachedFetch(url, onBytes) {
  const c = await caches.open(CACHE);
  const hit = await c.match(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  let body = res.body;
  if (onBytes && body) {
    let n = 0;
    body = body.pipeThrough(new TransformStream({ transform(chunk, ctl) { n += chunk.byteLength; onBytes(n); ctl.enqueue(chunk); } }));
  }
  const blob = await new Response(body).blob();
  const copy = new Response(blob, { headers: { 'content-type': res.headers.get('content-type') || '', 'content-length': String(blob.size) } });
  await c.put(url, copy.clone());
  return copy;
}

/** Download a voice (and the engine, the first time). onProgress gets 0..1. */
export async function downloadVoice(lang, { onProgress } = {}) {
  const v = VOICES.find((x) => x.lang === lang);
  if (!v) throw new Error('No offline voice for this language');
  if (jobs.has(lang)) return;
  jobs.set(lang, 0); emit();
  try {
    const c = await caches.open(CACHE);
    const missing = [];
    for (const u of ENGINE) if (!(await c.match(u))) missing.push(u);
    const total = v.sizeMB * 1e6 + (missing.length ? ENGINE_MB * 1e6 : 0);
    let done = 0;
    const tick = (n) => { const p = Math.min(0.99, (done + n) / total); jobs.set(lang, p); onProgress?.(p); emit(); };
    for (const u of missing) { const r = await cachedFetch(u, tick); done += await sizeOf(r); }
    await cachedFetch(HF + encodeURI(v.file) + '.json');
    await cachedFetch(HF + encodeURI(v.file), tick);
  } finally {
    jobs.delete(lang);
    await refreshVoices();
  }
}

/** Delete a voice; the engine goes too when no voice is left. */
export async function deleteVoice(lang) {
  const v = VOICES.find((x) => x.lang === lang);
  if (!v || !canCache()) return;
  const c = await caches.open(CACHE);
  await c.delete(HF + encodeURI(v.file));
  await c.delete(HF + encodeURI(v.file) + '.json');
  sessions.delete(lang);
  present.delete(lang);
  if (!present.size) { for (const u of ENGINE) await c.delete(u); engine = null; }
  await refreshVoices();
}

/* ------------------------------------------------------------ synthesis */

let engine = null;              // Promise<{ ort, createPhonemize, phonemizeWasm, phonemizeData }>
const sessions = new Map();     // lang -> Promise<{ session, config }>

const blobUrl = async (url, type) => URL.createObjectURL(new Blob([await (await cachedFetch(url)).arrayBuffer()], { type }));

function loadEngine() {
  engine ??= (async () => {
    const [ortMjs, glueMjs] = await Promise.all([blobUrl(ENGINE[0], 'text/javascript'), blobUrl(ENGINE[1], 'text/javascript')]);
    const ortWasm = await blobUrl(ENGINE[2], 'application/wasm');
    const ort = await import(/* webpackIgnore: true */ ortMjs);
    ort.env.wasm.numThreads = 1;      // no cross-origin isolation here, so no threads
    ort.env.wasm.wasmPaths = { mjs: glueMjs, wasm: ortWasm };
    // the phonemizer is a classic script that defines createPiperPhonemize
    if (!window.createPiperPhonemize) {
      const src = await blobUrl(ENGINE[3], 'text/javascript');
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not start the voice engine'));
        document.head.append(s);
      });
    }
    const [phonemizeWasm, phonemizeData] = await Promise.all([
      cachedFetch(ENGINE[4]).then((r) => r.arrayBuffer()), cachedFetch(ENGINE[5]).then((r) => r.arrayBuffer()),
    ]);
    return { ort, createPhonemize: window.createPiperPhonemize, phonemizeWasm, phonemizeData };
  })();
  engine.catch(() => { engine = null; });
  return engine;
}

function session(v) {
  if (!sessions.has(v.lang)) {
    const p = (async () => {
      const { ort } = await loadEngine();
      const config = await (await cachedFetch(HF + encodeURI(v.file) + '.json')).json();
      const model = await (await cachedFetch(HF + encodeURI(v.file))).arrayBuffer();
      return { session: await ort.InferenceSession.create(model, { executionProviders: ['wasm'] }), config };
    })();
    p.catch(() => sessions.delete(v.lang));
    sessions.set(v.lang, p);
  }
  return sessions.get(v.lang);
}

/** Text -> phoneme ids, with eSpeak NG compiled to WebAssembly. */
async function phonemeIds(text, voice) {
  const { createPhonemize, phonemizeWasm, phonemizeData } = await loadEngine();
  return new Promise((resolve, reject) => {
    let done = false;
    createPhonemize({
      wasmBinary: phonemizeWasm,
      getPreloadedPackage: () => phonemizeData,
      print: (line) => { if (!done) { done = true; resolve(JSON.parse(line).phoneme_ids); } },
      printErr: (msg) => { if (!done) { done = true; reject(new Error(msg)); } },
      locateFile: (f) => PHONEMIZE + f,
    }).then((m) => {
      m.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    }, reject);
  });
}

/** Sentences of at most ~400 characters (long texts are spoken piece by piece). */
function chunks(text) {
  const out = []; let cur = '';
  for (const s of text.match(/[^.!?…。！？\n]+[.!?…。！？]*\s*/g) || [text]) {
    if ((cur + s).length > 400 && cur.trim()) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function wav(pcm, rate) {
  const b = new ArrayBuffer(44 + pcm.length * 2); const d = new DataView(b);
  const str = (o, t) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); d.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt '); d.setUint32(16, 16, true);
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true);
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([b], { type: 'audio/wav' });
}

/** Speak text with a downloaded voice: resolves to a WAV blob. */
export async function synthesize(text, lang) {
  const v = voiceFor(lang);
  if (!v) throw new Error('NO_VOICE');
  const { ort } = await loadEngine();
  const { session: s, config } = await session(v);
  const { noise_scale: ns = 0.667, length_scale: ls = 1, noise_w: nw = 0.8 } = config.inference || {};
  const parts = [];
  for (const piece of chunks(text)) {
    const ids = await phonemeIds(piece, config.espeak?.voice || v.lang);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([ns, ls, nw]), [3]),
    };
    if (Object.keys(config.speaker_id_map || {}).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    parts.push((await s.run(feeds)).output.data);
  }
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return wav(all, config.audio?.sample_rate || 22050);
}

/** "63 MB" plus the one-time engine download while no voice is there yet. */
export const downloadSize = (v) => (present.size ? formatMB(v.sizeMB * 1e6) : `${formatMB(v.sizeMB * 1e6)} + ${ENGINE_MB} MB voice engine, once`);

refreshVoices();
