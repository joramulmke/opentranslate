// Shared app state + provider access. UI modules subscribe; they never touch providers directly.
import { createProvider, ProviderError, getProviderDef } from './providers.js';
import { offlineUnusable } from './features/offline.js';   // registers the on-device service
import { llmSpec, nanoUsable, onLlmChange } from './features/localllm.js';                  // registers the on-device AI model
import { chromeTranslatorSupported } from './features/chrometranslator.js';     // registers Chrome's built-in translator
import { STATIC_LANGUAGES } from './languages.js';
import { settings, recentLangs } from './store.js';

const s0 = settings.get();
export const state = {
  source: s0.source,          // 'auto' or a code
  target: s0.target,
  detected: null,             // { language, confidence } when source === 'auto'
  languages: STATIC_LANGUAGES,
  languagesSource: 'static',  // 'static' | 'provider'
  mode: s0.mode === 'advanced' ? 'advanced' : 'classic',  // Classic (Mock/LibreTranslate) or Advanced (LLM)
  provider: null,             // the ACTIVE provider for the current mode
  providerError: null,
  classic: null, classicError: null,
  advanced: null, advancedError: null,
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function set(patch) {
  Object.assign(state, patch);
  subs.forEach((fn) => fn(state, patch));
}

export function setSource(code) {
  set({ source: code, detected: code === 'auto' ? state.detected : null });
  settings.set({ source: code });
  recentLangs.push('source', code);
}
export function setTarget(code) {
  set({ target: code });
  settings.set({ target: code });
  recentLangs.push('target', code);
}
export function setPair(source, target) {
  set({ source, target, detected: null });
  settings.set({ source, target });
}

export const kindOf = (entry) => getProviderDef(entry?.type)?.kind || 'classic';

function buildEntry(e) {
  try {
    const p = createProvider(e.type, e.config || {});
    p.entryId = e.id; p.entryLabel = e.label;
    return [p, null];
  } catch (err) { return [null, err]; }
}

/**
 * All services of one kind as a single provider: the active entry first, then the others in
 * list order. If one fails or can't do the language pair, the next one is tried.
 * The offline demo only takes part when it is the active entry (its output isn't real).
 */
export class ProviderChain {
  constructor(kind, members) {
    this.kind = kind;
    this.members = members;
    const lead = members[0];
    this.lead = lead;
    this.name = lead.name;
    this.entryId = lead.entryId;
    this.entryLabel = lead.entryLabel;
    this.isMock = !!lead.isMock;
    this.isAdvanced = kind === 'advanced';
    // optional capabilities, present only if some member has them (stt.js / hwr.js check for them)
    const stt = members.find((m) => typeof m.transcribe === 'function' && m.sttModel);
    if (stt) { this.sttModel = stt.sttModel; this.transcribe = (...a) => this._run('transcribe', a, (m) => !!m.sttModel).then(([r]) => r); }
    if (members.some((m) => typeof m.recognizeImage === 'function')) {
      this.recognizeImage = (...a) => this._run('recognizeImage', a).then(([r]) => r);
    }
    if (members.some((m) => typeof m.readPhoto === 'function')) {
      this.readPhoto = (...a) => this._run('readPhoto', a, (m) => typeof m.readPhoto === 'function').then(([r]) => r);
    }
  }

  async _run(method, args, canTry = () => true) {
    let firstErr = null;
    const skipped = []; const later = [];
    const attempt = async (m) => { try { return [await m[method](...args), m]; } catch (e) { firstErr ??= e; return null; } };
    for (const m of this.members) {
      if (typeof m[method] !== 'function') continue;
      const ok = canTry(m);
      if (ok === 'later') { later.push(m); continue; }
      if (!ok) { skipped.push(m); continue; }
      const r = await attempt(m);
      if (r) return r;
    }
    // last resort, e.g. on-device without the languages yet: its error says what to download
    for (const m of later) { const r = await attempt(m); if (r) return r; }
    if (skipped.length && (!firstErr || !['UNSUPPORTED_PAIR', 'NEEDS_DOWNLOAD'].includes(firstErr.code))) {
      // the services that know the language pair didn't answer, the others can't do the pair
      const names = skipped.map((m) => m.entryLabel).join(', ');
      throw new ProviderError('UNSUPPORTED_PAIR', `${names} can't translate this language pair` +
        (firstErr ? `, and the other service failed: ${firstErr.message}` : '.'));
    }
    throw firstErr || new ProviderError('UNSUPPORTED_PAIR', 'None of your translation services can do this.');
  }

  /** false if the member is known not to support source→target (saves a request). */
  supports(m, source, target) {
    // on-device: only as a fallback once its languages are downloaded (as first choice it explains what to download)
    if (typeof m.ready === 'function' && m !== this.lead) return m.ready(source, target) || 'later';
    if (!source || source === 'auto' || typeof m.targetsFor !== 'function') return true;
    const t = m.targetsFor(source);
    return !t || t.includes(target);
  }

  async translate(text, source, target) {
    const [r, m] = await this._run('translate', [text, source, target], (x) => this.supports(x, source, target));
    return { ...r, via: m === this.lead ? undefined : m.entryLabel, entryId: m.entryId };
  }

  async detect(text) { return (await this._run('detect', [text]))[0]; }

  async languages() {
    const res = await Promise.allSettled(this.members.map((m) => m.languages()));
    const ok = res.filter((r) => r.status === 'fulfilled' && Array.isArray(r.value));
    if (!ok.length) throw res[0]?.reason;
    const seen = new Map();
    for (const r of ok) for (const l of r.value) if (!seen.has(l.code)) seen.set(l.code, l);
    return [...seen.values()];
  }

  /** Union of what the members can translate into; null = unknown / anything. */
  targetsFor(source) {
    const out = new Set();
    for (const m of this.members) {
      const t = typeof m.targetsFor === 'function' ? m.targetsFor(source) : null;
      if (!t) return null;
      t.forEach((c) => out.add(c));
    }
    return [...out];
  }

  test() { return this.lead.test(); }
}

function buildChain(kind, entryList, activeId) {
  // the on-device service is left out where it can't work (see offline.js)
  const ofKind = entryList.filter((e) => kindOf(e) === kind && !(e.type === 'offline' && offlineUnusable())
    && !(e.type === 'chrome-translator' && !chromeTranslatorSupported())
    && !(e.type === 'webllm' && llmSpec(e.config).kind === 'nano' && !nanoUsable()));
  const lead = ofKind.find((e) => e.id === activeId) || ofKind.find((e) => e.type !== 'mock') || ofKind[0];
  if (!lead) {
    return [null, new ProviderError('NO_PROVIDER', kind === 'advanced' ? 'No AI model is set up.' : 'No translation service is set up.')];
  }
  const order = lead.type === 'mock' ? [lead] : [lead, ...ofKind.filter((e) => e !== lead && e.type !== 'mock')];
  const members = []; let leadErr = null;
  for (const e of order) {
    const [p, err] = buildEntry(e);
    if (p) members.push(p); else if (e === lead) leadErr = err;
  }
  return members.length ? [new ProviderChain(kind, members), null] : [null, leadErr || new ProviderError('NO_PROVIDER', 'No translation service is set up.')];
}

const active = (mode, s = state) => (mode === 'advanced'
  ? { provider: s.advanced, providerError: s.advancedError }
  : { provider: s.classic, providerError: s.classicError });

/** (Re)build the Classic and Advanced chains from settings; `provider` = the one for the current mode. */
// Gemini Nano starting or stopping to work (Chrome reports it ready, or it failed to start): rebuild the chains,
// so a broken one isn't tried again and a fixed one comes back
let nanoWas = nanoUsable();
onLlmChange(() => { if (nanoUsable() !== nanoWas) { nanoWas = nanoUsable(); initProvider(); } });

export function initProvider() {
  const s = settings.get();
  const [classic, classicError] = buildChain('classic', s.entries, s.activeClassic);
  const [advanced, advancedError] = buildChain('advanced', s.entries, s.activeAdvanced);
  const next = { classic, classicError, advanced, advancedError };
  set({ ...next, ...active(state.mode, next) });
  return loadLanguages();
}

/** Switch between Classic and Advanced translation. */
export function setMode(mode) {
  mode = mode === 'advanced' ? 'advanced' : 'classic';
  settings.set({ mode });
  set({ mode, ...active(mode) });
  loadLanguages();
}

/** Make a service the one used first (and switch to its mode). */
export function useEntry(id) {
  const e = settings.get().entries.find((x) => x.id === id);
  if (!e) return;
  const kind = kindOf(e);
  settings.set(kind === 'advanced' ? { activeAdvanced: id, mode: kind } : { activeClassic: id, mode: kind });
  set({ mode: kind });
  initProvider();
}

export const advancedReady = () => !!state.advanced;

let langReq = 0;
export async function loadLanguages() {
  const id = ++langReq;
  // Classic: the server's own list. Advanced: AI models handle any language, so offer the full list.
  const src = state.mode === 'advanced' && state.advanced ? state.advanced : state.classic;
  if (!src) { set({ languages: STATIC_LANGUAGES, languagesSource: 'static' }); return; }
  try {
    const list = await src.languages();
    if (id !== langReq) return;
    if (Array.isArray(list) && list.length) {
      set({ languages: list, languagesSource: src.isMock ? 'static' : 'provider' });
    }
  } catch {
    if (id !== langReq) return;
    set({ languages: STATIC_LANGUAGES, languagesSource: 'static' });
  }
}

let displayNames = null;
try { displayNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser */ }

export function langName(code) {
  if (!code) return '';
  if (code === 'auto') return 'Detect language';
  const hit = state.languages.find((l) => l.code === code) || STATIC_LANGUAGES.find((l) => l.code === code);
  if (hit) return hit.name;
  try { return displayNames?.of(code) || code; } catch { return code; }
}

function requireProvider() {
  if (!state.provider) throw state.providerError || new ProviderError('NO_PROVIDER', 'No translation provider is set up.');
  return state.provider;
}

const wrap = (e) => (e instanceof ProviderError ? e : new ProviderError('SERVER', e?.message || String(e), e));

export async function detect(text) {
  // no service in this mode: the other mode's can still tell the language
  if (!state.provider) {
    const other = state.mode === 'advanced' ? state.classic : state.advanced;
    if (other && !other.isMock) { try { return await other.detect(text); } catch { /* report below */ } }
  }
  const p = requireProvider();
  try { return await p.detect(text); } catch (e) { throw wrap(e); }
}

/** Why the chosen mode didn't translate, as the end of "… because …". */
function becauseOf(err, mode) {
  switch (err?.code) {
    case 'NO_PROVIDER': return mode === 'advanced' ? 'no AI model is set up' : 'no Classic service is set up';
    case 'NEEDS_DOWNLOAD': return mode === 'advanced' ? "the on-device AI model isn't downloaded yet" : "the offline languages aren't downloaded yet";
    case 'NETWORK': return `${mode === 'advanced' ? 'the AI service' : 'the Classic service'} isn't reachable`;
    case 'UNSUPPORTED_PAIR': return `${mode === 'advanced' ? 'Advanced' : 'Classic'} can't do this language pair`;
    case 'AUTH': return 'the API key was refused';
    case 'RATE_LIMIT': return 'its rate limit or quota is reached';
    case 'BROWSER_BLOCKED': return `${mode === 'advanced' ? 'the AI model' : 'the Classic service'} can't run in this browser`;
    default: return `${mode === 'advanced' ? 'Advanced' : 'Classic'} failed`;
  }
}

/**
 * Translate with the current mode's services; if none of them can, with the other mode's (Classic ⇄
 * Advanced), and say so in the result. The offline demo never stands in: its output isn't a translation.
 */
export async function translate(text, source, target) {
  const mode = state.mode;
  const otherMode = mode === 'advanced' ? 'classic' : 'advanced';
  const other = otherMode === 'advanced' ? state.advanced : state.classic;
  let err;
  if (state.provider) {
    try { return await state.provider.translate(text, source, target); } catch (e) { err = wrap(e); }
  } else {
    err = state.providerError || new ProviderError('NO_PROVIDER', 'No translation provider is set up.');
  }
  const otherName = otherMode === 'advanced' ? 'Advanced' : 'Classic';
  if (other && !other.isMock) {
    try {
      const r = await other.translate(text, source, target);
      return { ...r, via: undefined, note: `Translated with ${other.entryLabel} (${otherName}) because ${becauseOf(err, mode)}.`, otherMode };
    } catch { /* the other mode can't either: report this mode's error */ }
  }
  // a button can switch modes when the other one has something to offer (even the demo)
  if (other && err.code === 'NO_PROVIDER') err.detail = { ...(err.detail || {}), switchTo: otherMode };
  throw err;
}

/** Human-facing copy for each error code. */
export function describeError(err) {
  const code = err?.code || 'SERVER';
  const map = {
    NEEDS_DOWNLOAD: ['Download needed', `${err.message} Download it once to translate without internet.`],
    BROWSER_BLOCKED: ['Not available in this browser', err.message],
    NO_PROVIDER: ['No translation provider', err.message || 'Choose a provider in Settings to start translating.'],
    NETWORK: ["Can't translate", `Check your connection and try again. ${err.message}`],
    UNSUPPORTED_PAIR: ['Language pair not supported', err.message],
    AUTH: ['Access denied', err.message + ' Check the API key in Settings.'],
    RATE_LIMIT: ['Slow down', err.message],
    TOO_LONG: ['Text too long', err.message],
    BAD_RESPONSE: ['Unexpected answer from server', err.message],
    SERVER: ['Translation failed', err.message],
  };
  const [title, message] = map[code] || map.SERVER;
  return { code, title, message };
}
