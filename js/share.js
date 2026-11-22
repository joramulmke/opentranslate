// "Share to OpenTranslate": the service worker (sw.js) keeps what another app shared and opens
// ./?share=text or ./?share=photo. Here the app picks it up once and forgets it (a photo opens camera text).
const CACHE = 'ot-share-v1';
const URL_RE = /https?:\/\/\S+/g;

/** What goes into the text box: title and text without links; a link alone stays as it is. */
export function sharedText({ title = '', text = '', url = '' } = {}) {
  const clean = (s) => String(s || '').replace(URL_RE, '').replace(/[ \t]+\n/g, '\n').trim();
  const parts = [];
  for (const p of [clean(title), clean(text)]) if (p && !parts.some((q) => q.includes(p))) parts.push(p);
  if (parts.length) return parts.join('\n');
  return String(url || '').trim() || (String(text).match(URL_RE) || [])[0] || String(title || '').trim();
}

/** null, or { kind: 'text', text } / { kind: 'photo', photo: Blob, text }. */
export async function takeShare() {
  const kind = new URLSearchParams(location.search).get('share');
  if (!kind) return null;
  // drop ?share=… so a reload doesn't share again
  history.replaceState(history.state, '', location.pathname + location.hash);
  if (typeof caches === 'undefined') return null;
  try {
    const c = await caches.open(CACHE);
    const base = new URL('./', location.href);
    const [j, p] = await Promise.all([c.match(new URL('__shared.json', base)), c.match(new URL('__shared-photo', base))]);
    const data = j ? await j.json() : {};
    const photo = kind === 'photo' && p ? await p.blob() : null;
    await Promise.all([c.delete(new URL('__shared.json', base)), c.delete(new URL('__shared-photo', base))]);
    if (photo) return { kind: 'photo', photo, text: sharedText(data) };
    const text = sharedText(data);
    return text ? { kind: 'text', text } : null;
  } catch {
    return null;
  }
}

/** A web+translate: link (manifest protocol_handlers) opens ./?q=web%2Btranslate%3A…: the text after the colon, or ''. */
export function takeLinkText() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q == null) return '';
  params.delete('q');
  const rest = params.toString();
  history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  let t = q.replace(/^web\+translate:(\/\/)?/i, '');
  try { t = decodeURIComponent(t); } catch { /* not encoded: keep as is */ }
  return t.trim().slice(0, 20000);
}

/** "Open with OpenTranslate" on a computer (manifest file_handlers): calls handler(file) with the opened file. */
export function onOpenedFile(handler) {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    try { handler(await params.files[0].getFile()); } catch { /* file gone or not allowed */ }
  });
}
