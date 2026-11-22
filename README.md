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

Open **Settings** (gear icon) → **Services and downloads**. It has three parts: **Translation** (Classic,
Advanced), **Voice** (Speech recognition, Read aloud, Cloud voice services) and **Text recognition** (Handwriting,
Camera text). Translation services are a list in two groups; add as many as
you like with **+ Add LibreTranslate** (under Classic) and **+ Add AI model** / **+ Add on-device AI** (under
Advanced), edit, reorder (↑ ↓) or remove them (with Undo). If the chosen mode can't translate (nothing set up, server down, no download yet), the other mode
stands in and the result says so, e.g. *"Translated with LibreTranslate · joram.eu (Classic) because no AI model is set
up."* When neither can, the error offers **Use Classic** / **Use Advanced**. The offline demo never stands in.
An AI model's form has two boxes, **Read images
(handwriting)** and **Speech to text**. The page can't tell from a model's name what it can do, so both stay off until
**Test connection** has tried it (a small red square, half a second of silence); then you decide whether to use it.

| Group | Service | Notes |
| --- | --- | --- |
| Classic | **On this device (Bergamot)** | Built in. Translates in the browser with downloaded language packs (see below). No server, no key, works offline; nothing you type leaves the device. |
| Classic | **LibreTranslate** | Any server with the standard `/languages`, `/detect`, `/translate` API. Server URL and (optional) API key. |
| Classic | **Offline demo** | Built in, for trying the app: a few phrases, other text gets a clearly marked placeholder. Can simulate network / unsupported-pair errors. |
| Advanced | **AI model** (OpenAI-compatible) | Any `/chat/completions` endpoint: OpenAI, OpenRouter, Groq, Mistral, DeepSeek, Ollama, LM Studio or custom. Base URL, API key and model; **Test connection** lists available models. |
| Advanced | **On-device AI** | A small AI model running in the browser (see below). No server, no key, works offline after the download; nothing you type leaves the device. |

**Which one is used:** the checked service in each group goes first. If it fails (offline, server down) or
doesn't have the language, the next one **of the same group** is tried, in list order; the result then says
who failed and why, e.g. *LT one didn't answer in time, so LT two translated this.* A **Why?** button under the
note lists every service that was tried, what went wrong with each, and which one answered. The offline demo
never stands in for a real service.

The dropdown next to the character count lists all services (Classic and Advanced) for quick switching.
Settings saved by older versions (one LibreTranslate + one AI setup) are moved into the list automatically.

### Offline languages (On this device, Bergamot)

Download a language once, then translate without internet:

- in the **language picker** (Classic mode), tap the download icon next to a language; tap again to cancel, or
  to remove a downloaded one;
- or in **Settings → On this device (Bergamot) → Manage** (all languages, sizes, storage used, remove);
- or when a translation needs a missing language, the result card offers **Download**.

Each pack is English ↔ that language (about 45–75 MB, Chinese ~120 MB); English is built in. Other pairs go
through English (German → English → French), so they need both packs. ~58 languages are available.
The engine is [Bergamot](https://github.com/browsermt/bergamot-translator) (the engine of Firefox's built-in
translation, WebAssembly in a Web Worker, vendored in `vendor/bergamot/`, MPL-2.0); the models are Mozilla's
open translation models, downloaded from Mozilla's model CDN, checked against their SHA-256 hashes and stored in
the browser's Cache Storage. Language detection uses [franc](https://github.com/wooorm/franc) (MIT), limited to
the downloaded languages. Not available on device: Irish, Swahili, Esperanto (greyed out).

Mozilla serves the models from two addresses:

- model list (works in every browser):
  `https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records`
- model files: `https://firefox-settings-attachments.cdn.mozilla.net/` + each record's `attachment.location`

**Chrome, Edge, Brave and other Chromium-based browsers download the files from a mirror:** Mozilla's file
server answers HTTP 406 to any browser whose User-Agent contains "Chrome", and a web page can't change that
header. To check:
`curl -s -o /dev/null -w "%{http_code}\n" -r 0-15 -A Chrome https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/23db71e7-b6d9-45eb-a47d-0290d7d8ef63.bin`
(406; without `-A Chrome` it is 206). So in those browsers:

- the model list still comes from Mozilla (it serves every browser) and decides the version;
- the files come from [midudev/firefox-translations](https://huggingface.co/midudev/firefox-translations) on
  Hugging Face, a byte-for-byte MPL-2.0 mirror of Mozilla's models (Hugging Face lists each file's SHA-256);
- a model version is offered only if the mirror has all its files with the SHA-256 from Mozilla's list, and every
  downloaded file is checked again, so the mirror can't hand out anything else;
- languages the mirror lacks aren't offered there (in November 2026: Belarusian, Chinese (Simplified), Croatian,
  Korean, Maltese, Norwegian Nynorsk, Tagalog, Uyghur; the mirror's Chinese model is an older one Mozilla no
  longer lists). Safari, Firefox and Chrome on iPhone keep downloading from Mozilla;
- if the mirror disappears, the app goes back to switching the on-device service off and explaining why.

### On-device AI (Advanced mode)

Settings → **+ Add on-device AI**, pick a model, **Add and download**. The model picker has a filter box and
four groups:

- **Recommended for translating**: 10 multilingual models from tiny to large, each with its download size and the
  graphics memory it needs (e.g. Qwen 3.5 0.8B: 0.4 GB, fits phones; Qwen 2.5 1.5B: 0.9 GB, the default;
  Llama 3.2 3B: 1.8 GB; Qwen 3.5 9B / Gemma 2 9B: ~5 GB, strong graphics chip).
- **Built into this browser**: Gemini Nano in Chrome (Prompt API). Chrome downloads and updates it itself; no
  WebGPU needed. It may not write every target language yet; the app says so when it can't.
- **All WebLLM models**: the whole catalogue of WebLLM 0.2.87 (62 chat models; embedding, vision and 70B models
  left out), sizes measured from Hugging Face (`js/features/llmcatalog.js`).
- **Your own model**: an MLC-compiled model by URL plus its WebGPU model library (`.wasm`, https only). WebLLM
  runs code from that library, so the field says to use only one you trust.

WebLLM models run on the graphics chip with [WebLLM](https://github.com/mlc-ai/web-llm) (Apache-2.0, loaded from
jsDelivr, in a Web Worker). Qwen 3 models are told not to "think" first, which keeps translations quick.

Classic also offers **Add Chrome translator** where Chrome has its built-in translator (Translator API): Chrome
downloads each language pair the first time it's used and translates on the device; detection uses Chrome's
LanguageDetector.

- Needs **WebGPU**: recent Chrome or Edge on a computer, Safari 26+. Without it the add button is disabled
  and says why.
- The files come from Hugging Face (`huggingface.co/mlc-ai`, works in Chrome too) and the engine code from
  `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs`; they are kept in Cache Storage (`webllm/*`).
- The service row shows the download progress, with cancel (what was fetched is kept and resumes) and a
  download button if it isn't downloaded yet. Translating before the download offers **Download** in the result.
- Removing the service deletes its downloaded model (unless another service uses the same one).
- Text only: no handwriting recognition or speech-to-text; those use their usual engines.
- Translations are less fluent than large online models; the first translation after opening the app takes a few
  seconds while the model loads onto the graphics chip.

### Downloads on this device

Everything the app downloads is listed in Settings → **Services and downloads**. Every option there carries the
same short tags: **Private** or **Sends to <host>**, **Works offline** or **Needs internet**, its size
(**130 MB download**, **Ready**, **No download**), and **Best / Good / Fastest** where quality really differs.
Under the tags is one short line. The **ⓘ** button opens the details: where it comes from (host and a link to the
model page), licence and engine. Download and delete buttons sit next to it, to download ahead of time (e.g.
before travelling) or free space. Every download prompt and error also names the source.

The top of Settings shows the space used on this device (*Using 1.2 GB on this device · 6 downloads*).
**Free up space** opens one list of every download, largest first, each with a Delete button (it asks first).
A **Search settings** box filters the whole Settings page: only matching rows and their headings stay; Escape
clears it.

| Group | What | From | Kept in |
| --- | --- | --- | --- |
| Classic › On this device (Bergamot) | offline languages, ~45–75 MB each | Mozilla (`firefox-settings-attachments.cdn.mozilla.net`) | Cache Storage `ot-offline-*` |
| Advanced › On-device AI | WebLLM model, ~0.2–7 GB (your pick), or your own model | Hugging Face (`huggingface.co/mlc-ai`) or your model URL | Cache Storage `webllm/*` |
| Speech recognition › On this device | Whisper tiny / base / small / large-v3 turbo, 41–563 MB | Hugging Face (`huggingface.co/Xenova/whisper-base`) | Cache Storage `transformers-cache` |
| Read aloud › Offline voices | Piper voice, ~63 MB per language (+ 30 MB engine, once); manager with search | Hugging Face (`huggingface.co/rhasspy/piper-voices`), engine from jsDelivr | Cache Storage `ot-piper-v1` |
| Read aloud › Offline voices › Kokoro | Kokoro 82M (quantised), 92 MB + 0.5 MB per voice | Hugging Face (`huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX`) | Cache Storage `ot-piper-v1` |
| Camera text / Handwriting › PP-OCRv6 | detection + recognition, 31 MB (+ 11 MB ONNX Runtime, shared with the voices) | Hugging Face (`huggingface.co/PaddlePaddle`) | Cache Storage `ot-paddle-v1` |
| Handwriting › On-device model | TrOCR small handwritten, ~130 MB | Hugging Face (`huggingface.co/Xenova/trocr-small-handwritten`) | Cache Storage `transformers-cache` |
| Camera text (OCR) › Tesseract | one file per language, ~1–15 MB; manager with search | jsDelivr (`cdn.jsdelivr.net/npm/@tesseract.js-data`) | IndexedDB `keyval-store` |

The engines themselves (Bergamot is in the app; WebLLM, transformers.js and Tesseract.js come from jsDelivr) sit in
the browser's normal cache and are not listed. Whisper and TrOCR downloads can't be cancelled half-way
(transformers.js has no way to stop them); the others can. Deleting Whisper or TrOCR means the app asks again
before downloading it the next time it's needed.

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

- **Text:** auto-detect, live translation while typing, swap, copy, read aloud (see below; play the
  same text again within 10 s and it plays slower, at 0.6×, for practising pronunciation; the next play is normal),
  history (last 100) and saved phrasebook, all stored in `localStorage`.
- **Read aloud** (Text, Handwriting, Conversation). Four engines; the one checked in Settings → Translation
  services → **Read aloud** goes first, the others follow:
  1. **Built-in voices (system)** (`speechSynthesis`), nothing to download, quality depends on the device;
  2. **Natural voices (Piper)** ([Piper](https://github.com/rhasspy/piper)): one voice per language for 53
     languages, ~63 MB each from Hugging Face (`huggingface.co/rhasspy/piper-voices`), plus a one-time 30 MB voice
     engine (ONNX Runtime and the Piper phonemizer with eSpeak NG data, GPL-3.0, from jsDelivr). Downloaded in the
     *Offline voices* manager, or the app asks the first time a language has no voice ("Not now" is remembered per
     language). Works without internet. No Piper voices for Hebrew, Japanese, Lithuanian and Thai: they need
     phonemizers that don't run in the browser;
  3. **Cloud-AI (your model)**: your AI model's `/audio/speech` (set *Text-to-speech model*, e.g. `gpt-4o-mini-tts`, `tts-1`,
     and a *Voice*), once *Test connection* confirmed it;
  4. **Cloud-AI (ElevenLabs)** (Settings → Voice → Cloud voice services → *Add ElevenLabs*): your API key, voice and model (Flash v2.5 or
     Multilingual v2). The key stays in this browser and goes only to `api.elevenlabs.io`.

  **Kokoro 82M** (hexgrad, Apache-2.0; `onnx-community/Kokoro-82M-v1.0-ONNX`, 92 MB) sits at the top of the
  Offline voices manager: one model for English (US, UK), Spanish, French, Hindi, Italian and Portuguese (Brazil),
  with a voice picker per language (each further voice 0.5 MB). When downloaded it reads those languages instead of
  Piper. Its pronunciation comes from eSpeak NG (through Piper's phonemizer), not from the tools Kokoro was trained
  with, so some words can sound off; Japanese and Chinese aren't offered for that reason.

  A replay of the same text uses the recording it already has (no second request or charge).
- **Voice input** works in every browser that can record audio. Four engines; the one checked in
  Settings → Voice → **Speech recognition** goes first, the others follow:
  1. **Browser speech (Web Speech)** with live text (Chrome, Edge, Safari; your voice goes to Google, Microsoft
     or Apple). Not in Brave or Firefox; if it fails, the app switches to recording;
  2. **Cloud-AI (Whisper API)**: the app records the microphone itself (stops after ~1.5 s of silence) and sends
     it to your AI service's `/audio/transcriptions` (set *Speech-to-text model*, e.g. `whisper-1`,
     `whisper-large-v3-turbo`). Used when chosen, or in Advanced mode;
  3. **Cloud-AI (ElevenLabs)** (Scribe), with an ElevenLabs entry under Voice › Cloud voice services;
  4. **On this device (Whisper)**, in four sizes picked in the row: tiny (41 MB), base (80 MB, default), small
     (250 MB, much better outside English) and large-v3 turbo (563 MB, needs WebGPU with 16-bit support): `whisper-base` in the browser, asks before a one-time ~80 MB download, detects
     the language.
- **Languages** your services can't translate stay visible but greyed out; tapping one explains why
  (e.g. not installed on your LibreTranslate server). Languages that can be downloaded show a download icon.
- **Camera:** live preview or imported photo; OCR with [Tesseract.js](https://tesseract.projectnaptha.com/)
  (loaded from jsDelivr on first use; one language file per language, see below) as **Basic (Tesseract)**, or **Many languages (PP-OCRv6)** (PaddlePaddle,
  Apache-2.0) when picked in Settings → Text recognition → Camera text: two small ONNX models (31 MB, once, from
  `huggingface.co/PaddlePaddle`), much better on photos, for Latin-script languages, Chinese, Japanese and Greek
  (other scripts go to Tesseract automatically), or **Advanced (AI vision)**: your AI model reads the photo (any script,
  angled or curved text; needs a model whose **Read images** box is ticked; only when picked, since the photo is
  sent to that service; if it fails, the photo is read on the device and a notice says so). Translated text is
  drawn over the photo: line by line where the model gives line boxes, otherwise as one block.
- **Conversation:** two people, one language each, turns alternate; translations can be read aloud.
- **Handwriting:** draw on a pad (undo, clear, stroke width), pick a suggestion, edit, then translate.
  Four engines; the one checked in Settings → Text recognition → **Handwriting** goes first, the others follow:
  1. **Advanced (AI vision)**: your AI model reads the drawing (any script, cursive), when chosen or in Advanced mode. Needs a
     model whose **Read images** box is ticked (after Test connection); one API call per recognition.
  2. **On-device model (TrOCR)**: TrOCR handwriting model in the browser via
     [transformers.js](https://github.com/huggingface/transformers.js); asks before a one-time ~130 MB download,
     Latin-script languages only, private.
  3. **Many languages (PP-OCRv6)**: the camera text model (see Camera), when picked; Latin script, Chinese, Japanese, Greek;
  4. **Basic (Tesseract)**: fallback for everything else, best with neat printed letters.
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
| `demo_mode` | `false` removes the offline demo service (default: on). Until someone adds a real service, Settings then says none is set up |

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
js/ui/storage.js       Settings: space used on this device and the "Free up space" list
js/ui/settingssearch.js Settings: search box that hides what doesn't match
js/store.js            localStorage: settings + service list (with migration), history, phrasebook
js/providers.js        provider interface + registry: Mock, LibreTranslate, OpenAI-compatible
js/features/offline.js on-device translation: model list, downloads, Bergamot worker, detection
js/features/localllm.js on-device AI (WebLLM): model choice, WebGPU check, download, provider (+ llm-worker.js)
js/features/models.js  transformers.js models (Whisper, TrOCR): loading, downloaded state, size, source, delete
js/ui/enginerows.js    Settings rows for Speech recognition, Read aloud, Handwriting, Camera text (+ voice and OCR managers)
js/features/piper.js   offline voices (Piper): voice list, download, delete, synthesis
js/features/llmcatalog.js  on-device AI models: WebLLM catalogue with sizes, recommended picks
js/features/chrometranslator.js  Chrome's built-in translator (Classic)
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
OCR, the on-device models and the on-device AI (WebGPU), `application/wasm` for the offline engine, and camera/microphone access. Without
it, providers fail with "Can't reach", camera/mic are disabled and offline translation can't start.

The service worker keeps downloaded language packs and the engine across app updates (only old app-shell
caches are cleared).

## Status

Prototype. Tested with automated module and DOM tests, API stand-ins, a real LibreTranslate server, and the
real on-device engine with real model downloads (outside a browser). Not yet checked by hand in every browser
and screen size; camera/handwriting OCR not yet on real images; no test against a real paid AI provider.
Not affiliated with any translation service; all names and marks belong to their owners.
