// Bundled fallback list: the 50 most common languages.
// Used when the active provider cannot list its languages (offline, misconfigured).
export const STATIC_LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'],
  ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'], ['hi', 'Hindi'],
  ['bn', 'Bengali'], ['ur', 'Urdu'], ['fa', 'Persian'], ['tr', 'Turkish'],
  ['pl', 'Polish'], ['uk', 'Ukrainian'], ['cs', 'Czech'], ['sk', 'Slovak'],
  ['hu', 'Hungarian'], ['ro', 'Romanian'], ['bg', 'Bulgarian'], ['el', 'Greek'],
  ['he', 'Hebrew'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'],
  ['fi', 'Finnish'], ['et', 'Estonian'], ['lv', 'Latvian'], ['lt', 'Lithuanian'],
  ['sl', 'Slovenian'], ['hr', 'Croatian'], ['sr', 'Serbian'], ['id', 'Indonesian'],
  ['ms', 'Malay'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['tl', 'Filipino'],
  ['sw', 'Swahili'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'],
  ['ca', 'Catalan'], ['ga', 'Irish'], ['az', 'Azerbaijani'], ['eo', 'Esperanto'],
].map(([code, name]) => ({ code, name }));

export const RTL_LANGS = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug']);

export const isRtl = (code) => RTL_LANGS.has(String(code || '').split('-')[0]);

// ISO 639-1 -> Tesseract traineddata names (for camera / handwriting OCR).
export const TESSERACT_LANGS = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld',
  ru: 'rus', zh: 'chi_sim', 'zh-Hant': 'chi_tra', zt: 'chi_tra', ja: 'jpn', ko: 'kor',
  ar: 'ara', hi: 'hin', bn: 'ben', ur: 'urd', fa: 'fas', tr: 'tur', pl: 'pol',
  uk: 'ukr', cs: 'ces', sk: 'slk', hu: 'hun', ro: 'ron', bg: 'bul', el: 'ell',
  he: 'heb', sv: 'swe', da: 'dan', no: 'nor', nb: 'nor', fi: 'fin', et: 'est',
  lv: 'lav', lt: 'lit', sl: 'slv', hr: 'hrv', sr: 'srp', id: 'ind', ms: 'msa',
  th: 'tha', vi: 'vie', tl: 'tgl', sw: 'swa', ta: 'tam', te: 'tel', mr: 'mar',
  ca: 'cat', ga: 'gle', az: 'aze', eo: 'epo', af: 'afr', sq: 'sqi', eu: 'eus',
  gl: 'glg', cy: 'cym', is: 'isl', mk: 'mkd', be: 'bel', ka: 'kat', hy: 'hye',
  kk: 'kaz', uz: 'uzb', ne: 'nep', si: 'sin', km: 'khm', lo: 'lao', my: 'mya',
  am: 'amh', la: 'lat', gu: 'guj', kn: 'kan', ml: 'mal', pa: 'pan',
};
