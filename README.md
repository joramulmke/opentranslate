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

## Translation providers

Open **Settings** (gear icon).

| Mode | Provider | Notes |
| --- | --- | --- |
| Classic | **Offline demo (Mock)** | Default. Works offline, deterministic. Knows a set of common phrases; other text gets a clearly marked placeholder. Can simulate network / unsupported-pair errors. |
| Classic | **LibreTranslate** | Any server with the standard `/languages`, `/detect`, `/translate` API. Enter the server URL and (optional) API key. |
| Advanced | **OpenAI-compatible API** | An AI model via any `/chat/completions` endpoint: OpenAI, OpenRouter, Groq, Mistral, DeepSeek, Ollama, LM Studio or custom. Enter base URL, API key and model; **Test connection** lists available models. |

Switch between **Classic** and **Advanced** with the dropdown next to the character count.

**API keys are stored only in your browser (`localStorage`) and sent only to the URL you enter.** They are
never part of this repository. Use keys with spending limits; anyone with access to that browser profile can read them.

### LibreTranslate server

```bash
docker run -p 5000:5000 libretranslate/libretranslate          # official image
# or without Docker (Python 3.10–3.12):
python3 -m venv .venv && .venv/bin/pip install libretranslate
.venv/bin/libretranslate --load-only en,es,fr,de
```

Then set the server URL to `http://localhost:5000`.

### Local AI models (Ollama / LM Studio)

The browser calls them directly, so they must allow the page's origin (CORS), e.g.
`OLLAMA_ORIGINS=* ollama serve`, then use base URL `http://localhost:11434/v1` and a model such as `llama3.1`.

## Features

- **Text:** auto-detect, live translation while typing, swap, copy, read aloud (`speechSynthesis`),
  voice input (Web Speech API: Chrome, Edge, Safari; not Firefox or Brave), history (last 100) and
  saved phrasebook, all stored in `localStorage`.
- **Camera:** live preview or imported photo; OCR with [Tesseract.js](https://tesseract.projectnaptha.com/)
  (loaded from a CDN on first use); translated text drawn over the photo.
- **Conversation:** two people, one language each, turns alternate; translations can be read aloud.
- **Handwriting:** draw on a pad (undo, clear, stroke width), recognition suggestions via Tesseract,
  edit, then translate. Works best with neat printed letters.
- Light/dark theme (follows the system, or set it in Settings / the top bar), keyboard operation, ARIA labels,
  `lang`/`dir` on output text, offline app shell via service worker (translations are never cached).

## Layouts

- **< 720 px:** phone layout (big text sheet, language buttons, Conversation · mic · Camera).
- **720–1199 px:** tabs in a bottom bar (720–1023) or navigation rail (1024–1199), side-by-side panes.
- **≥ 1200 px:** desktop layout with mode chips, language tabs, two panes, History/Saved below.

## Project structure

```
index.html  styles.css  manifest.webmanifest  sw.js  icons/
js/app.js              boot, routing (#text, #camera, #conversation, #handwriting), theme, service worker
js/state.js            shared state, Classic/Advanced provider selection, error messages
js/store.js            localStorage: settings, history, phrasebook
js/providers.js        provider interface + registry: Mock, LibreTranslate, OpenAI-compatible
js/languages.js        bundled 50-language fallback, RTL and OCR language maps
js/ui/*.js             text view, language bar/picker, mode menu, sheets, menus, icons, layout
js/features/*.js       camera, conversation, handwriting, OCR, speech
```

### Adding a provider

```js
registerProvider({
  id: 'deepl', label: 'DeepL', kind: 'classic',            // or 'advanced'
  fields: [{ key: 'apiKey', label: 'Auth key', type: 'password', required: true }],
  create: (cfg) => new DeepLProvider(cfg),                  // detect(), translate(), languages(), test()
});
```

Settings renders the fields automatically; no UI changes needed.

## Deployment

Pushing to `main` deploys the repository root via the shared SFTP workflow.
The workflow bumps `CACHE_NAME` in `sw.js` so installed apps pick up new versions.

## Status

Prototype. Tested with automated module and DOM tests and against API stand-ins; not yet tested against
a real LibreTranslate server or a real AI provider, and camera/handwriting OCR not yet on real images.
Not affiliated with any translation service; all names and marks belong to their owners.
