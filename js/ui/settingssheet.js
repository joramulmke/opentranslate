// Settings sheet. Provider fields are rendered from each provider definition, so new
// providers need no UI changes here. Two groups: Classic (radio list of providers) and
// Advanced (the LLM provider: OpenAI-compatible API).
import { listProviders, getProviderDef, createProvider } from '../providers.js';
import { settings } from '../store.js';
import { initProvider } from '../state.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { escapeHtml } from './langpicker.js';
import { toast } from './snackbar.js';

const $ = (id) => document.getElementById(id);
let dlg, form;
let selected = 'mock';       // classic provider id being edited
let advId = 'openai';        // advanced provider id
let draft = {};              // unsaved field values per provider while switching radios

export function initSettingsSheet({ onThemeChange }) {
  dlg = setupDialog($('settings-dialog'));
  form = $('settings-form');

  $('provider-options').addEventListener('change', (e) => {
    if (e.target.name !== 'provider') return;
    draft[selected] = readFields($('provider-fields'));
    selected = e.target.value;
    renderClassic();
    $('test-result').hidden = true;
  });

  wireTest($('btn-test'), $('test-result'), () => [selected, readFields($('provider-fields'))]);
  wireTest($('btn-test-adv'), $('test-result-adv'), () => [advId, readFields($('adv-fields'))], (r) => {
    if (r.models?.length) $('adv-models').innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
    closeDialog(dlg);
    toast('Settings saved');
  });

  $('set-live').addEventListener('change', (e) => settings.set({ liveTranslate: e.target.checked }));
  $('set-speak').addEventListener('change', (e) => settings.set({ speakConversation: e.target.checked }));
  $('theme-options').addEventListener('change', (e) => {
    settings.set({ theme: e.target.value });
    onThemeChange(e.target.value);
  });
}

function wireTest(btn, out, get, onResult) {
  btn.addEventListener('click', async () => {
    out.hidden = false;
    out.className = 'test-result';
    out.textContent = 'Testing…';
    btn.disabled = true;
    try {
      const [id, cfg] = get();
      // Advanced: allow testing without a model so the model list can be discovered
      const lenient = getProviderDef(id)?.kind === 'advanced' && String(cfg.baseUrl || '').trim();
      const r = await createProvider(id, cfg, { skipRequired: !!lenient }).test();
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

/** @param {'advanced'} [focus]  open scrolled to the Advanced section */
export function openSettings(focus) {
  const s = settings.get();
  selected = s.providerId;
  advId = s.advancedProviderId || 'openai';
  draft = {};
  $('provider-options').innerHTML = listProviders('classic').map((p) => `
    <label class="radio-row"><input type="radio" name="provider" value="${p.id}" ${p.id === selected ? 'checked' : ''}>
      <span>${escapeHtml(p.label)}</span></label>`).join('');
  renderClassic();
  renderFields($('adv-fields'), advId, $('adv-desc'));
  $('test-result').hidden = true;
  $('test-result-adv').hidden = true;
  $('set-live').checked = s.liveTranslate;
  $('set-speak').checked = s.speakConversation;
  form.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === s.theme; });
  openDialog(dlg);
  if (focus === 'advanced') {
    requestAnimationFrame(() => {
      $('advanced-group').scrollIntoView({ block: 'start' });
      $('adv-fields').querySelector('input, select')?.focus();
    });
  }
}

function renderClassic() { renderFields($('provider-fields'), selected, $('provider-desc')); }

function renderFields(host, id, descEl) {
  const def = getProviderDef(id);
  if (!def) { host.innerHTML = ''; return; }
  descEl.textContent = def.description || '';
  const saved = { ...settings.providerConfig(id), ...(draft[id] || {}) };
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

function save() {
  settings.setProviderConfig(selected, readFields($('provider-fields')));
  settings.setProviderConfig(advId, readFields($('adv-fields')));
  settings.set({ providerId: selected, advancedProviderId: advId });
  initProvider();
}
