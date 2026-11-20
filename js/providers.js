// Translation provider layer.
//
// interface TranslationProvider {
//   name: string;
//   detect(text): Promise<{ language: string; confidence: number }>;        // confidence 0..1
//   translate(text, source, target): Promise<{ text: string; detected?: string }>;
//   languages(): Promise<Array<{ code: string; name: string }>>;
// }
//
// Providers are registered as *definitions* in PROVIDERS. Each definition describes
// its own settings fields, so the Settings sheet renders them generically. Adding a
// DeepL or Google Cloud provider = one more registerProvider() call; no UI changes.

import { STATIC_LANGUAGES } from './languages.js';

/** Error with a machine-readable code the UI maps to a visible state. */
export class ProviderError extends Error {
  /**
   * @param {'NO_PROVIDER'|'NETWORK'|'UNSUPPORTED_PAIR'|'AUTH'|'RATE_LIMIT'|'SERVER'|'BAD_RESPONSE'|'TOO_LONG'} code
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.detail = detail;
  }
}

const PROVIDERS = new Map();

/**
 * @param {{ id: string, label: string, description?: string,
 *           fields?: Array<{key:string,label:string,type?:'text'|'url'|'password'|'select',
 *                           placeholder?:string, help?:string, options?:Array<{value:string,label:string}>,
 *                           default?:string, required?:boolean}>,
 *           create: (config: object) => object }} def
 */
export function registerProvider(def) {
  PROVIDERS.set(def.id, def);
}

/** @param {'classic'|'advanced'} [kind]  Classic = Mock/LibreTranslate-style; Advanced = LLM-based. */
export const listProviders = (kind) => [...PROVIDERS.values()].filter((p) => !kind || (p.kind || 'classic') === kind);
export const getProviderDef = (id) => PROVIDERS.get(id);

/** Build a provider instance from saved settings, or throw NO_PROVIDER if it's not usable. */
export function createProvider(id, config = {}, { skipRequired = false } = {}) {
  const def = PROVIDERS.get(id);
  if (!def) throw new ProviderError('NO_PROVIDER', 'No translation provider is selected.');
  const cfg = { ...defaults(def), ...config };
  for (const f of def.fields || []) {
    if (f.required && !skipRequired && !String(cfg[f.key] || '').trim()) {
      throw new ProviderError('NO_PROVIDER', `${def.label} needs a ${f.label.toLowerCase()} before it can translate.`);
    }
  }
  return def.create(cfg);
}

function defaults(def) {
  const out = {};
  for (const f of def.fields || []) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ */
/* MockProvider: offline, deterministic                                     */
/* ------------------------------------------------------------------------ */

// A small phrasebook so common sentences produce real-looking output offline.
const PHRASES = {
  'hello':                   { es: 'hola', fr: 'bonjour', de: 'hallo', it: 'ciao', pt: 'olá', nl: 'hallo', ja: 'こんにちは', zh: '你好', ko: '안녕하세요', ru: 'привет', ar: 'مرحبا', tr: 'merhaba', pl: 'cześć', sv: 'hej' },
  'good morning':            { es: 'buenos días', fr: 'bonjour', de: 'guten Morgen', it: 'buongiorno', pt: 'bom dia', nl: 'goedemorgen', ja: 'おはようございます', zh: '早上好', ko: '좋은 아침입니다', ru: 'доброе утро', ar: 'صباح الخير', tr: 'günaydın', pl: 'dzień dobry', sv: 'god morgon' },
  'good night':              { es: 'buenas noches', fr: 'bonne nuit', de: 'gute Nacht', it: 'buonanotte', pt: 'boa noite', nl: 'goedenacht', ja: 'おやすみなさい', zh: '晚安', ko: '안녕히 주무세요', ru: 'спокойной ночи', ar: 'تصبح على خير', tr: 'iyi geceler', pl: 'dobranoc', sv: 'god natt' },
  'thank you':               { es: 'gracias', fr: 'merci', de: 'danke', it: 'grazie', pt: 'obrigado', nl: 'dank je', ja: 'ありがとう', zh: '谢谢', ko: '감사합니다', ru: 'спасибо', ar: 'شكرا', tr: 'teşekkür ederim', pl: 'dziękuję', sv: 'tack' },
  'thank you very much':     { es: 'muchas gracias', fr: 'merci beaucoup', de: 'vielen Dank', it: 'grazie mille', pt: 'muito obrigado', nl: 'heel erg bedankt', ja: 'どうもありがとうございます', zh: '非常感谢', ko: '정말 감사합니다', ru: 'большое спасибо', ar: 'شكرا جزيلا', tr: 'çok teşekkür ederim', pl: 'dziękuję bardzo', sv: 'tack så mycket' },
  'how are you?':            { es: '¿cómo estás?', fr: 'comment allez-vous ?', de: 'wie geht es dir?', it: 'come stai?', pt: 'como você está?', nl: 'hoe gaat het?', ja: 'お元気ですか？', zh: '你好吗？', ko: '어떻게 지내세요?', ru: 'как дела?', ar: 'كيف حالك؟', tr: 'nasılsın?', pl: 'jak się masz?', sv: 'hur mår du?' },
  'where is the bathroom?':  { es: '¿dónde está el baño?', fr: 'où sont les toilettes ?', de: 'wo ist die Toilette?', it: "dov'è il bagno?", pt: 'onde fica o banheiro?', nl: 'waar is het toilet?', ja: 'トイレはどこですか？', zh: '洗手间在哪里？', ko: '화장실이 어디예요?', ru: 'где туалет?', ar: 'أين الحمام؟', tr: 'tuvalet nerede?', pl: 'gdzie jest łazienka?', sv: 'var är toaletten?' },
  'how much does this cost?':{ es: '¿cuánto cuesta esto?', fr: 'combien ça coûte ?', de: 'wie viel kostet das?', it: 'quanto costa questo?', pt: 'quanto custa isso?', nl: 'hoeveel kost dit?', ja: 'これはいくらですか？', zh: '这个多少钱？', ko: '이거 얼마예요?', ru: 'сколько это стоит?', ar: 'كم يكلف هذا؟', tr: 'bu ne kadar?', pl: 'ile to kosztuje?', sv: 'vad kostar det här?' },
  'nice to meet you':        { es: 'encantado de conocerte', fr: 'enchanté', de: 'freut mich, dich kennenzulernen', it: 'piacere di conoscerti', pt: 'prazer em conhecê-lo', nl: 'leuk je te ontmoeten', ja: 'はじめまして', zh: '很高兴认识你', ko: '만나서 반갑습니다', ru: 'приятно познакомиться', ar: 'تشرفت بلقائك', tr: 'tanıştığıma memnun oldum', pl: 'miło cię poznać', sv: 'trevligt att träffas' },
  'goodbye':                 { es: 'adiós', fr: 'au revoir', de: 'auf Wiedersehen', it: 'arrivederci', pt: 'adeus', nl: 'tot ziens', ja: 'さようなら', zh: '再见', ko: '안녕히 가세요', ru: 'до свидания', ar: 'وداعا', tr: 'hoşça kal', pl: 'do widzenia', sv: 'hej då' },
  'i love you':              { es: 'te quiero', fr: "je t'aime", de: 'ich liebe dich', it: 'ti amo', pt: 'eu te amo', nl: 'ik hou van je', ja: '愛してる', zh: '我爱你', ko: '사랑해요', ru: 'я тебя люблю', ar: 'أحبك', tr: 'seni seviyorum', pl: 'kocham cię', sv: 'jag älskar dig' },
  'excuse me':               { es: 'disculpe', fr: 'excusez-moi', de: 'entschuldigung', it: 'mi scusi', pt: 'com licença', nl: 'pardon', ja: 'すみません', zh: '打扰一下', ko: '실례합니다', ru: 'извините', ar: 'عفوا', tr: 'affedersiniz', pl: 'przepraszam', sv: 'ursäkta' },
  'please':                  { es: 'por favor', fr: "s'il vous plaît", de: 'bitte', it: 'per favore', pt: 'por favor', nl: 'alstublieft', ja: 'お願いします', zh: '请', ko: '제발', ru: 'пожалуйста', ar: 'من فضلك', tr: 'lütfen', pl: 'proszę', sv: 'snälla' },
  'yes':                     { es: 'sí', fr: 'oui', de: 'ja', it: 'sì', pt: 'sim', nl: 'ja', ja: 'はい', zh: '是', ko: '네', ru: 'да', ar: 'نعم', tr: 'evet', pl: 'tak', sv: 'ja' },
  'no':                      { es: 'no', fr: 'non', de: 'nein', it: 'no', pt: 'não', nl: 'nee', ja: 'いいえ', zh: '不', ko: '아니요', ru: 'нет', ar: 'لا', tr: 'hayır', pl: 'nie', sv: 'nej' },
  'i don\'t understand':     { es: 'no entiendo', fr: 'je ne comprends pas', de: 'ich verstehe nicht', it: 'non capisco', pt: 'não entendo', nl: 'ik begrijp het niet', ja: 'わかりません', zh: '我不明白', ko: '이해가 안 돼요', ru: 'я не понимаю', ar: 'أنا لا أفهم', tr: 'anlamıyorum', pl: 'nie rozumiem', sv: 'jag förstår inte' },
  'cheers':                  { es: 'salud', fr: 'santé', de: 'prost', it: 'salute', pt: 'saúde', nl: 'proost', ja: '乾杯', zh: '干杯', ko: '건배', ru: 'будем здоровы', ar: 'في صحتك', tr: 'şerefe', pl: 'na zdrowie', sv: 'skål' },
};

// Word-level fallback dictionary (English -> a few targets).
const WORDS = {
  es: { the: 'el', a: 'un', is: 'es', are: 'son', i: 'yo', you: 'tú', we: 'nosotros', and: 'y', or: 'o', not: 'no', with: 'con', for: 'para', in: 'en', on: 'en', of: 'de', to: 'a', my: 'mi', your: 'tu', this: 'esto', that: 'eso', water: 'agua', coffee: 'café', tea: 'té', food: 'comida', train: 'tren', station: 'estación', ticket: 'billete', hotel: 'hotel', room: 'habitación', street: 'calle', city: 'ciudad', friend: 'amigo', house: 'casa', car: 'coche', book: 'libro', dog: 'perro', cat: 'gato', today: 'hoy', tomorrow: 'mañana', good: 'bueno', bad: 'malo', big: 'grande', small: 'pequeño', want: 'quiero', need: 'necesito', have: 'tengo', where: 'dónde', when: 'cuándo', what: 'qué', open: 'abierto', closed: 'cerrado', exit: 'salida', entrance: 'entrada', menu: 'menú', bill: 'cuenta', help: 'ayuda' },
  fr: { the: 'le', a: 'un', is: 'est', are: 'sont', i: 'je', you: 'vous', we: 'nous', and: 'et', or: 'ou', not: 'pas', with: 'avec', for: 'pour', in: 'dans', on: 'sur', of: 'de', to: 'à', my: 'mon', your: 'votre', this: 'ceci', that: 'cela', water: 'eau', coffee: 'café', tea: 'thé', food: 'nourriture', train: 'train', station: 'gare', ticket: 'billet', hotel: 'hôtel', room: 'chambre', street: 'rue', city: 'ville', friend: 'ami', house: 'maison', car: 'voiture', book: 'livre', dog: 'chien', cat: 'chat', today: "aujourd'hui", tomorrow: 'demain', good: 'bon', bad: 'mauvais', big: 'grand', small: 'petit', want: 'veux', need: 'besoin', have: 'ai', where: 'où', when: 'quand', what: 'quoi', open: 'ouvert', closed: 'fermé', exit: 'sortie', entrance: 'entrée', menu: 'menu', bill: 'addition', help: 'aide' },
  de: { the: 'der', a: 'ein', is: 'ist', are: 'sind', i: 'ich', you: 'du', we: 'wir', and: 'und', or: 'oder', not: 'nicht', with: 'mit', for: 'für', in: 'in', on: 'auf', of: 'von', to: 'zu', my: 'mein', your: 'dein', this: 'dies', that: 'das', water: 'Wasser', coffee: 'Kaffee', tea: 'Tee', food: 'Essen', train: 'Zug', station: 'Bahnhof', ticket: 'Fahrkarte', hotel: 'Hotel', room: 'Zimmer', street: 'Straße', city: 'Stadt', friend: 'Freund', house: 'Haus', car: 'Auto', book: 'Buch', dog: 'Hund', cat: 'Katze', today: 'heute', tomorrow: 'morgen', good: 'gut', bad: 'schlecht', big: 'groß', small: 'klein', want: 'will', need: 'brauche', have: 'habe', where: 'wo', when: 'wann', what: 'was', open: 'geöffnet', closed: 'geschlossen', exit: 'Ausgang', entrance: 'Eingang', menu: 'Speisekarte', bill: 'Rechnung', help: 'Hilfe' },
};

const STOPWORDS = {
  en: ['the', 'and', 'is', 'you', 'to', 'of', 'it', 'this', 'that', 'what', 'where', 'how', 'are', 'i', 'my', 'with', 'hello', 'thank'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'es', 'por', 'una', 'con', 'para', 'dónde', 'está', 'hola', 'gracias', 'cómo'],
  fr: ['le', 'la', 'les', 'de', 'et', 'est', 'un', 'une', 'je', 'vous', 'pas', 'pour', 'où', 'bonjour', 'merci', 'avec', 'que'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'ein', 'eine', 'zu', 'mit', 'wo', 'wie', 'hallo', 'danke', 'du', 'sie'],
  it: ['il', 'la', 'di', 'che', 'e', 'è', 'un', 'una', 'per', 'non', 'sono', 'dove', 'ciao', 'grazie', 'come', 'gli'],
  pt: ['o', 'a', 'de', 'que', 'e', 'é', 'um', 'uma', 'para', 'não', 'com', 'onde', 'olá', 'obrigado', 'você', 'está'],
  nl: ['de', 'het', 'een', 'en', 'is', 'ik', 'niet', 'van', 'je', 'waar', 'hoe', 'hallo', 'dank', 'zijn', 'wat'],
  sv: ['och', 'att', 'det', 'är', 'jag', 'en', 'som', 'på', 'inte', 'var', 'hej', 'tack', 'du', 'med'],
  pl: ['i', 'w', 'nie', 'się', 'jest', 'to', 'na', 'że', 'jak', 'gdzie', 'cześć', 'dziękuję', 'ja', 'z'],
  tr: ['ve', 'bir', 'bu', 'da', 'ne', 'için', 'ben', 'nerede', 'merhaba', 'evet', 'değil', 'çok'],
  id: ['dan', 'yang', 'di', 'ini', 'itu', 'saya', 'tidak', 'dengan', 'apa', 'terima', 'kasih'],
};

function detectHeuristic(text) {
  const t = text.trim();
  if (!t) return { language: 'en', confidence: 0 };
  const scripts = [
    [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'],
    [/[؀-ۿ]/, /[پچژگ]/.test(t) ? 'fa' : 'ar'], [/[֐-׿]/, 'he'],
    [/[Ͱ-Ͽ]/, 'el'], [/[฀-๿]/, 'th'], [/[ऀ-ॿ]/, 'hi'],
    [/[ঀ-৿]/, 'bn'], [/[஀-௿]/, 'ta'],
    [/[Ѐ-ӿ]/, /[іїєґ]/i.test(t) ? 'uk' : /[ъ]/.test(t) && !/[ыэ]/.test(t) ? 'bg' : 'ru'],
  ];
  for (const [re, lang] of scripts) if (re.test(t)) return { language: lang, confidence: 0.92 };

  const words = t.toLowerCase().match(/[\p{L}']+/gu) || [];
  // phrase table hit?
  const norm = normalize(t);
  for (const [en, tr] of Object.entries(PHRASES)) {
    if (normalize(en) === norm) return { language: 'en', confidence: 0.98 };
    for (const [lang, s] of Object.entries(tr)) if (normalize(s) === norm) return { language: lang, confidence: 0.97 };
  }
  const scores = {};
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    scores[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  // diacritic hints
  if (/[ñ¿¡]/.test(t)) scores.es += 2;
  if (/[çœèêà]/.test(t)) scores.fr += 2;
  if (/[äöüß]/.test(t)) scores.de += 2;
  if (/[ãõ]/.test(t)) scores.pt += 2;
  if (/[ąęłńśźż]/.test(t)) scores.pl += 2;
  if (/[ğış]/.test(t)) scores.tr += 2;
  if (/[å]/.test(t)) scores.sv += 2;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const total = ranked.reduce((n, [, s]) => n + s, 0);
  if (!bestScore) return { language: 'en', confidence: 0.35 };
  return { language: best, confidence: Math.min(0.95, 0.4 + 0.55 * (bestScore / total)) };
}

function normalize(s) {
  return s.toLowerCase().replace(/[\s　]+/g, ' ').replace(/[.!¡¿?？。,，'’"]/g, '').trim();
}

// Deterministic "pseudo-translation" for text the mock dictionary doesn't know.
const ACCENTS = { a: 'á', e: 'é', i: 'í', o: 'ö', u: 'ü', c: 'ç', n: 'ñ', A: 'Á', E: 'É', I: 'Í', O: 'Ö', U: 'Ü', C: 'Ç', N: 'Ñ' };
const pseudo = (s) => s.replace(/[aeioucnAEIOUCN]/g, (c) => ACCENTS[c]);

function caseLike(src, out) {
  if (!out) return out;
  if (src && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) {
    return out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

function mockTranslateLine(line, source, target) {
  if (!line.trim() || source === target) return line;
  const norm = normalize(line);
  const trailing = (line.trim().match(/[.!?？。]+$/) || [''])[0];
  // 1) phrase table (pivot through English)
  let english = null;
  if (source === 'en') english = Object.keys(PHRASES).find((k) => normalize(k) === norm) || null;
  else {
    for (const [en, tr] of Object.entries(PHRASES)) if (tr[source] && normalize(tr[source]) === norm) { english = en; break; }
  }
  if (english) {
    if (target === 'en') return caseLike(line, english);
    const hit = PHRASES[english][target];
    if (hit) return caseLike(line, hit);
  }
  // 2) word-by-word for en -> es/fr/de
  if (source === 'en' && WORDS[target]) {
    const dict = WORDS[target];
    let replaced = 0;
    const out = line.replace(/[A-Za-z']+/g, (w) => {
      const tr = dict[w.toLowerCase()];
      if (tr) { replaced++; return w[0] === w[0].toUpperCase() ? tr[0].toUpperCase() + tr.slice(1) : tr; }
      return w;
    });
    if (replaced) return out;
  }
  // 3) deterministic pseudo-translation, clearly marked as mock output
  return pseudo(line.replace(/[.!?？。]+$/, '')) + trailing;
}

registerProvider({
  id: 'mock',
  label: 'Offline demo (Mock)',
  description: 'Works without a network. Knows a small set of phrases; everything else gets a deterministic placeholder translation.',
  fields: [
    {
      key: 'simulate', label: 'Simulate', type: 'select', default: 'none',
      help: 'Force an error state to see how the app handles it.',
      options: [
        { value: 'none', label: 'Normal behaviour' },
        { value: 'slow', label: 'Slow network (2 s)' },
        { value: 'network', label: 'Network failure' },
        { value: 'unsupported', label: 'Unsupported language pair' },
      ],
    },
  ],
  create(cfg) {
    const simulate = async () => {
      await sleep(cfg.simulate === 'slow' ? 2000 : 120);
      if (cfg.simulate === 'network') throw new ProviderError('NETWORK', 'Simulated network failure.');
    };
    return {
      name: 'Mock',
      isMock: true,
      async languages() { await sleep(20); return STATIC_LANGUAGES; },
      async detect(text) { await simulate(); return detectHeuristic(text); },
      async translate(text, source, target) {
        await simulate();
        let detected;
        if (!source || source === 'auto') { detected = detectHeuristic(text).language; source = detected; }
        if (cfg.simulate === 'unsupported') {
          throw new ProviderError('UNSUPPORTED_PAIR', `Translating from ${source} to ${target} isn't supported.`);
        }
        const out = text.split('\n').map((l) => mockTranslateLine(l, source, target)).join('\n');
        return { text: out, detected };
      },
      async test() { await simulate(); return { ok: true, message: `Ready, ${STATIC_LANGUAGES.length} languages (offline).` }; },
    };
  },
});

/* ------------------------------------------------------------------------ */
/* LibreTranslateProvider: standard LibreTranslate REST API                 */
/* ------------------------------------------------------------------------ */

registerProvider({
  id: 'libretranslate',
  label: 'LibreTranslate',
  description: 'Any LibreTranslate server, self-hosted or hosted. Uses /languages, /detect and /translate.',
  fields: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', placeholder: 'http://localhost:5000', default: 'http://localhost:5000', required: true,
      help: 'Run one locally with: docker run -p 5000:5000 libretranslate/libretranslate' },
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'Optional', help: 'Only needed if the server requires keys.' },
  ],
  create(cfg) { return new LibreTranslateProvider(cfg); },
});

export class LibreTranslateProvider {
  constructor({ baseUrl, apiKey }) {
    this.name = 'LibreTranslate';
    this.base = String(baseUrl).trim().replace(/\/+$/, '');
    this.apiKey = String(apiKey || '').trim();
    this._langs = null;
  }

  async _req(path, body, { timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(this.base + path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(this.apiKey ? { ...body, api_key: this.apiKey } : body), signal: ctrl.signal }
        : { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    } catch (e) {
      const why = e.name === 'AbortError' ? 'The server took too long to answer.' : `Can't reach ${this.base}.`;
      throw new ProviderError('NETWORK', why, e);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 401) throw new ProviderError('AUTH', `The server refused the request: ${msg}`);
      if (res.status === 429) throw new ProviderError('RATE_LIMIT', `Too many requests: ${msg}`);
      if (res.status === 400 && /not supported|unsupported|not available/i.test(msg)) throw new ProviderError('UNSUPPORTED_PAIR', msg);
      if (res.status === 400 && /characters|limit/i.test(msg)) throw new ProviderError('TOO_LONG', msg);
      throw new ProviderError('SERVER', msg);
    }
    if (data === null) throw new ProviderError('BAD_RESPONSE', 'The server sent something that is not JSON.');
    return data;
  }

  async _rawLanguages() {
    if (!this._langs) {
      const data = await this._req('/languages');
      if (!Array.isArray(data)) throw new ProviderError('BAD_RESPONSE', 'Unexpected /languages response.');
      this._langs = data;
    }
    return this._langs;
  }

  async languages() {
    const list = await this._rawLanguages();
    return list.map(({ code, name }) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async detect(text) {
    const data = await this._req('/detect', { q: text });
    const best = Array.isArray(data) ? data[0] : null;
    if (!best) throw new ProviderError('BAD_RESPONSE', 'The server could not detect a language.');
    return { language: best.language, confidence: (best.confidence ?? 0) / 100 };
  }

  async translate(text, source, target) {
    // Pre-check the pair against /languages when we have it, for a clearer error.
    if (source && source !== 'auto' && this._langs) {
      const src = this._langs.find((l) => l.code === source);
      if (src && Array.isArray(src.targets) && !src.targets.includes(target)) {
        const tName = this._langs.find((l) => l.code === target)?.name || target;
        throw new ProviderError('UNSUPPORTED_PAIR', `This server can't translate ${src.name} to ${tName}.`);
      }
    }
    const data = await this._req('/translate', { q: text, source: source || 'auto', target, format: 'text' });
    if (typeof data.translatedText !== 'string') throw new ProviderError('BAD_RESPONSE', 'Missing translatedText in response.');
    return { text: data.translatedText, detected: data.detectedLanguage?.language };
  }

  async test() {
    const langs = await this.languages();
    const raw = await this._rawLanguages();
    const en = raw.find((l) => l.code === 'en');
    const target = (en?.targets || []).find((c) => c !== 'en') || langs.find((l) => l.code !== 'en')?.code || 'es';
    const sample = await this.translate('Hello', en ? 'en' : 'auto', target).catch((e) => e);
    if (sample instanceof Error) {
      return { ok: false, message: `Languages OK (${langs.length}), but translate failed: ${sample.message}` };
    }
    return { ok: true, message: `Connected: ${langs.length} languages. "Hello" → "${sample.text}"` };
  }
}

/* ------------------------------------------------------------------------ */
/* OpenAICompatibleProvider: "Advanced" translation via any chat-completions */
/* API (OpenAI, OpenRouter, Groq, Mistral, DeepSeek, Ollama, LM Studio, …)   */
/* ------------------------------------------------------------------------ */

export const OPENAI_PRESETS = {
  openai:     { label: 'OpenAI',          baseUrl: 'https://api.openai.com/v1',      needsKey: true },
  openrouter: { label: 'OpenRouter',      baseUrl: 'https://openrouter.ai/api/v1',   needsKey: true },
  groq:       { label: 'Groq',            baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  mistral:    { label: 'Mistral',         baseUrl: 'https://api.mistral.ai/v1',      needsKey: true },
  deepseek:   { label: 'DeepSeek',        baseUrl: 'https://api.deepseek.com/v1',    needsKey: true },
  ollama:     { label: 'Ollama (local)',  baseUrl: 'http://localhost:11434/v1',      needsKey: false },
  lmstudio:   { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1',     needsKey: false },
  custom:     { label: 'Custom',          baseUrl: '',                               needsKey: false },
};

registerProvider({
  id: 'openai',
  kind: 'advanced',
  label: 'OpenAI-compatible API',
  description: 'Uses a large language model through any OpenAI-compatible /chat/completions endpoint. Your API key is stored only in this browser and sent only to the URL below.',
  fields: [
    { key: 'preset', label: 'Service', type: 'select', default: 'openai',
      options: Object.entries(OPENAI_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      fills: (value) => (OPENAI_PRESETS[value]?.baseUrl ? { baseUrl: OPENAI_PRESETS[value].baseUrl } : {}) },
    { key: 'baseUrl', label: 'API base URL', type: 'url', default: OPENAI_PRESETS.openai.baseUrl, required: true,
      placeholder: 'https://api.openai.com/v1',
      help: 'Local servers (Ollama, LM Studio) must allow this page’s origin (CORS), e.g. OLLAMA_ORIGINS=*.' },
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'sk-…', help: 'Leave empty for local servers.' },
    { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'e.g. gpt-4o-mini, llama3.1',
      suggest: true, help: '“Test connection” fills in the models your server offers.' },
  ],
  create(cfg) { return new OpenAICompatibleProvider(cfg); },
});

const langLabel = (code) => {
  if (!code || code === 'auto') return null;
  const hit = STATIC_LANGUAGES.find((l) => l.code === code);
  if (hit) return `${hit.name} (${code})`;
  try { return `${new Intl.DisplayNames(['en'], { type: 'language' }).of(code)} (${code})`; } catch { return code; }
};

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey, model }) {
    this.name = 'OpenAI-compatible';
    this.isAdvanced = true;
    this.base = String(baseUrl).trim().replace(/\/+$/, '');
    this.apiKey = String(apiKey || '').trim();
    this.model = String(model || '').trim();
  }

  async _req(path, body, { timeout = 60000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res;
    try {
      res = await fetch(this.base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    } catch (e) {
      const local = /localhost|127\.0\.0\.1/.test(this.base);
      const why = e.name === 'AbortError' ? 'The model took too long to answer.'
        : `Can't reach ${this.base}.${local ? ' Is the server running and allowing this origin (CORS)?' : ''}`;
      throw new ProviderError('NETWORK', why, e);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || data?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new ProviderError('AUTH', `The API refused the key: ${msg}`);
      if (res.status === 429) throw new ProviderError('RATE_LIMIT', `Rate limit or quota reached: ${msg}`);
      if (res.status === 404 && /model/i.test(String(msg))) throw new ProviderError('SERVER', `Unknown model “${this.model}”: ${msg}`);
      throw new ProviderError('SERVER', String(msg));
    }
    if (data === null) throw new ProviderError('BAD_RESPONSE', 'The API sent something that is not JSON.');
    return data;
  }

  async _chat(system, user, maxTokens) {
    const data = await this._req('/chat/completions', {
      model: this.model,
      temperature: 0,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    const out = data?.choices?.[0]?.message?.content;
    if (typeof out !== 'string') throw new ProviderError('BAD_RESPONSE', 'The API answered without any text.');
    return out.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, ''); // strip reasoning blocks some local models emit
  }

  async languages() { return STATIC_LANGUAGES; }

  async detect(text) {
    const out = await this._chat(
      'Identify the language of the user’s text. Reply with only its ISO 639-1 code in lowercase (e.g. en, es, zh). No other words.',
      text.slice(0, 1000), 8);
    const code = (out.trim().toLowerCase().match(/[a-z]{2,3}(-[a-z]{2,4})?/) || [])[0];
    if (!code) throw new ProviderError('BAD_RESPONSE', 'The model did not return a language code.');
    return { language: code, confidence: 0.9 };
  }

  async translate(text, source, target) {
    const from = langLabel(source);
    const to = langLabel(target) || target;
    const system = [
      `You are a professional translation engine. Translate the user's text ${from ? `from ${from} ` : ''}into ${to}.`,
      'Return ONLY the translation: no quotes, notes, explanations or transliteration.',
      'Preserve meaning, tone, line breaks, numbers, names, URLs and formatting.',
      'If the text is already in the target language, return it unchanged.',
    ].join(' ');
    const out = await this._chat(system, text);
    return { text: out.trim() };
  }

  /**
   * Read handwriting / text in an image with a vision-capable model.
   * @returns {Promise<string[]>} best guess first, then alternatives
   */
  async recognizeImage(dataUrl, langHint) {
    const hint = langLabel(langHint);
    const prompt = [
      'The image shows handwriting drawn on a touch pad (dark ink on white).',
      hint ? `It is most likely ${hint}.` : '',
      'Transcribe exactly what is written, keeping the original language and script; do not translate or correct it.',
      'Reply with JSON only: {"candidates": ["best reading", "alternative", "alternative"]} with 1 to 4 distinct readings.',
    ].filter(Boolean).join(' ');
    let data;
    try {
      data = await this._req('/chat/completions', {
        model: this.model, temperature: 0, max_tokens: 200,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      });
    } catch (e) {
      if (e.code === 'SERVER' && /image|vision|multimodal|content.*type|not support/i.test(e.message)) {
        throw new ProviderError('UNSUPPORTED_PAIR', `“${this.model}” can't read images. Choose a vision-capable model for handwriting.`);
      }
      throw e;
    }
    const raw = String(data?.choices?.[0]?.message?.content || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
    const json = raw.match(/\{[\s\S]*\}/);
    let list = [];
    if (json) { try { list = JSON.parse(json[0]).candidates || []; } catch { /* fall through */ } }
    if (!list.length && raw) list = [raw.replace(/^["'`]+|["'`]+$/g, '')];
    return [...new Set(list.map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 4);
  }

  async listModels() {
    const data = await this._req('/models', null, { timeout: 15000 });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return list.map((m) => m.id || m.name).filter(Boolean).sort();
  }

  async test() {
    let models = [];
    try { models = await this.listModels(); } catch (e) { if (e.code === 'AUTH' || e.code === 'NETWORK') throw e; }
    if (!this.model) return { ok: false, models, message: `Connected${models.length ? `, ${models.length} models available` : ''}. Pick a model, then test again.` };
    const r = await this.translate('Good morning', 'en', 'es');
    return { ok: true, models, message: `Connected. ${this.model}: “Good morning” → “${r.text}”` };
  }
}

// Example of how a future provider plugs in (kept commented so the UI stays honest):
//
// registerProvider({
//   id: 'deepl', label: 'DeepL',
//   fields: [{ key: 'apiKey', label: 'Auth key', type: 'password', required: true }],
//   create: (cfg) => new DeepLProvider(cfg),   // implements detect/translate/languages
// });
