// Translates the static markup in place. Each text node's and attribute's
// original English is remembered on first visit, so switching back and
// forth is lossless. Only the listed roots are visited: the self-rendering
// panels (props, journey, assistant, legend, examples menu, toast, palette
// body) redraw themselves through onLanguageChange.
import { trd, getLang, setLang, onLanguageChange } from '../i18n.js';

const ROOTS = ['#toolbar', '#palette-search', '#hintbar', '#present-nav', 'dialog'];
const ATTRS = ['title', 'placeholder', 'aria-label'];
const LETTER = /[A-Za-z]/;
const originals = new WeakMap(); // node -> { text } | { attrs: { name: original } }

function translateText(node) {
  let rec = originals.get(node);
  if (!rec) {
    // First visit only: the live nodeValue is still the original English, so
    // this is the one point where testing it for a letter (skipping bare
    // whitespace/punctuation nodes) is meaningful. Once translated, the
    // nodeValue holds Chinese and has no Latin letters, so later calls must
    // not re-run this guard against the live text — they replay the
    // remembered original and its surrounding whitespace instead.
    const raw = node.nodeValue;
    const trimmed = raw.trim();
    if (!LETTER.test(trimmed)) return;
    const lead = raw.slice(0, raw.indexOf(trimmed));
    const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
    rec = { text: trimmed, lead, tail };
    originals.set(node, rec);
  }
  node.nodeValue = rec.lead + trd(rec.text) + rec.tail;
}

function translateAttrs(el) {
  let rec = originals.get(el);
  if (!rec) {
    rec = { attrs: {} };
    for (const a of ATTRS) if (el.hasAttribute(a) && LETTER.test(el.getAttribute(a))) rec.attrs[a] = el.getAttribute(a);
    originals.set(el, rec);
  }
  for (const [a, original] of Object.entries(rec.attrs)) el.setAttribute(a, trd(original));
}

function walk(el, textOff) {
  if (el.nodeType !== 1) return;
  translateAttrs(el);
  const off = textOff || el.getAttribute('data-i18n') === 'off';
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 3) {
      if (!off) translateText(child);
    } else if (child.nodeType === 1 && !['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'SVG', 'svg', 'KBD', 'CODE'].includes(child.tagName)) {
      walk(child, off);
    } else if (child.nodeType === 1) {
      translateAttrs(child); // inputs keep their value but translate placeholder/title/aria-label
    }
  }
}

export function translateStatic(root = document) {
  for (const sel of ROOTS) {
    for (const el of root.querySelectorAll(sel)) walk(el, false);
  }
  if (root !== document && root.nodeType === 1) walk(root, false);
}

// The toolbar switch shows the language it would switch to.
export function initLanguageSwitch(button) {
  const paint = () => { button.textContent = getLang() === 'zh' ? 'EN' : '中文'; };
  button.addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
  onLanguageChange(() => { translateStatic(); paint(); });
  paint();
}
