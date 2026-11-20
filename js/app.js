// Entry point: wires the views, navigation, theme and service worker.
// Phones (< 720px): home screen + full-screen sub-views with back buttons (no tab bar).
// 720px+: tabs in a bottom bar (720-1023px) or a navigation rail (1024px+).
import { hydrateIcons, icon } from './ui/icons.js';
import { initProvider, state } from './state.js';
import { settings, onChange } from './store.js';
import * as textView from './ui/textview.js';
import { initHistorySheet, openHistory } from './ui/historysheet.js';
import { initSettingsSheet, openSettings } from './ui/settingssheet.js';
import { initModeMenu } from './ui/modemenu.js';
import { initMenu, openMenu } from './ui/menu.js';
import { isPhone, isRail, onLayoutChange } from './ui/layout.js';
import { initCamera } from './features/camera.js';
import { initConversation } from './features/conversation.js';
import { initHandwriting } from './features/handwriting.js';

const TABS = ['text', 'camera', 'conversation', 'handwriting'];
// which home-screen control opened each phone sub-view (focus returns there on Back)
const OPENER = { camera: 'home-camera', conversation: 'home-convo', handwriting: 'btn-to-hand' };
const hooks = {};
let currentTab = null;
let navIndex = 0;   // position in our own pushState entries, so Back never leaves the app

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = dark ? '#111318' : '#faf8ff';
    if (theme !== 'system') m.removeAttribute('media');
  });
  // 1200px+ top bar toggle shows the current mode (sun = light, moon = dark)
  const t = document.getElementById('btn-theme');
  if (t) {
    t.innerHTML = icon(dark ? 'darkMode' : 'lightMode');
    t.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    t.dataset.dark = dark ? '1' : '0';
  }
}

/** Light/dark toggle: writes the same theme setting as the Settings sheet. */
function toggleTheme() {
  const dark = document.getElementById('btn-theme').dataset.dark === '1';
  const theme = dark ? 'light' : 'dark';
  settings.set({ theme });
  applyTheme(theme);
}

function navigate(tab, { replace = false, focus = false } = {}) {
  if (!TABS.includes(tab)) tab = 'text';
  if (tab === currentTab) return;
  const prev = currentTab;
  if (prev) hooks[prev]?.onHide?.();
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
  hooks[tab]?.onShow?.();
  if (focus) document.getElementById(`tab-${tab}`).focus();
  else if (prev && isPhone()) focusAfterPhoneNav(tab, prev);
}

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
  initSettingsSheet({ onThemeChange: applyTheme });

  hooks.camera = initCamera({ sendToText });
  hooks.conversation = initConversation();
  hooks.handwriting = initHandwriting({ sendToText });

  // top bar
  $('btn-history').addEventListener('click', () => openHistory('history'));
  $('btn-saved').addEventListener('click', () => openHistory('saved'));
  $('btn-saved-wide').addEventListener('click', () => openHistory('saved'));
  $('btn-settings').addEventListener('click', () => openSettings());
  $('btn-more').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('btn-menu').addEventListener('click', (e) => openMenu(e.currentTarget));
  $('btn-theme').addEventListener('click', toggleTheme);
  $('web-history').addEventListener('click', () => openHistory('history'));
  $('web-saved').addEventListener('click', () => openHistory('saved'));
  $('btn-clear-top').addEventListener('click', () => textView.clearText());
  $('btn-back').addEventListener('click', () => {
    if (currentTab === 'text') textView.exitEdit();
    else goBack();
  });
  // pen: switch the input to handwriting, carrying the text over
  const toHandwriting = () => { hooks.handwriting.setText(textView.getInput()); navigate('handwriting'); };
  $('btn-pen').addEventListener('click', toHandwriting);
  $('btn-to-hand').addEventListener('click', toHandwriting);
  // keyboard: back to typing, carrying the handwritten text over
  $('btn-keyboard').addEventListener('click', () => {
    const t = hooks.handwriting.getText();
    navigate('text');
    textView.setInput(t, { translateNow: !!t.trim() });
    textView.focusInput();
  });
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', goBack));

  // phone home actions
  $('home-convo').addEventListener('click', () => navigate('conversation'));
  $('home-camera').addEventListener('click', () => navigate('camera'));

  initModeMenu({ openSettings });
  initMenu('more-menu', {
    history: () => openHistory('history'),
    saved: () => openHistory('saved'),
    settings: () => openSettings(),
  });

  onChange((what) => { if (what === 'phrasebook') textView.refreshStar(); });
  onLayoutChange(() => textView.onLayoutChange());

  setupNav();
  navIndex = history.state?.i ?? 0;
  navigate(location.hash.slice(1) || 'text', { replace: true });

  if (!state.provider) console.info('[OpenTranslate] no usable provider:', state.providerError?.message);

  window.__otBooted = true;
  document.getElementById('boot-msg').hidden = true;

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
