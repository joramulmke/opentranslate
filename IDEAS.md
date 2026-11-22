# OpenTranslate: feature ideas

Possible features for later, not promises. Items marked "Done" are kept for what is still left to do.

## 1. Translate the camera photo in place

Draw the translation over the original text in the photo (like Lens): each text line gets a box in the
background colour with the translated text on top, sized to fit. Uses the line boxes that Tesseract,
PP-OCRv6 and AI vision already return.

## 2. Live subtitles in Conversation

Continuous speech recognition and translation as running captions, for talks or calls. Big, readable
text, scrolling; each line translated as soon as it is final.


## 4. Look up a word on Wiktionary

When the input is only a word or a few (e.g. "test", "Prüfung", "church community"), show a link to
https://www.wiktionary.org/ for it: meanings, gender, plural, pronunciation. Not for whole sentences.

## 5. Web Share

(Done, Nov 2026: Text view, translation only.) Share a translation (Web Share): a Share button next to Copy that opens the phone's share menu, so you can send a translation to WhatsApp or by email. NEXT: Share translated image, file, website etc. 

## 6. Persistent downloads

Keep downloads safe (persistent storage): downloads can be several GB, and the browser may delete them when
   space runs low. One call asks it to keep them; the right moment is right after the first download.

## 7. background fetch

(Done, Nov 2026: language packs, voices, PP-OCRv6, speech, handwriting and on-device AI models; not yet tried on a phone.) Downloads keep going when the app is closed (Background Fetch): large language and model downloads finish even if you leave the app. This works in Chrome on Android only.

## 8. pip
   
A floating translator window (Picture-in-Picture): on a computer, a small always-on-top window for translating while you work in other apps. It also fits the live subtitles idea.
   
## 9. File and Website Translation

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
