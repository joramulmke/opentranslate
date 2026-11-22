// On-device AI model (WebLLM) in a Web Worker, so the page stays responsive while it downloads,
// loads and generates. Messages: { id, op: 'has'|'load'|'chat'|'delete', model, record?, messages?, maxTokens?, noThinking? }.
// record: a model added by URL (not in WebLLM's catalogue), added to the catalogue before use.
// Answers: { id, progress, text } while loading, then { id, ok } or { id, error }.
import * as webllm from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/lib/index.js';

let engine = null;
let loaded = null;     // model id currently on the GPU
let chatting = false;
let queue = Promise.resolve();

const post = (id, msg) => self.postMessage({ id, ...msg });

const customs = new Map();   // model id -> record
function appConfig(record) {
  if (record) customs.set(record.model_id, record);
  return { ...webllm.prebuiltAppConfig, model_list: [...webllm.prebuiltAppConfig.model_list, ...customs.values()] };
}

async function ensure(model, id, record) {
  engine ??= new webllm.MLCEngine();
  engine.setAppConfig(appConfig(record));
  engine.setInitProgressCallback((r) => post(id, { progress: r.progress, text: r.text }));
  if (loaded !== model) {
    loaded = null;
    await engine.reload(model);
    loaded = model;
  }
}

/**
 * For a download in the background: the small files (settings, tokenizer, model library, list of weights)
 * go straight into WebLLM's caches, under the names WebLLM looks for; the answer lists the weight files
 * still missing [{ url, size }]. null when the model is packaged in a way this doesn't cover.
 */
async function plan(model, record) {
  const rec = appConfig(record).model_list.find((m) => m.model_id === model);
  if (!rec || rec.model_manifest !== undefined || !/^https:\/\//.test(rec.model_lib || '')) return null;
  // the same address WebLLM uses (cleanModelUrl): …/resolve/main/ unless the URL names a revision
  let base = rec.model.endsWith('/') ? rec.model : `${rec.model}/`;
  if (!/.+\/resolve\/.+\//.test(base)) base += 'resolve/main/';
  base = new URL(base).href;
  const put = async (scope, url) => {
    const c = await caches.open(scope);
    if (!(await c.match(new Request(url)))) await c.add(new Request(url));
    return (await c.match(new Request(url))).clone();
  };
  const config = await (await put('webllm/config', new URL('mlc-chat-config.json', base).href)).json();
  await put('webllm/model', new URL(config.tokenizer_files?.includes('tokenizer.json') ? 'tokenizer.json' : 'tokenizer.model', base).href);
  await put('webllm/wasm', rec.model_lib);
  const list = await (await put('webllm/model', new URL('tensor-cache.json', base).href)).json();
  const have = new Set((await (await caches.open('webllm/model')).keys()).map((r) => r.url));
  return list.records.map((r) => ({ url: new URL(r.dataPath, base).href, size: r.nbytes })).filter((f) => !have.has(f.url));
}

async function run({ id, op, model, record, messages, maxTokens, noThinking }) {
  if (op === 'has') return webllm.hasModelInCache(model, appConfig(record));
  if (op === 'plan') return plan(model, record);
  if (op === 'delete') {
    if (loaded === model) { await engine.unload(); loaded = null; }
    await webllm.deleteModelAllInfoInCache(model, appConfig(record));
    return true;
  }
  await ensure(model, id, record);
  if (op === 'load') return true;
  if (op === 'chat') {
    chatting = true;
    try {
      const r = await engine.chat.completions.create({ messages, temperature: 0, max_tokens: maxTokens || 1024,
        ...(noThinking ? { extra_body: { enable_thinking: false } } : {}) });
      return r.choices?.[0]?.message?.content ?? '';
    } finally { chatting = false; }
  }
  throw new Error(`Unknown request: ${op}`);
}

self.onmessage = ({ data }) => {
  // a newer translation replaces the one still being written (the page only shows the newest)
  if (data.op === 'chat' && chatting) engine?.interruptGenerate();
  queue = queue.then(() => run(data))
    .then((ok) => post(data.id, { ok }), (e) => post(data.id, { error: e?.message || String(e) }));
};
