// Red "!" on the settings and menu buttons while only the offline demo is set up,
// so users find out early that they need a real provider.
import { subscribe } from '../state.js';
import { settings } from '../store.js';
import { installedLanguages, onOfflineChange } from '../features/offline.js';
import { demoEnabled } from '../siteconfig.js';

const BUTTONS = ['btn-settings', 'btn-menu', 'btn-more'];

/** true while no real translation service has been added (only the demo, or nothing when it's off). */
export const onlyDemo = () => !settings.get().entries.some((e) => !['mock', 'offline', 'elevenlabs'].includes(e.type)) && !installedLanguages().length;

export function initSetupBadge() {
  const labels = {};
  const render = () => {
    const need = !!onlyDemo();
    document.documentElement.toggleAttribute('data-setup-needed', need);
    for (const id of BUTTONS) {
      const b = document.getElementById(id);
      if (!b) continue;
      labels[id] ??= b.getAttribute('aria-label');
      b.classList.toggle('needs-setup', need);
      b.setAttribute('aria-label', need ? `${labels[id]} (setup needed: ${demoEnabled() ? 'only the offline demo is active' : 'no translation service yet'})` : labels[id]);
    }
    const hint = document.getElementById('setup-hint');
    if (hint) {
      hint.hidden = !need;
      hint.querySelector('[data-hint=demo]').hidden = !demoEnabled();
      hint.querySelector('[data-hint=none]').hidden = demoEnabled();
    }
  };
  subscribe(render);
  onOfflineChange(render);
  render();
}
