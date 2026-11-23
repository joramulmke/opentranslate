// Entry point: wires the views, navigation, theme and service worker.
// Phones (< 720px): home screen + full-screen sub-views with back buttons (no tab bar).
// 720px+: tabs in a bottom bar (720-1023px) or a navigation rail (1024px+).
import { hydrateIcons, icon } from './ui/icons.js';
import { initProvider, state } from './state.js';
import { settings, onChange } from './store.js';
import * as textView from './ui/textview.js';
import { initHistorySheet, openHistory } from './ui/historysheet.js';
import { initModeMenu } from './ui/modemenu.js';
import { initSetupBadge } from './ui/setupbadge.js';
import { initSiteFooter } from './ui/sitefooter.js';
import { initVersion } from './ui/version.js';
import { loadSiteConfig } from './siteconfig.js';
import { initMenu, openMenu } from './ui/menu.js';
import { initInstall } from './ui/install.js';
import { initPersist } from './features/persist.js';
import { pipSupported, openPip } from './features/pip.js';
import { isPhone, isRail, onLayoutChange } from './ui/layout.js';
import { takeShare, takeLinkText, onOpenedFiles } from './share.js';
import { leaveScreen } from './ui/snackbar.js';

const TABS = ['text', 'camera', 'conversation', 'handwriting'];
// which home-screen control opened each phone sub-view (focus returns there on Back)
const OPENER = { camera: 'home-camera', conversation: 'home-convo', handwriting: 'btn-to-hand' };
const hooks = {};

// Loaded after the text view is up (in idle time), or at once when opened first: the app starts with
// about half the code. Each part loads and starts once; the service worker keeps all of them offline.
const parts = {};
const loaders = {};
function part(name) {
  parts[name] ??= loaders[name]();
  parts[name].catch(() => { delete parts[name]; });   // e.g. offline on a first visit: try again next time
  return parts[name];
}
const openSettings = (...a) => part('settings').then((m) => m.openSettings(...a));
const openDocs = (...a) => part('docs').then((m) => m.openDocs(...a));
const openFeedback = (...a) => part('feedback').then((m) => m.openFeedback(...a));
let currentTab = null;
let navIndex = 0;   // position in our own pushState entries, so Back never leaves the app

let isDark = false;   // the theme on screen right now (set by applyTheme)

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = dark ? '#111318' : '#faf8ff';
    if (theme !== 'system') m.removeAttribute('media');
  });
  isDark = dark;
  // 1200px+ top bar toggle shows the current mode (sun = light, moon = dark)
  const t = document.getElementById('btn-theme');
  if (t) {
    t.innerHTML = icon(dark ? 'darkMode' : 'lightMode');
    t.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  // the menu item offers the other mode
  const m = document.querySelector('[data-theme-toggle]');
  if (m) m.innerHTML = icon(dark ? 'lightMode' : 'darkMode') + `<span>${dark ? 'Light theme' : 'Dark theme'}</span>`;
}

/** Light/dark toggle (top bar and menu): writes the same theme setting as the Settings sheet. */
function toggleTheme() {
  const theme = isDark ? 'light' : 'dark';
  settings.set({ theme });
  applyTheme(theme);
}

function navigate(tab, { replace = false, focus = false } = {}) {
  if (!TABS.includes(tab)) tab = 'text';
  if (tab === currentTab) return;
  const prev = currentTab;
  if (prev) { hooks[prev]?.onHide?.(); leaveScreen(); }
  currentTab = tab;
  document.getElementById('app').dataset.tab = tab;
  for (const t of TABS) {
    const btn = document.getElementById(`tab-${t}`);
    const view = document.getElementById(`view-${t}`);
    const on = t === tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    view.hidden = !on;
    if (on && prev) {
      view.classList.remove('entering'); void view.offsetWidth; view.classList.add('entering');
    }
  }
  const hash = `#${tab}`;
  if (location.hash !== hash) {
    if (replace || !prev) history.replaceState({ ot: tab, i: navIndex }, '', hash);
    else { navIndex += 1; history.pushState({ ot: tab, i: navIndex }, '', hash); }
  }
  const show = () => {
    hooks[tab]?.onShow?.({ viaArrowKeys: focus });   // focus === keyboard tab navigation
    if (!focus && prev && isPhone()) focusAfterPhoneNav(tab, prev);
  };
  if (hooks[tab] || !loaders[tab]) show();
  else part(tab).then(() => { if (currentTab === tab) show(); }, (e) => console.warn('[OpenTranslate]', tab, e));
  updateWakeLock();
  if (focus) document.getElementById(`tab-${tab}`).focus();
}

// Conversation and Camera keep the screen on while they're open (Wake Lock). The browser drops the lock
// when the app goes to the background, so it is asked for again on return.
const AWAKE = ['camera', 'conversation'];
let wakeLock = null;
let wakeLockAsking = false;
async function updateWakeLock() {
  const want = AWAKE.includes(currentTab) && document.visibilityState === 'visible';
  if (!want) {
    const l = wakeLock; wakeLock = null;
    l?.release().catch(() => {});
    return;
  }
  if ((wakeLock && !wakeLock.released) || wakeLockAsking || !navigator.wakeLock) return;
  wakeLockAsking = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (AWAKE.includes(currentTab) && document.visibilityState === 'visible') wakeLock = l;
    else l.release().catch(() => {});
  } catch { /* not allowed (battery saver, no permission): the screen just dims as usual */ }
  wakeLockAsking = false;
}
document.addEventListener('visibilitychange', updateWakeLock);

function focusAfterPhoneNav(tab, prev) {
  // only move focus if it was on a control that just disappeared
  const a = document.activeElement;
  if (a && a !== document.body && a.offsetParent !== null) return;
  if (tab === 'text') document.getElementById(OPENER[prev])?.focus();
  else {
    const back = tab === 'handwriting' ? document.getElementById('btn-back') : document.querySelector(`#view-${tab} [data-back]`);
    back?.focus();
  }
}

/** Phone Back: step back through our own history entries, or go home. */
function goBack() {
  if ((history.state?.i ?? 0) > 0) history.back();
  else navigate('text', { replace: true });
}

function setupNav() {
  const list = document.querySelector('.nav-list');
  const railMq = matchMedia('(min-width: 1024px) and (max-width: 1199.98px)');
  const orient = () => list.setAttribute('aria-orientation', railMq.matches ? 'vertical' : 'horizontal');
  railMq.addEventListener('change', orient);
  orient();
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b) navigate(b.dataset.tab);
  });
  list.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(currentTab);
    const vertical = isRail();
    const next = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: vertical ? 1 : 0, ArrowUp: vertical ? -1 : 0 }[e.key];
    if (e.key === 'Home') { e.preventDefault(); navigate(TABS[0], { focus: true }); return; }
    if (e.key === 'End') { e.preventDefault(); navigate(TABS[TABS.length - 1], { focus: true }); return; }
    if (!next) return;
    e.preventDefault();
    navigate(TABS[(i + next + TABS.length) % TABS.length], { focus: true });
  });
  window.addEventListener('popstate', () => {
    navIndex = history.state?.i ?? 0;
    navigate(location.hash.slice(1) || 'text', { replace: true });
  });
}

function boot() {
  hydrateIcons();
  applyTheme(settings.get().theme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(settings.get().theme));

  initProvider();

  const $ = (id) => document.getElementById(id);
  textView.initTextView({ navigate: (t) => navigate(t), openSettings: () => openSettings() });
  hooks.text = { onShow: textView.onShow, onHide: textView.onHide };

  const sendToText = (text, opts = {}) => { navigate('text'); textView.setInput(text, { translateNow: true, ...opts }); };

  initHistorySheet({ onSelect: (item) => sendToText(item.text, { source: item.source, target: item.target }) });

  loaders.camera = () => import('./features/camera.js').then((m) => (hooks.camera = m.initCamera({ sendToText })));
  loaders.conversation = () => import('./features/conversation.js').then((m) => (hooks.conversation = m.initConversation({ leave: () => goBack() })));
  loaders.handwriting = () => import('./features/handwriting.js').then((m) => (hooks.handwriting = m.initHandwriting({ sendToText })));
  loaders.settings = () => Promise.all([import('./ui/settingssheet.js'), import('./ui/backup.js')]).then(([m, backup]) => {
    m.initSettingsSheet({ onThemeChange: applyTheme });
    backup.initBackup();   // its buttons are in Settings
    return m;
  });
  loaders.docs = () => import('./ui/docsheet.js').then((m) => { m.initDocs(); return m; });
  loaders.feedback = () => import('./ui/feedback.js').then((m) => { m.initFeedback({ currentTab: () => currentTab }); return m; });
  loaders.files = () => import('./features/openfiles.js');

  // top bar
  $('btn-history').addEventListener('click', () => openHistory('history'));
  $('btn-saved').addEventListener('click', () => openHistory('saved'));
  $('btn-saved-wide').addEventListener('click', () => openHistory('saved'));
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-more').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('btn-menu').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('btn-phone-menu').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('btn-theme').addEventListener('click', toggleTheme);
  $('web-history').addEventListener('click', () => openHistory('history'));
  $('web-saved').addEventListener('click', () => openHistory('saved'));
  $('btn-clear-top').addEventListener('click', () => textView.clearText());
  $('btn-back').addEventListener('click', () => {
    if (currentTab === 'text') textView.exitEdit();
    else goBack();
  });
  // pen: switch the input to handwriting, carrying the text over
  const toHandwriting = async () => { const t = textView.getInput(); (await part('handwriting')).setText(t); navigate('handwriting'); };
  $('btn-pen').addEventListener('click', toHandwriting);
  $('btn-to-hand').addEventListener('click', toHandwriting);
  // keyboard: back to typing, carrying the handwritten text over
  $('btn-keyboard').addEventListener('click', () => {
    const t = hooks.handwriting?.getText() || '';
    navigate('text');
    textView.setInput(t, { translateNow: !!t.trim() });
    textView.focusInput();
  });
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  // phone home actions
  $('home-convo').addEventListener('click', () => navigate('conversation'));
  $('home-camera').addEventListener('click', () => navigate('camera'));

  initModeMenu({ openSettings });
  initSetupBadge();
  initSiteFooter();
  initVersion();
  // change-me.txt changed since the last start (e.g. demo_mode): rebuild the service list
  loadSiteConfig().then((changed) => { if (changed) { settings.set({}); initProvider(); } });
  initMenu('more-menu', {
    history: () => openHistory('history'),
    saved: () => openHistory('saved'),
    theme: toggleTheme,
    install: initInstall($('menu-install')),
    settings: () => openSettings(),
    feedback: openFeedback,
    docs: () => openDocs(),
    pip: () => openPip().catch((e) => console.warn('[OpenTranslate] floating window:', e)),
  });
  $('menu-pip').hidden = !pipSupported();
  initPersist();

  onChange((what) => { if (what === 'phrasebook') textView.refreshStar(); });
  onLayoutChange(() => textView.onLayoutChange());

  setupNav();
  navIndex = history.state?.i ?? 0;
  navigate(location.hash.slice(1) || 'text', { replace: true });

  if (!state.provider) console.info('[OpenTranslate] no usable provider:', state.providerError?.message);

  // a web+translate: link (manifest protocol_handlers): the text is translated
  const linkText = takeLinkText();
  if (linkText) {
    navigate('text', { replace: true });
    textView.setInput(linkText, { translateNow: true });
  }

  // home-screen shortcut "Translate a file" (manifest shortcuts): ./?open=docs
  const params = new URLSearchParams(location.search);
  if (params.get('open') === 'docs') {
    params.delete('open');
    const rest = params.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    openDocs();
  }

  // files opened with the installed app on a computer (manifest file_handlers) or shared from another app
  // (manifest share_target, see sw.js): photos go to camera text, short PDFs and .txt files into the text
  // box, documents and long PDFs to "Translate a file"
  const fileTargets = {
    toDocs: (file) => openDocs({ file }),
    toText: (text) => { navigate('text', { replace: true }); textView.setInput(text, { translateNow: true }); },
    toCamera: async (images) => {
      if (!(await (await part('camera')).openImages?.(images))) return false;
      navigate('camera', { replace: true });
      return true;
    },
  };
  const openFiles = (...a) => part('files').then((m) => m.openFiles(...a));
  onOpenedFiles((files) => openFiles(files, fileTargets));
  takeShare().then(async (shared) => {
    if (!shared) return;
    if (shared.kind === 'files') { await openFiles(shared.files, { ...fileTargets, text: shared.text }); return; }
    fileTargets.toText(shared.text);
  });

  window.__otBooted = true;
  document.getElementById('boot-msg').hidden = true;

  // the rest, one part at a time once the page is idle (a backup was just imported: Settings says so)
  let backupJustImported = false;
  try { backupJustImported = !!sessionStorage.getItem('ot.backupImported'); } catch { /* no storage */ }
  if (backupJustImported) part('settings');
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 1200));
  const rest = Object.keys(loaders);
  const next = () => { const n = rest.shift(); if (n) part(n).catch(() => {}).finally(() => idle(next)); };
  idle(next);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

// sw.js downloads a new version in the background and keeps it waiting. If one is waiting when the app
// starts, it takes over first (one quick reload), so this start already runs the new version, whole.
function start() {
  const sw = navigator.serviceWorker;
  let once = false;
  try { once = sessionStorage.getItem('ot-updating') === '1'; sessionStorage.removeItem('ot-updating'); } catch { /* no storage */ }
  if (!sw?.controller || once) { boot(); return; }
  let booted = false;
  const go = () => { if (!booted) { booted = true; boot(); } };
  const timer = setTimeout(go, 3000);   // never keep the app from starting
  sw.getRegistration().then((reg) => {
    if (!reg?.waiting) { clearTimeout(timer); go(); return; }
    try { sessionStorage.setItem('ot-updating', '1'); } catch { /* reloads at most once anyway: see timer */ }
    sw.addEventListener('controllerchange', () => { if (!booted) location.reload(); });
    reg.waiting.postMessage('skipWaiting');
  }).catch(() => { clearTimeout(timer); go(); });
}

start();
