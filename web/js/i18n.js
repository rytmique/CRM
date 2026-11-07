// UA / RU for the panel. The Ukrainian text is the key; the Russian one comes from i18n-ru.js.
// Every text that goes through h() (ui.js) is translated, so pages stay written in Ukrainian.
import { RU, RU_PATTERNS } from './i18n-ru.js';

const KEY = 'agc_lang';
let lang = (() => { try { return localStorage.getItem(KEY) === 'ru' ? 'ru' : 'uk'; } catch { return 'uk'; } })();
document.documentElement.lang = lang;

export const getLang = () => lang;
/** Switches the language (the next render uses it). */
export function setLang(l) {
  lang = l === 'ru' ? 'ru' : 'uk';
  try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
  document.documentElement.lang = lang;
}

const CYR = /[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ’]/;
const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
// «{}» in a key = any value (a number, a name): "Чекають підтвердження: {}"
const PATTERNS = Object.entries(RU_PATTERNS).map(([ua, ru]) => [new RegExp(`^${esc(ua.trim()).replace(/\{\}/g, '([\\s\\S]+?)')}$`), ru.trim()]);

/** A text in the current language (unknown texts stay as they are). */
export function t(s) {
  if (lang !== 'ru' || typeof s !== 'string' || !CYR.test(s)) return s;
  if (RU[s] !== undefined) return RU[s];
  const lead = /^\s*/.exec(s)[0];
  const tail = /\s*$/.exec(s)[0];
  const core = s.trim();
  if (core !== s && RU[core] !== undefined) return lead + RU[core] + tail;
  for (const [re, ru] of PATTERNS) {
    const m = re.exec(core);
    if (m) { let i = 1; return lead + ru.replace(/\{\}/g, () => t(m[i++])) + tail; }
  }
  return s;
}
