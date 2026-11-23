// Settings → "Version abc1234": which commit this copy of the app runs (version.json, stamped by the deploy).
// "Check for updates" asks the server for its version; "Update now" appears only when a newer one exists.
// Only the app's own files are replaced: downloaded models, voices and settings stay.
const REPO = 'https://github.com/joramulmke/opentranslate';
const $ = (id) => document.getElementById(id);
let running = null;

async function readVersion(latest) {
  // '?latest' makes sw.js go to the server; without it, the file comes from this version's cache
  const res = await fetch(latest ? 'version.json?latest' : 'version.json', { cache: latest ? 'no-store' : 'default' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const shortSha = (v) => (v?.commit && v.commit !== 'dev' ? v.commit.slice(0, 7) : 'dev');
function label(v) {
  const d = v?.date ? new Date(v.date) : null;
  const date = d && !Number.isNaN(+d) ? ` · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  return shortSha(v) + date;
}

export async function initVersion() {
  const link = $('app-version');
  const status = $('update-status');
  const check = $('update-check');
  const reload = $('update-reload');
  if (!link) return;
  try {
    running = await readVersion(false);
    link.textContent = label(running);
    if (shortSha(running) !== 'dev') link.href = `${REPO}/commit/${running.commit}`;
  } catch { link.textContent = 'unknown'; }

  check.addEventListener('click', async () => {
    check.disabled = true;
    status.textContent = 'Checking…';
    try {
      const [latest] = await Promise.all([
        readVersion(true),
        navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {}),  // start downloading it
      ]);
      const fresh = latest.commit === running?.commit;
      status.textContent = fresh ? 'Up to date.' : `New version available: ${label(latest)}`;
      reload.hidden = fresh;   // only offered when there is something to switch to
    } catch {
      status.textContent = 'Could not reach the server.';
      reload.hidden = true;
    }
    check.disabled = false;
  });

  reload.addEventListener('click', async () => {
    reload.disabled = check.disabled = true;
    status.textContent = 'Updating…';
    await hardReload();
  });
}

const once = (target, type) => new Promise((ok) => target.addEventListener(type, ok, { once: true }));
const within = (ms, p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('timeout'), ms))]);

async function hardReload() {
  const sw = navigator.serviceWorker;
  const reg = await sw?.getRegistration().catch(() => null);
  if (!reg) { location.reload(); return; }
  try { await reg.update(); } catch { /* offline: fall through */ }
  // a new version that is still downloading: wait for it (it fetches every file fresh, past the HTTP cache)
  const inst = reg.installing;
  if (inst) {
    await within(60000, new Promise((ok) => {
      inst.addEventListener('statechange', () => { if (inst.state === 'installed' || inst.state === 'redundant') ok(); });
    }));
  }
  if (reg.waiting) {
    try { sessionStorage.setItem('ot-updating', '1'); } catch { /* start() then just checks again */ }
    const switched = within(5000, once(sw, 'controllerchange'));
    reg.waiting.postMessage('skipWaiting');
    if (await switched !== 'timeout') { location.reload(); return; }
  }
  // no new version to switch to (or it got stuck): drop the app's own cache and start clean.
  // Only 'ot-shell-*' is deleted; models (ot-offline-*, ot-engine-*, …) are kept.
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ot-shell-')).map((k) => caches.delete(k)));
  } catch { /* no cache storage */ }
  await reg.unregister().catch(() => {});
  location.reload();
}
