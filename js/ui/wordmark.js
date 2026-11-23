// Word highlight while reading aloud (IDEAS #16). Uses the CSS Custom Highlight API, so the text itself
// isn't changed (no extra elements, nothing new for screen readers). Browsers without it: no highlight.
const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
const mark = supported ? new Highlight() : null;
if (supported) CSS.highlights.set('spoken-word', mark);

/** The first text node in el that holds the text (the translation is one text node). */
function textNode(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return w.nextNode();
}

/**
 * An onWord(start, end) callback for speak() that marks that range of el's text; (-1, -1) clears it.
 * Returns null where highlighting isn't supported, so speak() doesn't bother.
 */
export function wordMarker(el) {
  if (!supported) return null;
  return (start, end) => {
    mark.clear();
    if (start < 0) return;
    const n = textNode(el);
    if (!n || end > n.length) return;
    const r = new Range();
    r.setStart(n, start);
    r.setEnd(n, end);
    mark.add(r);
  };
}
export const clearWordMark = () => mark?.clear();
