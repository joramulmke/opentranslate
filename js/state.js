// Shared app state + provider access. UI modules subscribe; they never touch providers directly.
import { createProvider, ProviderError } from './providers.js';
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

const build = (id) => {
  try { return [createProvider(id, settings.providerConfig(id)), null]; } catch (e) { return [null, e]; }
};

const active = (mode, s = state) => (mode === 'advanced'
  ? { provider: s.advanced, providerError: s.advancedError }
  : { provider: s.classic, providerError: s.classicError });

/** (Re)build the Classic and Advanced providers from settings; `provider` = the one for the current mode. */
export function initProvider() {
  const s = settings.get();
  const [classic, classicError] = build(s.providerId);
  const [advanced, advancedError] = build(s.advancedProviderId);
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
  const p = requireProvider();
  try { return await p.detect(text); } catch (e) { throw wrap(e); }
}

export async function translate(text, source, target) {
  const p = requireProvider();
  try { return await p.translate(text, source, target); } catch (e) { throw wrap(e); }
}

/** Human-facing copy for each error code. */
export function describeError(err) {
  const code = err?.code || 'SERVER';
  const map = {
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
