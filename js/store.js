// localStorage persistence: settings, history (last 100), phrasebook (starred).
import { demoEnabled } from './siteconfig.js';
import { prettyName } from './features/llmcatalog.js';
const KEY = { settings: 'ot.settings.v1', history: 'ot.history.v1', saved: 'ot.phrasebook.v1', recents: 'ot.recentLangs.v1' };
const HISTORY_MAX = 100;

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } };

const DEFAULT_SETTINGS = {
  // Translation services, in fallback order. Each: { id, type, label, config }.
  // type = a registered provider id (mock | libretranslate | openai | …). API keys live in
  // config, in this browser only. null = not migrated yet (see migrate()).
  entries: null,
  activeClassic: 'mock',       // entry id used first in Classic mode
  activeAdvanced: null,        // entry id used first in Advanced mode (null = first AI entry)
  mode: 'classic',             // classic | advanced
  source: 'auto',
  target: 'es',
  liveTranslate: true,
  theme: 'system',             // system | light | dark
  speakConversation: true,
  hwrEngine: 'vision',         // first handwriting engine: vision | ondevice | tesseract (old 'auto' = vision)
  speechEngine: 'browser',     // first speech engine: browser | api | elevenlabs | ondevice
  ttsEngine: 'system',         // first read-aloud engine: system | ondevice (Piper) | api | elevenlabs
  ttsDeclined: [],             // languages where "Download a voice?" was answered "Not now"
  hwrModelOk: null,            // null = not asked yet, true/false = answer to the model download prompt
  sttModelOk: null,            // same, for the on-device speech model
};

export const MOCK_ENTRY = { id: 'mock', type: 'mock', label: 'Offline demo', config: {} };
export const OFFLINE_ENTRY = { id: 'offline', type: 'offline', label: 'On this device', config: {} };
export const BUILT_IN = new Set([MOCK_ENTRY.id, OFFLINE_ENTRY.id]);
export const newEntryId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Default display name for a service, e.g. "LibreTranslate · joram.eu", "OpenAI · gpt-4o-mini". */
export function entryLabel(type, config = {}) {
  if (type === 'mock') return MOCK_ENTRY.label;
  if (type === 'offline') return OFFLINE_ENTRY.label;
  if (type === 'elevenlabs') return 'ElevenLabs';
  if (type === 'chrome-translator') return 'Chrome translator';
  if (type === 'webllm') {
    const m = { small: 'Qwen2.5-1.5B-Instruct', medium: 'Llama-3.2-3B-Instruct' }[config.model] || config.model || 'Qwen2.5-1.5B-Instruct';
    if (m === 'gemini-nano') return 'Gemini Nano';
    if (m === 'custom') return `On-device AI · ${String(config.customUrl || '').split('/').filter(Boolean).pop() || 'own model'}`;
    return `On-device AI · ${prettyName(m)}`;
  }
  let host = '';
  try { host = new URL(config.baseUrl).hostname; } catch { /* empty / invalid url */ }
  const parts = host.split('.');
  const site = parts.length > 2 && !/^\d+$/.test(parts.at(-1)) ? parts.slice(-2).join('.') : host;
  if (type === 'libretranslate') return site ? `LibreTranslate · ${site}` : 'LibreTranslate';
  if (type === 'openai') {
    const preset = { openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', ollama: 'Ollama', lmstudio: 'LM Studio' }[config.preset];
    return [preset || site || 'AI model', config.model].filter(Boolean).join(' · ');
  }
  return type;
}

/** Older versions stored one Classic + one Advanced provider; turn them into entries. */
function migrate(raw) {
  const pc = raw.providerConfig || {};
  const list = [];
  let activeClassic = 'mock';
  let activeAdvanced = null;
  if (pc.libretranslate?.baseUrl) {
    const e = { id: newEntryId(), type: 'libretranslate', label: entryLabel('libretranslate', pc.libretranslate), config: pc.libretranslate };
    list.push(e);
    if (raw.providerId === 'libretranslate') activeClassic = e.id;
  }
  list.push({ ...MOCK_ENTRY, config: pc.mock || {} });
  if (pc.openai?.baseUrl && pc.openai?.model) {
    const e = { id: newEntryId(), type: 'openai', label: entryLabel('openai', pc.openai), config: pc.openai };
    list.push(e);
    activeAdvanced = e.id;
  }
  return { entries: list, activeClassic, activeAdvanced };
}

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((fn) => fn(what));

export const settings = {
  get() {
    const raw = read(KEY.settings, {});
    if (!Array.isArray(raw.entries)) {
      const { providerId, advancedProviderId, providerConfig, ...rest } = raw;
      write(KEY.settings, { ...rest, ...migrate(raw) });
      return this.get();
    }
    // the on-device service is always in the list (added for older saved lists too)
    if (!raw.entries.some((e) => e.id === OFFLINE_ENTRY.id)) {
      const demo = raw.entries.findIndex((e) => e.id === MOCK_ENTRY.id);
      raw.entries.splice(demo < 0 ? raw.entries.length : demo, 0, { ...OFFLINE_ENTRY });
      write(KEY.settings, raw);
    }
    // the offline demo: left out when change-me.md says demo_mode = false, back (last) when it's on again
    if (!demoEnabled()) raw.entries = raw.entries.filter((e) => e.type !== 'mock');
    else if (!raw.entries.some((e) => e.id === MOCK_ENTRY.id)) { raw.entries.push({ ...MOCK_ENTRY }); write(KEY.settings, raw); }
    return { ...DEFAULT_SETTINGS, ...raw };
  },
  set(patch) { const next = { ...this.get(), ...patch }; write(KEY.settings, next); emit('settings'); return next; },
};

/** The list of translation services (Settings › Translation services). */
export const entries = {
  all() { return settings.get().entries; },
  get(id) { return this.all().find((e) => e.id === id) || null; },
  save(entry) {
    const list = this.all();
    const i = list.findIndex((e) => e.id === entry.id);
    const demo = list.findIndex((e) => e.id === MOCK_ENTRY.id);
    if (i >= 0) list[i] = entry;
    else if (demo >= 0) list.splice(demo, 0, entry); // the demo always stays last
    else list.push(entry);
    settings.set({ entries: list });
    return entry;
  },
  remove(id) {
    if (BUILT_IN.has(id)) return;
    const s = settings.get();
    settings.set({
      entries: s.entries.filter((e) => e.id !== id),
      ...(s.activeClassic === id ? { activeClassic: null } : {}),
      ...(s.activeAdvanced === id ? { activeAdvanced: null } : {}),
    });
  },
  /** Move an entry up (-1) or down (+1) among the entries of the same kind. */
  move(id, step, kindOf) {
    const list = this.all();
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return;
    const kind = kindOf(list[i]);
    let j = i + step;
    while (j >= 0 && j < list.length && kindOf(list[j]) !== kind) j += step;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    settings.set({ entries: list });
  },
};

const sameEntry = (a, b) => a.text === b.text && a.source === b.source && a.target === b.target;
const entryId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const history = {
  all() { return read(KEY.history, []); },
  add(e) {
    if (!e.text?.trim() || !e.result?.trim()) return;
    const list = this.all().filter((x) => !sameEntry(x, e));
    list.unshift({ id: entryId(), ts: Date.now(), ...e });
    write(KEY.history, list.slice(0, HISTORY_MAX));
    emit('history');
  },
  remove(id) { write(KEY.history, this.all().filter((x) => x.id !== id)); emit('history'); },
  clear() { write(KEY.history, []); emit('history'); },
};

export const phrasebook = {
  all() { return read(KEY.saved, []); },
  has(e) { return this.all().some((x) => sameEntry(x, e)); },
  toggle(e) {
    const list = this.all();
    const i = list.findIndex((x) => sameEntry(x, e));
    if (i >= 0) list.splice(i, 1);
    else list.unshift({ id: entryId(), ts: Date.now(), text: e.text, result: e.result, source: e.source, target: e.target });
    write(KEY.saved, list);
    emit('phrasebook');
    return i < 0;
  },
  remove(id) { write(KEY.saved, this.all().filter((x) => x.id !== id)); emit('phrasebook'); },
  clear() { write(KEY.saved, []); emit('phrasebook'); },
};

export const recentLangs = {
  get(side) { return read(KEY.recents, { source: [], target: [] })[side] || []; },
  push(side, code) {
    if (!code || code === 'auto') return;
    const all = read(KEY.recents, { source: [], target: [] });
    all[side] = [code, ...(all[side] || []).filter((c) => c !== code)].slice(0, 5);
    write(KEY.recents, all);
  },
};
