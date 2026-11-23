// History / Saved overlay sheet.
import { history, phrasebook, onChange } from '../store.js';
import { langName } from '../state.js';
import { icon } from './icons.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { escapeHtml } from './langpicker.js';
import { toast } from './snackbar.js';

let dlg, list, empty, title, clearBtn, segs;
let mode = 'history';
let onPick = () => {};

export function initHistorySheet({ onSelect }) {
  onPick = onSelect;
  dlg = setupDialog(document.getElementById('history-dialog'));
  list = document.getElementById('entry-list');
  empty = document.getElementById('entry-empty');
  title = document.getElementById('history-title');
  clearBtn = document.getElementById('history-clear');
  segs = [...dlg.querySelectorAll('[data-seg]')];

  segs.forEach((b) => b.addEventListener('click', () => { mode = b.dataset.seg; render(); }));
  dlg.querySelector('.segmented').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    mode = mode === 'history' ? 'saved' : 'history';
    render();
    dlg.querySelector(`[data-seg="${mode}"]`).focus();
  });

  clearBtn.addEventListener('click', () => {
    const store = mode === 'history' ? history : phrasebook;
    const backup = store.all();
    if (!backup.length) return;
    store.clear();
    toast(mode === 'history' ? 'History cleared' : 'Saved translations cleared', {
      action: 'Undo',
      onAction: () => { localStorage.setItem(mode === 'history' ? 'ot.history.v1' : 'ot.phrasebook.v1', JSON.stringify(backup)); render(); },
    });
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.entry');
    if (!li) return;
    const items = mode === 'history' ? history.all() : phrasebook.all();
    const item = items.find((x) => x.id === li.dataset.id);
    if (!item) return;
    if (e.target.closest('[data-act="star"]')) { phrasebook.toggle(item); return; }
    if (e.target.closest('[data-act="delete"]')) {
      (mode === 'history' ? history : phrasebook).remove(item.id);
      return;
    }
    if (e.target.closest('.entry-main')) { closeDialog(dlg); onPick(item); }
  });

  onChange((what) => { if (dlg.open && (what === 'history' || what === 'phrasebook')) render(); });
}

export function openHistory(which = 'history') {
  mode = which;
  render();
  openDialog(dlg);
}

function render() {
  segs.forEach((b) => {
    const on = b.dataset.seg === mode;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  dlg.querySelector('#history-panel').setAttribute('aria-labelledby', `seg-${mode}`);
  title.textContent = mode === 'history' ? 'History' : 'Saved';
  const items = mode === 'history' ? history.all() : phrasebook.all();
  clearBtn.hidden = !items.length;
  empty.hidden = !!items.length;
  list.hidden = !items.length;
  if (!items.length) {
    empty.innerHTML = mode === 'history'
      ? `${icon('history')}<strong>No history yet</strong><span>Your last 100 translations will show up here.</span>`
      : `${icon('starBorder')}<strong>No saved translations</strong><span>Tap the star on a translation to save it here.</span>`;
    return;
  }
  list.innerHTML = items.map((x) => {
    const starred = mode === 'saved' || phrasebook.has(x);
    return `<li class="entry" data-id="${x.id}">
      <button type="button" class="entry-main" aria-label="${escapeHtml(`${x.text} → ${x.result}. Open`)}">
        <div class="entry-langs">${escapeHtml(langName(x.source))} → ${escapeHtml(langName(x.target))}</div>
        <div class="entry-src" lang="${x.source}">${escapeHtml(x.text)}</div>
        <div class="entry-tgt" lang="${x.target}">${escapeHtml(x.result)}</div>
      </button>
      <button type="button" class="icon-btn" data-act="star" aria-pressed="${starred}" aria-label="${starred ? 'Remove from saved' : 'Save translation'}">${icon(starred ? 'star' : 'starBorder')}</button>
      ${mode === 'history' ? `<button type="button" class="icon-btn" data-act="delete" aria-label="Delete from history">${icon('close')}</button>` : ''}
    </li>`;
  }).join('');
}
