// Files shared to the app (Android share menu) or opened with it (a computer's "Open with"):
//   photos → camera text (several: a strip to switch between them)
//   PDF    → its text into the text box; a scanned PDF's pages → camera text, like photos; a PDF with both:
//            the text, and a "Read them" button that opens the scanned pages in camera text
//   .txt   → its text into the text box
//   Word, PowerPoint, e-books and other documents, and PDFs longer than the text box → "Translate a file"
//   an OpenTranslate backup (.json, or its text shared) → Settings › Import, never translated
// The text box holds 5,000 characters; longer .txt files are cut with a note.
import { MAX } from '../ui/textview.js';
import { canTranslateFile } from './doctranslate.js';
import { toast } from '../ui/snackbar.js';
import { errorText } from '../state.js';

const isImage = (f) => /^image\//.test(f.type);
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isText = (f) => /^text\/plain/.test(f.type) || /\.txt$/i.test(f.name || '');
const isJson = (f) => f.type === 'application/json' || /\.json$/i.test(f.name || '');
const nf = (n) => n.toLocaleString('en');

/** Whether a text is an OpenTranslate backup (Settings › Back up or move), which goes to Import. */
export function isBackupText(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') || !/"app"\s*:\s*"OpenTranslate"/.test(t)) return false;
  try { return JSON.parse(t)?.app === 'OpenTranslate'; } catch { return false; }
}

const MAX_SCANS = 10;   // pages drawn for camera text at most, like photos

/** The scanned pages of a PDF that also has text: drawn, then opened in camera text. */
async function readScans(pdf, pages, toCamera) {
  try {
    toast('Preparing the scanned pages…', { duration: 15000 });
    const { drawPages } = await import('./pdf.js');
    const scans = await drawPages(pdf, pages.slice(0, MAX_SCANS));
    toast(pages.length > MAX_SCANS ? `Reading the first ${MAX_SCANS} of ${pages.length} scanned pages.` : 'Reading the scanned pages.', { duration: 4000 });
    await toCamera(scans);
  } catch (e) {
    toast(errorText(e, 'The scanned pages couldn’t be read.'));
  }
}

/** A .txt file as text: UTF-8, or Windows-1252 (older Windows files) when it isn't valid UTF-8. */
export async function readTextFile(f) {
  const buf = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

/**
 * @param {File[]} files
 * @param {{ text?: string, toText: (text: string) => void, toCamera: (images: (Blob|HTMLCanvasElement)[]) => Promise<boolean>, toDocs?: (file: File) => void, toBackup?: (text: string) => void }} to
 */
export async function openFiles(files, { text = '', toText, toCamera, toDocs, toBackup }) {
  const pdf = files.find(isPdf);
  const images = files.filter(isImage);
  const texts = files.filter((f) => isText(f) && !isPdf(f));
  const doc = files.find((f) => !isImage(f) && !isPdf(f) && !isText(f) && canTranslateFile(f));
  try {
    // a backup is settings, saved translations and maybe API keys: it goes to Import, never to a service
    if (toBackup) {
      for (const f of files.filter((x) => isJson(x) || isText(x))) {
        const t = await f.text();
        if (isBackupText(t)) { toBackup(t); return; }
      }
      if (!files.length && isBackupText(text)) { toBackup(text); return; }
    }
    if (doc && toDocs) { toDocs(doc); return; }
    if (pdf) {
      toast('Reading the PDF…', { duration: 15000 });
      const { readPdf } = await import('./pdf.js');
      const r = await readPdf(pdf, { maxChars: MAX });
      if (r.cut && toDocs) { toDocs(pdf); return; }   // too long for the text box: translate the whole PDF
      if (r.text) {
        toText(r.text);
        const scanned = r.cut ? [] : r.emptyPages;
        if (r.cut) toast(`The text box holds ${nf(MAX)} characters, so only the beginning of the PDF is here.`, { duration: 9000 });
        else if (scanned.length) {
          // text pages and scanned pages: the text is here; one tap reads the scans in camera text
          const n = scanned.length;
          toast(`${n} of ${r.pages} pages ${n === 1 ? 'is a scan' : 'are scans'}, so ${n === 1 ? 'its' : 'their'} text isn’t here yet.`, {
            action: n === 1 ? 'Read it' : `Read ${n > MAX_SCANS ? `first ${MAX_SCANS}` : 'them'}`,
            onAction: () => readScans(pdf, scanned, toCamera),
          });
        } else toast(`PDF read: ${r.pages === 1 ? '1 page' : `${r.pages} pages`}`, { duration: 3000 });
      } else if (r.scans.length) {
        toast(r.scanPages > r.scans.length
          ? `This PDF is a scan: reading its text from the pictures (the first ${r.scans.length} of ${r.scanPages} pages).`
          : 'This PDF is a scan: reading its text from the pictures.', { duration: 6000 });
        await toCamera(r.scans);
      } else {
        toast('This PDF has no text.');
      }
      return;
    }
    if (images.length) { await toCamera(images); return; }
    if (texts.length) {
      const parts = [];
      for (const f of texts) parts.push((await readTextFile(f)).trim());
      const all = parts.filter(Boolean).join('\n\n');
      if (!all) { toast('This file is empty.'); return; }
      toText(all);
      if (all.length > MAX) toast(`The text box holds ${nf(MAX)} characters, so only the beginning of the file is here.`, { duration: 9000 });
      return;
    }
    if (text) { toText(text); return; }
    toast('OpenTranslate can open photos, PDFs, text files and documents (Word, PowerPoint, Excel, e-books…).');
  } catch (e) {
    toast(errorText(e, 'This file couldn’t be opened.'));
  }
}
