/**
 * Makes the bot's code harder to read when it is downloaded: comments, indentation and blank lines go away.
 * A small JS tokenizer, so strings, template literals and regular expressions are never touched.
 * (Code in a browser can never be fully hidden; the real protection is that the bot is useless without our server,
 * an approved account and a license.)
 */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

export function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lineStart = true; // only whitespace so far on this output line
  let lastSig = ''; // last significant code character / word (to tell a regex from a division)
  const braces = []; // template nesting: depth of `{` inside each `${`
  let depth = 0;

  const emit = (s) => { out += s; if (s.trim()) lineStart = false; };
  const newline = () => {
    out = out.replace(/[ \t]+$/, '');
    if (!out.endsWith('\n') && out.length) out += '\n';
    lineStart = true;
  };

  function readString(q) {
    let j = i + 1;
    while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
    emit(src.slice(i, j + 1));
    i = j + 1;
    lastSig = q;
  }
  /** From a backtick (or a `}` closing `${`) to the next `${` or the closing backtick. */
  function readTemplate(start) {
    let j = start;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { emit(src.slice(i, j + 1)); i = j + 1; lastSig = '`'; return; }
      if (src[j] === '$' && src[j + 1] === '{') { emit(src.slice(i, j + 2)); i = j + 2; braces.push(depth); depth = 0; lastSig = '{'; return; }
      j++;
    }
    emit(src.slice(i)); i = n;
  }
  function readRegex() {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      else if (c === '\n') break;
      j++;
    }
    j++;
    while (j < n && /[a-z]/i.test(src[j])) j++; // flags
    emit(src.slice(i, j));
    i = j;
    lastSig = 'a';
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n' || c === '\r') { if (c === '\r' && d === '\n') i++; i++; newline(); continue; }
    if ((c === ' ' || c === '\t') && lineStart) { i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
      if (body.includes('\n')) newline(); else if (!lineStart && !/\s$/.test(out)) out += ' ';
      continue;
    }
    if (c === '"' || c === "'") { readString(c); continue; }
    if (c === '`') { readTemplate(i + 1); continue; }
    if (c === '/') {
      const word = /[A-Za-z_$][\w$]*$/.exec(out.trimEnd())?.[0];
      const regexOk = !lastSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || (word && REGEX_AFTER_WORD.has(word) && /[A-Za-z_$]$/.test(lastSig));
      if (regexOk) { readRegex(); continue; }
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0 && braces.length) { depth = braces.pop(); readTemplate(i + 1); continue; } // emits from this } on
      depth--;
    }
    // collapse runs of spaces in code
    if (c === ' ' || c === '\t') {
      if (!/[ \t]$/.test(out)) out += ' ';
      i++;
      continue;
    }
    emit(c);
    if (!/\s/.test(c)) lastSig = /[\w$]/.test(c) ? 'a' : c;
    i++;
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').replace(/^\n/, '');
}
