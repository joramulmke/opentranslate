// On-device AI model (WebLLM) in a Web Worker, so the page stays responsive while it downloads,
// loads and generates. Messages: { id, op: 'has'|'load'|'chat'|'delete', model, messages?, maxTokens? }.
// Answers: { id, progress, text } while loading, then { id, ok } or { id, error }.
import * as webllm from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/lib/index.js';

let engine = null;
let loaded = null;     // model id currently on the GPU
let chatting = false;
let queue = Promise.resolve();

const post = (id, msg) => self.postMessage({ id, ...msg });

async function ensure(model, id) {
  engine ??= new webllm.MLCEngine();
  engine.setInitProgressCallback((r) => post(id, { progress: r.progress, text: r.text }));
  if (loaded !== model) {
    loaded = null;
    await engine.reload(model);
    loaded = model;
  }
}

async function run({ id, op, model, messages, maxTokens }) {
  if (op === 'has') return webllm.hasModelInCache(model);
  if (op === 'delete') {
    if (loaded === model) { await engine.unload(); loaded = null; }
    await webllm.deleteModelAllInfoInCache(model);
    return true;
  }
  await ensure(model, id);
  if (op === 'load') return true;
  if (op === 'chat') {
    chatting = true;
    try {
      const r = await engine.chat.completions.create({ messages, temperature: 0, max_tokens: maxTokens || 1024 });
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
