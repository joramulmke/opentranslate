// Files shared to the app (Android share menu) or opened with it (a computer's "Open with"):
//   photos → camera text (several: a strip to switch between them)
//   PDF    → its text into the text box; a scanned PDF's pages → camera text, like photos
//   .txt   → its text into the text box
//   Word, PowerPoint, e-books and other documents, and PDFs longer than the text box → "Translate a file"
// The text box holds 5,000 characters; longer .txt files are cut with a note.
import { MAX } from '../ui/textview.js';
import { canTranslateFile } from './doctranslate.js';
import { toast } from '../ui/snackbar.js';

const isImage = (f) => /^image\//.test(f.type);
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isText = (f) => /^text\/plain/.test(f.type) || /\.txt$/i.test(f.name || '');
const nf = (n) => n.toLocaleString('en');

/** A .txt file as text: UTF-8, or Windows-1252 (older Windows files) when it isn't valid UTF-8. */
export async function readTextFile(f) {
  const buf = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

/**
 * @param {File[]} files
 * @param {{ text?: string, toText: (text: string) => void, toCamera: (images: (Blob|HTMLCanvasElement)[]) => Promise<boolean>, toDocs?: (file: File) => void }} to
 */
export async function openFiles(files, { text = '', toText, toCamera, toDocs }) {
  const pdf = files.find(isPdf);
  const images = files.filter(isImage);
  const texts = files.filter((f) => isText(f) && !isPdf(f));
  const doc = files.find((f) => !isImage(f) && !isPdf(f) && !isText(f) && canTranslateFile(f));
  try {
    if (doc && toDocs) { toDocs(doc); return; }
    if (pdf) {
      toast('Reading the PDF…', { duration: 15000 });
      const { readPdf } = await import('./pdf.js');
      const r = await readPdf(pdf, { maxChars: MAX });
      if (r.cut && toDocs) { toDocs(pdf); return; }   // too long for the text box: translate the whole PDF
      if (r.text) {
        toText(r.text);
        const notes = [];
        if (r.cut) notes.push(`The text box holds ${nf(MAX)} characters, so only the beginning of the PDF is here.`);
        if (r.textPages < r.pages && !r.cut) notes.push(`${r.pages - r.textPages} of ${r.pages} pages have no text (scans?) and were left out.`);
        if (notes.length) toast(notes.join(' '), { duration: 9000 });
        else toast(`PDF read: ${r.pages === 1 ? '1 page' : `${r.pages} pages`}`, { duration: 3000 });
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
    toast(e.message || 'This file could not be opened.');
  }
}
