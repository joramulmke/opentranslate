# OpenTranslate: feature ideas

Possible features for later, not promises. Items marked "Done" are kept for what is still left to do.

## 1. Translate the camera photo in place

Draw the translation over the original text in the photo (like Lens): each text line gets a box in the
background colour with the translated text on top, sized to fit. Uses the line boxes that Tesseract,
PP-OCRv6 and AI vision already return.

Half there before (Nov 2026): a light box with the translation over each line. Plan (agreed Nov 2026):
- The photo's own colours: each box takes the background colour around its line (sampled from the
  photo's edges of the box) and a text colour that stands out from it, so it blends in.
- Whole sentences: lines that belong together (a paragraph: close below each other, about the same left
  edge and height) are translated as one text, then spread back over their lines by length. Better
  translations than line by line.
- Save and share the translated photo as a picture (the photo with the boxes drawn in), also the
  "NEXT" from #5.
- Pinch (or Ctrl + wheel) to zoom and drag to move the photo. Tapping a box does nothing; "Original"
  still shows the original text.

## 2. Live subtitles in Conversation

Continuous speech recognition and translation as running captions, for talks or calls. Big, readable
text, scrolling; each line translated as soon as it is final.

(Done, Nov 2026: in Conversation › Listening, with microphone or tab sound, the pause switch, text size,
transcript and floating captions on computers. Tried with a recording engine; Chrome's own speech service
and tab sound still need a try on a real computer and phone. Phones: see #13.)
Plan (agreed Nov 2026): build it into Conversation › Listening, which already listens, translates only
their language and restarts the mic by itself (it pauses after two silences today).
- Runs until you stop it or leave: no pause after silence (after ~2 minutes of silence it pauses, to save
  battery, and says so). A switch "Pause after 2 minutes of silence" (on by default, remembered) in the
  Listening setup and on the captions screen turns that off, e.g. for a long talk with breaks. Chrome's speech service: `continuous = true` in Listening, restarted when Chrome
  ends it (about every minute). Recording engines (Whisper, ElevenLabs, on-device): the next recording
  starts at once while the last one is transcribed, so no words get lost between pieces.
- Captions: translation big, original small under it (as now); the words being heard show greyed until
  they're final; only final lines are translated (no extra API calls). Scrolls to the newest line, unless
  you scrolled up: then a "Jump to latest" button. Screen readers hear final lines only.
- Text size: A− / A+ on the captions screen, 4 steps, remembered.
- Audio: Microphone (default) or, on a computer, "Tab or screen audio" (a video call, a YouTube tab) via
  screen sharing with audio. That needs a recording engine; with Chrome's speech service chosen, the app
  says so and uses the next engine. Hidden where the browser can't share audio (phones; see #13 for
  "Sound from this phone", and #11 for other apps' sound in a native app).
- Save the transcript: Copy, Share, or download as .txt (both languages, with times).
- Floating window (#8): "Pop out captions" on a computer shows the latest lines big in the always-on-top
  window; the main tab keeps the microphone. On phones: floating captions as a video, see #13.
- Keep screen on: already done (Conversation keeps the screen on).
- Costs: Whisper and ElevenLabs charge per minute, so continuous captions can add up; the setup says so
  when one of them is chosen.
- Test: Playwright with a fake microphone (a WAV file) and a mocked transcription API; Chrome's own speech
  service only on a real device.


## 4. Look up a word on Wiktionary

(Done, Nov 2026.) When the input is only a word or a few (e.g. "test", "Prüfung", "church community"), show a link to
https://www.wiktionary.org/ for it: meanings, gender, plural, pronunciation. Not for whole sentences.

Plan (agreed Nov 2026):
- Looks up the translation, not the input: German→English "Prüfung" gives a link for "test".
- In the target language's Wiktionary: `https://{target}.wiktionary.org/w/index.php?search={translation}`
  (search URL: opens the entry if it exists, else search results, so capitalisation doesn't matter).
  Languages without their own Wiktionary fall back to en.wiktionary.org.
- A small link under the result, e.g. 'Look up "test" on Wiktionary ↗', in `js/ui/textview.js`. Shown only when
  the input is 1–3 words (no sentence punctuation, no line break) and the translation has finished.
  Opens in a new tab, with a proper screen-reader label.

## 5. Web Share

(Done, Nov 2026: Text view, translation only.) Share a translation (Web Share): a Share button next to Copy that opens the phone's share menu, so you can send a translation to WhatsApp or by email. NEXT: Share translated image, file, website etc. 

## 6. Persistent downloads

(Done, Nov 2026; not yet tried in Firefox or on a phone.) Keep downloads safe (persistent storage): downloads can be several GB, and the browser may delete them when
   space runs low. One call asks it to keep them; the right moment is right after the first download.

Plan (agreed Nov 2026, built):
- On the first tap on Download, the app asks the user first, with its own sheet (`sheet()` from
  `js/features/permissions.js`):
  "Keep downloads safe? Downloads can be large. When space on this device runs low, the browser may delete
  them without asking. OpenTranslate can ask the browser to keep them." Buttons: "Keep them safe" / "Not now".
  The download starts either way.
- Only after "Keep them safe" does the app ask the browser (`navigator.storage.persist()`). Firefox then shows
  its own prompt; Chrome, Edge and Safari decide by themselves (installed, bookmarked, used a lot).
- If the browser says no, ask the browser again later without a new sheet, because its answer can change:
  after the app is installed (`appinstalled`, or the first start as an installed app), and at the next
  downloads. Stop once it says yes. (Firefox remembers a "Block" and won't prompt again.)
- "Not now" in the sheet: don't ask again by sheet. Settings gets a switch "Keep downloads safe" to change it.
- A helper `ensurePersisted()` in `js/ui/storage.js`, called from the download buttons (language packs, voices,
  models, PP-OCRv6, on-device AI; `js/features/offline.js`, `bgfetch.js`).
- Show the result in Settings › storage line: "· Kept safe", or "· May be deleted when space runs low" with a
  hint "Install the app to keep them safe". Nothing shown where the browser has no storage API.

## 7. background fetch

(Done, Nov 2026: language packs, voices, PP-OCRv6, speech, handwriting and on-device AI models; not yet tried on a phone.) Downloads keep going when the app is closed (Background Fetch): large language and model downloads finish even if you leave the app. This works in Chrome on Android only.

## 8. pip
   
(Done, Nov 2026: Chrome/Edge on computers. Live captions in it: later, with #2.) A floating translator window (Picture-in-Picture): on a computer, a small always-on-top window for translating while you work in other apps. It also fits the live subtitles idea.
   
## 9. File and Website Translation

Plan (agreed Nov 2026):
- Where: "Translate a file or website" in the ⋮ menu (and a home-screen shortcut, below) opens a sheet:
  pick or drop a file, or paste a link. Files opened with or shared to the app that the text box can't
  take well (.docx, .pptx, …) open there too.
- Files, translated in place, same format out, translation only: Word .docx, PowerPoint .pptx, Excel
  .xlsx (text cells only, numbers and formulas left alone), OpenDocument .odt/.ods/.odp, e-books .epub,
  .html, .txt/.md, subtitles .srt/.vtt (lines and times kept), .csv, .po and .json strings. Office files
  are ZIPs of XML: the text of each paragraph is swapped (formatting inside a paragraph, e.g. one bold
  word, goes to the whole paragraph). The ZIP reader (fflate) loads only when needed, from jsDelivr.
- PDF, two results: a readable page view (translated paragraphs page by page, next to the original;
  download as .html or .txt) and "Original layout" (each page drawn like #1, translation over the text,
  saved as a new PDF of page pictures, so any script works; its text can't be selected).
- Websites by link: the page with its layout and pictures, text translated, in a safe frame with the
  site's scripts off; a tapped link is translated too. Download as .html. Most sites can't be read from
  another site (CORS), so: the user's own proxy in Settings (a URL template like
  https://my-proxy.example/?url={url}), with a short guide and a tiny Cloudflare Worker to copy. No proxy
  from us. Without one, only sites that allow it work.
- Size: up to 20,000 characters starts right away; above that it shows the size (characters, pages) and
  the service and asks first. Progress and a Stop button while it runs.
- Translation: segments are sent in batches (one per line); if a service returns a different number of
  lines, that batch goes segment by segment.
- Home-screen shortcuts (manifest): each gets its own icon (camera, mic, pen) instead of the app icon,
  and a 4th, "Translate a file".

## 12. Share more to OpenTranslate

(Done, Nov 2026; not yet tried on a phone.) Before, "Share → OpenTranslate" (Android) took text, links and one photo. Plan (agreed Nov 2026):
- .txt files: the text goes into the text box (UTF-8, else Windows-1252), up to 5,000 characters (what the
  text box holds); a note when it was cut.
- PDFs: pdf.js (Mozilla's PDF reader, exact version from jsDelivr like the voice engine) loads only when a
  PDF arrives; its text goes into the text box. Pages without text (scans) open in camera text instead,
  one page per photo (see below). Everything stays on the device; only the reader is downloaded.
- Several photos: camera text opens the first one, with a strip of thumbnails to switch; each photo keeps
  its own result. Up to 10. "Import" in camera text takes several photos too.
- How: the manifest's share_target accepts image/*, text/plain and application/pdf; the service worker
  keeps every file (not only the first photo) and opens ./?share=files. "Open with OpenTranslate" on a
  computer (file_handlers) gets .pdf too, with the same code.
- Test: submit a share form to ./share in Playwright (text, .txt, a text PDF, a scanned PDF, 3 photos);
  then on your Android phone from Files, Gmail and WhatsApp.

## 10. App stores without Google Play: AltStore PAL, F-Droid, other Android stores, a plain APK

Preferred over the Play Store (below). Ideas to check:
- Android: one wrapper app, published as a signed APK on the GitHub releases page (and the website), and
  from there in F-Droid (builds from source and only takes free software: no Google libraries, no
  tracking; a Trusted Web Activity needs a Chrome-type browser, so a plain WebView or Capacitor wrapper may
  fit better), Obtainium (installs straight from GitHub releases), Accrescent, and others such as the
  Huawei AppGallery, Samsung Galaxy Store or Amazon Appstore if worth it.
- iPhone/iPad (EU): AltStore PAL takes native iOS apps only, so OpenTranslate needs a small iOS wrapper
  (WKWebView or Capacitor), Apple notarization and an Apple developer account. Check AltStore's current
  rules and fees first.
- The home-screen widget idea below works in any of these Android builds, not only from the Play Store.
- Notifications for downloads in the app versions: in Chrome, background downloads (#7) show Chrome's own
  download notification, so the web app never asks for notification permission (only Chrome's phone setting
  for notifications matters, and the app can't ask for that). An app version must ask itself:
  - Android 13+: declare POST_NOTIFICATIONS and ask at the first big download, not at the first start.
    Without it, downloads still finish but show no progress or "ready" message.
  - Trusted Web Activity: background downloads still run in Chrome; web notifications go through the app
    (notification delegation), so the app needs the permission too.
  - Plain WebView or Capacitor: no Background Fetch at all. Downloads need native code (Android
    DownloadManager, or WorkManager with a foreground service and its notification), and so the permission.
  - iOS wrapper: no Background Fetch either; use a background URLSession for downloads and ask for
    notification permission (UNUserNotificationCenter) for the "ready" message.

## 11. after 10 - add a home-screen widget

Android has no widgets for PWAs. The way there: wrap OpenTranslate as a Play Store app (Trusted Web Activity,
built with Bubblewrap) and write the widget natively (Kotlin), e.g. a quick "translate" box or a phrase of the
day from saved phrases. Needs a Play developer account, app signing and Digital Asset Links on joram.eu.
The store listing would also ask for an IARC age rating (then add iarc_rating_id to the manifest).
- Live subtitles (#2) from other apps' sound: a native app can caption a video call, YouTube or a podcast
  playing on the phone itself, which a web app can't (no browser lets web apps capture screen or app audio
  on phones). Android 10+: AudioPlaybackCapture with MediaProjection (asks "start recording?" each time;
  apps can opt out, e.g. some call apps). iPhone: other apps' sound can't be captured, only the
  microphone, so this would be Android only.
- Full brightness for Show to someone (#15): a web app can't turn up the screen brightness, a native app
  can (Android: the window's screenBrightness, only while the card is open, no permission needed; iPhone:
  UIScreen.brightness).

## 13. Live subtitles on phones (try on a real phone first)

Two things for live subtitles (#2) on phones, where there's no tab audio and no floating window like #8.
Try each on a real Android phone (and an iPhone) before building it out.
- "Sound from this phone": an audio choice that turns off echo cancellation (and noise suppression), so
  the microphone also hears the phone's own loudspeaker, e.g. a video playing in another app. Quality
  depends on the phone; only offered where it works well enough.
- Floating captions: the latest caption lines drawn on a canvas, turned into a video (canvas.captureStream)
  and put into the phone's floating video window (requestPictureInPicture). Works where floating videos
  work (Chrome on Android, Safari on iPhone). Only the captions, no buttons. Microphone in the background
  (checked Nov 2026): Chrome on Android stops its own speech service as soon as the page is hidden, so
  floating captions need a recording engine (Whisper, ElevenLabs, on-device). A page recording the
  microphone itself can stay alive (Chrome shows a "using your microphone" notification), but whether the
  captions keep coming still has to be tried on a real phone.
- Screen readers can't read text inside a video, so the floating captions say nothing to them. That goes
  into the accessibility notices (below); the captions screen in the app stays fully readable.

Accessibility notices: a short "Accessibility" section at the bottom of Settings listing what doesn't
work with screen readers or other assistive tech, and what to use instead. First entry: the floating
captions on phones (a video, so not readable; use the captions screen instead). Later entries as found.

## 14. Backup and move to another device

(Done, Nov 2026; QR scanning not yet tried on a phone. Differences from the plan: QR codes are scanned in
Import itself, not in camera text; opening a backup file with "Open with" isn't wired up, use Import.)
Take settings, history and phrasebook to a new phone or computer, without an account. Plan (agreed Nov 2026):
- In Settings: "Back up or move" with Export and Import.
- What goes in: settings (engines, languages, options), phrasebook, history, recent languages. Downloads
  (language packs, voices, models) don't: they're too big, and the new device downloads them again.
- API keys: a checkbox "Include API keys", off by default, with a note that anyone who has the backup can
  use them. Without it, the engines come over without their keys, and the app asks for them.
- Three ways, same data:
  - File: download an `opentranslate-backup-YYYY-MM-DD.json` (on Android: Share it). Import with a file
    picker, or by opening the file with OpenTranslate (file_handlers, #12).
  - Copy as text: the same backup as one text block to paste into a chat or an email to yourself; Import
    has a "Paste" box.
  - QR codes: the backup split into numbered codes ("2 of 5") with Back / Next buttons. The other device
    scans them in camera text (BarcodeDetector: Android Chrome, Macs; not Windows Chrome) in any order and
    shows which ones are still missing. The QR codes are drawn by a small library loaded only when needed.
- Import asks before replacing: "Replace" or "Add to" (phrasebook and history are merged without duplicates;
  settings are replaced). A backup from a newer app version still opens; unknown parts are skipped.
- Test: export → import in a second browser profile (file, text); QR codes with a fake camera showing them.

## 15. Show to someone

(Done, Nov 2026; not yet tried on a phone.) Show the translation big to the person you're talking to, e.g. at a pharmacy or to a taxi driver. Plan
(agreed Nov 2026):
- A full-screen button (icon) next to Copy and Share under the text result.
- The card: only the translation, as big as fits on the screen, nothing else (no original). Light text on
  dark or the other way round, as the theme. Closes with ✕, Back or Escape.
- Reads the translation aloud after 5 seconds ("Reading aloud in 5…"), with a Stop button; Play to hear it
  again. No voice for the language: no countdown.
- Keeps the screen on while open (Screen Wake Lock). A web app can't turn up the brightness (native app: #11).
- Full screen (Fullscreen API) where the browser allows it; otherwise a page-filling layer.

## 16. Highlight each word while reading aloud

(Done, Nov 2026: Text result and Show to someone; not yet tried with a real ElevenLabs key or on a phone.)
While a translation is read aloud, the word being spoken is marked, at normal and at the slower speed (the
second press of Play is already slower). Plan (agreed Nov 2026):
- Only with exact timings: the browser's own voices that report word boundaries (`onboundary`; many
  on-device voices do, Google's online voices on Chrome don't) and ElevenLabs (its "with timestamps"
  speech endpoint). Piper and other voices without timings play as now, without a highlight.
- Always on while playing; the mark goes when it stops. In the Text result first; Show to someone (#15)
  and the phrasebook can use it too.
- Screen readers: the highlight is only visual (no announcements for each word).
