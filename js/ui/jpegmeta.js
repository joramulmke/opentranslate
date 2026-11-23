// A text description written into a JPEG, so gallery apps (and, more and more, screen readers) can say
// what a translated photo shows: "Pharmacy, please ring (German: Apotheke, bitte klingeln)".
// Two places, because readers differ: EXIF ImageDescription and XMP dc:description (both UTF-8).

const enc = new TextEncoder();
const MAX = 60000;   // one JPEG segment holds 64 KB

/** The JPEG with `text` as its description, in language `lang` (e.g. "en", so a reader picks the right
 *  voice); the same JPEG when that can't be done. */
export async function describeJpeg(blob, text, lang = '') {
  text = String(text || '').trim();
  if (!text) return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0xFF || b[1] !== 0xD8) return blob;
  // after SOI and a JFIF APP0, as the specs ask; anything already there stays
  let at = 2;
  if (b[2] === 0xFF && b[3] === 0xE0) at = 4 + ((b[4] << 8) | b[5]);
  const parts = [b.subarray(0, at), exif(text), xmp(text, lang), b.subarray(at)];
  return new Blob(parts, { type: 'image/jpeg' });
}

/** Cut to whole characters so the bytes fit. */
function fit(text, room) {
  let t = text;
  while (enc.encode(t).length > room) t = t.slice(0, Math.floor(t.length * 0.9));
  return t;
}

function segment(marker, body) {
  const out = new Uint8Array(4 + body.length);
  out[0] = 0xFF; out[1] = marker;
  out[2] = (body.length + 2) >> 8; out[3] = (body.length + 2) & 0xFF;
  out.set(body, 4);
  return out;
}

/** APP1 "Exif": a little-endian TIFF with one entry, ImageDescription (0x010E). */
function exif(text) {
  const str = enc.encode(fit(text, MAX - 64));
  const n = str.length + 1;   // ends with 0
  const head = 6 + 8 + 2 + 12 + 4;   // "Exif\0\0", TIFF header, count, entry, next IFD
  const out = new Uint8Array(head + n);
  const v = new DataView(out.buffer);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  out.set([0x49, 0x49, 0x2A, 0x00], 6); v.setUint32(10, 8, true);   // "II", 42, IFD0 at 8
  v.setUint16(14, 1, true);
  v.setUint16(16, 0x010E, true); v.setUint16(18, 2, true); v.setUint32(20, n, true); v.setUint32(24, head - 6, true);
  v.setUint32(28, 0, true);
  out.set(str, head);
  return segment(0xE1, out);
}

const xmlEsc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** APP1 XMP with dc:description: x-default first, as XMP asks, and the same text again under its language. */
function xmp(text, lang) {
  const tag = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(lang) ? lang : '';
  const ns = enc.encode('http://ns.adobe.com/xap/1.0/\0');
  const wrap = (t) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(t)}</rdf:li>${tag ? `<rdf:li xml:lang="${tag}">${xmlEsc(t)}</rdf:li>` : ''}</rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="r"?>`;
  let t = fit(text, tag ? (MAX - 600) / 2 : MAX - 600); let body = enc.encode(wrap(t));
  while (body.length > MAX - ns.length) { t = t.slice(0, Math.floor(t.length * 0.9)); body = enc.encode(wrap(t)); }   // & and < grow when escaped
  const out = new Uint8Array(ns.length + body.length);
  out.set(ns, 0); out.set(body, ns.length);
  return segment(0xE1, out);
}
