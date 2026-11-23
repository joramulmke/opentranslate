// Keep downloads safe (persistent storage). Downloads can be several GB, and when space runs low the browser
// may delete them without asking. The first time someone downloads something, the app asks them first
// (its own sheet); only after "Keep them safe" does it ask the browser (navigator.storage.persist()).
// Chrome, Edge and Safari decide by themselves (installed, bookmarked, used a lot); Firefox shows its own
// prompt. A "no" from the browser can change, so it's asked again later without the sheet: after the app is
// installed, at the next start as an installed app, and at the next downloads. Settings has a switch too.
import { settings } from '../store.js';
import { sheet } from './permissions.js';

const api = () => (typeof navigator !== 'undefined' && navigator.storage?.persist ? navigator.storage : null);
const listeners = new Set();
let state = null;   // null (unknown) | 'kept' | 'not-kept' | 'unsupported'
let asking = null;

/** Whether this browser can keep downloads safe at all. */
export const persistSupported = () => !!api();

/** 'kept' | 'not-kept' | 'unsupported' */
export async function persistState() {
  if (!api()) return (state = 'unsupported');
  try { state = (await api().persisted()) ? 'kept' : 'not-kept'; } catch { state = 'not-kept'; }
  return state;
}

export function onPersistChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => { try { fn(state); } catch { /* */ } });

/** Ask the browser (no sheet). Resolves true when downloads are kept safe. */
export async function askBrowser() {
  if (!api()) return false;
  let ok = false;
  try { ok = (await api().persisted()) || (await api().persist()); } catch { ok = false; }
  state = ok ? 'kept' : 'not-kept';
  emit();
  return ok;
}

/**
 * Call when someone starts a download. Doesn't wait for it: the download starts at once, either way.
 * First time: the sheet. After "Keep them safe": the browser, again each time until it says yes.
 */
export function keepDownloadsSafe() {
  if (!api() || asking) return;
  asking = (async () => {
    try {
      if (state === 'kept' || (await persistState()) === 'kept') return;
      const pref = settings.get().keepSafe;   // null = not asked yet, true/false = the answer
      if (pref === false) return;
      if (pref == null) {
        const yes = await sheet({
          iconName: 'download', title: 'Keep downloads safe?',
          bodyHtml: 'Downloads can be large. <strong>When space on this device runs low, the browser may delete them without asking.</strong> OpenTranslate can ask the browser to keep them.',
          allowLabel: 'Keep them safe', cancelLabel: 'Not now',
        });
        settings.set({ keepSafe: yes });
        if (!yes) { emit(); return; }
      }
      await askBrowser();
    } finally { asking = null; }
  })();
}

/** Settings switch: on asks the browser right away, off just stops asking (the browser can't be told to forget). */
export async function setKeepSafe(on) {
  settings.set({ keepSafe: on });
  if (on) return askBrowser();
  emit();
  return false;
}

/** At start: if the user said yes but the browser said no, ask it again once installed. */
export function initPersist() {
  if (!api()) return;
  const retry = () => { if (settings.get().keepSafe === true && state !== 'kept') askBrowser(); };
  persistState().then(() => {
    const installed = matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches
      || navigator.standalone === true;
    if (installed) retry();
  });
  // Chrome needs a moment after installing before it counts the app as installed
  window.addEventListener('appinstalled', () => setTimeout(retry, 3000));
}
