// <dialog> helpers: open/close with exit animation, close on backdrop click and [data-close].

export function setupDialog(dlg, { onClose } = {}) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeDialog(dlg); return; }
    if (e.target === dlg) {
      // click on ::backdrop lands on the dialog element itself, outside its box
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeDialog(dlg);
    }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(dlg); });
  dlg.addEventListener('close', () => onClose?.());
  return dlg;
}

export function openDialog(dlg) {
  if (dlg.open) return;
  dlg.classList.remove('closing');
  dlg.showModal();
}

export function closeDialog(dlg, value = '') {
  if (!dlg.open || dlg.classList.contains('closing')) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { dlg.close(value); return; }
  dlg.classList.add('closing');
  const done = () => { dlg.classList.remove('closing'); dlg.close(value); };
  dlg.addEventListener('animationend', done, { once: true });
  setTimeout(() => dlg.open && done(), 260); // safety net
}
