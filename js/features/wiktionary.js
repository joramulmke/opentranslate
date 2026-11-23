// Look up a short translation on Wiktionary: meanings, gender, plural, pronunciation. Only for a word or a
// few (1–3 words), never for sentences. Opens the target language's Wiktionary, so the word is explained in
// the language it's in; languages without their own Wiktionary use the English one.
const EDITIONS = new Set(('en es fr de it pt nl ru zh ja ko ar hi bn ur fa tr pl uk cs sk hu ro bg el he sv da no '
  + 'fi et lv lt sl hr sr id ms th vi tl sw ta te mr ca ga az eo is sq mk bs gl eu cy kk uz ky hy ka af '
  + 'am ne si km lo my mn ps ku la lb mt kn ml gu pa').split(' '));
const ALIAS = { nb: 'no', nn: 'no', iw: 'he', fil: 'tl', zh: 'zh' };
const MAX_WORDS = 3;

function words(text, lang) {
  if (typeof Intl?.Segmenter === 'function') {
    try { return [...new Intl.Segmenter(lang || undefined, { granularity: 'word' }).segment(text)].filter((s) => s.isWordLike).length; }
    catch { /* unknown locale */ }
  }
  return text.split(/\s+/).filter(Boolean).length;
}

/** Short enough to be a word or a phrase, not a sentence. */
function isShort(text, lang) {
  const t = String(text || '').trim();
  if (!t || t.length > 60 || /[\n.!?;:,。！？；：、]/.test(t.replace(/\.$/, ''))) return false;
  const n = words(t, lang);
  return n >= 1 && n <= MAX_WORDS;
}

/**
 * The Wiktionary link for a translation, or null when it isn't a word or a few.
 * input/source: what was typed; text/target: the translation.
 * @returns {{ url: string, word: string } | null}
 */
export function wiktionaryLink({ input, source, text, target }) {
  if (!isShort(input, source) || !isShort(text, target)) return null;
  const word = String(text).trim().replace(/[.!?。！？]+$/, '');
  const base = String(target || 'en').toLowerCase().split('-')[0];
  const ed = ALIAS[base] || base;
  const host = EDITIONS.has(ed) ? ed : 'en';
  // the search page opens the entry when there is one, and search results otherwise (capitals, spelling)
  return { url: `https://${host}.wiktionary.org/w/index.php?search=${encodeURIComponent(word)}`, word };
}
