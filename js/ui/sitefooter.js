// Footer links: Impressum · Datenschutzerklärung (configured in change-me.txt, shown when set) · GitHub.
import { loadSiteConfig, siteValue } from '../siteconfig.js';

export async function initSiteFooter() {
  await loadSiteConfig();
  const url = (v) => (v && !/^[a-z]+:\/\//i.test(v) ? `https://${v}` : v);
  const privacy = url(siteValue('privacy_policy_link'));
  const imprint = url(siteValue('imprint_link')) || privacy;
  if (!privacy) return;
  document.getElementById('privacy-link').href = privacy;
  document.getElementById('imprint-link').href = imprint;
  document.getElementById('legal-links').hidden = false;
}
