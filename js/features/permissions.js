// Camera / microphone permissions: explain first, then trigger the browser prompt, and
// give browser-specific steps when access is blocked.
import { icon } from '../ui/icons.js';
import { setupDialog, openDialog, closeDialog } from '../ui/sheet.js';

const $ = (id) => document.getElementById(id);
const SEEN = 'ot.permExplained.v1';

/** 'granted' | 'denied' | 'prompt' | 'unknown' (browser can't tell, e.g. Firefox for some names) */
export async function permissionState(kind) {
  try {
    const st = await navigator.permissions.query({ name: kind });
    return st.state;
  } catch {
    return 'unknown';
  }
}

/** Calls fn(state) whenever the browser reports a change (e.g. the user flips it in site settings). */
export async function onPermissionChange(kind, fn) {
  try {
    const st = await navigator.permissions.query({ name: kind });
    st.addEventListener('change', () => fn(st.state));
  } catch { /* not supported */ }
}

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isFirefox = /Firefox\//.test(ua);
const isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
const isMac = /Macintosh/.test(ua) && !isIOS;

/** Step-by-step instructions to re-enable a blocked permission, for this browser. */
export function blockedSteps(kind) {
  const what = kind === 'camera' ? 'Camera' : 'Microphone';
  const steps = [];
  if (isIOS) steps.push(`Tap “aA” in the address bar → Website Settings → ${what} → Allow.`, `Also check iPhone Settings → Safari → ${what}.`);
  else if (isAndroid) steps.push(`Tap the icon left of the web address → Permissions → ${what} → Allow.`, `If it stays blocked: Android Settings → Apps → your browser → Permissions → ${what}.`);
  else if (isSafari) steps.push(`Safari menu → Settings for This Website… → ${what} → Allow.`);
  else if (isFirefox) steps.push(`Click the crossed-out ${what.toLowerCase()} icon in the address bar → clear the block (×).`);
  else steps.push(`Click the icon left of the web address → Site settings → ${what} → Allow.`);
  if (isMac) steps.push(`macOS: System Settings → Privacy & Security → ${what} → turn on your browser.`);
  steps.push('Then reload this page.');
  return steps;
}

let dlg = null;
let answer = null;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = setupDialog($('perm-dialog'), { onClose: () => { const a = answer; answer = null; a?.(dlg.returnValue === 'allow'); } });
  $('perm-allow').addEventListener('click', () => closeDialog(dlg, 'allow'));
  $('perm-cancel').addEventListener('click', () => closeDialog(dlg, 'cancel'));
  return dlg;
}

/** Show the explain / blocked sheet. Resolves true when the user taps Allow. */
export function sheet({ iconName, title, body, bodyHtml, steps = [], allowLabel = 'Allow', cancelLabel = 'Not now', allow = true }) {
  ensureDialog();
  $('perm-icon').innerHTML = icon(iconName);
  $('perm-title').textContent = title;
  if (bodyHtml) $('perm-body').innerHTML = bodyHtml; else $('perm-body').textContent = body;
  $('perm-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('perm-steps').hidden = !steps.length;
  $('perm-allow').hidden = !allow;
  $('perm-allow').textContent = allowLabel;
  $('perm-cancel').textContent = cancelLabel;
  dlg.returnValue = '';
  return new Promise((resolve) => { answer = resolve; openDialog(dlg); requestAnimationFrame(() => (allow ? $('perm-allow') : $('perm-cancel')).focus()); });
}

const COPY = {
  camera: {
    iconName: 'camera', title: 'Allow camera access',
    body: 'OpenTranslate uses your camera to read text in front of you. Photos stay on this device; only the recognized text is sent to your translation provider.',
  },
  microphone: {
    iconName: 'mic', title: 'Allow microphone access',
    body: 'OpenTranslate uses your microphone so you can speak instead of typing. Your browser’s speech service turns speech into text; OpenTranslate never records audio.',
  },
};

export function showBlocked(kind) {
  return sheet({ ...COPY[kind], title: `${kind === 'camera' ? 'Camera' : 'Microphone'} is blocked`,
    body: 'Your browser is blocking access for this site. To turn it back on:', steps: blockedSteps(kind), allow: false, cancelLabel: 'OK' });
}

/**
 * Make sure we may use the microphone: explain once, then trigger the browser prompt.
 * @returns {Promise<boolean>}
 */
export async function ensureMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) return true; // let the speech API prompt on its own
  const st = await permissionState('microphone');
  if (st === 'granted') return true;
  if (st === 'denied') { await showBlocked('microphone'); return false; }
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN) || '{}'); } catch { /* */ }
  if (!seen.microphone || st === 'prompt') {
    const ok = await sheet({ ...COPY.microphone, allowLabel: 'Allow microphone' });
    if (!ok) return false;
    try { localStorage.setItem(SEEN, JSON.stringify({ ...seen, microphone: true })); } catch { /* */ }
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') await showBlocked('microphone');
    else if (e.name === 'NotFoundError') await sheet({ ...COPY.microphone, title: 'No microphone found', body: 'Connect a microphone, then try again.', allow: false, cancelLabel: 'OK' });
    return false;
  }
}

/** Camera explainer copy for the in-page empty state (the camera tab shows it inline, not as a sheet). */
export const cameraCopy = COPY.camera;
