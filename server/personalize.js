// Keep in sync with extension/personalize.js (the extension cannot import from outside its folder).

/** Usable first name or '' (site usernames like "john_1985" are skipped). */
export function firstName(raw) {
  const first = String(raw || '').trim().split(/\s+/)[0] || '';
  if (!/^\p{L}[\p{L}'-]{1,24}$/u.test(first)) return '';
  return first.charAt(0).toLocaleUpperCase() + first.slice(1);
}

/** Replaces {name} {age} {country}; drops a placeholder (and its leading comma) when the value is unknown. */
export function personalize(text, man = {}) {
  const vars = {
    name: firstName(man.name),
    age: man.age ? String(man.age) : '',
    country: String(man.country || '').trim(),
  };
  let out = String(text || '');
  for (const [k, v] of Object.entries(vars)) {
    if (v) out = out.replaceAll(`{${k}}`, v);
    else out = out.replace(new RegExp(`[ \\t]*,?[ \\t]*\\{${k}\\}`, 'g'), '');
  }
  return out.replace(/[ \t]+([!?.,])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}
