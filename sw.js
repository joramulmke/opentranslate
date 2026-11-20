// Service worker: precache the app shell; never cache API responses or CDN OCR assets.
const CACHE_NAME = 'ot-shell-v6';
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
  './js/features/models.js',
  './js/ui/enginerows.js',
  './js/features/llm-worker.js',
  './js/ui/offlineui.js',
  './vendor/bergamot/translator-worker.js',
  './vendor/bergamot/bergamot-translator-worker.js',
];
// The on-device engine binary (5 MB) is cached on first use, not precached for every visitor.
const ENGINE_CACHE = 'ot-engine-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // only old app-shell caches; downloaded language models (ot-offline-*) and the engine stay
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ot-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // translate/detect POSTs go straight to network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // provider APIs, Tesseract CDN: not cached here
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // Navigations: network first (fresh deploys), fall back to cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true })));
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
  // Shell assets: cache first, then network (and refresh the cache in the background).
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok && SHELL.some((p) => url.pathname.endsWith(p.replace('./', '/')) || url.pathname === scope.pathname)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
