/** Hyperscript: h('div.card#id', { onclick, class, ... }, ...children). Text is always set as text (XSS-safe). */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = Boolean(v);
    else if (k === 'html') el.innerHTML = v; // only for trusted static markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : String(k));
  }
}

export const svgNs = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(svgNs, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : String(k));
  return el;
}

// ---------- formatting ----------
export const fmtInt = (n) => new Intl.NumberFormat('uk-UA').format(n || 0);
export const fmtPct = (x) => `${(Math.round((x || 0) * 1000) / 10).toLocaleString('uk-UA')}%`;
export function fmtDate(ts, withTime = true) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('uk-UA', withTime ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'щойно';
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
  return `${Math.floor(s / 86400)} дн тому`;
}
export const dayLabel = (d) => { const [, m, dd] = d.split('-'); return `${dd}.${m}`; };

// ---------- toast ----------
export function toast(text, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div#toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h(`div.toast.${kind}`, text);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 3000);
}

// ---------- modal ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { onclick: close, 'aria-label': 'Закрити', title: 'Закрити' }, '✕')),
    h('div.modal-body', body),
    actions.length ? h('div.modal-foot', actions) : null);
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => box.querySelector('input:not([type=hidden]),textarea,select')?.focus(), 30);
  return { close, box };
}

export function confirmDialog(text, { ok = 'Так', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: 'Підтвердження',
      body: h('p', text),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        h('button.btn', { onclick: () => m.close() }, 'Скасувати'),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => { done = true; m.close(); resolve(true); } }, ok),
      ],
    });
  });
}

// ---------- forms ----------
export function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div.field', h('label', { for: id }, label), input, hint ? h('small.hint', hint) : null);
}

export function input(name, value, attrs = {}) {
  return h('input', { name, value: value ?? '', ...attrs });
}
export function textarea(name, value, attrs = {}) {
  const t = h('textarea', { name, rows: 3, ...attrs });
  t.value = value ?? '';
  return t;
}
export function select(name, value, options, attrs = {}) {
  return h('select', { name, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}

/** Collects named fields into an object; numbers for type=number, '' → null for numbers. */
export function formData(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number' || el.dataset.num !== undefined) out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

/** Runs an async action with a busy button and error toast. */
export async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.classList.add('loading'); }
  try {
    return await fn();
  } catch (e) {
    toast(e.message || 'Помилка', 'err');
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = label; }
  }
}

export function badge(text, kind = '') {
  return h(`span.badge${kind ? `.${kind}` : ''}`, text);
}

export function avatar(name, url) {
  const el = h('span.avatar', (name || '?').trim()[0]?.toUpperCase() || '?');
  if (url && /^https?:\/\//.test(url)) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  return el;
}

export function empty(text, action) {
  return h('div.empty', h('p', text), action || null);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопійовано'); } catch { toast('Не вдалося скопіювати', 'err'); }
}

/** Wraps an async event handler so failures show a toast instead of disappearing. */
export const safe = (fn) => (e) => Promise.resolve().then(() => fn(e)).catch((err) => toast(err.message || 'Помилка', 'err'));
