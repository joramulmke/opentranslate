// Lists every module the app needs to start (js/app.js and what it imports, not the parts loaded later
// with import()) as <link rel="modulepreload"> in index.html, between the two marker comments. The browser
// then fetches them all at once instead of one import level after the other: on a slow phone network the
// app starts about 0.7 s sooner. For the unbundled app (local copies): node .github/scripts/preload.mjs
// The deploy bundles instead (.github/scripts/bundle.mjs), which writes its own list.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const seen = new Set();
(function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gms)) {
    if (spec.startsWith('.')) walk(normalize(join(dirname(file), spec)));
  }
})('js/app.js');

const links = [...seen].filter((f) => f !== 'js/app.js').sort()
  .map((f) => `  <link rel="modulepreload" href="${f.replaceAll('\\', '/')}">`).join('\n');
const html = readFileSync('index.html', 'utf8');
const start = '<!-- modulepreload: start -->', end = '<!-- modulepreload: end -->';
const a = html.indexOf(start), b = html.indexOf(end);
if (a < 0 || b < a) throw new Error('index.html: modulepreload markers not found');
writeFileSync('index.html', `${html.slice(0, a + start.length)}\n${links}\n  ${html.slice(b)}`);
console.log(`modulepreload: ${seen.size - 1} modules`);
