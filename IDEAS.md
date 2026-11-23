# OpenTranslate: feature ideas

Possible features for later, not promises. Ideas that are done have been taken out (they're in the app, and
in this file's git history); what is still open from them is in the first section. Numbers of ideas that
were taken out (#2 live subtitles, #7 background downloads, #15 Show to someone…) still mean those features.

## Left over from done ideas

- Camera photo translated in place (#1): try Tesseract and PP-OCRv6 on real photos (only AI vision was
  tried, in a test).
- Live subtitles (#2): try Chrome's own speech service and tab sound on a real computer. Phones: see #13.
- Right-to-left translations in saved files (#5): .txt files have no direction mark, and Word / OpenDocument
  files keep their paragraph direction.
- Screen readers (#5): try the app with real TalkBack, VoiceOver and NVDA.
- Keep downloads safe (#6): try in Firefox (its own prompt, and "Block" is remembered).
- Translate a file or website (#9):
  - A scanned PDF (no text) isn't translated in "Translate a file", only in camera text.
  - Text in pictures on websites isn't translated.
  - The files' own links, and formatting inside a paragraph (e.g. one bold word), go to the whole paragraph.
- Word highlight while reading aloud (#16): try with a real ElevenLabs key.
- Faster loading (#18c): the web host only has gzip (no Brotli) and only speaks HTTP/1.1 (no HTTP/2 or
  HTTP/3); that would need IONOS or Cloudflare in front.

## 8. pip
   
(Done, Nov 2026: Chrome/Edge on computers. Live captions in it: later, with #2.) A floating translator window (Picture-in-Picture): on a computer, a small always-on-top window for translating while you work in other apps. It also fits the live subtitles idea.
   
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

## 19. First-run welcome (idea)

On the first visit, one screen instead of the red "!" on the menu: "Which languages do you need?"
(the phone's language is already picked; add the one you'll read or speak). Then either download them for
offline use (size shown, one tap) or add a service (LibreTranslate server, AI key). Skippable; never shown
again once a service or a language is set up. Replaces the setup badge and the first "Translate on this
device" card.

## 20. Language packs (idea)

One download per language that covers everything for it: offline translation, the photo language file
(Tesseract), an offline voice (Piper) and, if wanted, on-device speech recognition. Shown as one row per
language in Settings with the total size and what's included, and offered from the language picker
("Get everything for Japanese, 120 MB"). Good for travel: set up at home on Wi-Fi, everything works abroad
without data. Deleting a pack removes all its parts.
