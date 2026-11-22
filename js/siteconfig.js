// Site settings for this deployment, from change-me.txt (`key = value`, one per line; # starts a comment).
// Copies set up before it was renamed may still have change-me.md: read as a fallback.
// The last values read are kept in this browser, so they apply right away on the next start
// (and offline); the file is fetched again on every start in case it changed.
const CACHE = 'ot.site.v1';

const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE)) || {}; } catch { return {}; } };
let values = readCache();
let loading = null;

/** A setting, or undefined when it isn't set. Synchronous: uses the last values read. */
export const siteValue = (key) => values[key];

/** false only when change-me.txt says `demo_mode = false` (or off / no / 0). */
export const demoEnabled = () => !/^(false|off|no|0)$/i.test(values.demo_mode ?? '');

/** Fetch change-me.txt (or the old change-me.md) once. Resolves to true when a value changed since the last start. */
export function loadSiteConfig() {
  loading ??= (async () => {
    let text = null;
    for (const name of ['change-me.txt', 'change-me.md']) {
      try {
        const res = await fetch(name, { cache: 'no-cache' });
        // some hosts answer a missing file with the app page: that isn't the settings file
        if (res.ok && !/html/i.test(res.headers.get('content-type') || '')) { text = await res.text(); break; }
      } catch { /* offline: try the next, then keep the last values */ }
    }
    if (text == null) return false;
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
