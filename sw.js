// Service worker: the app always opens from its cache (fast, works offline). A new version is downloaded
// whole, in the background, into its own cache, and only takes over at the next start (js/app.js), so the
// page never runs with a mix of old and new files. API responses and CDN assets are never cached here.
const CACHE_NAME = 'ot-shell-v29';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './change-me.txt',
  './version.json',
  './js/ui/version.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './js/app.js',
  './js/state.js',
  './js/store.js',
  './js/siteconfig.js',
  './js/languages.js',
  './js/providers.js',
  './js/ui/icons.js',
  './js/ui/layout.js',
  './js/ui/menu.js',
  './js/ui/install.js',
  './js/ui/feedback.js',
  './js/ui/diagnostics.js',
  './vendor/html-to-image/html-to-image.js',
  './js/ui/modemenu.js',
  './js/ui/setupbadge.js',
  './js/ui/sitefooter.js',
  './js/ui/langbar.js',
  './js/ui/langpicker.js',
  './js/ui/sheet.js',
  './js/ui/snackbar.js',
  './js/ui/textview.js',
  './js/ui/historysheet.js',
  './js/ui/settingssheet.js',
  './js/features/speech.js',
  './js/features/ocr.js',
  './js/features/permissions.js',
  './js/features/hwr.js',
  './js/features/stt.js',
  './js/features/camera.js',
  './js/features/conversation.js',
  './js/features/handwriting.js',
  './js/features/offline.js',
  './js/features/localllm.js',
  './js/features/llmcatalog.js',
  './js/features/chrometranslator.js',
  './js/features/models.js',
  './js/features/piper.js',
  './js/features/ort.js',
  './js/features/paddle.js',
  './js/features/florence.js',
  './js/ui/enginerows.js',
  './js/ui/storage.js',
  './js/ui/settingssearch.js',
  './js/ui/tags.js',
  './js/share.js',
  './js/features/pdf.js',
  './js/features/openfiles.js',
  './js/features/captions.js', './js/ui/showcard.js', './js/ui/wordmark.js', './js/ui/backup.js',
  './js/features/bgfetch.js',
  './js/features/persist.js',
  './js/features/wiktionary.js',
  './js/features/pip.js',
  './js/features/llm-worker.js',
  './js/ui/offlineui.js',
  './vendor/bergamot/translator-worker.js',
  './vendor/bergamot/bergamot-translator-worker.js',
];
// The on-device engine binary (5 MB) is cached on first use, not precached for every visitor.
const ENGINE_CACHE = 'ot-engine-v1';

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's HTTP cache, so the new version can't pick up stale old files.
  // No skipWaiting: the running version keeps its own complete cache until the app starts again.
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // only old app-shell caches; downloaded language models (ot-offline-*) and the engine stay
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ot-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The app found a downloaded update at start: switch now (it reloads itself right after).
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

// "Share to OpenTranslate" (manifest share_target): keep what was shared (text, and up to 10 files: photos,
// .txt files, PDFs), then open the app on it. js/share.js picks it up.
const SHARE_CACHE = 'ot-share-v1';
const SHARE_MAX_FILES = 10;
const shareable = (f) => f && typeof f !== 'string' && f.size > 0
  && (/^image\//.test(f.type) || /^text\/plain|^application\/pdf/.test(f.type) || /\.(txt|pdf)$/i.test(f.name || ''));
async function receiveShare(req) {
  const scope = self.registration.scope;
  let files = [];
  try {
    const fd = await req.formData();
    const pick = (k) => String(fd.get(k) || '').slice(0, 20000);
    files = fd.getAll('photo').filter(shareable).slice(0, SHARE_MAX_FILES);
    const c = await caches.open(SHARE_CACHE);
    for (const k of await c.keys()) await c.delete(k);   // nothing left over from an earlier share
    const list = files.map((f) => ({ name: String(f.name || '').slice(0, 200), type: f.type || '' }));
    await c.put(new URL('__shared.json', scope), new Response(JSON.stringify({ title: pick('title'), text: pick('text'), url: pick('url'), files: list }), { headers: { 'Content-Type': 'application/json' } }));
    await Promise.all(files.map((f, i) => c.put(new URL(`__shared-file-${i}`, scope), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
  } catch { files = []; /* nothing readable: just open the app */ }
  return Response.redirect(new URL(files.length ? './?share=files#text' : './?share=text#text', scope).href, 303);
}

// Downloads that went on in the background (js/features/bgfetch.js): put each file into the cache its
// feature reads from, mark the job done (or failed) for the app, and update the download notification.
const BG_META = 'ot-bg-v1';
const bgMetaUrl = (id) => new URL(`__bg/${encodeURIComponent(id)}`, self.registration.scope).href;
const bgChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ot-bg') : null;
async function bgMeta(id) {
  const r = await (await caches.open(BG_META)).match(bgMetaUrl(id));
  return r ? r.json() : null;
}
async function bgMark(meta, state) {
  meta.state = state;
  await (await caches.open(BG_META)).put(bgMetaUrl(meta.id), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  bgChannel?.postMessage({ bg: meta.id, state });
}
const sha256 = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function bgStore(reg) {
  const meta = await bgMeta(reg.id);
  if (!meta) return null;
  const files = new Map(meta.files.map((f) => [f.url, f]));
  let ok = reg.result === 'success';
  // files that did arrive are kept even if others failed: the next try only fetches what's missing
  for (const rec of await reg.matchAll()) {
    const f = files.get(rec.request.url);
    try {
      const res = await rec.responseReady;
      if (!f || !res.ok) { ok = false; continue; }
      const cache = await caches.open(f.cache);
      if (f.hash) {
        const buf = await res.arrayBuffer();
        if ((await sha256(buf)) !== f.hash) { ok = false; continue; }
        await cache.put(f.url, new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.byteLength) } }));
      } else {
        await cache.put(f.url, res);
      }
    } catch { ok = false; }
  }
  await bgMark(meta, ok ? 'done' : 'failed');
  return meta;
}
const bgFinished = (e) => e.waitUntil(bgStore(e.registration).then((meta) => meta
  && e.updateUI({ title: meta.state === 'done' ? meta.doneTitle : meta.failTitle }).catch(() => {})));
self.addEventListener('backgroundfetchsuccess', bgFinished);
self.addEventListener('backgroundfetchfail', bgFinished);
self.addEventListener('backgroundfetchabort', (e) => e.waitUntil(bgMeta(e.registration.id).then((meta) => meta && bgMark(meta, 'cancelled'))));
// tapping the notification opens the app (or brings it to the front)
self.addEventListener('backgroundfetchclick', (e) => e.waitUntil((async () => {
  const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (open.length) return open[0].focus();
  return self.clients.openWindow(self.registration.scope);
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === new URL('share', self.registration.scope).pathname) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;                       // translate/detect POSTs go straight to network
  if (url.origin !== self.location.origin) return;        // provider APIs, Tesseract CDN: not cached here
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // Settings → "Check for updates": the server's version.json, never a cached one.
  if (url.pathname === scope.pathname + 'version.json' && url.searchParams.has('latest')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }
  // Navigations: the page from this version's cache (network only if it's missing).
  if (req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html')) {
    e.respondWith(fromShell(new Request(new URL('./index.html', scope).href)).then((hit) => hit || fetch(req)));
    return;
  }
  if (url.pathname.endsWith('.wasm') && url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(ENGINE_CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // Everything else of the app: from this version's cache; what isn't in it comes from the network,
  // untouched (writing it into the cache would mix versions).
  e.respondWith(fromShell(req).then((hit) => hit || fetch(req)));
});

/** A file from this version's own cache (never from another version's). */
function fromShell(req) {
  return caches.open(CACHE_NAME).then((c) => c.match(req, { ignoreSearch: true }));
}
