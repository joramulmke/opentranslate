// Settings › top: one line with the space OpenTranslate uses on this device, and a
// "Free up space" list of every download (largest first), each with its own Delete button.
import { settings } from '../store.js';
import { langName } from '../state.js';
import { installedLanguages, packBytes, deletePack, onOfflineChange } from '../features/offline.js';
import { ocrDownloaded, ocrDelete, ocrLanguages } from '../features/ocr.js';
import { downloadedVoices, voiceBytes, voiceLabel, deleteVoice, piperBytes, kokoroState, kokoroSize, deleteKokoro, refreshVoices, onVoicesChange } from '../features/piper.js';
import { HF_MODELS, modelState, modelBytes, deleteModel as deleteHfModel, refreshModels, onModelsChange } from '../features/models.js';
import { paddleState, paddleBytes, deletePaddle, refreshPaddle, onPaddleChange } from '../features/paddle.js';
import { downloadedLlms, llmSpec, deleteModel as deleteLlm, onLlmChange } from '../features/localllm.js';
import { sheet } from '../features/permissions.js';
import { formatMB } from './offlineui.js';
import { escapeHtml as esc } from './langpicker.js';
import { toast } from './snackbar.js';
import { icon } from './icons.js';
import { persistState, persistSupported, setKeepSafe, onPersistChange } from '../features/persist.js';

const $ = (id) => document.getElementById(id);
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : formatMB(b));
let items = [];
let busy = false;
let collecting = false;   // our own refresh*() calls announce changes too: don't react to those

/** Everything downloaded: [{ id, name, kind, bytes, note?, remove? }] */
async function collect() {
  collecting = true;
  try {
    await Promise.all([refreshVoices(), refreshModels(), refreshPaddle()].map((p) => Promise.resolve(p).catch(() => {})));
  } finally { collecting = false; }
  const out = [];
  for (const l of installedLanguages().filter((c) => c !== 'en')) {
    out.push({ id: `pack:${l}`, name: langName(l), kind: 'Offline language (Bergamot)', bytes: packBytes(l),
      after: 'It no longer translates offline until you download it again.', remove: () => deletePack(l) });
  }
  let ocr = new Map();
  try { ocr = await ocrDownloaded(); } catch { /* no IndexedDB */ }
  const isoOf = new Map(ocrLanguages().map((x) => [x.code, x.iso]));
  for (const [code, bytes] of ocr) {
    out.push({ id: `ocr:${code}`, name: langName(isoOf.get(code) || code), kind: 'Camera text language (Tesseract)', bytes,
      after: "It's downloaded again the next time camera text needs it.", remove: () => ocrDelete(code) });
  }
  const voices = downloadedVoices();
  for (const lang of voices) {
    out.push({ id: `voice:${lang}`, name: voiceLabel(lang, langName), kind: 'Read-aloud voice (Piper)', bytes: voiceBytes(lang),
      after: 'You can download it again at any time.', remove: () => deleteVoice(lang) });
  }
  if (kokoroState() === 'ready') {
    out.push({ id: 'kokoro', name: 'Kokoro', kind: 'Read-aloud voices (Kokoro)', bytes: kokoroSize(),
      after: "Read-aloud uses the Piper voices or the device's voices until you download it again.", remove: () => deleteKokoro() });
  }
  const engine = piperBytes() - voices.reduce((a, l) => a + voiceBytes(l), 0);
  if (engine > 0) out.push({ id: 'voice-engine', name: 'Voice engine', kind: 'Shared by Piper and Kokoro', bytes: engine, note: 'Deleted with the last voice' });
  for (const key of Object.keys(HF_MODELS)) {
    if (modelState(key) !== 'ready') continue;
    const m = HF_MODELS[key];
    out.push({ id: `hf:${key}`, name: m.title, kind: m.what.replace(/^./, (c) => c.toUpperCase()), bytes: modelBytes(key) || m.sizeMB * 1e6,
      after: "It's downloaded again (after asking) the next time it's needed.", remove: () => deleteHfModel(key) });
  }
  if (paddleState() === 'ready') {
    out.push({ id: 'paddle', name: 'PP-OCRv6', kind: 'Text recognition model', bytes: paddleBytes(),
      after: 'Camera text and handwriting use Tesseract until you download it again.',
      remove: async () => { await deletePaddle(); settings.set({ paddleOk: null }); } });
  }
  for (const key of downloadedLlms()) {
    const custom = key.startsWith('custom:');
    const spec = custom ? { title: key.split('/').filter(Boolean).pop() || 'Own model', sizeMB: 0 } : llmSpec({ model: key });
    out.push({ id: `llm:${key}`, name: spec.title, kind: 'On-device AI model', bytes: spec.sizeMB * 1e6, estimate: true,
      after: 'It needs downloading again before on-device AI can use it.', remove: () => deleteLlm(key) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

async function usage() {
  try { const e = await navigator.storage?.estimate?.(); return e?.usage ?? null; } catch { return null; }
}

/** Refresh the summary line (and the list when it's open). */
export async function renderStorage() {
  const line = $('storage-line');
  if (!line) return;
  items = await collect();
  const sum = items.reduce((a, x) => a + x.bytes, 0);
  const used = Math.max(sum, (await usage()) || 0);
  const kept = await persistState();
  const safety = !items.length || kept === 'unsupported' ? '' : kept === 'kept' ? ' · Kept safe' : ' · May be deleted when space runs low';
  const text = used > 0
    ? `Using ${size(used)} on this device${items.length ? ` · ${items.length} download${items.length === 1 ? '' : 's'}` : ''}${safety}`
    : 'Nothing downloaded on this device yet.';
  renderKeepSafe(kept);
  if (line.textContent !== text) line.textContent = text;
  $('btn-storage').hidden = !items.length;
  if (!items.length) setOpen(false);
  if (!$('storage-list').hidden) renderList();
}

function renderList() {
  const list = $('storage-list');
  const focused = document.activeElement?.closest?.('#storage-list [data-free]')?.dataset.free;
  list.innerHTML = items.map((x) => `<li class="offline-row">
      <span class="offline-copy"><span>${esc(x.name)}</span><small>${esc(x.kind)} · ${x.bytes ? `${x.estimate ? 'about ' : ''}${size(x.bytes)}` : 'size unknown'}${x.note ? ` · ${esc(x.note)}` : ''}</small></span>
      ${x.remove ? `<button class="icon-btn sm" type="button" data-free="${esc(x.id)}" aria-label="Delete ${esc(x.name)}, ${esc(x.kind)}">${icon('delete')}</button>` : ''}
    </li>`).join('');
  if (focused) (list.querySelector(`[data-free="${CSS.escape(focused)}"]`) || $('btn-storage')).focus();
}

function setOpen(open) {
  $('storage-list').hidden = !open;
  $('btn-storage').setAttribute('aria-expanded', String(open));
  $('btn-storage').textContent = open ? 'Hide list' : 'Free up space';
  if (open) renderList();
}

async function onFree(id) {
  const x = items.find((i) => i.id === id);
  if (!x?.remove || busy) return;
  const ok = await sheet({
    iconName: 'delete', title: `Delete ${x.name}?`,
    body: `${x.kind}. This frees ${x.bytes ? `${x.estimate ? 'about ' : ''}${size(x.bytes)}` : 'its space'}. ${x.after}`,
    allowLabel: 'Delete', cancelLabel: 'Cancel',
  });
  if (!ok) return;
  busy = true;
  try { await x.remove(); toast(`Deleted ${x.name}`); }
  catch (e) { toast(`Couldn't delete ${x.name}: ${e.message || e}`); }
  finally { busy = false; }
  await renderStorage();
  // focus moved with the deleted row: keep it in the list
  const list = $('storage-list');
  (list.querySelector('[data-free]') || ($('btn-storage').hidden ? $('storage-line') : $('btn-storage'))).focus();
}

/** The "Keep downloads safe" switch under the storage line, and what the browser answered. */
function renderKeepSafe(kept) {
  const row = $('keep-safe-row');
  if (!row) return;
  row.hidden = !persistSupported();
  const on = settings.get().keepSafe === true || kept === 'kept';
  $('set-keep-safe').checked = on;
  // once the browser keeps them, it can't be told to forget: the switch stays on
  $('set-keep-safe').disabled = kept === 'kept';
  const installed = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches;
  $('keep-safe-note').textContent = kept === 'kept'
    ? 'The browser keeps your downloads, even when space runs low'
    : on
      ? `The browser hasn't agreed yet. ${installed ? 'It may agree after you use OpenTranslate more often.' : 'Install the app to keep them safe: it asks again then.'}`
      : 'Asks the browser not to delete downloads when space runs low';
}

export function initStorage() {
  if (!$('storage-line')) return;
  $('set-keep-safe')?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    const ok = await setKeepSafe(on);
    if (on) toast(ok ? 'Downloads are kept safe.' : "The browser didn't agree yet. It's asked again later.");
    renderStorage();
  });
  onPersistChange(() => { if ($('settings-dialog')?.open) renderStorage(); });
  $('btn-storage').addEventListener('click', () => setOpen($('storage-list').hidden));
  $('storage-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-free]');
    if (b) onFree(b.dataset.free);
  });
  let t = 0;
  const later = (what) => {
    if (what === 'progress' || collecting) return;
    clearTimeout(t); t = setTimeout(() => { if ($('settings-dialog')?.open) renderStorage(); }, 300); };
  [onOfflineChange, onVoicesChange, onModelsChange, onPaddleChange, onLlmChange].forEach((on) => { try { on(later); } catch { /* not available */ } });
}
