// localStorage persistence: settings, history (last 100), phrasebook (starred).
const KEY = { settings: 'ot.settings.v1', history: 'ot.history.v1', saved: 'ot.phrasebook.v1', recents: 'ot.recentLangs.v1' };
const HISTORY_MAX = 100;

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } };

const DEFAULT_SETTINGS = {
  providerId: 'mock',          // Classic provider
  advancedProviderId: 'openai',// Advanced (LLM) provider
  mode: 'classic',             // classic | advanced
  providerConfig: {},          // { [providerId]: { field: value } }  (API keys live here, in this browser only)
  source: 'auto',
  target: 'es',
  liveTranslate: true,
  theme: 'system',             // system | light | dark
  speakConversation: true,
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((fn) => fn(what));

export const settings = {
  get() { return { ...DEFAULT_SETTINGS, ...read(KEY.settings, {}) }; },
  set(patch) { const next = { ...this.get(), ...patch }; write(KEY.settings, next); emit('settings'); return next; },
  providerConfig(id) { return this.get().providerConfig[id] || {}; },
  setProviderConfig(id, cfg) {
    const s = this.get();
    this.set({ providerConfig: { ...s.providerConfig, [id]: cfg } });
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
