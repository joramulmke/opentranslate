// Translating whole files and web pages (IDEAS #9). Each format is read into "segments" (pieces of text,
// e.g. a paragraph), the segments are translated in batches, and the same format is written back with the
// translation in place. Office files and e-books are ZIPs of XML; the ZIP reader (fflate) is loaded only
// when one is opened, from jsDelivr like the PDF reader.
import { state, translate, detect } from '../state.js';
import { spreadText } from './inplace.js';

const FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
let fflate = null;
const zipLib = () => (fflate ||= import(FFLATE).catch((e) => {
  fflate = null;
  throw new Error(`The file reader could not be loaded. Check the internet connection and try again. (${e.message || e})`);
}));

/** The proxy every copy of the app uses unless Settings or change-me.txt (web_proxy) name another. */
export const DEFAULT_PROXY = 'https://geoscope-proxy.joram-eu.workers.dev/fetch?url={url}';

export const ASK_ABOVE = 20000;   // characters: bigger files ask before translating
const BATCH_CHARS = 1800;
const BATCH_SEGMENTS = 40;
const hasWords = (s) => /\p{L}/u.test(s);

/* ---------------- translating segments ---------------- */

/**
 * Translate a list of texts. Sent in batches, one text per line; a batch whose answer has a different
 * number of lines is sent again text by text. Same texts are translated once.
 * @param {string[]} texts
 * @param {{ source: string, target: string, onProgress?: (done: number, total: number) => void, stopped?: () => boolean }} o
 * @returns {Promise<string[]>}
 */
export async function translateTexts(texts, { source, target, onProgress = () => {}, stopped = () => false }) {
  const out = texts.map((t) => t);
  const todo = new Map();   // text (trimmed, one line) → indices
  texts.forEach((t, i) => {
    const key = t.replace(/\s+/g, ' ').trim();
    if (!key || !hasWords(key)) return;
    if (!todo.has(key)) todo.set(key, []);
    todo.get(key).push(i);
  });
  const keys = [...todo.keys()];
  const total = keys.reduce((a, k) => a + k.length, 0);
  let done = 0;
  const put = (key, value) => {
    const lead = (s) => s.match(/^\s*/)[0];
    const trail = (s) => s.match(/\s*$/)[0];
    for (const i of todo.get(key)) out[i] = lead(texts[i]) + value.trim() + trail(texts[i]);
  };
  for (let i = 0; i < keys.length;) {
    if (stopped()) throw Object.assign(new Error('Stopped.'), { code: 'STOPPED' });
    const batch = [];
    let size = 0;
    while (i < keys.length && batch.length < BATCH_SEGMENTS && (!batch.length || size + keys[i].length < BATCH_CHARS)) {
      batch.push(keys[i]); size += keys[i].length + 1; i++;
    }
    const res = await translate(batch.join('\n'), source, target);
    const lines = res.text.split('\n').filter((l) => l.trim());
    if (lines.length === batch.length) batch.forEach((k, j) => put(k, lines[j]));
    else {
      for (const k of batch) {
        if (stopped()) throw Object.assign(new Error('Stopped.'), { code: 'STOPPED' });
        put(k, (await translate(k, source, target)).text.replace(/\s*\n\s*/g, ' '));
      }
    }
    done += size;
    onProgress(Math.min(done, total), total);
  }
  return out;
}

/** The source language: the one chosen, or detected from a sample of the text. */
export async function sourceFor(texts) {
  if (state.source !== 'auto') return state.source;
  const sample = texts.filter(hasWords).join('\n').slice(0, 1500);
  const d = await detect(sample).catch(() => null);
  return d?.language || 'auto';
}

/* ---------------- formats ---------------- */

export const FORMATS = {
  docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet',
  odp: 'OpenDocument presentation', epub: 'E-book', html: 'Web page', htm: 'Web page', xhtml: 'Web page',
  txt: 'Text', md: 'Markdown', srt: 'Subtitles', vtt: 'Subtitles', csv: 'Table', po: 'Translation file',
  json: 'JSON strings', pdf: 'PDF',
};
export const ACCEPT = Object.keys(FORMATS).map((e) => '.' + e).join(',');
export const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const canTranslateFile = (f) => extOf(f.name) in FORMATS;

/** The translated file's name: report.docx → report.en.docx */
export const outName = (name, target) => {
  const ext = extOf(name);
  return ext ? name.replace(new RegExp(`\\.${ext}$`, 'i'), `.${target}.${ext}`) : `${name}.${target}`;
};

/** A UTF-8 text file (or Windows-1252, for older files). */
async function readText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

/**
 * Open a file for translation.
 * @returns {Promise<{ kind: string, label: string, texts: string[], build: (translated: string[]) => Promise<Blob> }>}
 *   texts: the segments to translate; build: the translated file from their translations
 */
export async function openDocument(file, target) {
  const ext = extOf(file.name);
  const label = FORMATS[ext];
  if (!label) throw new Error('This kind of file can’t be translated here.');
  if (['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'epub'].includes(ext)) return { kind: ext, label, ...(await openZip(file, ext, target)) };
  const text = await readText(file);
  const type = { html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', json: 'application/json', csv: 'text/csv', md: 'text/markdown', vtt: 'text/vtt' }[ext] || 'text/plain';
  const blob = (s) => new Blob([s], { type: `${type};charset=utf-8` });
  const fmt = {
    txt: plainText, md: markdown, srt: subtitles, vtt: subtitles, csv, po, json: jsonStrings,
    html: (t) => htmlDoc(t, target), htm: (t) => htmlDoc(t, target), xhtml: (t) => htmlDoc(t, target, true),
  }[ext];
  const r = fmt(text);
  return { kind: ext, label, texts: r.texts, build: async (tr) => blob(r.build(tr)) };
}

/* plain text: paragraphs (lines joined); blank lines kept */
function plainText(text) {
  const parts = text.replace(/\r\n?/g, '\n').split(/(\n\s*\n)/);
  const idx = []; const texts = [];
  parts.forEach((p, i) => { if (i % 2 === 0 && p.trim()) { idx.push(i); texts.push(p.trim().replace(/\s*\n\s*/g, ' ')); } });
  const edges = (p) => [p.match(/^\s*/)[0], p.match(/\s*$/)[0]];
  return { texts, build: (tr) => { const o = [...parts]; idx.forEach((i, k) => { const [a, z] = edges(parts[i]); o[i] = a + tr[k].trim() + z; }); return o.join(''); } };
}

/* Markdown: line by line; headings, list marks and quotes kept; code blocks left alone */
function markdown(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const texts = []; const where = [];
  let code = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { code = !code; return; }
    if (code || /^\s{4,}\S/.test(l) || /^\s*(\||-{3,}|\*{3,})/.test(l)) return;
    const m = l.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ x]\]\s+)?|>\s*|\d+[.)]\s+)*)(.*)$/);
    if (m[2].trim()) { texts.push(m[2]); where.push([i, m[1]]); }
  });
  return { texts, build: (tr) => { const o = [...lines]; where.forEach(([i, pre], k) => { o[i] = pre + tr[k]; }); return o.join('\n'); } };
}

/* .srt / .vtt: each cue's lines translated together, then spread over as many lines; times kept */
function subtitles(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\n+/);
  const texts = []; const where = [];
  blocks.forEach((b, i) => {
    const lines = b.split('\n');
    const t = lines.findIndex((l) => l.includes('-->'));
    if (t < 0) return;
    const cue = lines.slice(t + 1).filter((l) => l.trim());
    if (!cue.join('').trim()) return;
    texts.push(cue.map((l) => l.replace(/<[^>]+>/g, '').trim()).join(' '));
    where.push([i, t, cue.length]);
  });
  return {
    texts,
    build: (tr) => {
      const o = [...blocks];
      where.forEach(([i, t, n], k) => {
        const lines = o[i].split('\n');
        o[i] = [...lines.slice(0, t + 1), ...spreadText(tr[k], Array(n).fill(1))].join('\n');
      });
      return o.join('\n\n') + '\n';
    },
  };
}

/* .csv: cells with words; numbers, dates, links and e-mail addresses left alone */
function csv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const texts = []; const where = [];
  rows.forEach((r, i) => r.forEach((c, j) => {
    if (hasWords(c) && !/^(https?:|www\.|\S+@\S+\.\w+$)/i.test(c.trim())) { texts.push(c); where.push([i, j]); }
  }));
  const quote = (c) => (/[",;\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return { texts, build: (tr) => { where.forEach(([i, j], k) => { rows[i][j] = tr[k]; }); return rows.map((r) => r.map(quote).join(sep)).join('\r\n') + '\r\n'; } };
}

/* .po (gettext): every msgid gets its translation as msgstr; the header is kept */
function po(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const unq = (s) => JSON.parse(s.replace(/^[^"]*/, '').trim());
  const q = (s) => JSON.stringify(s);
  const entries = []; let cur = null; let last = null;
  lines.forEach((l, i) => {
    let m;
    if ((m = l.match(/^(msgid|msgid_plural|msgstr(?:\[\d+\])?|msgctxt)\s+(".*")\s*$/))) {
      if (m[1] === 'msgid' || (m[1] === 'msgctxt')) { if (!cur || cur.done) { cur = { from: i, parts: {} }; entries.push(cur); } }
      if (m[1].startsWith('msgstr')) cur.done = true;
      cur.parts[m[1]] = { text: unq(m[2]), first: i, last: i };
      last = cur.parts[m[1]];
      cur.to = i;
    } else if (/^\s*"/.test(l) && last) { last.text += unq(l); last.last = i; cur.to = i; } else last = null;
  });
  const texts = []; const where = [];
  for (const e of entries) {
    if (!e.parts.msgid?.text) continue;   // header
    texts.push(e.parts.msgid.text); where.push([e, 'one']);
    if (e.parts.msgid_plural) { texts.push(e.parts.msgid_plural.text); where.push([e, 'many']); }
  }
  return {
    texts,
    build: (tr) => {
      const repl = new Map();   // line index → replacement lines (or null to drop)
      where.forEach(([e, which], k) => { (e.tr ||= {})[which] = tr[k]; });
      for (const e of entries) {
        if (!e.tr) continue;
        for (const [key, p] of Object.entries(e.parts)) {
          if (!key.startsWith('msgstr')) continue;
          const n = Number(key.match(/\[(\d+)\]/)?.[1] || 0);
          const value = n > 0 && e.tr.many != null ? e.tr.many : e.tr.one;
          repl.set(p.first, [`${key} ${q(value)}`]);
          for (let j = p.first + 1; j <= p.last; j++) repl.set(j, null);
        }
      }
      const o = [];
      lines.forEach((l, i) => { if (!repl.has(i)) o.push(l); else if (repl.get(i)) o.push(...repl.get(i)); });
      return o.join('\n');
    },
  };
}

/* .json: every string value with words (keys stay); links and paths left alone */
function jsonStrings(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This .json file could not be read.'); }
  const texts = []; const where = [];
  (function walk(v, set) {
    if (typeof v === 'string') { if (hasWords(v) && !/^(https?:|\/|\.\/|#)\S*$/.test(v)) { texts.push(v); where.push(set); } return; }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, (y) => { v[i] = y; }));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], (y) => { v[k] = y; });
  })(data, (y) => { data = y; });
  const indent = (text.match(/\n([ \t]+)"/) || [])[1] || '  ';
  return { texts, build: (tr) => { where.forEach((set, k) => set(tr[k])); return JSON.stringify(data, null, indent) + '\n'; } };
}

/* ---------------- HTML (files, e-book chapters, web pages) ---------------- */

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'SVG', 'MATH', 'TEMPLATE']);
const ATTRS = ['alt', 'title', 'placeholder', 'aria-label'];

/** The text of a parsed HTML or XHTML document as segments (text nodes and a few attributes). */
export function htmlSegments(doc) {
  const texts = []; const sets = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.nodeName.toUpperCase()) || n.getAttribute?.('translate') === 'no')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if (hasWords(n.nodeValue)) { texts.push(n.nodeValue); sets.push(((node) => (t) => { node.nodeValue = t; })(n)); }
    } else {
      for (const a of ATTRS) {
        const v = n.getAttribute(a);
        if (v && hasWords(v)) { texts.push(v); sets.push(((el, name) => (t) => el.setAttribute(name, t))(n, a)); }
      }
      if (n.nodeName.toLowerCase() === 'meta' && /^(description|og:title|og:description)$/i.test(n.getAttribute('name') || n.getAttribute('property') || '')) {
        const v = n.getAttribute('content');
        if (v && hasWords(v)) { texts.push(v); sets.push(((el) => (t) => el.setAttribute('content', t))(n)); }
      }
    }
  }
  return { texts, apply: (tr) => sets.forEach((set, k) => set(tr[k])) };
}

function htmlDoc(text, target, xhtml = false) {
  const doc = new DOMParser().parseFromString(text, xhtml ? 'application/xhtml+xml' : 'text/html');
  if (doc.querySelector('parsererror')) throw new Error('This file could not be read as a web page.');
  const seg = htmlSegments(doc);
  return {
    texts: seg.texts,
    build: (tr) => {
      seg.apply(tr);
      doc.documentElement.setAttribute('lang', target);
      if (xhtml) doc.documentElement.setAttribute('xml:lang', target);
      return xhtml ? new XMLSerializer().serializeToString(doc) : '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    },
  };
}

/* ---------------- ZIP files: Office, OpenDocument, e-books ---------------- */

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
};

/**
 * Paragraphs of an XML document: the text pieces (e.g. Word's <w:t>) grouped by the paragraph they are
 * in (the nearest <w:p>). The translation goes into the first piece; the others are emptied, so
 * formatting inside a paragraph (one bold word) applies to the whole paragraph afterwards.
 */
function xmlParagraphs(doc, { ns, para, piece, skip = () => false }) {
  const paras = new Map();
  const isPara = (n) => n.nodeType === 1 && n.namespaceURI === ns && para.includes(n.localName);
  const pieces = piece === '#text'
    ? (() => { const out = []; const w = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; })()
    : [...doc.getElementsByTagNameNS(ns, piece)];
  for (const t of pieces) {
    let p = t.parentNode;
    while (p && !isPara(p)) p = p.parentNode;
    if (!p || skip(p)) continue;
    if (!paras.has(p)) paras.set(p, []);
    paras.get(p).push(t);
  }
  const list = [...paras.values()].filter((ts) => hasWords(ts.map((t) => t.textContent).join('')));
  return {
    texts: list.map((ts) => ts.map((t) => t.textContent).join('')),
    apply: (tr) => list.forEach((ts, k) => {
      ts.forEach((t, j) => { t.textContent = j ? '' : tr[k]; });
      if (ts[0].nodeType === 1) ts[0].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    }),
  };
}

const odfSkipCell = (p) => {
  // a spreadsheet cell that holds a number, date or formula result: its text is how the number is shown
  let c = p.parentNode;
  while (c && !(c.namespaceURI === NS.table && c.localName === 'table-cell')) c = c.parentNode;
  const type = c?.getAttributeNS(NS.office, 'value-type');
  return !!(c && type && type !== 'string');
};

/** Which parts of the ZIP are translated, and how. */
function zipParts(names, ext) {
  const pick = (re) => names.filter((n) => re.test(n));
  switch (ext) {
    case 'docx': return pick(/^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/).map((n) => [n, { ns: NS.w, para: ['p'], piece: 't' }]);
    case 'pptx': return pick(/^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/).map((n) => [n, { ns: NS.a, para: ['p'], piece: 't' }]);
    case 'xlsx': return pick(/^xl\/sharedStrings\.xml$/).map((n) => [n, { ns: NS.x, para: ['si'], piece: 't' }])
      .concat(pick(/^xl\/worksheets\/sheet\d+\.xml$/).map((n) => [n, { ns: NS.x, para: ['is'], piece: 't' }]));
    case 'odt': case 'ods': case 'odp':
      return pick(/^(content|styles)\.xml$/).map((n) => [n, { ns: NS.text, para: ['p', 'h'], piece: '#text', skip: ext === 'ods' ? odfSkipCell : () => false }]);
    case 'epub': return pick(/\.(x?html?|ncx)$/i).map((n) => [n, /\.ncx$/i.test(n) ? { ns: 'http://www.daisy.org/z3986/2005/ncx/', para: ['text'], piece: '#text' } : 'html']);
    default: return [];
  }
}

async function openZip(file, ext, target) {
  const { unzipSync, zipSync, strFromU8, strToU8 } = await zipLib();
  let files;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch { throw new Error('This file could not be opened. Is it damaged, or protected with a password?'); }
  const parts = zipParts(Object.keys(files), ext);
  if (!parts.length) throw new Error('No text was found in this file.');
  const docs = parts.map(([name, how]) => {
    const xml = strFromU8(files[name]);
    if (how === 'html') {
      const doc = new DOMParser().parseFromString(xml, /\.html?$/i.test(name) && !/^<\?xml/.test(xml) ? 'text/html' : 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) return null;
      return { name, doc, html: !/^<\?xml/.test(xml) && /\.html?$/i.test(name), ...htmlSegments(doc) };
    }
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return { name, doc, ...xmlParagraphs(doc, how) };
  }).filter(Boolean);
  const texts = docs.flatMap((d) => d.texts);
  return {
    texts,
    build: async (tr) => {
      let k = 0;
      const out = {};
      for (const d of docs) {
        d.apply(tr.slice(k, k + d.texts.length)); k += d.texts.length;
        if (d.html) d.doc.documentElement.setAttribute('lang', target);
        files[d.name] = strToU8(d.html ? '<!DOCTYPE html>\n' + d.doc.documentElement.outerHTML : new XMLSerializer().serializeToString(d.doc));
      }
      if (ext === 'epub') setEpubLanguage(files, target, strFromU8, strToU8);
      // OpenDocument and e-books: "mimetype" first and not compressed, or other apps won't open them
      if (files.mimetype) out.mimetype = [files.mimetype, { level: 0 }];
      for (const [n, data] of Object.entries(files)) if (n !== 'mimetype') out[n] = data;
      const type = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
        odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip' }[ext];
      return new Blob([zipSync(out, { level: 6 })], { type });
    },
  };
}

function setEpubLanguage(files, target, strFromU8, strToU8) {
  for (const n of Object.keys(files).filter((x) => /\.opf$/i.test(x))) {
    const doc = new DOMParser().parseFromString(strFromU8(files[n]), 'application/xml');
    for (const l of doc.getElementsByTagNameNS(NS.dc, 'language')) l.textContent = target;
    files[n] = strToU8(new XMLSerializer().serializeToString(doc));
  }
}

/* ---------------- web pages by link ---------------- */

/** "https://proxy/?url={url}" → the address to fetch url through; without {url}, the link is added at the end. */
export function proxied(template, url) {
  const t = String(template || '').trim();
  if (!t) return url;
  return t.includes('{url}') ? t.replace('{url}', encodeURIComponent(url)) : t + encodeURIComponent(url);
}

/**
 * Fetch a web page, through the proxy set in Settings if there is one. Understands proxies that answer
 * with the page itself and ones that wrap it in JSON ({ body | contents | html, finalUrl }).
 * @returns {Promise<{ html: string, url: string }>}
 */
export async function fetchPage(url, proxy) {
  let res;
  try {
    res = await fetch(proxied(proxy, url), { headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5' } });
  } catch {
    throw new Error(proxy
      ? 'The proxy could not be reached, or it doesn’t allow this app. Check its address in Settings › Websites.'
      : 'This website can’t be read from another site. Set up your own proxy in Settings › Websites.');
  }
  const type = res.headers.get('content-type') || '';
  if (/json/.test(type)) {
    let d;
    try { d = await res.json(); } catch { throw new Error('The proxy’s answer could not be read.'); }
    const html = d.body ?? d.contents ?? d.html ?? d.data;
    if (d.ok === false || typeof html !== 'string') {
      const why = d.message || d.error || `error ${d.status || res.status}`;
      throw new Error(/NON_HTML|html/i.test(why) ? 'This link isn’t a web page.' : `The page could not be loaded: ${why}`);
    }
    if (d.status >= 400) throw new Error(`The website answered with error ${d.status}.`);
    return { html, url: d.finalUrl || d.url || d.status?.url || url };
  }
  if (!res.ok) throw new Error(`The page could not be loaded (error ${res.status}).`);
  if (type && !/html|xml|text\/plain/.test(type)) throw new Error('This link isn’t a web page.');
  return { html: await res.text(), url: res.headers.get('x-final-url') || url };
}

/**
 * A web page made safe to show: no scripts, frames or plug-ins; links and pictures relative to the page;
 * a policy that blocks any script. Its text as segments.
 */
export function openPage(html, url, target) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, base, link[rel~="preload"], link[rel~="modulepreload"], link[rel~="manifest"], meta[http-equiv]').forEach((n) => n.remove());
  for (const n of doc.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
  }
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
  const base = doc.createElement('base');
  base.setAttribute('href', url);
  head.prepend(csp, base);
  const seg = htmlSegments(doc);
  return {
    texts: seg.texts,
    title: () => doc.title,
    build: (tr) => { seg.apply(tr); doc.documentElement.setAttribute('lang', target); return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML; },
    original: () => '<!DOCTYPE html>\n' + doc.documentElement.outerHTML,
  };
}

/* ---------------- the proxy guide ---------------- */

/** A Cloudflare Worker that fetches pages for this app only (Settings › Websites › Make your own proxy). */
export const workerCode = (origin) => `// OpenTranslate proxy: fetches web pages for ${origin} only.
export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': '${origin}',
      'Access-Control-Expose-Headers': 'X-Final-URL',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    const target = new URL(req.url).searchParams.get('url');
    if (!target || !/^https?:\\/\\//.test(target)) return new Response('Add ?url=https://…', { status: 400, headers: cors });
    const res = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (OpenTranslate proxy)', 'Accept': 'text/html,*/*' } });
    const type = res.headers.get('Content-Type') || '';
    if (!/html|xml|text/.test(type)) return new Response('Not a web page', { status: 415, headers: cors });
    return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': type, 'X-Final-URL': res.url } });
  },
};
`;
