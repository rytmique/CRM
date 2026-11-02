import { h, busy, toast } from '../ui.js';
import { post } from '../api.js';

function insertAtCursor(t, text) {
  const { selectionStart: a, selectionEnd: b, value } = t;
  t.value = value.slice(0, a) + text + value.slice(b);
  t.focus();
  t.selectionStart = t.selectionEnd = a + text.length;
  t.dispatchEvent(new Event('input'));
}

/**
 * Prompt textarea + variable chips + "reset" + "try on a profile".
 * fixedProfileId: try only on this profile (profile editor); getFields: unsaved form values for the preview.
 */
export function promptEditor({ value, defaultPrompt, promptVars, profiles = [], fixedProfileId, getFields, rows = 14, name, allowEmpty = false, placeholder }) {
  const text = h('textarea.mono.prompt-editor', { rows, spellcheck: 'false', name, placeholder });
  text.value = value || '';
  const badge = h('span.badge');
  const isDefault = () => text.value.trim() === defaultPrompt.trim();
  const update = () => {
    if (allowEmpty && !text.value.trim()) { badge.textContent = 'Не задано — діє майстер-промт'; badge.className = 'badge muted'; return; }
    badge.textContent = isDefault() ? 'Стандартний' : 'Свій промт';
    badge.className = `badge ${isDefault() ? 'muted' : 'accent'}`;
  };
  text.addEventListener('input', update);
  update();

  const vars = h('div.vars', promptVars.map(([k, label]) => h('button.chip', { type: 'button', title: `Вставити ${k}`, onclick: () => insertAtCursor(text, k) }, h('code', k), ` ${label}`)));
  const reset = allowEmpty
    ? h('button.btn', { type: 'button', onclick: () => { text.value = ''; update(); } }, 'Очистити (діятиме майстер-промт)')
    : h('button.btn', { type: 'button', onclick: () => { text.value = defaultPrompt; update(); toast('Повернуто стандартний промт. Не забудьте зберегти.'); } }, 'Скинути до стандартного');
  const copyDefault = allowEmpty
    ? h('button.btn', { type: 'button', onclick: () => { text.value = defaultPrompt; update(); } }, 'Взяти стандартний за основу')
    : null;

  const sel = fixedProfileId ? null : h('select', { 'aria-label': 'Анкета для перевірки' }, profiles.map((p) => h('option', { value: p.id }, p.name)));
  const out = h('div.preview-out', { hidden: true, role: 'status' });
  const test = h('button.btn.primary', { type: 'button', disabled: !fixedProfileId && !profiles.length }, fixedProfileId ? 'Перевірити промт' : 'Перевірити на анкеті');
  test.addEventListener('click', () => busy(test, async () => {
    const id = fixedProfileId || sel.value;
    const r = await post(`/api/profiles/${id}/invites/preview`, { prompt: text.value, fields: getFields ? getFields() : undefined });
    out.hidden = false;
    out.replaceChildren(
      h('div.small.muted', r.source === 'template' ? 'Ключ Claude не задано — показано шаблон, промт не використано.' : `Приклад від ${r.model}. Нічого не збережено.`),
      h('p.preview-text', r.preview),
      h('div.small.muted', `${r.text.length} символів · так інвайт побачить чоловік на ім’я Michael`));
  }).catch(() => {}));

  const el = h('div.prompt-box',
    text,
    h('div.small.muted', 'Змінні (клікніть, щоб вставити в місце курсора):'),
    vars,
    h('p.small.muted', 'У самому інвайті {name}, {age}, {country} — дані чоловіка: бот підставляє їх під час відправки. Контакти, посилання й месенджери сервер не пропускає ніколи — за них сайти банять анкети.'),
    h('div.row-wrap', reset, copyDefault, sel, test),
    out);
  return { el, badge, value: () => text.value, textarea: text };
}
