// Red "!" on the settings and menu buttons while only the offline demo is set up,
// so users find out early that they need a real provider.
import { state, subscribe } from '../state.js';

const BUTTONS = ['btn-settings', 'btn-menu', 'btn-more'];

export const onlyDemo = () => (!state.classic || !!state.classic.isMock) && !state.advanced;

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
      b.setAttribute('aria-label', need ? `${labels[id]} (setup needed: only the offline demo is active)` : labels[id]);
    }
    const hint = document.getElementById('setup-hint');
    if (hint) hint.hidden = !need;
  };
  subscribe(render);
  render();
}
