// Settings sheet. Translation services are a list (Classic group, Advanced group) with
// "+ Add" buttons; the form for one service opens only when adding or editing it.
// Provider fields are rendered from each provider definition, so new provider types need
// no UI changes here.
import { getProviderDef, createProvider } from '../providers.js';
import { settings, entries, entryLabel, newEntryId, MOCK_ENTRY, BUILT_IN } from '../store.js';
import { installedLanguages, usedBytes, offlineLanguages, packState, packSize, onOfflineChange, loadRegistry, downloadsBlocked, offlineUnusable, BLOCKED_REASON } from '../features/offline.js';
import { dlButton, updateDownloadButtons, onDownloadClick, formatMB } from './offlineui.js';
import { langName } from '../state.js';
import { initProvider, kindOf, useEntry, state } from '../state.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { escapeHtml } from './langpicker.js';
import { toast } from './snackbar.js';
import { icon } from './icons.js';
import { ENGINES } from '../features/hwr.js';

const $ = (id) => document.getElementById(id);
let dlg, form;
let editing = null;          // { id, type, isNew } while the editor is open
let wantAdvanced = false;    // opened from "Advanced" without an AI model: switch to it once added

export function initSettingsSheet({ onThemeChange }) {
  dlg = setupDialog($('settings-dialog'));
  form = $('settings-form');

  $('btn-add-lt').addEventListener('click', () => openEditor({ type: 'libretranslate' }));
  $('btn-add-ai').addEventListener('click', () => openEditor({ type: 'openai' }));
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

  for (const listId of ['svc-classic', 'svc-advanced']) {
    const list = $(listId);
    list.addEventListener('change', (e) => {
      if (e.target.matches('input[type=radio]')) { useEntry(e.target.value); renderLists(); }
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('[data-id]').dataset.id;
      const act = btn.dataset.act;
      if (act === 'edit') openEditor({ id });
      if (act === 'manage') openManager();
      if (act === 'up' || act === 'down') {
        entries.move(id, act === 'up' ? -1 : 1, kindOf);
        initProvider(); renderLists();
        $(listId).querySelector(`[data-id="${id}"] [data-act="${act}"]:not(:disabled)`)?.focus()
          || $(listId).querySelector(`[data-id="${id}"] input`)?.focus();
      }
      if (act === 'delete') remove(id);
    });
  }

  wireTest($('btn-test'), $('test-result'), (r) => {
    if (r.models?.length) $('adv-models').innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  });

  // Enter in an editor field saves that service; nothing else in the sheet needs saving
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (editing) saveEditor();
  });

  $('set-live').addEventListener('change', (e) => settings.set({ liveTranslate: e.target.checked }));
  $('set-speak').addEventListener('change', (e) => settings.set({ speakConversation: e.target.checked }));
  $('set-hwr').innerHTML = Object.entries(ENGINES).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
  // choosing an engine explicitly also resets an earlier "Use basic" answer to the model download prompt
  $('set-hwr').addEventListener('change', (e) => settings.set({ hwrEngine: e.target.value, ...(e.target.value === 'ondevice' ? { hwrModelOk: null } : {}) }));
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
  renderLists();
  $('set-live').checked = s.liveTranslate;
  $('set-speak').checked = s.speakConversation;
  $('set-hwr').value = s.hwrEngine || 'auto';
  form.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === s.theme; });
  openDialog(dlg);
  if (focus === 'offline') openManager();
  if (focus === 'advanced') {
    if (!s.entries.some((e) => kindOf(e) === 'advanced')) openEditor({ type: 'openai' });
    else requestAnimationFrame(() => { $('svc-advanced-head').scrollIntoView({ block: 'start' }); $('svc-advanced').querySelector('input')?.focus(); });
  }
}

/* ---------------------------------------------------------------- list */

function subtitle(e) {
  const c = e.config || {};
  if (e.type === 'mock') return 'A few phrases only, for trying the app';
  if (e.type === 'offline') {
    if (offlineUnusable()) return 'Not available in this browser';
    const n = installedLanguages().length;
    return n ? `${n} language${n > 1 ? 's' : ''} + English · ${formatMB(usedBytes())} · works without internet` : 'No languages downloaded yet';
  }
  let host = c.baseUrl || '';
  try { host = new URL(c.baseUrl).host; } catch { /* keep raw */ }
  if (e.type === 'openai') return [host, c.model].filter(Boolean).join(' · ');
  return host;
}

const blocked = (e) => e.type === 'offline' && offlineUnusable();

function renderLists() {
  const s = settings.get();
  const lead = { classic: null, advanced: null };
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
        <label class="svc-pick"><input type="radio" name="svc-${kind}" value="${e.id}" aria-describedby="svc-sub-${e.id}" ${e === lead[kind] ? 'checked' : ''} ${blocked(e) ? 'disabled' : ''}>
          <span class="svc-copy"><strong title="${name}">${name}</strong><small id="svc-sub-${e.id}">${escapeHtml(subtitle(e))}</small></span></label>
        <span class="svc-actions">
          ${isMock ? '' : `<button class="icon-btn sm" type="button" data-act="up" aria-label="Move ${name} up" ${i <= 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="icon-btn sm" type="button" data-act="down" aria-label="Move ${name} down" ${i >= movable.length - 1 ? 'disabled' : ''}>${icon('down')}</button>`}
          ${e.type === 'offline'
    ? (blocked(e)
      ? `<button class="icon-btn sm" type="button" data-act="manage" aria-label="Why offline languages aren't available" aria-describedby="svc-sub-${e.id}">${icon('info')}</button>`
      : `<button class="icon-btn sm" type="button" data-act="manage" aria-label="Manage offline languages">${icon('download')}</button>`)
    : `<button class="icon-btn sm" type="button" data-act="edit" aria-label="Edit ${name}">${icon('edit')}</button>`}
          ${builtIn ? '' : `<button class="icon-btn sm" type="button" data-act="delete" aria-label="Remove ${name}">${icon('delete')}</button>`}
        </span></li>`;
    }).join('') : `<li class="svc-empty">${kind === 'advanced' ? 'No AI model yet. Add one to use Advanced translation.' : 'Nothing yet.'}</li>`;
  }
}

function remove(id) {
  const e = entries.get(id);
  if (!e) return;
  const s = settings.get();
  const pos = s.entries.findIndex((x) => x.id === id);
  const row = document.querySelector(`.svc-row[data-id="${id}"]`);
  const nextId = (row?.nextElementSibling || row?.previousElementSibling)?.dataset?.id;
  entries.remove(id);
  initProvider(); renderLists();
  // keep focus in the list: the next row, else the previous one, else the add button
  const nextRadio = nextId && document.querySelector(`.svc-row[data-id="${nextId}"] input`);
  (nextRadio || $('btn-add-lt')).focus();
  toast(`Removed ${e.label}`, {
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
  editing = { id: e?.id || newEntryId(), type: e?.type || type, isNew: !e, opener: document.activeElement };
  const def = getProviderDef(editing.type);
  const kindName = def.kind === 'advanced' ? 'AI model' : def.label;
  $('svc-editor-title').textContent = e ? `Edit ${e.label}` : `Add ${kindName}`;
  $('svc-desc').textContent = def.description || '';
  $('svc-name').value = e?.label || '';
  $('svc-name').placeholder = editing.isNew ? (def.kind === 'advanced' ? 'e.g. GPT, Groq, my Ollama' : 'e.g. My server') : '';
  renderFields($('svc-fields'), def, e?.config || {});
  $('test-result').hidden = true;
  $('btn-test').hidden = editing.type === 'mock';
  $('svc-editor').hidden = false;
  $('svc-add').hidden = true;
  requestAnimationFrame(() => {
    $('svc-editor').scrollIntoView({ block: 'nearest' });
    (editing.isNew ? $('svc-fields').querySelector('input, select') : $('svc-name'))?.focus();
  });
}

function closeEditor({ silent = false } = {}) {
  const wasId = editing?.id;
  const opener = editing?.opener;
  editing = null;
  $('svc-editor').hidden = true;
  $('svc-add').hidden = false;
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
  for (const f of def.fields || []) {
    if (f.required && !config[f.key]) {
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
  toast(isNew ? `Added ${label}${state.mode === kind && kind === 'advanced' ? ' · Advanced translation is on' : ''}` : `Saved ${label}`);
}

function renderFields(host, def, saved) {
  const id = def.id;
  host.innerHTML = (def.fields || []).map((f) => {
    const fid = `pf-${id}-${f.key}`;
    const val = saved[f.key] ?? f.default ?? '';
    const control = f.type === 'select'
      ? `<select id="${fid}" data-key="${f.key}" ${f.help ? `aria-describedby="${fid}-help"` : ''}>${f.options.map((o) => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`
      : `<input id="${fid}" data-key="${f.key}" type="${f.type || 'text'}" value="${escapeHtml(val)}" placeholder="${escapeHtml(f.placeholder || '')}"
           ${f.required ? 'required aria-required="true"' : ''} ${f.suggest ? 'list="adv-models"' : ''} ${f.help ? `aria-describedby="${fid}-help"` : ''}
           autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" spellcheck="false">`;
    return `<div class="field"><label for="${fid}">${escapeHtml(f.label)}${f.required ? '' : ' (optional)'}</label>${control}
      ${f.help ? `<p class="field-help" id="${fid}-help">${escapeHtml(f.help)}</p>` : ''}</div>`;
  }).join('');
  host.style.display = host.innerHTML ? 'grid' : 'none';
  host.style.gap = '12px';
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

function readFields(host) {
  const out = {};
  host.querySelectorAll('[data-key]').forEach((i) => { out[i.dataset.key] = i.value.trim(); });
  return out;
}

/* ------------------------------------------------- offline languages manager */

function openManager() {
  if (editing) closeEditor({ silent: true });
  $('offline-search').value = '';
  $('offline-manager').hidden = false;
  $('svc-add').hidden = true;
  renderManager();
  if (!downloadsBlocked) loadRegistry().then(() => { if (!$('offline-manager').hidden) renderManager(); }).catch((e) => {
    $('offline-usage').textContent = e.message;
  });
  requestAnimationFrame(() => { $('offline-manager').scrollIntoView({ block: 'start' }); (downloadsBlocked ? $('offline-blocked') : $('offline-search')).focus(); });
}

function closeManager({ silent = false } = {}) {
  if ($('offline-manager').hidden) return;
  $('offline-manager').hidden = true;
  $('svc-add').hidden = false;
  renderLists();
  if (!silent) document.querySelector('.svc-row [data-act="manage"]')?.focus();
}

function renderManager() {
  // blocked: a heading and the reason, read once when focus lands on it (no live region)
  $('offline-title').textContent = downloadsBlocked ? "Offline languages aren't available" : 'Offline languages';
  for (const id of ['offline-help', 'offline-usage', 'offline-search', 'offline-list']) $(id).hidden = downloadsBlocked;
  $('offline-blocked').hidden = !downloadsBlocked;
  if (downloadsBlocked) { $('offline-blocked').textContent = BLOCKED_REASON; return; }
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
