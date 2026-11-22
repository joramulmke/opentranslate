// Screenshots for the install dialog (manifest "screenshots"): the app is served from this folder with the
// offline demo switched on, a demo phrase is translated, and each view is saved to icons/screenshots/.
// Run by .github/workflows/deploy.yml (button or "[screenshots]" in the commit message), or locally:
//   npm i --no-save playwright-core && node .github/scripts/screenshots.mjs
// Uses an installed Chrome (CHROME=/path/to/chrome to pick another one).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'icons/screenshots');
const PHRASE = 'Where is the bathroom?';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.wasm': 'application/wasm', '.md': 'text/markdown' };

// a tiny static server; change-me.md gets the demo switched on (only here, the file isn't changed)
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) throw new Error('outside');
    let body = await fs.readFile(file);
    if (p === '/change-me.md') body = String(body).replace(/^demo_mode\s*=.*$/m, 'demo_mode = true');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chrome' });
await fs.mkdir(OUT, { recursive: true });

async function shot(name, { width, height, scale }, view, prepare) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'light',
    serviceWorkers: 'block', reducedMotion: 'reduce', locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}#${view}`);
  await page.waitForFunction(() => window.__otBooted === true);
  if (prepare) await prepare(page);
  // demo-only hints ("Offline demo translation", the red "!" for "set up a service") stay out of the picture
  await page.addStyleTag({ content: '.needs-setup::after, #mock-chip { display: none !important; }' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('saved', `icons/screenshots/${name}.png`);
  await ctx.close();
}

async function translate(page) {
  await page.locator('#src-text').fill(PHRASE);
  await page.locator('#out-text').waitFor({ state: 'visible' });
  await page.locator('#src-text').blur();
}

const PHONE = { width: 412, height: 915, scale: 2 };
const DESKTOP = { width: 1280, height: 800, scale: 1 };
try {
  await shot('phone-text', PHONE, 'text', translate);
  await shot('phone-conversation', PHONE, 'conversation');
  await shot('phone-handwriting', PHONE, 'handwriting');
  await shot('desktop-text', DESKTOP, 'text', translate);
} finally {
  await browser.close();
  server.close();
}
