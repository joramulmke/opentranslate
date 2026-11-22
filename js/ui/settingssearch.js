// Settings › search box: only matching rows and their headings stay visible; an empty box shows
// everything. Rows are re-rendered all the time (downloads, tests), so the filter re-applies itself.
const $ = (id) => document.getElementById(id);
const MISS = 'search-miss';
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const has = (el, q) => norm(el.textContent + ' ' + (el.dataset?.keywords || '')).includes(q);

let form; let input; let applying = false;

function show(el, on) { el.classList.toggle(MISS, !on); }

/** Units inside a block of a fieldset: list rows, buttons rows, switch / radio rows, open editors. */
function units(el) {
  if (el.matches('ul.svc-list, ul.offline-list, .radio-list')) return [...el.children];
  if (el.matches('.svc-add')) return [...el.querySelectorAll('.btn')];
  return [el];
}

function apply() {
  if (!form) return;
  applying = true;
  const q = norm(input.value.trim());
  form.classList.toggle('is-searching', !!q);
  let found = 0;
  form.querySelectorAll(`.${MISS}`).forEach((el) => el.classList.remove(MISS));
  if (q) {
    for (const fs of form.querySelectorAll(':scope > fieldset, :scope > section')) {
      const legend = fs.querySelector(':scope > legend');
      if (legend && has(legend, q)) { found += 1; continue; }   // the whole group matches
      let h3 = null; let h4 = null; let h3Hit = false; let h4Hit = false;
      const shown = { h3: new Set(), h4: new Set() };
      let any = false;
      for (const el of fs.children) {
        if (el === legend) continue;
        if (el.matches('h3')) { h3 = el; h4 = null; h3Hit = has(el, q); h4Hit = false; if (h3Hit) { shown.h3.add(el); any = true; found += 1; } continue; }
        if (el.matches('h4')) { h4 = el; h4Hit = h3Hit || has(el, q); if (h4Hit) { shown.h4.add(el); if (h3) shown.h3.add(h3); any = true; if (!h3Hit) found += 1; } continue; }
        if (el.hidden) continue;
        if (h4Hit || h3Hit) continue;   // under a matching heading: everything stays
        const us = units(el);
        let hit = false;
        for (const u of us) {
          const ok = !u.hidden && has(u, q);
          if (us.length > 1 || u !== el) show(u, ok);
          if (ok) { hit = true; found += 1; }
        }
        show(el, hit);
        if (hit) { any = true; if (h4) shown.h4.add(h4); if (h3) shown.h3.add(h3); }
      }
      for (const el of fs.querySelectorAll(':scope > h3')) show(el, shown.h3.has(el));
      for (const el of fs.querySelectorAll(':scope > h4')) show(el, shown.h4.has(el));
      if (!legend && fs.matches('section') && !any) show(fs, has(fs, q));
      else show(fs, any);
    }
    for (const p of form.querySelectorAll(':scope > p:not(#settings-search-none)')) show(p, false);
  }
  const none = $('settings-search-none');
  none.hidden = !q || found > 0;
  none.textContent = q && !found ? `No settings match “${input.value.trim()}”.` : '';
  const status = $('settings-search-status');
  const text = q ? (found ? `${found} match${found === 1 ? '' : 'es'}` : 'No matches') : '';
  if (status.textContent !== text) status.textContent = text;
  applying = false;
}

export function initSettingsSearch() {
  form = $('settings-form');
  input = $('settings-search');
  if (!form || !input) return;
  let t = 0;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(apply, 120); });
  input.addEventListener('keydown', (e) => {
    // Escape clears the box first; a second Escape closes Settings as usual
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); }
  });
  // rows are re-rendered (downloads, tests, edits): filter the new ones too
  new MutationObserver(() => { if (!applying && input.value.trim()) { clearTimeout(t); t = setTimeout(apply, 60); } })
    .observe(form, { childList: true, subtree: true });
}

/** Opening Settings starts with everything visible. */
export function resetSettingsSearch() {
  if (!input) return;
  input.value = '';
  apply();
}
