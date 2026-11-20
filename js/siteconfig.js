// Site settings for this deployment, from change-me.md (`key = value`, one per line).
// The last values read are kept in this browser, so they apply right away on the next start
// (and offline); the file is fetched again on every start in case it changed.
const CACHE = 'ot.site.v1';

const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } };
let values = readCache();
let loading = null;

/** A setting, or undefined when it isn't set. Synchronous: uses the last values read. */
export const siteValue = (key) => values[key];

/** false only when change-me.md says `demo_mode = false` (or off / no / 0). */
export const demoEnabled = () => !/^(false|off|no|0)$/i.test(values.demo_mode ?? '');

/** Fetch change-me.md (once). Resolves to true when a value changed since the last start. */
export function loadSiteConfig() {
  loading ??= (async () => {
    let text;
    try {
      const res = await fetch('change-me.md', { cache: 'no-cache' });
      if (!res.ok) return false;
      text = await res.text();
    } catch { return false; }   // offline and not cached: keep the last values
    const next = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([a-z_]+)\s*=\s*(\S+)\s*$/i);
      if (m) next[m[1].toLowerCase()] = m[2];
    }
    const changed = JSON.stringify(next) !== JSON.stringify(values);
    values = next;
    try { localStorage.setItem(CACHE, JSON.stringify(next)); } catch { /* private mode */ }
    return changed;
  })();
  return loading;
}
