// Deploy only: packs js/app.js and everything it imports into one file, because the web host speaks
// HTTP/1.1 (at most 6 downloads at a time), where 38 small modules cost several round trips at start.
// The repo stays unbundled; this runs on the deploy's copy and overwrites js/app.js there.
//  - parts opened later (Camera, Settings, documents, …) stay separate files in js/chunks/, loaded when
//    needed; they use the start code from app.js itself, so state and settings exist only once
//  - Rollup does the packing (it keeps everything the start needs in app.js), esbuild then minifies
//  - sw.js gets the new file list (offline), index.html preloads what app.js imports (normally nothing)
//  - js/features/llm-worker.js is a worker, started by its own URL: left as it is
// Writes the files to upload, one per line, to the path given as the first argument.
// By hand, on a throwaway copy (it overwrites js/app.js): node .github/scripts/bundle.mjs /tmp/files.txt
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROLLUP = 'rollup@4.24.0', ESBUILD = 'esbuild@0.25.0';
const tmp = mkdtempSync(join(tmpdir(), 'ot-bundle-'));
const out = join(tmp, 'js');
writeFileSync(join(tmp, 'rollup.config.mjs'), `export default {
  input: ${JSON.stringify(join(process.cwd(), 'js/app.js'))},
  external: (id) => /^https?:/.test(id),          // CDN libraries stay where they are
  output: { dir: ${JSON.stringify(out)}, format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
  onwarn(w, warn) { if (w.code !== 'CIRCULAR_DEPENDENCY') warn(w); },
};\n`);
execFileSync('npx', ['--yes', ROLLUP, '-c', join(tmp, 'rollup.config.mjs'), '--silent'], { stdio: 'inherit' });

const files = ['app.js', ...readdirSync(join(out, 'chunks')).map((f) => `chunks/${f}`)];
execFileSync('npx', ['--yes', ESBUILD, ...files.map((f) => join(out, f)), '--minify', '--format=esm',
  '--legal-comments=none', '--log-level=warning', `--outdir=${out}`, `--outbase=${out}`, '--allow-overwrite'], { stdio: 'inherit' });

// what app.js imports before it runs (not the import() parts): preloaded together with it
const staticImports = (f) => [...readFileSync(join(out, f), 'utf8').matchAll(/\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](\.[^"']+)["']/g)]
  .map((m) => join('js', f, '..', m[1]).replaceAll('\\', '/'));
const startup = staticImports('app.js');

// the old chunks of an earlier run go, then the new files go over the deploy's js/
rmSync('js/chunks', { recursive: true, force: true });
cpSync(out, 'js', { recursive: true });
rmSync(tmp, { recursive: true, force: true });
const paths = files.map((f) => `js/${f}`).sort();

const html = readFileSync('index.html', 'utf8');
const start = '<!-- modulepreload: start -->', end = '<!-- modulepreload: end -->';
const a = html.indexOf(start), b = html.indexOf(end);
if (a < 0 || b < a) throw new Error('index.html: modulepreload markers not found');
const links = startup.map((f) => `\n  <link rel="modulepreload" href="${f}">`).join('');
writeFileSync('index.html', `${html.slice(0, a + start.length)}${links}\n  ${html.slice(b)}`);

// sw.js: the app's own scripts in its offline list become the bundle's files (plus the worker)
const sw = readFileSync('sw.js', 'utf8');
const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shell) throw new Error('sw.js: SHELL list not found');
const kept = [...shell[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((u) => !u.startsWith('./js/'));
const list = [...kept, ...paths.map((f) => `./${f}`), './js/features/llm-worker.js'];
writeFileSync('sw.js', sw.replace(shell[0], `const SHELL = [\n${list.map((u) => `  '${u}',`).join('\n')}\n];`));

if (process.argv[2]) writeFileSync(process.argv[2], `${paths.join('\n')}\n`);
const kb = (f) => (statSync(f).size / 1024).toFixed(1);
console.log(`bundle: ${paths.length} files, ${startup.length + 1} at start`);
for (const f of paths) console.log(`  ${f}  ${kb(f)} KB${f === 'js/app.js' || startup.includes(f) ? '  (start)' : ''}`);
