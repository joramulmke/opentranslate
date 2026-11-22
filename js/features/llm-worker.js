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

async function run({ id, op, model, record, messages, maxTokens, noThinking }) {
  if (op === 'has') return webllm.hasModelInCache(model, appConfig(record));
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
