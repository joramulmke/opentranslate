// Service worker: the app always opens from its cache (fast, works offline). A new version is downloaded
// whole, in the background, into its own cache, and only takes over at the next start (js/app.js), so the
// page never runs with a mix of old and new files. API responses and CDN assets are never cached here.
const CACHE_NAME = 'ot-shell-v20';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './change-me.md',
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
  './js/ui/enginerows.js',
  './js/ui/storage.js',
  './js/ui/settingssearch.js',
  './js/ui/tags.js',
  './js/share.js',
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

// "Share to OpenTranslate" (manifest share_target): keep what was shared, then open the app on it.
const SHARE_CACHE = 'ot-share-v1';
async function receiveShare(req) {
  const scope = self.registration.scope;
  let photo = null;
  try {
    const fd = await req.formData();
    const pick = (k) => String(fd.get(k) || '').slice(0, 20000);
    photo = fd.getAll('photo').find((f) => f && typeof f !== 'string' && /^image\//.test(f.type)) || null;
    const c = await caches.open(SHARE_CACHE);
    await c.put(new URL('__shared.json', scope), new Response(JSON.stringify({ title: pick('title'), text: pick('text'), url: pick('url') }), { headers: { 'Content-Type': 'application/json' } }));
    if (photo) await c.put(new URL('__shared-photo', scope), new Response(photo, { headers: { 'Content-Type': photo.type } }));
    else await c.delete(new URL('__shared-photo', scope));
  } catch { /* nothing readable: just open the app */ }
  return Response.redirect(new URL(photo ? './?share=photo#text' : './?share=text#text', scope).href, 303);
}

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
