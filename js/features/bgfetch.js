// Downloads that keep going when the app is closed (Background Fetch: Chrome and Edge, mainly on Android).
// The browser downloads the files itself and shows its own download notification; when it's done, the service
// worker (sw.js) puts each file into the cache the feature reads it from, as if the app had fetched it.
// What each job is (its files, which cache, how to finish) is kept in Cache Storage under ./__bg/<id>, so
// both the service worker and a later start of the app can read it. Elsewhere bgDownload() returns null and
// the feature downloads as before, while the app is open.
const META = 'ot-bg-v1';
const ICON = { src: new URL('icons/icon-192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' };
const chan = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ot-bg') : null;
const metaUrl = (id) => new URL(`__bg/${encodeURIComponent(id)}`, document.baseURI).href;

async function readMeta(id) {
  try { return await (await (await caches.open(META)).match(metaUrl(id)))?.json() ?? null; } catch { return null; }
}
async function writeMeta(meta) {
  await (await caches.open(META)).put(metaUrl(meta.id), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
}
async function deleteMeta(id) { try { await (await caches.open(META)).delete(metaUrl(id)); } catch { /* gone */ } }

/** The browser's background download manager, when this page can use it (needs the service worker). */
async function manager() {
  if (typeof window === 'undefined' || !('BackgroundFetchManager' in window) || !navigator.serviceWorker?.controller) return null;
  try { return (await navigator.serviceWorker.ready).backgroundFetch || null; } catch { return null; }
}

const trackers = new Map();   // id -> tracker

/**
 * A running background download as the features see it:
 * { loaded, total, progress() 0..1, onProgress, cancel(), promise } (promise: the job's data when it's stored).
 */
function track(reg, meta) {
  if (trackers.has(reg.id)) return trackers.get(reg.id);
  const t = { loaded: reg.downloaded, total: reg.downloadTotal || meta.total || 0, onProgress: null, cancel: () => reg.abort() };
  t.progress = () => (t.total ? Math.min(0.99, t.loaded / t.total) : 0);
  t.promise = new Promise((resolve, reject) => {
    let done = false;
    const finish = async () => {
      // the service worker may still be copying the files into their caches: wait for its "done" mark
      const m = await readMeta(reg.id);
      if (done || !m || m.state === 'running') return;
      done = true;
      chan?.removeEventListener('message', onMsg);
      reg.removeEventListener('progress', onProg);
      clearInterval(poll);
      trackers.delete(reg.id);
      await deleteMeta(reg.id);
      if (m.state === 'done') resolve(m.data);
      else {
        const e = new Error(m.state === 'cancelled' ? 'Download cancelled.' : "The download didn't finish. Try again.");
        if (m.state === 'cancelled') e.name = 'AbortError';
        reject(e);
      }
    };
    const onMsg = ({ data }) => { if (data?.bg === reg.id) finish(); };
    const onProg = () => { t.loaded = reg.downloaded; t.onProgress?.(t.progress()); if (reg.result) finish(); };
    chan?.addEventListener('message', onMsg);
    reg.addEventListener('progress', onProg);
    const poll = setInterval(finish, 3000);   // in case a message was missed
    finish();
  });
  trackers.set(reg.id, t);
  return t;
}

/**
 * Start a background download, or null when this browser can't (then download the usual way).
 * files: [{ url, cache, hash?, size? }] (only the files still missing); estimate: bytes, for the progress
 * when not every size is known; data: what the feature needs to finish (returned by the promise).
 */
export async function bgDownload(id, { title, doneTitle, failTitle, files, estimate = 0, data = null }) {
  const m = await manager();
  if (!m || !files.length) return null;
  try {
    const running = await m.get(id);
    if (running) return track(running, (await readMeta(id)) || { total: estimate });
  } catch { return null; }
  const seen = new Set();
  const list = files.map((f) => ({ ...f, url: new URL(f.url).href })).filter((f) => !seen.has(f.url) && seen.add(f.url));
  // the exact total lets Android show real progress; a wrong one would stop the download, so only when known
  const exact = list.every((f) => f.size > 0) ? list.reduce((a, f) => a + f.size, 0) : 0;
  const meta = { id, state: 'running', title, doneTitle, failTitle, total: exact || estimate, data,
    files: list.map(({ url, cache, hash }) => ({ url, cache, hash: hash || null })) };
  try {
    await writeMeta(meta);
    const reg = await m.fetch(id, list.map((f) => new Request(f.url, { mode: 'cors', credentials: 'omit' })),
      { title, icons: [ICON], downloadTotal: exact });
    return track(reg, meta);
  } catch {
    // not allowed, no space, or the browser said no: the usual download still works while the app is open
    await deleteMeta(id);
    return null;
  }
}

/**
 * At start: jobs of this kind (id = prefix + key) that run, or finished while the app was closed.
 * adopt(key, tracker) for each; a finished one comes as a tracker whose promise is already settled.
 */
export async function bgResume(prefix, adopt) {
  if (typeof caches === 'undefined') return;
  let keys;
  try { keys = await (await caches.open(META)).keys(); } catch { return; }
  const m = await manager();
  for (const req of keys) {
    const id = decodeURIComponent(req.url.split('/__bg/')[1] || '');
    if (!id.startsWith(prefix)) continue;
    const meta = await readMeta(id);
    if (!meta) continue;
    const key = id.slice(prefix.length);
    if (meta.state === 'running') {
      const reg = m ? await m.get(id).catch(() => null) : null;
      if (reg) adopt(key, track(reg, meta));
      else await deleteMeta(id);          // the browser dropped it
      continue;
    }
    await deleteMeta(id);
    const settled = { loaded: 0, total: 0, progress: () => 0, cancel() {}, onProgress: null,
      promise: meta.state === 'done' ? Promise.resolve(meta.data) : Promise.reject(new Error("The download didn't finish.")) };
    settled.promise.catch(() => {});
    adopt(key, settled);
  }
}

/** A language's English name, for the download notification. */
export const langLabel = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};
