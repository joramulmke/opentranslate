// Chrome's built-in translator (Translator API, Chrome 138+ on computers): translation models that
// Chrome downloads per language pair and runs on the device. Nothing is downloaded from us, and the
// text doesn't leave the device. Language detection uses Chrome's LanguageDetector where there is one.
import { registerProvider, ProviderError } from '../providers.js';
import { STATIC_LANGUAGES } from '../languages.js';

const T = () => globalThis.Translator;
const D = () => globalThis.LanguageDetector;
export const chromeTranslatorSupported = () => typeof T()?.availability === 'function';

const code = (c) => (c === 'zh-Hant' ? 'zh-Hant' : String(c).split('-')[0]);

export class ChromeTranslatorProvider {
  constructor() {
    this.name = 'Chrome translator';
    this.translators = new Map();   // "en>es" -> Translator
  }

  async languages() { return STATIC_LANGUAGES; }

  async detect(text) {
    if (typeof D()?.create !== 'function') throw new ProviderError('UNSUPPORTED_PAIR', "Chrome can't detect the language here. Pick the language you're translating from.");
    this.detector ??= D().create();
    const [best] = await (await this.detector).detect(text);
    if (!best || best.detectedLanguage === 'und') throw new ProviderError('BAD_RESPONSE', "Couldn't tell which language this is.");
    return { language: best.detectedLanguage, confidence: best.confidence };
  }

  async _translator(source, target) {
    const key = `${source}>${target}`;
    if (!this.translators.has(key)) {
      const pair = { sourceLanguage: source, targetLanguage: target };
      const st = await T().availability(pair);
      if (st === 'unavailable') throw new ProviderError('UNSUPPORTED_PAIR', `Chrome's translator can't translate this language pair.`);
      // 'downloadable': Chrome downloads the pair now (it needs the click or keypress that started this)
      const p = T().create(pair);
      p.catch(() => this.translators.delete(key));
      this.translators.set(key, p);
    }
    return this.translators.get(key);
  }

  async translate(text, source, target) {
    if (!chromeTranslatorSupported()) throw new ProviderError('BROWSER_BLOCKED', 'Chrome’s built-in translator is only in Chrome on computers.');
    const from = !source || source === 'auto' ? (await this.detect(text)).language : source;
    if (code(from) === code(target)) return { text };
    let t;
    try { t = await this._translator(code(from), code(target)); } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(e?.name === 'NotAllowedError' ? 'NEEDS_DOWNLOAD' : 'SERVER', `Chrome's translator didn't start: ${e?.message || e}`);
    }
    return { text: await t.translate(text), ...(source === 'auto' ? { detected: { language: from } } : {}) };
  }

  async test() {
    if (!chromeTranslatorSupported()) return { ok: false, message: 'Chrome’s built-in translator is only in Chrome on computers.' };
    const st = await T().availability({ sourceLanguage: 'en', targetLanguage: 'es' });
    if (st === 'unavailable') return { ok: false, message: "Chrome's translator isn't available on this device." };
    const r = await this.translate('Good morning', 'en', 'es');
    return { ok: true, message: `Ready. “Good morning” → “${r.text}”. Chrome downloads each language pair the first time it's used.` };
  }
}

registerProvider({
  id: 'chrome-translator',
  label: 'Chrome translator',
  description: "Chrome's built-in translator. It runs on this device and Chrome downloads each language pair the first time it's used (from Google). Nothing you type leaves the device. Only in Chrome on computers.",
  fields: [],
  create: () => new ChromeTranslatorProvider(),
});
