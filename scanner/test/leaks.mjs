// Generic leak detector for a scanner report: every word of every string must be an interface / technical word,
// a placeholder or code (class names, selectors). Anything else — a name, a city, a piece of a message — is a leak.
// Usage: node scanner/test/leaks.mjs <unzipped report dir>   (exit code 1 if anything is found)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(HERE, '..', 'dict.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(HERE, '..', 'roles.js'), 'utf8'));
const M = self.__scanMask;
const ROLES = new Set(self.__scanRoles.ROLE_NAMES.map((r) => r.toLowerCase()));
const OURS = new Set(['site', 'rec', 'w', 'текст', 'тел', 'email', 'url', 'x', 'адреса', 'inline', 'react', 'vue', 'angular', 'nuxt', 'svelte', 'css', 'modules',
  'in', 'js', 'flags', 'visible', 'hidden', 'prerender', 'navigate', 'reload', 'back_forward', 'backcompat', 'css1compat', 'utf', 'chrome', 'chromium', 'mozilla',
  'applewebkit', 'khtml', 'like', 'gecko', 'safari', 'headlesschrome', 'linux', 'windows', 'macintosh', 'europe', 'kyiv', 'uk', 'ua', 'en', 'us', 'gb', 'utc',
  'бачили', 'class', 'style', 'hidden', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head',
  'textbox', 'listbox', 'menuitem', 'menubar', 'tablist', 'tabpanel', 'combobox', 'checkbox', 'radio', 'presentation', 'region', 'banner', 'navigation', 'complementary',
  'main', 'img', 'heading', 'listitem', 'group', 'log', 'status', 'tooltip', 'separator', 'article', 'feed', 'grid', 'gridcell', 'treeitem', 'searchbox', 'spinbutton']);
// keys whose values are code, not text: class names, ids, selectors, tags, types, our own enums
const CODE_KEYS = new Set(['c', 'css', 'altCss', 'xp', 'path', 'added', 'incidents', 'tg', 'ty', 'kind', 'k', 'key', 'it', 'fw', 'sig', 'reason', 'm', 'err', 'inner', 'pos', 'note',
  'browser', 'tz', 'lang', 'charset', 'mode', 'type', 'vis', 's', 'st', 'dir', 'version', 'why', 'role', 'from_file']);
const allowWord = (w) => {
  const l = w.toLowerCase();
  return M.DICT.has(l) || M.TECH.has(l) || OURS.has(l) || ROLES.has(l) || /^[a-z]{1,2}$/.test(l) || /^~[0-9a-f]{4}$/.test(w) || /^h-[0-9a-f]{6}$/.test(w)
    || /^[a-p]{32}$/.test(w) || /^aria$/.test(l); // extension IDs (not personal) and attribute names
};
const found = new Map();
const flag = (w, where) => {
  if (!found.has(w)) found.set(w, { n: 0, where: new Set() });
  const f = found.get(w);
  f.n++;
  if (f.where.size < 4) f.where.add(where);
};
/** Every word of a text; joined tokens (anna_k, michael-smith, a@b.c) are split and checked part by part. */
let PREFIXES = null; // every start of an interface / technical word: a text cut to a box ends with «Sen…» or «mes…»
const isPrefix = (w) => {
  if (!PREFIXES) { PREFIXES = new Set(); for (const d of [...M.DICT, ...M.TECH]) for (let k = 1; k <= d.length; k++) PREFIXES.add(d.slice(0, k)); }
  return PREFIXES.has(w.toLowerCase());
};
function checkWords(text, where) {
  const t = String(text).replace(/\[(W|w|текст \d+|тел|email|url|x|адреса)\]/g, ' ');
  for (const tok of t.split(/[\s,;!?"'`|+«»()]+/)) {
    if (/^[\p{L}]+…$/u.test(tok)) { const w = tok.slice(0, -1); if (w.length >= 2 && !allowWord(w) && !isPrefix(w)) flag(w, where); continue; }
    for (const part of tok.split(/[-_.:/=#@\[\]>~*&?%]+/)) {
      if (!part || /^[0-9a-f]{4,8}$/i.test(part)) continue; // ~hash parts
      // ChatList, anna1990, dialogAnnaSmith: each word on its own (a name glued to code is still a name); random code (k2L3m) has no 2+ letter words
      const words = /[a-z][A-Z]|\d[A-Za-z]|[A-Za-z]\d/.test(part) ? part.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+/g) || [] : part.match(/[\p{L}][\p{L}'’]*/gu) || [];
      for (const w of words) if (w.length >= (words.length > 1 ? 4 : 2) && !allowWord(w)) flag(w, where);
    }
  }
}
function checkString(s, where) {
  const str = String(s);
  // element descriptors "div.chat-item[role=button] «[W], # …»", "+span.left-msgs": the code part is class names —
  // check only the quoted (masked) text
  const TAG = '(div|span|a|button|li|ul|ol|input|textarea|label|section|main|aside|header|footer|nav|img|p|h[1-6]|i|b|em|strong|small|form|select|option|table|tr|td|th|svg|summary|details|iframe|article|picture|video|audio|[a-z]+-[a-z-]+)';
  const descriptor = new RegExp(`^(\\+|(click|key|submit|file)(:\\w+)? )?${TAG}([.[]|$| «| end=)`).test(str);
  if (descriptor || /«[^»]*»/.test(str)) { for (const m of str.matchAll(/«([^»]*)»/g)) checkWords(m[1], where); return; }
  checkWords(str, where);
}
function walk(v, where, key) {
  if (typeof v === 'string') { if (!CODE_KEYS.has(key)) checkString(v, where); return; }
  if (Array.isArray(v)) { for (const x of v) walk(x, where, key); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`, k);
}

const dir = process.argv[2];
const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
for (const f of files) {
  const p = path.join(dir, f);
  if (f.endsWith('.json')) walk(JSON.parse(fs.readFileSync(p, 'utf8')), f, '');
  else if (f.endsWith('.jsonl')) for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (line.trim()) walk(JSON.parse(line), f, ''); }
  else if (f.endsWith('.svg')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/<text[^>]*>([^<]*)<\/text>/g)) checkString(m[1].replace(/&[a-z]+;/g, ' '), f);
}
const list = [...found.entries()].sort((a, b) => b[1].n - a[1].n);
if (!list.length) { console.log(`no leaks: every word in ${files.length} files is an interface word, code or a placeholder`); process.exit(0); }
console.log(`SUSPICIOUS WORDS (${list.length}):`);
for (const [w, f] of list.slice(0, 60)) console.log(`  ${w} ×${f.n}  ${[...f.where].join('  ')}`);
process.exit(1);
