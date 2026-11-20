// Small overflow menu (<dialog class="menu">) with arrow-key navigation.
let dlg = null;
let trigger = null;
let handlers = {};

export function initMenu(id, actions) {
  dlg = document.getElementById(id);
  handlers = actions;
  const items = () => [...dlg.querySelectorAll('[role="menuitem"]')];
  dlg.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitem"]');
    if (item) { closeMenu(); handlers[item.dataset.menu]?.(); return; }
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeMenu();
    }
  });
  dlg.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); list[(i + step + list.length) % list.length].focus(); }
    if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  });
  dlg.addEventListener('close', () => {
    trigger?.setAttribute('aria-expanded', 'false');
    // a menu action may have opened another dialog; don't steal its focus
    if (!document.querySelector('dialog[open]')) trigger?.focus();
    trigger = null;
  });
}

export function openMenu(btn) {
  if (!dlg || dlg.open) return;
  trigger = btn;
  btn.setAttribute('aria-expanded', 'true');
  dlg.showModal();
  dlg.querySelector('[role="menuitem"]')?.focus();
}

export function closeMenu() { if (dlg?.open) dlg.close(); }
