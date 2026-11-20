// Legal footer links (Impressum · Datenschutzerklärung), configured in change-me.md.
export async function initSiteFooter() {
  const footer = document.getElementById('site-footer');
  let cfg = {};
  try {
    const res = await fetch('change-me.md', { cache: 'no-cache' });
    if (res.ok) {
      for (const line of (await res.text()).split('\n')) {
        const m = line.match(/^\s*([a-z_]+)\s*=\s*(\S+)\s*$/i);
        if (m) cfg[m[1].toLowerCase()] = m[2];
      }
    }
  } catch { /* offline and not cached: keep the footer hidden */ }
  const url = (v) => (v && !/^[a-z]+:\/\//i.test(v) ? `https://${v}` : v);
  const privacy = url(cfg.privacy_policy_link);
  const imprint = url(cfg.imprint_link) || privacy;
  if (!privacy) return;
  document.getElementById('privacy-link').href = privacy;
  document.getElementById('imprint-link').href = imprint;
  footer.hidden = false;
}
