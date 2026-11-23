// Back up or move (IDEAS #14): settings, phrasebook, history and recent languages, to keep or to take to
// another phone or computer. No account, nothing leaves the device unless you send it yourself.
//   File          opentranslate-backup-YYYY-MM-DD.json (download; on phones: the share menu)
//   Copy as text  the same JSON, to paste into a chat or an email to yourself
//   QR codes      the backup compressed and split into numbered codes, with Back / Next; scanned on the
//                 other device in Import (BarcodeDetector: Android Chrome, Macs; not Windows Chrome)
// API keys only with "Include API keys" (off by default). Downloads (languages, voices, models) never.
import { getProviderDef } from '../providers.js';
import { toast, copyToClipboard } from './snackbar.js';
import { setupDialog, openDialog, closeDialog } from './sheet.js';
import { icon } from './icons.js';

const APP = 'OpenTranslate';
const FORMAT = 1;
// localStorage keys in a backup; downloads and their state (offline packs, models) stay out
const PARTS = {
  settings: 'ot.settings.v1',
  phrasebook: 'ot.phrasebook.v1',
  history: 'ot.history.v1',
  recentLangs: 'ot.recentLangs.v1',
  conversation: 'ot.conversation.v1',
};
const QR_CHARS = 500;          // characters per QR code: small enough to scan from a screen
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs';
const IMPORTED_FLAG = 'ot.backupImported';

const read = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
const today = () => new Date().toISOString().slice(0, 10);

/** The secret fields of a service (API keys…): its fields of type password. */
const secretKeys = (type) => (getProviderDef(type)?.fields || []).filter((f) => f.type === 'password').map((f) => f.key);

function withoutKeys(s) {
  if (!s?.entries) return s;
  return {
    ...s,
    entries: s.entries.map((e) => {
      const drop = secretKeys(e.type);
      if (!drop.length || !e.config) return e;
      const config = { ...e.config };
      for (const k of drop) delete config[k];
      return { ...e, config };
    }),
  };
}

/** The backup as an object. */
export function makeBackup({ keys = false } = {}) {
  const data = {};
  for (const [name, key] of Object.entries(PARTS)) {
    const v = read(key);
    if (v != null) data[name] = v;
  }
  if (data.settings && !keys) data.settings = withoutKeys(data.settings);
  return { app: APP, format: FORMAT, date: new Date().toISOString(), apiKeys: !!keys, ...data };
}

/** A parsed backup, or throws with a message for people. */
export function parseBackup(text) {
  let b;
  try { b = JSON.parse(String(text).trim()); } catch { throw new Error('This isn’t an OpenTranslate backup.'); }
  if (!b || b.app !== APP || typeof b !== 'object') throw new Error('This isn’t an OpenTranslate backup.');
  return b;   // a newer format still opens: parts we don't know are skipped
}

export function describe(b) {
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  const parts = [];
  if (b.settings) parts.push(b.apiKeys ? 'settings with API keys' : 'settings (without API keys)');
  parts.push(`${n(b.phrasebook)} saved ${n(b.phrasebook) === 1 ? 'translation' : 'translations'}`);
  parts.push(`${n(b.history)} history ${n(b.history) === 1 ? 'entry' : 'entries'}`);
  const d = b.date ? new Date(b.date) : null;
  return `${d && !isNaN(d) ? `Backup from ${d.toLocaleDateString()}` : 'Backup'}: ${parts.join(', ')}.`;
}

const same = (a, b) => a.text === b.text && a.source === b.source && a.target === b.target;
function mergeLists(mine = [], theirs = [], max = Infinity) {
  const out = [...mine];
  for (const x of theirs) if (x && !out.some((y) => same(x, y))) out.push(x);
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, max);
}

/**
 * Write a backup into this browser. mode: 'add' merges phrasebook and history (no duplicates),
 * 'replace' replaces them. Settings are always replaced; a backup without API keys keeps the keys of
 * the same services already set up here.
 */
export function applyBackup(b, { mode = 'add' } = {}) {
  const put = (key, v) => localStorage.setItem(key, JSON.stringify(v));
  if (b.settings && typeof b.settings === 'object') {
    let s = b.settings;
    if (!b.apiKeys && Array.isArray(s.entries)) {
      const here = read(PARTS.settings)?.entries || [];
      s = {
        ...s,
        entries: s.entries.map((e) => {
          const old = here.find((h) => h.id === e.id && h.type === e.type);
          if (!old) return e;
          const config = { ...e.config };
          for (const k of secretKeys(e.type)) if (old.config?.[k] && !config[k]) config[k] = old.config[k];
          return { ...e, config };
        }),
      };
    }
    put(PARTS.settings, s);
  }
  for (const [name, max] of [['phrasebook', Infinity], ['history', 100]]) {
    if (!Array.isArray(b[name])) continue;
    put(PARTS[name], mode === 'replace' ? b[name].slice(0, max) : mergeLists(read(PARTS[name]) || [], b[name], max));
  }
  if (b.recentLangs && typeof b.recentLangs === 'object') put(PARTS.recentLangs, b.recentLangs);
  if (b.conversation && typeof b.conversation === 'object') put(PARTS.conversation, b.conversation);
}

/* ---------------- QR codes ---------------- */

const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
async function squeeze(text) {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function unsqueeze(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(s).text();
}

/** The backup as QR code texts: "OT1|id|i|n|data" (i counts from 1). */
export async function qrParts(backup) {
  const data = b64url(await squeeze(JSON.stringify(backup)));
  const id = Math.random().toString(36).slice(2, 6);
  const n = Math.max(1, Math.ceil(data.length / QR_CHARS));
  return Array.from({ length: n }, (_, i) => `OT1|${id}|${i + 1}|${n}|${data.slice(i * QR_CHARS, (i + 1) * QR_CHARS)}`);
}

/** Collects scanned codes; add() returns { id, have, n, missing, done } or null for a foreign code. */
export function qrCollector() {
  let id = null, n = 0;
  const got = new Map();
  return {
    add(text) {
      const m = /^OT1\|([a-z0-9]+)\|(\d+)\|(\d+)\|([A-Za-z0-9_-]*)$/.exec(String(text).trim());
      if (!m) return null;
      if (id !== m[1]) { id = m[1]; n = +m[3]; got.clear(); }   // codes of another backup: start over
      got.set(+m[2], m[4]);
      const missing = [];
      for (let i = 1; i <= n; i++) if (!got.has(i)) missing.push(i);
      return { id, have: got.size, n, missing, done: !missing.length };
    },
    async backup() {
      const data = Array.from({ length: n }, (_, i) => got.get(i + 1)).join('');
      return parseBackup(await unsqueeze(unb64url(data)));
    },
  };
}

let qrLib = null;
async function drawQr(canvas, text) {
  qrLib ??= import(/* @vite-ignore */ QR_LIB).then((m) => m.default);
  const qrcode = await qrLib;
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const count = q.getModuleCount();
  const quiet = 4;
  const cell = Math.max(2, Math.floor(600 / (count + quiet * 2)));
  const size = (count + quiet * 2) * cell;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);   // always dark on white: scanners need the contrast
  g.fillStyle = '#000';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
}

/* ---------------- Settings UI ---------------- */

const $ = (id) => document.getElementById(id);
let importText = null;   // set by initBackup: opens Import with a backup's text

/** A backup opened with or shared to the app: Import opens with it, ready to confirm. */
export function openBackupImport(text) { importText?.(text); }

const canScan = () => 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
const canCompress = () => typeof CompressionStream === 'function';

export function initBackup() {
  try {
    if (sessionStorage.getItem(IMPORTED_FLAG)) {
      sessionStorage.removeItem(IMPORTED_FLAG);
      setTimeout(() => toast('Backup imported.'), 600);
    }
  } catch { /* no session storage */ }
  const dlg = setupDialog($('backup-dialog'), { onClose: stopScan });
  const keys = () => $('backup-keys').checked;
  $('backup-qr').hidden = !canCompress();

  $('backup-file').addEventListener('click', async () => {
    const json = JSON.stringify(makeBackup({ keys: keys() }), null, 1);
    const name = `opentranslate-backup-${today()}.json`;
    const file = new File([json], name, { type: 'application/json' });
    // phones: the share menu (save to Files, send to yourself); computers: a download
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Saved ${name}`);
  });

  $('backup-copy').addEventListener('click', () => {
    copyToClipboard(JSON.stringify(makeBackup({ keys: keys() })), 'Backup copied. Paste it into Import on the other device.');
  });

  // QR codes: one at a time, with Back / Next
  let codes = [], at = 0;
  const showCode = async () => {
    $('backup-qr-count').textContent = `${at + 1} of ${codes.length}`;
    $('backup-qr-prev').disabled = at === 0;
    $('backup-qr-next').disabled = at === codes.length - 1;
    try { await drawQr($('backup-qr-canvas'), codes[at]); $('backup-qr-canvas').setAttribute('aria-label', `QR code ${at + 1} of ${codes.length}`); }
    catch { toast('The QR code maker couldn’t be loaded. Check the connection, or use the file.'); closeDialog(dlg); }
  };
  $('backup-qr').addEventListener('click', async () => {
    codes = await qrParts(makeBackup({ keys: keys() }));
    at = 0;
    show('qr');
    $('backup-title').textContent = 'Scan on the other device';
    openDialog(dlg);
    await showCode();
  });
  $('backup-qr-prev').addEventListener('click', () => { if (at > 0) { at--; showCode(); } });
  $('backup-qr-next').addEventListener('click', () => { if (at < codes.length - 1) { at++; showCode(); } });

  // Import
  let pending = null;
  const ready = (b) => {
    pending = b;
    stopScan();
    $('backup-summary').textContent = describe(b);
    $('backup-confirm').hidden = false;
    $('backup-do-import').focus();
  };
  const tryText = (text) => { try { ready(parseBackup(text)); } catch (e) { toast(e.message); } };
  $('backup-import').addEventListener('click', () => {
    pending = null;
    show('import');
    $('backup-title').textContent = 'Import a backup';
    $('backup-paste').value = '';
    $('backup-confirm').hidden = true;
    $('backup-scan').hidden = !canScan() || !canCompress();
    openDialog(dlg);
  });
  importText = (text) => {
    $('backup-import').click();
    tryText(text);
  };
  $('backup-pick').addEventListener('click', () => $('backup-file-input').click());
  $('backup-file-input').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) tryText(await f.text());
  });
  $('backup-paste-go').addEventListener('click', () => tryText($('backup-paste').value));
  $('backup-scan').addEventListener('click', () => startScan(ready));
  $('backup-do-import').addEventListener('click', () => {
    if (!pending) return;
    const mode = document.querySelector('input[name="backup-mode"]:checked')?.value || 'add';
    try { applyBackup(pending, { mode }); } catch { toast('Couldn’t import: this browser’s storage is full or blocked.'); return; }
    try { sessionStorage.setItem(IMPORTED_FLAG, '1'); } catch { /* the toast is a nicety */ }
    location.reload();   // everything starts again with the imported settings
  });

  function show(what) {
    $('backup-qr-panel').hidden = what !== 'qr';
    $('backup-import-panel').hidden = what !== 'import';
  }
}

/* ---------------- scanning ---------------- */

let scan = null;   // { stream, timer }
async function startScan(onDone) {
  const status = $('backup-scan-status');
  const video = $('backup-video');
  stopScan();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    status.textContent = 'The camera isn’t available. Use the file or the text instead.';
    return;
  }
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const codes = qrCollector();
  scan = { stream, timer: 0 };
  video.srcObject = stream;
  video.hidden = false;
  $('backup-scan').innerHTML = `${icon('stop')}<span>Stop scanning</span>`;
  status.textContent = 'Point the camera at the first QR code.';
  await video.play().catch(() => {});
  let busy = false;
  scan.timer = setInterval(async () => {
    if (busy || !scan) return;
    busy = true;
    try {
      for (const c of await detector.detect(video)) {
        const r = codes.add(c.rawValue);
        if (!r) continue;
        if (r.done) { const b = await codes.backup(); onDone(b); return; }
        status.textContent = `Got ${r.have} of ${r.n}. Still missing: ${r.missing.join(', ')}. Show the next one.`;
      }
    } catch (e) {
      if (e?.message?.includes('backup')) { status.textContent = e.message; }
    } finally { busy = false; }
  }, 250);
}
function stopScan() {
  if (!scan) return;
  clearInterval(scan.timer);
  scan.stream.getTracks().forEach((t) => t.stop());
  scan = null;
  const video = $('backup-video');
  video.srcObject = null;
  video.hidden = true;
  $('backup-scan').innerHTML = `${icon('camera')}<span>Scan QR codes</span>`;
}
