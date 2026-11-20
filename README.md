# OpenTranslate

A translation app as a static, installable web app (PWA): text, camera (OCR), conversation and
handwriting. Vanilla HTML/CSS/JavaScript (ES modules), no build step, no framework. Neutral branding,
ready to wrap as an Android app (TWA or Capacitor).

Live: <https://domain.tld/opentranslate/>

## Run locally

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/>. Any static server works. Opening `index.html` from `file://` does not:
browsers block ES modules there (the page shows a hint). Camera and microphone need `https://` or `localhost`.

## Translation services

Open **Settings** (gear icon) → **Translation services**. Services are a list in two groups; add as many as
you like with **+ Add LibreTranslate** / **+ Add AI model** (name, URL, key, model, **Test connection**), edit,
reorder (↑ ↓) or remove them (with Undo).

| Group | Service | Notes |
| --- | --- | --- |
| Classic | **On this device** | Built in. Translates in the browser with downloaded language packs (see below). No server, no key, works offline; nothing you type leaves the device. |
| Classic | **LibreTranslate** | Any server with the standard `/languages`, `/detect`, `/translate` API. Server URL and (optional) API key. |
| Classic | **Offline demo** | Built in, for trying the app: a few phrases, other text gets a clearly marked placeholder. Can simulate network / unsupported-pair errors. |
| Advanced | **AI model** (OpenAI-compatible) | Any `/chat/completions` endpoint: OpenAI, OpenRouter, Groq, Mistral, DeepSeek, Ollama, LM Studio or custom. Base URL, API key and model; **Test connection** lists available models. |

**Which one is used:** the checked service in each group goes first. If it fails (offline, server down) or
doesn't have the language, the next one **of the same group** is tried, in list order; the result then says
*Translated with …*. The offline demo never stands in for a real service.

The dropdown next to the character count lists all services (Classic and Advanced) for quick switching.
Settings saved by older versions (one LibreTranslate + one AI setup) are moved into the list automatically.

### Offline languages (On this device)

Download a language once, then translate without internet:

- in the **language picker** (Classic mode), tap the download icon next to a language; tap again to cancel, or
  to remove a downloaded one;
- or in **Settings → On this device → Manage** (all languages, sizes, storage used, remove);
- or when a translation needs a missing language, the result card offers **Download**.

Each pack is English ↔ that language (about 45–75 MB, Chinese ~120 MB); English is built in. Other pairs go
through English (German → English → French), so they need both packs. ~58 languages are available.
The engine is [Bergamot](https://github.com/browsermt/bergamot-translator) (the engine of Firefox's built-in
translation, WebAssembly in a Web Worker, vendored in `vendor/bergamot/`, MPL-2.0); the models are Mozilla's
open translation models, downloaded from Mozilla's model CDN, checked against their SHA-256 hashes and stored in
the browser's Cache Storage. Language detection uses [franc](https://github.com/wooorm/franc) (MIT), limited to
the downloaded languages. Not available on device: Irish, Swahili, Esperanto (greyed out).

**Privacy:** in Advanced mode your text (and, for handwriting, the drawing) is sent to the AI service you
configure. **API keys are stored only in your browser (`localStorage`) and sent only to the URL you enter.** They are
never part of this repository. Use keys with spending limits; anyone with access to that browser profile can read them.

### LibreTranslate server

```bash
docker run -p 5000:5000 libretranslate/libretranslate          # official image
# or without Docker (Python 3.10–3.12):
python3 -m venv .venv && .venv/bin/pip install libretranslate
.venv/bin/libretranslate --load-only en,es,fr,de
```

Then add it in Settings → **+ Add LibreTranslate** with the server URL (e.g. `http://localhost:5000`).

**Your own server:** the app is served over HTTPS, so the LibreTranslate server must be reachable over
HTTPS too (e.g. behind a reverse proxy). LibreTranslate allows cross-origin browser requests by default; keep
the `Access-Control-Allow-Origin` header if you add a proxy.

**API keys** are only needed if the server runs with `--api-keys`. Create one on the server:

```bash
ltmanage keys add 120                     # 120 requests/minute; prints the key
docker exec -it <container> ./venv/bin/ltmanage keys add 120   # inside the Docker image
```

Enter it in the service's **API key** field (Settings → edit the service), then **Test connection**.

### Local AI models (Ollama / LM Studio)

The browser calls them directly, so they must allow the page's origin (CORS), e.g.
`OLLAMA_ORIGINS=* ollama serve`, then use base URL `http://localhost:11434/v1` and a model such as `llama3.1`.

## Features

- **Text:** auto-detect, live translation while typing, swap, copy, read aloud (`speechSynthesis`),
  history (last 100) and saved phrasebook, all stored in `localStorage`.
- **Voice input** works in every browser that can record audio:
  1. the browser's speech service with live text (Chrome, Edge, Safari);
  2. where there is none (Brave, Firefox) or it fails, the app records the microphone itself (stops after
     ~1.5 s of silence) and transcribes with your **Advanced API's Whisper endpoint** (`/audio/transcriptions`,
     set *Speech-to-text model*, e.g. `whisper-1`, `whisper-large-v3-turbo`) in Advanced mode, otherwise with
     **on-device Whisper** (`whisper-base`, asks before a one-time ~80 MB download, detects the language).
- **Languages** your services can't translate stay visible but greyed out; tapping one explains why
  (e.g. not installed on your LibreTranslate server). Languages that can be downloaded show a download icon.
- **Camera:** live preview or imported photo; OCR with [Tesseract.js](https://tesseract.projectnaptha.com/)
  (loaded from a CDN on first use); translated text drawn over the photo.
- **Conversation:** two people, one language each, turns alternate; translations can be read aloud.
- **Handwriting:** draw on a pad (undo, clear, stroke width), pick a suggestion, edit, then translate.
  Three engines, best available first (Settings → Handwriting recognition):
  1. **AI vision**: in Advanced mode, your model reads the drawing (any script, cursive). Needs a vision-capable
     model; one API call per recognition.
  2. **On-device model**: TrOCR handwriting model in the browser via
     [transformers.js](https://github.com/huggingface/transformers.js); asks before a one-time ~130 MB download,
     Latin-script languages only, private.
  3. **Basic**: Tesseract; fallback for everything else, best with neat printed letters.
- **Permissions:** camera and microphone are explained first; the browser prompt only appears after you tap
  *Allow*. If access is blocked, the app shows browser-specific steps to re-enable it.
- Light/dark theme (follows the system, or set it in Settings / the top bar), keyboard operation, ARIA labels,
  `lang`/`dir` on output text, offline app shell via service worker (translations are never cached).

## Site settings (`change-me.md`)

Deployment-specific values live in [`change-me.md`](change-me.md) (`key = value`), read by the app at runtime:

| Key | Used for |
| --- | --- |
| `privacy_policy_link` | "Datenschutzerklärung" link in the footer (and "Impressum" unless `imprint_link` is set) |
| `imprint_link` | optional separate "Impressum" link |

The footer sits below the full-height app, so it appears when you scroll down.

While only the offline demo is set up, the settings and menu buttons show a red **!** and Settings explains
how to add a real provider.

## Layouts

- **< 720 px:** phone layout (big text sheet, language buttons, Conversation · mic · Camera).
- **720–1199 px:** tabs in a bottom bar (720–1023) or navigation rail (1024–1199), side-by-side panes.
- **≥ 1200 px:** desktop layout with mode chips, language tabs, two panes, History/Saved below.

## Project structure

```
index.html  styles.css  manifest.webmanifest  sw.js  icons/
js/app.js              boot, routing (#text, #camera, #conversation, #handwriting), theme, service worker
js/state.js            shared state, service chains (first choice + fallbacks per group), error messages
js/store.js            localStorage: settings + service list (with migration), history, phrasebook
js/providers.js        provider interface + registry: Mock, LibreTranslate, OpenAI-compatible
js/features/offline.js on-device translation: model list, downloads, Bergamot worker, detection
vendor/bergamot/       Bergamot WebAssembly engine + worker (MPL-2.0, see LICENSE there)
js/languages.js        bundled 50-language fallback, RTL and OCR language maps
js/ui/*.js             text view, language bar/picker, mode menu, sheets, menus, icons, layout
js/features/*.js       camera, conversation, handwriting (+ hwr.js engines), OCR, speech (+ stt.js), permissions
```

### Adding a provider

```js
registerProvider({
  id: 'deepl', label: 'DeepL', kind: 'classic',            // or 'advanced'
  fields: [{ key: 'apiKey', label: 'Auth key', type: 'password', required: true }],
  create: (cfg) => new DeepLProvider(cfg),                  // detect(), translate(), languages(), test()
});
```

Settings renders the fields automatically and the service can be added to the list; no UI changes needed.

## Deployment

Pushing to `main` deploys the repository root via the shared SFTP workflow.
The workflow bumps `CACHE_NAME` in `sw.js` so installed apps pick up new versions.

`.htaccess` relaxes the host's site-wide security headers **for this folder only**: provider requests to any
HTTPS URL (and `localhost` for local AI servers), scripts/workers from `cdn.jsdelivr.net` plus WebAssembly for
OCR and the on-device models, `application/wasm` for the offline engine, and camera/microphone access. Without
it, providers fail with "Can't reach", camera/mic are disabled and offline translation can't start.

The service worker keeps downloaded language packs and the engine across app updates (only old app-shell
caches are cleared).

## Status

Prototype. Tested with automated module and DOM tests, API stand-ins, a real LibreTranslate server, and the
real on-device engine with real model downloads (outside a browser). Not yet checked by hand in every browser
and screen size; camera/handwriting OCR not yet on real images; no test against a real paid AI provider.
Not affiliated with any translation service; all names and marks belong to their owners.
