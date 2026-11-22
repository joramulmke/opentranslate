// ONNX Runtime Web (MIT, from jsDelivr), shared by the on-device models that run outside transformers.js:
// offline voices (piper.js, kokoro) and PP-OCRv6 text recognition (paddle.js). Each feature keeps the
// runtime files in its own Cache Storage, so deleting one feature's downloads never breaks another;
// a copy already downloaded by the other feature is reused instead of fetched again.
export const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
export const ORT_FILES = [ORT_BASE + 'ort.wasm.min.mjs', ORT_BASE + 'ort-wasm-simd-threaded.mjs', ORT_BASE + 'ort-wasm-simd-threaded.wasm'];
export const ORT_MB = 11;
const CACHES = ['ot-piper-v1', 'ot-paddle-v1'];

/**
 * A file from cacheName, else from another feature's cache (copied over), else from the network.
 * onBytes(n) reports progress while downloading.
 */
export async function cachedFile(url, cacheName, onBytes) {
  const c = await caches.open(cacheName);
  const hit = await c.match(url);
  if (hit) return hit;
  for (const other of CACHES) {
    if (other === cacheName) continue;
    const res = await (await caches.open(other)).match(url);
    if (res) { await c.put(url, res.clone()); return res; }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  let body = res.body;
  if (onBytes && body) {
    let n = 0;
    body = body.pipeThrough(new TransformStream({ transform(chunk, ctl) { n += chunk.byteLength; onBytes(n); ctl.enqueue(chunk); } }));
  }
  const blob = await new Response(body).blob();
  const copy = new Response(blob, { headers: { 'content-type': res.headers.get('content-type') || '', 'content-length': String(blob.size) } });
  await c.put(url, copy.clone());
  return copy;
}

let ort = null;
/** The runtime (loaded once per page), from cached files so it also starts without internet. */
export function loadOrt(cacheName) {
  ort ??= (async () => {
    const url = async (u, type) => URL.createObjectURL(new Blob([await (await cachedFile(u, cacheName)).arrayBuffer()], { type }));
    const [mjs, glue, wasm] = await Promise.all([url(ORT_FILES[0], 'text/javascript'), url(ORT_FILES[1], 'text/javascript'), url(ORT_FILES[2], 'application/wasm')]);
    const m = await import(/* webpackIgnore: true */ mjs);
    m.env.wasm.numThreads = 1;      // no cross-origin isolation here, so no threads
    m.env.wasm.wasmPaths = { mjs: glue, wasm };
    return m;
  })();
  ort.catch(() => { ort = null; });
  return ort;
}
