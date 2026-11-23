// Settings sheet. Translation services are a list (Classic group, Advanced group) with
// "+ Add" buttons; the form for one service opens only when adding or editing it.
// Provider fields are rendered from each provider definition, so new provider types need
// no UI changes here.
import { getProviderDef, createProvider } from '../providers.js';
import { settings, entries, entryLabel, newEntryId, MOCK_ENTRY, BUILT_IN } from '../store.js';
import { installedLanguages, usedBytes, offlineLanguages, packState, packSize, onOfflineChange, loadRegistry, downloadsBlocked, offlineUnusable, BLOCKED_REASON, usesMirror, MIRROR } from '../features/offline.js';
import { dlButton, updateDownloadButtons, onDownloadClick, formatMB } from './offlineui.js';
import { langName } from '../state.js';
import { initProvider, kindOf, useEntry, state } from '../state.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { escapeHtml } from './langpicker.js';
import { toast } from './snackbar.js';
import { icon } from './icons.js';
import { initEngineRows, renderEngines, closeOcrManager, closeVoiceManager, extLink } from './enginerows.js';
import { tagLine, infoButton, initInfo, details, PRIVATE, sends, OFFLINE, ONLINE, NO_DOWNLOAD, READY, download, downloading, quality, UNAVAILABLE } from './tags.js';
import { chromeTranslatorSupported, CHROME_TRANSLATOR_REASON } from '../features/chrometranslator.js';
import { llmSpec, llmState, llmProgress, isDownloaded, downloadModel, cancelModelDownload, deleteModel, checkGpu, onLlmChange, nanoUsable, nanoReason, NANO, NANO_INTERNALS } from '../features/localllm.js';
import { copyToClipboard } from './snackbar.js';
import { initStorage, renderStorage } from './storage.js';
import { initSettingsSearch, resetSettingsSearch } from './settingssearch.js';

const $ = (id) => document.getElementById(id);
let dlg, form;
let editing = null;          // { id, type, isNew } while the editor is open
let wantAdvanced = false;    // opened from "Advanced" without an AI model: switch to it once added

export function initSettingsSheet({ onThemeChange }) {
  dlg = setupDialog($('settings-dialog'));
  form = $('settings-form');

  $('btn-add-lt').addEventListener('click', () => openEditor({ type: 'libretranslate' }));
  $('btn-add-ai').addEventListener('click', () => openEditor({ type: 'openai' }));
  $('btn-add-llm').addEventListener('click', () => openEditor({ type: 'webllm' }));
  $('btn-add-chrome').addEventListener('click', () => openEditor({ type: 'chrome-translator' }));
  $('btn-add-eleven').addEventListener('click', () => openEditor({ type: 'elevenlabs' }));
  onLlmChange((what) => {
    if (!dlg?.open) return;
    if (what !== 'progress') { renderLists(); return; }
    // progress: only the row's subtitle changes (re-rendering would move focus)
    for (const e of settings.get().entries) if (e.type === 'webllm') { const t = $(`svc-tags-${e.id}`); if (t) t.outerHTML = tagLine(`svc-tags-${e.id}`, svcTags(e)); }
  });
  $('btn-svc-cancel').addEventListener('click', () => closeEditor());
  $('svc-fields').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
  $('btn-offline-done').addEventListener('click', () => closeManager());
  // Escape inside the editor / manager closes just that panel, not the whole sheet
  $('svc-editor').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('select')) { e.preventDefault(); e.stopPropagation(); closeEditor(); }
  });
  $('offline-manager').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (e.target.id === 'offline-search' && e.target.value) { e.target.value = ''; renderManager(); } else closeManager();
  });
  $('offline-search').addEventListener('input', () => renderManager());
  $('offline-list').addEventListener('click', (e) => { const b = e.target.closest('[data-dl]'); if (b) onDownloadClick(b.dataset.dl); });
  onOfflineChange(() => {
    if (!dlg?.open) return;
    if (!$('offline-manager').hidden) renderManager(); else renderLists();
  });

  for (const listId of ['svc-classic', 'svc-advanced', 'svc-voice']) {
    const list = $(listId);
    list.addEventListener('change', (e) => {
      if (e.target.matches('input[type=radio]')) { useEntry(e.target.value); renderLists(); }
    });
    wireRowMenus(list);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.dataset.act === 'more') return;
      const id = btn.closest('[data-id]').dataset.id;
      const act = btn.dataset.act;
      btn.closest('.row-menu')?.hidePopover();
      if (act === 'edit') openEditor({ id });
      if (act === 'manage') openManager();
      if (act === 'why') {
        const e = entries.get(id);
        const why = whyBlocked(e);
        // a chrome:// address can't be a link (Chrome won't open it from a page): offer to copy it instead
        toast(why, why.includes(NANO_INTERNALS) ? { action: 'Copy address', onAction: () => copyToClipboard(NANO_INTERNALS, 'Copied. Paste it into Chrome’s address bar.') } : { duration: 10000 });
      }
      if (act === 'llm-dl') llmDownloadToggle(entries.get(id));
      if (act === 'up' || act === 'down') {
        entries.move(id, act === 'up' ? -1 : 1, kindOf);
        initProvider(); renderLists();
        // after the closed menu's own focus return (to a button the new list replaced)
        requestAnimationFrame(() => ($(listId).querySelector(`[data-id="${id}"] [data-act="more"]`)
          || $(listId).querySelector(`[data-id="${id}"] input`))?.focus());
      }
      if (act === 'delete') remove(id);
    });
  }

  wireTest($('btn-test'), $('test-result'), (r) => {
    // suggestions: model names, or { value, label } (e.g. ElevenLabs voices: id and name)
    if (r.models?.length) {
      $('adv-models').innerHTML = r.models.map((m) => (typeof m === 'string'
        ? `<option value="${escapeHtml(m)}">` : `<option value="${escapeHtml(m.value)}" label="${escapeHtml(m.label)}">`)).join('');
    }
    for (const [key, ok] of Object.entries(r.caps || {})) {
      const box = $('svc-fields').querySelector(`[data-cap="${key}"]`);
      if (box && ok !== null) setCap(box, ok ? 'on' : 'no');
    }
  });
  // capability boxes: off until a test confirms them; clicks on an unconfirmed box do nothing
  $('svc-fields').addEventListener('click', (e) => {
    const box = e.target.closest('[data-cap]');
    if (box?.getAttribute('aria-disabled') === 'true') e.preventDefault();
  });

  // Enter in an editor field saves that service; nothing else in the sheet needs saving
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (editing) saveEditor();
  });

  $('set-live').addEventListener('change', (e) => settings.set({ liveTranslate: e.target.checked }));
  $('set-speak').addEventListener('change', (e) => settings.set({ speakConversation: e.target.checked }));
  initStorage();
  initInfo();
  initSettingsSearch();
  initEngineRows({ isOpen: () => !!dlg?.open, closeOthers: () => {
    closeEditor({ silent: true }); closeManager({ silent: true }); closeOcrManager({ silent: true }); closeVoiceManager({ silent: true });
  } });
  $('theme-options').addEventListener('change', (e) => {
    settings.set({ theme: e.target.value });
    onThemeChange(e.target.value);
  });
}

function wireTest(btn, out, onResult) {
  btn.addEventListener('click', async () => {
    out.hidden = false;
    out.className = 'test-result';
    out.textContent = 'Testing…';
    btn.disabled = true;
    try {
      const cfg = readFields($('svc-fields'));
      // AI: allow testing without a model so the model list can be discovered
      const lenient = getProviderDef(editing.type)?.kind === 'advanced' && String(cfg.baseUrl || '').trim();
      const r = await createProvider(editing.type, cfg, { skipRequired: !!lenient }).test();
      out.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
      out.textContent = r.message;
      onResult?.(r);
    } catch (e) {
      out.className = 'test-result bad';
      out.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * @param {'advanced'} [focus]  open at the Advanced group (or straight into "Add AI model" if there is none)
 */
export function openSettings(focus) {
  const s = settings.get();
  wantAdvanced = focus === 'advanced';
  closeEditor({ silent: true });
  closeManager({ silent: true });
  closeOcrManager({ silent: true });
  closeVoiceManager({ silent: true });
  renderLists();
  resetSettingsSearch();
  renderStorage();
  $('set-live').checked = s.liveTranslate;
  $('set-speak').checked = s.speakConversation;
  form.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === s.theme; });
  checkGpu().then((g) => {
    // Gemini Nano (Chrome) needs no WebGPU
    const ok = g.ok || nanoUsable();
    $('btn-add-llm').disabled = !ok;
    $('llm-unavailable').hidden = ok;
    $('llm-unavailable').textContent = ok ? '' : `On-device AI: ${g.reason}`;
  });
  openDialog(dlg);
  if (focus === 'offline') openManager();
  if (focus === 'advanced') {
    if (!s.entries.some((e) => kindOf(e) === 'advanced')) openEditor({ type: 'openai' });
    else requestAnimationFrame(() => { $('svc-advanced-head').scrollIntoView({ block: 'start' }); $('svc-advanced').querySelector('input')?.focus(); });
  }
}

/* ---------------------------------------------------------------- list */

const hostOfEntry = (e) => { try { return new URL(e.config.baseUrl).host; } catch { return e.config?.baseUrl || ''; } };

/** The short line under a service's name (the tags say private / internet / size). */
function subtitle(e) {
  const c = e.config || {};
  if (e.type === 'mock') return 'A few phrases only, for trying the app';
  if (e.type === 'offline') {
    if (offlineUnusable()) return 'Not available in this browser';
    const n = installedLanguages().length;
    return n ? `${n} language${n > 1 ? 's' : ''} + English · ${formatMB(usedBytes())}` : 'No languages downloaded yet';
  }
  if (e.type === 'webllm') {
    const spec = llmSpec(c);
    if (spec.kind === 'nano' && !nanoUsable()) return `${spec.title} · Not available: ${nanoReason().split('. ')[0].replace(/\.$/, '')}`;
    return spec.title;
  }
  if (e.type === 'chrome-translator') return chromeTranslatorSupported() ? 'Built into Chrome · Chrome downloads each language pair' : 'Not available in this browser: only in Chrome on computers';
  if (e.type === 'openai') return c.model || '';
  if (e.type === 'elevenlabs') {
    const can = [c.tts === 'on' && 'Reads aloud', c.audio === 'on' && 'voice input'].filter(Boolean);
    return can.length ? can.join(' and ') : 'Press Edit, then Test connection';
  }
  return '';
}

/** Privacy, internet, size (and quality where it differs) of a service. */
function svcTags(e) {
  const c = e.config || {};
  if (blocked(e)) return [UNAVAILABLE];
  if (e.type === 'mock') return [PRIVATE, OFFLINE, NO_DOWNLOAD];
  if (e.type === 'offline') return [PRIVATE, OFFLINE, installedLanguages().some((l) => l !== 'en') ? READY : download('About 45–75 MB per language'), quality('Good')];
  if (e.type === 'chrome-translator') return [PRIVATE, OFFLINE, { kind: 'size', text: 'Chrome downloads it' }];
  if (e.type === 'webllm') {
    const spec = llmSpec(c);
    const st = llmState(spec.key);
    const size = st === 'ready' ? READY
      : st === 'downloading' ? (spec.kind === 'nano' ? { kind: 'busy', text: 'Chrome is downloading' } : downloading(llmProgress(spec.key)))
        : spec.kind === 'nano' ? { kind: 'size', text: 'Chrome downloads it' } : spec.sizeMB ? download(spec.sizeMB) : { kind: 'size', text: 'Download' };
    return [PRIVATE, OFFLINE, size];
  }
  if (e.type === 'elevenlabs') return [sends('api.elevenlabs.io'), ONLINE, NO_DOWNLOAD];
  return [sends(hostOfEntry(e) || 'your server'), ONLINE, NO_DOWNLOAD];
}

/** What the ⓘ shows: where it comes from, licence, where your text goes. */
function svcInfo(e) {
  const host = hostOfEntry(e);
  if (e.type === 'mock') return details('A built-in demo that knows a few phrases, so you can try the app without setting anything up. It never stands in for a real service.');
  if (e.type === 'offline') return details(offlineSourceHtml(), 'Translates in your browser: nothing you type leaves this device. Manage the languages with the download button.');
  if (e.type === 'chrome-translator') return details("Chrome's built-in translator. Chrome downloads each language pair and runs it on this device.");
  if (e.type === 'webllm') {
    const spec = llmSpec(e.config);
    if (spec.kind === 'nano') return details(`Built into Chrome: Google's Gemini Nano, downloaded and updated by Chrome (see ${extLink('https://developer.chrome.com/docs/ai/prompt-api', 'Prompt API')}).`, 'Runs on this device.');
    if (spec.custom) {
      let h = spec.custom.url; try { h = new URL(spec.custom.url).host; } catch { /* keep */ }
      return details(`From ${extLink(spec.custom.url, h)} (your own model).`, 'Engine WebLLM from jsDelivr. Runs on this device with WebGPU.');
    }
    return details(`From ${extLink(`https://huggingface.co/mlc-ai?search_models=${encodeURIComponent(spec.key)}`, `Hugging Face: mlc-ai/${spec.key}`)}${spec.sizeMB ? `, about ${formatMB(spec.sizeMB * 1e6)}` : ''}.`,
      'Engine WebLLM from jsDelivr and GitHub (raw.githubusercontent.com). Runs on this device with WebGPU; nothing you type leaves it.');
  }
  if (e.type === 'elevenlabs') return details('Not a download: the text or your voice goes to ElevenLabs (api.elevenlabs.io).', 'Your key stays in this browser.');
  return details(`Not a download: the text goes to ${escapeHtml(host || 'your server')}${e.config?.model ? ` (model ${escapeHtml(e.config.model)})` : ''}.`, e.config?.apiKey ? 'Your key stays in this browser.' : '');
}

/** Where offline language files come from: Mozilla, or (Chromium browsers) the mirror on Hugging Face. */
const offlineSourceHtml = () => (usesMirror
  ? `From ${extLink(MIRROR.page, `Hugging Face: ${MIRROR.repo}`)}, a byte-for-byte mirror of ${extLink('https://github.com/mozilla/translations', "Mozilla's Firefox translation models")} (Mozilla's server doesn't serve Chromium browsers). Each file is checked against Mozilla's list · engine Bergamot, included in the app`
  : `From ${extLink('https://github.com/mozilla/translations', 'Mozilla')} (firefox-settings-attachments.cdn.mozilla.net) · Firefox translation models · engine Bergamot, included in the app`);

/** Services this browser can't run (they stay listed, explained, and can't be picked). */
const blocked = (e) => (e.type === 'offline' && offlineUnusable())
  || (e.type === 'chrome-translator' && !chromeTranslatorSupported())
  || (e.type === 'webllm' && llmSpec(e.config).kind === 'nano' && !nanoUsable());
const whyBlocked = (e) => (e?.type === 'chrome-translator' ? CHROME_TRANSLATOR_REASON : nanoReason());

function renderLists() {
  const s = settings.get();
  // keep focus on the same control (or its row) when the list is rebuilt
  const had = document.activeElement?.closest?.('.svc-row');
  const hadId = had?.dataset.id;
  const hadAct = document.activeElement?.dataset?.act;
  const lead = { classic: null, advanced: null };
  renderVoiceList(s);
  // Chrome's translator: offered once; elsewhere the button is off and says why (like on-device AI without WebGPU)
  const chromeOk = chromeTranslatorSupported();
  $('btn-add-chrome').hidden = s.entries.some((e) => e.type === 'chrome-translator');
  $('btn-add-chrome').disabled = !chromeOk;
  $('chrome-unavailable').hidden = chromeOk || $('btn-add-chrome').hidden;
  $('chrome-unavailable').textContent = chromeOk ? '' : `Chrome translator: ${CHROME_TRANSLATOR_REASON}`;
  for (const kind of ['classic', 'advanced']) {
    const list = s.entries.filter((e) => kindOf(e) === kind);
    const activeId = kind === 'advanced' ? s.activeAdvanced : s.activeClassic;
    const usable = list.filter((e) => !blocked(e));
    lead[kind] = usable.find((e) => e.id === activeId) || usable.find((e) => e.type !== 'mock') || usable[0];
    const movable = list.filter((e) => e.id !== MOCK_ENTRY.id);
    const host = $(kind === 'advanced' ? 'svc-advanced' : 'svc-classic');
    host.innerHTML = list.length ? list.map((e) => {
      const i = movable.indexOf(e);
      const name = escapeHtml(e.label);
      const builtIn = BUILT_IN.has(e.id);
      const isMock = e.id === MOCK_ENTRY.id;
      return `<li class="svc-row" data-id="${e.id}">
        <label class="svc-pick"><input type="radio" name="svc-${kind}" value="${e.id}" aria-describedby="svc-tags-${e.id} svc-sub-${e.id}" ${e === lead[kind] ? 'checked' : ''} ${blocked(e) ? 'disabled' : ''}>
          <span class="svc-copy"><strong>${name}</strong>${tagLine(`svc-tags-${e.id}`, svcTags(e))}<small id="svc-sub-${e.id}">${escapeHtml(subtitle(e))}</small></span></label>
        <span class="svc-actions">
          ${blocked(e) ? '' : infoButton(`svc-${e.id}`, e.label, svcInfo(e))}
          ${e.type === 'webllm' && llmState(llmSpec(e.config).key) !== 'ready' && !(llmSpec(e.config).kind === 'nano' && !nanoUsable()) ? llmButton(e) : ''}
          ${blocked(e) && e.type !== 'offline'
    ? `<button class="icon-btn sm" type="button" data-act="why" aria-label="Why ${name} isn't available" aria-describedby="svc-sub-${e.id}">${icon('info')}</button>`
    : ''}
          ${e.type === 'offline'
    ? (blocked(e)
      ? `<button class="icon-btn sm" type="button" data-act="manage" aria-label="Why offline languages aren't available" aria-describedby="svc-sub-${e.id}">${icon('info')}</button>`
      : `<button class="icon-btn sm" type="button" data-act="manage" aria-label="Manage offline languages">${icon('download')}</button>`)
    : `<button class="icon-btn sm" type="button" data-act="edit" aria-label="Edit ${name}">${icon('edit')}</button>`}
          ${rowMenu(e.id, name, [
    !isMock && i > 0 && ['up', 'Move up', 'up'],
    !isMock && i < movable.length - 1 && ['down', 'Move down', 'down'],
    !builtIn && ['delete', 'Remove', 'delete'],
  ])}
        </span></li>`;
    }).join('') : `<li class="svc-empty">${kind === 'advanced' ? 'No AI model yet. Add one to use Advanced translation.' : 'Nothing yet.'}</li>`;
  }
  renderEngines();
  if (hadId && !document.activeElement?.closest?.('.svc-row')) {
    const row = document.querySelector(`.svc-row[data-id="${hadId}"]`);
    (row?.querySelector(`[data-act="${hadAct}"]:not(:disabled)`) || row?.querySelector('input:not(:disabled)'))?.focus();
  }
}

/** "⋯" on a service row: the rarer actions (order, remove) in a small menu instead of three more
 *  buttons on every row. A popover in the list, so the list's click handler runs its items too. */
function rowMenu(id, name, items) {
  items = items.filter(Boolean);
  if (!items.length) return '';
  return `<button class="icon-btn sm" type="button" data-act="more" popovertarget="svc-more-${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${name}">${icon('more')}</button>
    <div class="row-menu" id="svc-more-${id}" popover role="menu" aria-label="${name}">${items.map(([act, label, ic]) =>
    `<button type="button" role="menuitem" data-act="${act}" aria-label="${label}: ${name}">${icon(ic)}<span>${label}</span></button>`).join('')}</div>`;
}

/** Place an open row menu under its "⋯" button (inside the viewport), focus its first item; arrow keys move. */
function wireRowMenus(list) {
  list.addEventListener('toggle', (e) => {
    const menu = e.target;
    if (!menu.matches?.('.row-menu')) return;
    const btn = list.querySelector(`[popovertarget="${menu.id}"]`);
    btn?.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open' || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    menu.style.top = `${r.bottom + 4 + h > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    menu.querySelector('[role=menuitem]')?.focus();
  }, true);
  list.addEventListener('keydown', (e) => {
    const menu = e.target.closest?.('.row-menu');
    if (!menu) return;
    const items = [...menu.querySelectorAll('[role=menuitem]')];
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    items[(items.indexOf(document.activeElement) + step + items.length) % items.length].focus();
  });
}

/** Voice services (ElevenLabs): not translation services, so no radio and no order; they are
 * picked in the Read aloud and Speech recognition groups. */
function renderVoiceList(s) {
  const list = s.entries.filter((e) => kindOf(e) === 'voice');
  $('svc-voice').innerHTML = list.length ? list.map((e) => {
    const name = escapeHtml(e.label);
    return `<li class="svc-row" data-id="${e.id}">
      <span class="svc-pick svc-pick-static"><span class="svc-copy"><strong>${name}</strong>${tagLine(`svc-tags-${e.id}`, svcTags(e))}<small id="svc-sub-${e.id}">${escapeHtml(subtitle(e))}</small></span></span>
      <span class="svc-actions">
        ${infoButton(`svc-${e.id}`, e.label, svcInfo(e))}
        <button class="icon-btn sm" type="button" data-act="edit" aria-label="Edit ${name}" aria-describedby="svc-sub-${e.id}">${icon('edit')}</button>
        <button class="icon-btn sm" type="button" data-act="delete" aria-label="Remove ${name}">${icon('delete')}</button>
      </span></li>`;
  }).join('') : '<li class="svc-empty">None yet. Optional: cloud voices for reading aloud and voice input.</li>';
}

/** "(868 MB) from Hugging Face" / "from huggingface.co" / "with Chrome" */
function llmFrom(spec) {
  if (spec.kind === 'nano') return 'with Chrome';
  let host = 'Hugging Face';
  if (spec.custom) { try { host = new URL(spec.custom.url).host; } catch { host = 'your model URL'; } }
  return `${spec.sizeMB ? `(${formatMB(spec.sizeMB * 1e6)}) ` : ''}from ${host}`;
}

function llmButton(e) {
  const name = escapeHtml(e.label);
  const spec = llmSpec(e.config);
  if (llmState(spec.key) === 'downloading') {
    // Chrome's own download of Gemini Nano can't be stopped from here
    return spec.kind === 'nano'
      ? `<button class="icon-btn sm" type="button" data-act="llm-dl" aria-disabled="true" aria-label="Chrome is downloading ${name}">${icon('download')}</button>`
      : `<button class="icon-btn sm" type="button" data-act="llm-dl" aria-label="Cancel download of ${name}">${icon('close')}</button>`;
  }
  return `<button class="icon-btn sm" type="button" data-act="llm-dl" aria-label="Download ${name} ${escapeHtml(llmFrom(spec))}">${icon('download')}</button>`;
}

function startLlmDownload(e) {
  const spec = llmSpec(e.config);
  const key = spec.key;
  toast(`Downloading ${e.label} ${llmFrom(spec)}. You can keep using the app.`);
  downloadModel(key).then(
    () => toast(`${e.label} is ready. It works without internet.`),
    (err) => { if (!/cancel/i.test(err.message)) toast(err.message); },
  );
}

function llmDownloadToggle(e) {
  if (!e) return;
  const key = llmSpec(e.config).key;
  if (llmState(key) === 'downloading') {
    if (key === NANO) return; cancelModelDownload(); toast('Download stopped. It continues where it left off next time.'); }
  else startLlmDownload(e);
}

function remove(id) {
  const e = entries.get(id);
  if (!e) return;
  const s = settings.get();
  const pos = s.entries.findIndex((x) => x.id === id);
  const row = document.querySelector(`.svc-row[data-id="${id}"]`);
  const nextId = (row?.nextElementSibling || row?.previousElementSibling)?.dataset?.id;
  entries.remove(id);
  // the on-device AI model's files go too, unless another service uses the same model
  const key = e.type === 'webllm' ? llmSpec(e.config).key : null;
  const lastUser = key && key !== NANO
    && !settings.get().entries.some((x) => x.type === 'webllm' && llmSpec(x.config).key === key);
  const freed = lastUser && isDownloaded(key);
  if (lastUser) deleteModel(key);
  initProvider(); renderLists();
  // keep focus in the list: the next row, else the previous one, else the add button
  const nextRadio = nextId && document.querySelector(`.svc-row[data-id="${nextId}"] input`);
  const fallback = { advanced: 'btn-add-ai', voice: 'btn-add-eleven' }[kindOf(e)] || 'btn-add-lt';
  (nextRadio || document.querySelector(`.svc-row[data-id="${nextId}"] [data-act="edit"]`) || $(fallback)).focus();
  toast(freed ? `Removed ${e.label} and deleted its download` : `Removed ${e.label}`, {
    action: 'Undo',
    onAction: () => {
      const list = settings.get().entries;
      list.splice(Math.min(pos, list.length), 0, e);
      settings.set({ entries: list, activeClassic: s.activeClassic, activeAdvanced: s.activeAdvanced });
      initProvider();
      if (dlg.open) { renderLists(); document.querySelector(`.svc-row[data-id="${id}"] input`)?.focus(); }
    },
  });
}

/* -------------------------------------------------------------- editor */

function openEditor({ id, type }) {
  const e = id ? entries.get(id) : null;
  closeManager({ silent: true });
  closeOcrManager({ silent: true });
  closeVoiceManager({ silent: true });
  editing = { id: e?.id || newEntryId(), type: e?.type || type, isNew: !e, opener: document.activeElement };
  const def = getProviderDef(editing.type);
  const kindName = editing.type === 'webllm' ? 'on-device AI' : def.kind === 'advanced' ? 'AI model' : def.label;
  const addRow = { advanced: 'svc-add-advanced', voice: 'svc-add-voice' }[def.kind] || 'svc-add-classic';
  $('svc-editor-title').textContent = e ? `Edit ${e.label}` : `Add ${kindName}`;
  $('svc-desc').textContent = def.description || '';
  $('svc-name').value = e?.label || '';
  $('svc-name').placeholder = editing.isNew ? (editing.type === 'webllm' ? 'e.g. On-device AI' : def.kind === 'advanced' ? 'e.g. GPT, Groq, my Ollama' : def.kind === 'voice' ? `e.g. ${def.label}` : 'e.g. My server') : '';
  renderFields($('svc-fields'), def, e?.config || {});
  $('test-result').hidden = true;
  // on-device AI: testing would start the download; the save button says that it downloads
  $('btn-test').hidden = editing.type === 'mock' || editing.type === 'webllm';
  const saveLabel = () => {
    const spec = editing?.type === 'webllm' ? llmSpec(readFields($('svc-fields'))) : null;
    $('btn-svc-save').textContent = spec && !isDownloaded(spec.key) && !(spec.kind === 'nano' && !nanoUsable())
      ? `${editing.isNew ? 'Add' : 'Save'} and download` : 'Save';
  };
  saveLabel();
  if (editing.type === 'webllm') $('svc-fields').addEventListener('change', saveLabel);
  $('svc-editor').hidden = false;
  // the form opens right under the list it adds to
  $(addRow).after($('svc-editor'));
  showAddRows(false);
  requestAnimationFrame(() => {
    $('svc-editor').scrollIntoView({ block: 'nearest' });
    (editing.isNew ? $('svc-fields').querySelector('input, select') : $('svc-name'))?.focus();
  });
}

function showAddRows(on) { document.querySelectorAll('.svc-add').forEach((r) => { r.hidden = !on; }); }

function closeEditor({ silent = false } = {}) {
  const wasId = editing?.id;
  const opener = editing?.opener;
  editing = null;
  $('svc-editor').hidden = true;
  showAddRows(true);
  if (silent) return;
  // saved/edited: that row's edit button; cancelled add: the "+ Add" button that opened the editor
  const target = document.querySelector(`.svc-row[data-id="${wasId}"] [data-act="edit"]`)
    || (opener?.isConnected && opener.offsetParent ? opener : null) || $('btn-add-lt');
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

function saveEditor() {
  const def = getProviderDef(editing.type);
  const config = readFields($('svc-fields'));
  // a choice this browser can't run isn't saved (the option is greyed out; this catches an old saved choice)
  if (editing.type === 'webllm' && config.model === NANO && !nanoUsable()) {
    toast(nanoReason(), { duration: 10000 });
    $('svc-fields').querySelector('[data-key="model"]')?.focus();
    return;
  }
  for (const f of def.fields || []) {
    const shown = !f.showIf || Object.entries(f.showIf).every(([k, v]) => config[k] === v);
    if (shown && f.required && !config[f.key]) {
      const input = $('svc-fields').querySelector(`[data-key="${f.key}"]`);
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      toast(`${f.label} is required`);
      return;
    }
  }
  const label = $('svc-name').value.trim() || entryLabel(editing.type, config);
  const { id, isNew } = editing;
  entries.save({ id, type: editing.type, label, config });
  // the first real service of its kind becomes the one used
  const s = settings.get();
  const kind = def.kind || 'classic';
  if (isNew) {
    const firstReal = !s.entries.some((x) => x.id !== id && x.type !== 'mock' && kindOf(x) === kind);
    if (kind === 'classic' && (firstReal || s.activeClassic === MOCK_ENTRY.id)) settings.set({ activeClassic: id });
    if (kind === 'advanced' && firstReal) settings.set({ activeAdvanced: id });
  }
  initProvider();
  if (isNew && kind === 'advanced' && wantAdvanced) { wantAdvanced = false; useEntry(id); }
  renderLists();
  closeEditor();
  const spec = def.id === 'webllm' ? llmSpec(config) : null;
  if (spec && llmState(spec.key) === 'none' && !(spec.kind === 'nano' && !nanoUsable())) startLlmDownload({ label, config });
  else toast(isNew ? `Added ${label}${state.mode === kind && kind === 'advanced' ? ' · Advanced translation is on' : ''}` : `Saved ${label}`);
}

function renderFields(host, def, saved) {
  const id = def.id;
  host.innerHTML = (def.fields || []).map((f) => {
    const fid = `pf-${id}-${f.key}`;
    const raw = saved[f.key] ?? f.default ?? '';
    const val = f.normalize ? f.normalize(raw) : raw;
    if (f.type === 'cap') {
      return `<div class="field cap-field"><label class="cap-row" for="${fid}"><input type="checkbox" id="${fid}" data-cap="${f.key}" data-what="${f.what}" aria-describedby="${fid}-help">
        <span>${escapeHtml(f.label)}</span></label><p class="field-help" id="${fid}-help"></p></div>`;
    }
    // fields shown only for some choices can't use the browser's own "required" check (it blocks Save while hidden)
    const req = f.required ? (f.showIf ? 'aria-required="true"' : 'required aria-required="true"') : '';
    const control = f.type === 'select'
      ? `${f.filter ? `<input type="search" class="field-filter" id="${fid}-filter" data-filter-for="${fid}" placeholder="Filter, e.g. qwen, gemma, 3B" aria-label="Filter the ${escapeHtml(f.label.toLowerCase())} list" aria-controls="${fid}" autocomplete="off" spellcheck="false"><span class="visually-hidden" role="status" id="${fid}-count"></span>` : ''}
        <select id="${fid}" data-key="${f.key}" ${f.help ? `aria-describedby="${fid}-help"` : ''}>${selectOptions(f, val)}</select>`
      : `<input id="${fid}" data-key="${f.key}" type="${f.type || 'text'}" value="${escapeHtml(val)}" placeholder="${escapeHtml(f.placeholder || '')}"
           ${req} ${f.suggest ? 'list="adv-models"' : ''} ${f.help ? `aria-describedby="${fid}-help"` : ''}
           autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" spellcheck="false">`;
    return `<div class="field" ${f.showIf ? `data-show-if='${escapeHtml(JSON.stringify(f.showIf))}'` : ''}><label for="${fid}">${escapeHtml(f.label)}${f.required ? '' : ' (optional)'}</label>${control}
      ${f.help ? `<p class="field-help" id="${fid}-help">${escapeHtml(f.help)}</p>` : ''}</div>`;
  }).join('');
  host.style.display = host.innerHTML ? 'grid' : 'none';
  host.style.gap = '12px';
  // fields that only apply to one choice (e.g. own model URL): shown while that choice is picked
  const applyShowIf = () => {
    const cur = readFields(host);
    host.querySelectorAll('[data-show-if]').forEach((d) => {
      d.hidden = !Object.entries(JSON.parse(d.dataset.showIf)).every(([k, v]) => cur[k] === v);
    });
  };
  applyShowIf();
  host.addEventListener('change', applyShowIf);
  // a filter box narrows a long list; the chosen option always stays in it
  host.querySelectorAll('[data-filter-for]').forEach((box) => {
    const sel = $(box.dataset.filterFor);
    const f = def.fields.find((x) => x.key === sel.dataset.key);
    box.addEventListener('input', () => {
      const q = box.value.trim().toLowerCase();
      const cur = sel.value;
      sel.innerHTML = selectOptions(f, cur, q);
      // the count is announced once typing pauses
      const n = sel.querySelectorAll('option').length - (q ? 1 : 0);
      clearTimeout(box._t);
      box._t = setTimeout(() => { $(`${box.id.replace(/-filter$/, '')}-count`).textContent = q ? (n > 0 ? `${n} other match${n > 1 ? 'es' : ''}. Press Enter to choose.` : 'No other matches.') : ''; }, 600);
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sel.focus(); } });
  });
  // capabilities: saved 'on' / 'off' were confirmed by a test earlier; '' = not tested
  for (const f of def.fields || []) {
    if (f.type !== 'cap') continue;
    const box = host.querySelector(`[data-cap="${f.key}"]`);
    setCap(box, saved[f.key] === 'on' || saved[f.key] === 'off' ? saved[f.key] : '');
    // a different model hasn't been tested
    host.querySelector(`[data-key="${f.resetBy}"]`)?.addEventListener('input', () => setCap(box, ''));
  }
  // Fields that fill others (e.g. a service preset fills the base URL)
  for (const f of def.fields || []) {
    if (!f.fills) continue;
    host.querySelector(`[data-key="${f.key}"]`).addEventListener('change', (e) => {
      for (const [k, v] of Object.entries(f.fills(e.target.value))) {
        const input = host.querySelector(`[data-key="${k}"]`);
        if (input) input.value = v;
      }
    });
  }
}

/** <option>s of a select field; grouped fields (groups()) get <optgroup>s; q filters by label. */
function selectOptions(f, val, q = '') {
  const opt = (o) => `<option value="${escapeHtml(o.value)}" ${o.value === val ? 'selected' : ''} ${o.disabled ? 'disabled' : ''}>${escapeHtml(o.label)}</option>`;
  const keep = (o) => !q || o.value === val || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
  if (!f.groups) return f.options.filter(keep).map(opt).join('');
  return f.groups().map((g) => ({ ...g, options: g.options.filter(keep) })).filter((g) => g.options.length)
    .map((g) => `<optgroup label="${escapeHtml(g.group)}">${g.options.map(opt).join('')}</optgroup>`).join('');
}

function readFields(host) {
  const out = {};
  host.querySelectorAll('[data-key]').forEach((i) => { out[i.dataset.key] = i.value.trim(); });
  host.querySelectorAll('[data-cap]').forEach((b) => {
    out[b.dataset.cap] = b.dataset.state === 'ok' ? (b.checked ? 'on' : 'off') : '';
  });
  return out;
}

/**
 * One capability box. state: '' (not tested: off and unavailable), 'no' (test says it can't),
 * 'on' / 'off' (test confirmed it; the user decides).
 */
function setCap(box, state) {
  const ok = state === 'on' || state === 'off';
  box.dataset.state = ok ? 'ok' : state || 'untested';
  box.checked = state === 'on';
  // aria-disabled, not disabled: stays reachable, so the reason below is heard
  if (ok) box.removeAttribute('aria-disabled'); else box.setAttribute('aria-disabled', 'true');
  const what = box.dataset.what;
  const field = { audio: 'sttModel', speech: 'ttsModel' }[what];
  const input = field && $('svc-fields').querySelector(`input[data-key="${field}"]`);
  const needsModel = input && !input.value.trim();
  const COPY = {
    images: ['Checked by the test. Untick to not send drawings to this model.', "The test showed this model can't read images."],
    audio: ['Checked by the test. Untick to not send your voice to this service.', "The test showed this speech-to-text model doesn't work here."],
    speech: ['Checked by the test. Untick to not send translations to this service for reading aloud.', "The test showed reading aloud doesn't work here."],
  }[what];
  $(box.getAttribute('aria-describedby')).textContent = ok ? COPY[0]
    : state === 'no' ? COPY[1]
      : needsModel ? `Fill in a ${what === 'speech' ? 'text-to-speech' : 'speech-to-text'} model above, then press “Test connection” to check it.`
        : 'Not checked yet. Press “Test connection” to find out.';
}

/* ------------------------------------------------- offline languages manager */

function openManager() {
  if (editing) closeEditor({ silent: true });
  closeOcrManager({ silent: true });
  closeVoiceManager({ silent: true });
  $('offline-search').value = '';
  $('svc-add-classic').after($('offline-manager'));   // under the Classic list it belongs to
  $('offline-manager').hidden = false;
  showAddRows(false);
  renderManager();
  if (!downloadsBlocked) loadRegistry().then(() => { if (!$('offline-manager').hidden) renderManager(); }).catch((e) => {
    $('offline-usage').textContent = e.message;
  });
  requestAnimationFrame(() => { $('offline-manager').scrollIntoView({ block: 'start' }); (downloadsBlocked ? $('offline-blocked') : $('offline-search')).focus(); });
}

function closeManager({ silent = false } = {}) {
  if ($('offline-manager').hidden) return;
  $('offline-manager').hidden = true;
  showAddRows(true);
  renderLists();
  if (!silent) document.querySelector('.svc-row [data-act="manage"]')?.focus();
}

function renderManager() {
  // blocked: a heading and the reason, read once when focus lands on it (no live region)
  $('offline-title').textContent = downloadsBlocked ? "Offline languages aren't available" : 'Offline languages';
  for (const id of ['offline-help', 'offline-source', 'offline-usage', 'offline-search', 'offline-list']) $(id).hidden = downloadsBlocked;
  $('offline-blocked').hidden = !downloadsBlocked;
  if (downloadsBlocked) { $('offline-blocked').textContent = BLOCKED_REASON; return; }
  $('offline-source').innerHTML = offlineSourceHtml();
  const q = $('offline-search').value.trim().toLowerCase();
  const n = installedLanguages().length;
  $('offline-usage').textContent = n ? `${n} downloaded · ${formatMB(usedBytes())} used on this device` : 'Nothing downloaded yet.';
  const codes = offlineLanguages().filter((c) => c !== 'en');
  const rank = (c) => ({ ready: 0, downloading: 1, none: 2 }[packState(c)]);
  const rows = codes
    .map((c) => ({ c, name: langName(c) }))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.c === q)
    .sort((a, b) => rank(a.c) - rank(b.c) || a.name.localeCompare(b.name));
  const focused = document.activeElement?.closest?.('#offline-list [data-dl]')?.dataset.dl;
  $('offline-list').innerHTML = rows.length ? rows.map(({ c, name }) => {
    const st = packState(c);
    const size = packSize(c);
    const sub = st === 'ready' ? 'Downloaded' : st === 'downloading' ? 'Downloading…' : size ? formatMB(size) : '';
    return `<li class="offline-row"><span class="offline-copy"><span>${escapeHtml(name)}</span><small>${sub}</small></span>${dlButton(c, true)}</li>`;
  }).join('') : `<li class="svc-empty">No languages match.</li>`;
  updateDownloadButtons($('offline-list'));
  if (focused) $('offline-list').querySelector(`[data-dl="${focused}"]`)?.focus();
}
