// Handing translated files to the person: the share sheet on phones, downloads on computers (IDEAS #5).
// One place so photos, files and web pages behave the same: the button says what will really happen,
// and when sharing doesn't work there is a clear way on.
import { toast } from './snackbar.js';

export const isPhone = () => matchMedia('(pointer: coarse)').matches;

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', txt: 'text/plain', html: 'text/html',
  srt: 'text/plain', vtt: 'text/vtt', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip',
};
export const typeOf = (name) => TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

/** Would the phone's share sheet take a file like this? (Phones only; browsers allow some types only.) */
export function canShareFile(name, type = typeOf(name)) {
  if (!isPhone() || !navigator.canShare) return false;
  try { return navigator.canShare({ files: [new File([''], name, { type })] }); } catch { return false; }
}

/** Share the files (phones), or save them as downloads; `what` names them in messages, e.g. "translated photo";
 *  `lead` starts the saved message, e.g. "There's no internet for the .zip, so ". */
export async function sendFiles(files, what = files.length > 1 ? 'files' : 'file', lead = '') {
  let fallback = lead;
  if (isPhone() && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return 'shared'; } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // making the file took a while and the phone no longer counts it as the tap's answer: one more tap
      if (e.name === 'NotAllowedError') {
        toast(`${cap(what)} ready`, { action: 'Share', onAction: () => navigator.share({ files }).catch((e2) => { if (e2.name !== 'AbortError') download(files, what, 'Sharing didn’t work, so '); }) });
        return 'asked';
      }
      fallback = 'Sharing didn’t work, so ';
    }
  }
  download(files, what, fallback);
  return 'saved';
}

function download(files, what, lead = '') {
  files.forEach((f, i) => setTimeout(() => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }, i * 300));   // one at a time, or the browser may drop some
  const many = files.length > 1;
  // "Translated photo saved to Downloads" / "Sharing didn't work, so the translated photo was saved to Downloads"
  if (!lead) { toast(`${cap(many ? `${files.length} ${what}` : what)} saved to Downloads`); return; }
  const it = many ? `${files.length} ${what} were` : `${/\./.test(what) ? what : `the ${what}`} was`;
  toast(`${lead}${it} saved to Downloads`);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Today as 2026-11-23 (local time). */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The first few words of a text, for a file name: "pharmacy-please-ring". Letters of any script stay. */
export function slugWords(text, words = 3, max = 40) {
  const w = String(text || '').normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  let s = '';
  for (const x of w.slice(0, words)) {
    const next = s ? `${s}-${x}` : x;
    if (next.length > max) break;
    s = next;
  }
  return s || w[0]?.slice(0, max) || '';
}
