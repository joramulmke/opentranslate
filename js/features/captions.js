// Live captions for Conversation › Listening (IDEAS #2): keeps listening until stopped, and hands over each
// finished piece of speech as soon as it's final.
//  - Chrome's (or another browser's) speech service: continuous recognition, restarted whenever the
//    browser ends it (about every minute, after silence, or when the app was in the background).
//  - Recording engines (your AI service's Whisper, ElevenLabs, on-device Whisper): the audio is cut at
//    pauses; the next piece is already recording while the last one is transcribed, so nothing is lost.
//    Stopped with stop({ keep: true }) (the Stop button), the words of the piece still being recorded
//    and of pieces still being transcribed come in after onEnd; without keep (leaving) they're dropped.
//  - Audio from the microphone, or (computers) a tab or the screen, shared with its sound. Shared sound
//    always goes to a recording engine: the browser's speech service only listens to the microphone.
// Optional: pause after 2 minutes without speech, to save battery.
import { browserSpeechAvailable } from './speech.js';
import { speechOrder, canRecord, transcribe } from './stt.js';

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
export const QUIET_PAUSE_MS = 2 * 60 * 1000;
const LOUD = 0.02;           // RMS above this counts as sound
const PAUSE_CUT_MS = 900;    // a pause this long ends a piece (recording engines)
const MAX_PIECE_MS = 12000;  // …and a piece never gets longer than this, so captions keep coming

/** Whether this browser can share a tab's or the screen's sound (computers: Chrome, Edge; not phones). */
export const canShareAudio = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
  && canRecord() && !matchMedia('(pointer: coarse)').matches;

/** The browser's own speech service will be used for the microphone. */
export const usesBrowserService = () => browserSpeechAvailable() && speechOrder()[0] === 'browser';

/**
 * Start live captions.
 * @param {string} lang  language spoken
 * @param {{ source?: 'mic'|'tab', pauseWhenQuiet?: boolean,
 *   onInterim?: (text: string) => void, onFinal?: (text: string) => void, onState?: (state: string) => void,
 *   onPaused?: () => void, onError?: (e: Error) => void, onEnd?: () => void }} cbs
 * @returns {{ stop: (opts?: { keep?: boolean }) => void, setPauseWhenQuiet: (on: boolean) => void }}
 */
export function startCaptions(lang, cbs = {}) {
  let stopped = false;
  let pauseWhenQuiet = cbs.pauseWhenQuiet !== false;
  let lastHeard = Date.now();
  let engine = null;   // { stop() }
  const quietTimer = setInterval(() => {
    if (!stopped && pauseWhenQuiet && Date.now() - lastHeard > QUIET_PAUSE_MS) { finish(); cbs.onPaused?.(); }
  }, 5000);
  const heard = () => { lastHeard = Date.now(); };
  function finish({ keep = false } = {}) {
    if (stopped) return;
    stopped = true;
    clearInterval(quietTimer);
    engine?.stop(keep);
    cbs.onInterim?.('');
    cbs.onEnd?.();
  }
  const fail = (e) => { if (stopped) return; finish(); cbs.onError?.(e); };   // keep: false, nothing more comes
  const live = () => !stopped;

  if (cbs.source !== 'tab' && usesBrowserService()) {
    engine = browserEngine(lang, { ...cbs, heard, live, fail, fallback: () => { engine = recordEngine(lang, null, { ...cbs, heard, live, fail }); } });
  } else if (canRecord()) {
    engine = recordEngine(lang, cbs.source === 'tab' ? 'tab' : 'mic', { ...cbs, heard, live, fail });
  } else {
    queueMicrotask(() => fail(new Error('UNSUPPORTED')));
  }
  return { stop: finish, setPauseWhenQuiet: (on) => { pauseWhenQuiet = on; lastHeard = Date.now(); } };
}

/* ---------------- the browser's speech service ---------------- */

function browserEngine(lang, { onInterim, onFinal, onState, heard, live, fail, fallback }) {
  let r = null;
  let quickEnds = 0;     // ends right after starting, in a row: something is wrong
  let startedAt = 0;
  let waitingForPage = false;
  const code = lang && lang !== 'auto' ? (lang === 'zh' ? 'zh-CN' : lang) : navigator.language || 'en-US';

  function start() {
    if (!live()) return;
    if (document.hidden) { waitingForPage = true; return; }   // Chrome on Android stops listening in the background
    r = new Recognition();
    r.lang = code;
    r.continuous = true;
    r.interimResults = true;
    let done = 0;          // results already handed over as final
    let fatal = null;
    r.onresult = (ev) => {
      heard();
      quickEnds = 0;
      let interim = '';
      for (let i = done; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal && i === done) { done++; const t = res[0].transcript.trim(); onInterim?.(''); if (t) onFinal?.(t); }
        else interim += res[0].transcript;
      }
      onInterim?.(interim.trim());
    };
    r.onerror = (ev) => {
      const e = ev.error || 'SR_ERROR';
      if (e === 'no-speech' || e === 'aborted') return;            // silence or our own stop: restart below
      if (e === 'network' && canRecord()) { fatal = 'fallback'; return; }
      fatal = e;
    };
    r.onend = () => {
      r = null;
      if (!live()) return;
      if (fatal === 'fallback') { fallback(); return; }
      if (fatal) { fail(new Error(fatal)); return; }
      quickEnds = Date.now() - startedAt < 1500 ? quickEnds + 1 : 0;
      if (quickEnds >= 5) { fail(new Error('SR_ERROR')); return; }
      setTimeout(start, quickEnds ? 400 * quickEnds : 0);
    };
    startedAt = Date.now();
    onState?.('listening');
    try { r.start(); } catch (e) { fail(e); }
  }
  const onVisible = () => { if (!document.hidden && waitingForPage && live()) { waitingForPage = false; start(); } };
  document.addEventListener('visibilitychange', onVisible);
  start();
  return {
    stop() {
      document.removeEventListener('visibilitychange', onVisible);
      try { r?.stop(); } catch { /* already stopped */ }
      r = null;
    },
  };
}

/* ---------------- recording engines ---------------- */

async function openStream(source) {
  if (source === 'tab') {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include', selfBrowserSurface: 'exclude' });
    s.getVideoTracks().forEach((t) => t.stop());   // only the sound is used
    if (!s.getAudioTracks().length) { s.getTracks().forEach((t) => t.stop()); throw new Error('NO_SHARED_AUDIO'); }
    return s;
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

function recordEngine(lang, source, { onInterim, onFinal, onState, heard, live, fail }) {
  let stream = null;
  let ctx = null;
  let timer = 0;
  let rec = null;
  let chain = Promise.resolve();
  let pending = 0;
  let draining = false;   // stopped with keep: the last pieces are still transcribed and handed over
  const deliver = () => live() || draining;
  const mimeType = MIME.find((m) => window.MediaRecorder?.isTypeSupported?.(m));

  const status = () => onState?.(pending ? 'transcribing' : 'listening');
  function enqueue(blob) {
    pending++; status();
    chain = chain.then(async () => {
      if (!deliver()) return;
      try {
        const { text } = await transcribe(blob, lang, { onStatus: () => {} });
        if (deliver() && text) onFinal?.(text.trim());
      } catch (e) {
        const m = e?.message || '';
        // no engine, or the service refused: stop; anything else (a bad piece of audio): carry on
        if (m === 'NO_ENGINE' || /^Speech service failed/.test(m)) fail(e);
      } finally { pending--; status(); }
    });
  }
  function piece() {
    const chunks = [];
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const p = { r, chunks, heard: false, start: performance.now(), lastLoud: 0 };
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => { if (p.heard && deliver()) enqueue(new Blob(chunks, { type: r.mimeType || mimeType || 'audio/webm' })); };
    r.start(250);
    return p;
  }
  function cut() {
    const old = rec;
    rec = live() ? piece() : null;
    if (old.r.state !== 'inactive') old.r.stop();
  }

  (async () => {
    try {
      stream = await openStream(source);
    } catch (e) {
      fail(new Error(e?.name === 'NotAllowedError' || e?.name === 'NotFoundError' ? e.name : (e?.message || 'SR_ERROR')));
      return;
    }
    if (!live()) { stream.getTracks().forEach((t) => t.stop()); return; }
    stream.getAudioTracks()[0].addEventListener('ended', () => fail(new Error(source === 'tab' ? 'SHARING_ENDED' : 'audio-capture')));
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    rec = piece();
    onState?.('listening');
    timer = setInterval(() => {
      if (!rec) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const now = performance.now();
      if (Math.sqrt(sum / buf.length) > LOUD) { rec.heard = true; rec.lastLoud = now; heard(); onInterim?.('…'); }
      const age = now - rec.start;
      if (rec.heard && (now - rec.lastLoud > PAUSE_CUT_MS || age > MAX_PIECE_MS)) { onInterim?.(''); cut(); }
      else if (!rec.heard && age > 10000) cut();   // nothing said: start a fresh piece (keeps them small)
    }, 100);
  })();

  return {
    /** keep: the piece being recorded is still transcribed, like those waiting; else all are dropped. */
    stop(keep = false) {
      clearInterval(timer);
      draining = keep;
      const r = rec; rec = null;
      const close = () => {
        stream?.getTracks().forEach((t) => t.stop());
        ctx?.close().catch(() => {});
        chain.then(() => { draining = false; });   // after the last piece: nothing more comes
      };
      // the recorder's own onstop (set in piece()) runs first and queues the last piece
      if (r && r.r.state !== 'inactive') { r.r.addEventListener('stop', close, { once: true }); r.r.stop(); } else close();
    },
  };
}
