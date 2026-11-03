import { h, field, input, busy, toast, modal, confirmDialog } from '../ui.js';
import { put } from '../api.js';

const ACTIONS = [
  ['message', '✉ Написати повідомлення'],
  ['click', '👆 Натиснути кнопку'],
  ['view', '👀 Переглянути його профіль'],
  ['pause', '⏸ Пауза'],
];
const TEXTS = [
  ['invite', 'Інвайт анкети'],
  ['followup', 'Повторне повідомлення (пише ШІ)'],
  ['custom', 'Свій текст'],
];

const clone = (x) => JSON.parse(JSON.stringify(x));

/** One-line summary of a scenario for the site card. */
export function scenarioSummary(sc) {
  const tries = sc.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length;
  const hm = sc.human;
  return [
    `${tries} ${tries === 1 ? 'спроба' : tries < 5 ? 'спроби' : 'спроб'}`,
    hm.hoursFrom !== hm.hoursTo ? `${hm.hoursFrom}:00–${hm.hoursTo}:00` : 'цілодобово',
    hm.perHour ? `до ${hm.perHour}/год` : null,
    hm.typing ? 'друкує як людина' : null,
  ].filter(Boolean).join(' · ');
}

const selectEl = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
  options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));

const num = (value, attrs, onchange) => h('input', { type: 'number', value: value ?? '', ...attrs, oninput: (e) => onchange(e.target.value === '' ? null : Number(e.target.value)) });

/** Scenario editor for a site: steps per man, filters, caution. */
export function openScenario(site, onSaved) {
  const sc = clone(site.scenario);
  const taught = site.config.actions || [];
  const marks = site.config.marks || [];
  const stepsBox = h('div.steps');

  const defaultAction = (kind) => ({
    message: { do: 'message', text: 'followup' },
    click: { do: 'click', action: taught[0]?.key || '' },
    view: { do: 'view', chance: 30, seconds: 8 },
    pause: { do: 'pause', seconds: 5 },
  }[kind]);

  function actionRow(step, a, i) {
    const parts = [selectEl(a.do, ACTIONS, (v) => { step.actions[i] = defaultAction(v); if (v === 'message' && step === sc.steps[0]) step.actions[i].text = 'invite'; renderSteps(); })];
    if (a.do === 'message') {
      parts.push(selectEl(a.text, TEXTS, (v) => { a.text = v; if (v === 'custom' && !a.custom) a.custom = ''; renderSteps(); }));
    } else if (a.do === 'click') {
      parts.push(taught.length
        ? selectEl(a.action, taught.map((t) => [t.key, t.name]), (v) => { a.action = v; })
        : h('span.small.muted', 'Кнопок ще немає — навчіть у розширенні: 🎯 → «Кнопки й ознаки»'));
    } else if (a.do === 'view') {
      parts.push(h('label.inline', 'шанс', num(a.chance, { min: 0, max: 100, step: 10 }, (v) => { a.chance = v ?? 100; }), '%'),
        h('label.inline', num(a.seconds, { min: 2, max: 120 }, (v) => { a.seconds = v ?? 8; }), 'с'));
    } else if (a.do === 'pause') {
      parts.push(h('label.inline', num(a.seconds, { min: 1, max: 600 }, (v) => { a.seconds = v ?? 5; }), 'с'));
    }
    parts.push(h('button.icon-btn', { type: 'button', title: 'Прибрати дію', onclick: () => { step.actions.splice(i, 1); renderSteps(); } }, '✕'));
    const row = h('div.action-row', parts);
    if (a.do === 'message' && a.text === 'custom') {
      const ta = h('textarea', { rows: 3, placeholder: 'Hi {name}! …\n---\nДругий варіант (бот вибере випадковий)', oninput: (e) => { a.custom = e.target.value; } });
      ta.value = a.custom || '';
      return h('div', row, ta, h('small.hint', '{name} — його ім’я, {her_name} — її ім’я. Кілька варіантів розділяйте рядком ---'));
    }
    if (a.do === 'message' && a.text === 'followup') return h('div', row, h('small.hint', 'ШІ один раз пише текст для кожної анкети. Побачити й змінити — в анкеті, розділ «Повторні повідомлення».'));
    return row;
  }

  function renderSteps() {
    const n = sc.steps.length;
    stepsBox.replaceChildren(
      ...sc.steps.map((step, idx) => h('div.step-card',
        h('div.step-head',
          h('b', `Крок ${idx + 1}`),
          idx === 0
            ? h('span.muted', '— одразу, коли бот знайшов нового чоловіка')
            : h('span.step-wait', '— через ', num(step.wait, { min: 0, max: 1440, step: 1, 'aria-label': 'годин' }, (v) => { step.wait = v ?? 24; }), ' год, якщо він не відповів'),
          h('span.spacer'),
          idx > 1 ? h('button.icon-btn', { type: 'button', title: 'Вище', onclick: () => { [sc.steps[idx - 1], sc.steps[idx]] = [sc.steps[idx], sc.steps[idx - 1]]; renderSteps(); } }, '↑') : null,
          idx > 0 && idx < n - 1 ? h('button.icon-btn', { type: 'button', title: 'Нижче', onclick: () => { [sc.steps[idx + 1], sc.steps[idx]] = [sc.steps[idx], sc.steps[idx + 1]]; renderSteps(); } }, '↓') : null,
          idx > 0 ? h('button.icon-btn', { type: 'button', title: 'Видалити крок', onclick: () => { sc.steps.splice(idx, 1); renderSteps(); } }, '✕') : null),
        step.actions.map((a, i) => actionRow(step, a, i)),
        step.actions.length < 8 ? h('button.btn.sm.ghost', { type: 'button', onclick: () => { step.actions.push(defaultAction(taught.length ? 'click' : 'view')); renderSteps(); } }, '+ дія') : null)),
      sc.steps.length < 10 ? h('button.btn.sm', { type: 'button', onclick: () => { sc.steps.push({ wait: 24, actions: [defaultAction('message')] }); renderSteps(); } }, '+ Додати крок') : null,
      h('p.step-end', `Після кроку ${n} без відповіді чоловік зникає зі списку бота. Спроб написати: ${sc.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length}.`));
  }

  const markPick = (list, label) => h('div.field', h('label', label), marks.length
    ? h('div.row-wrap', marks.map((mk) => h('label.check', h('input', { type: 'checkbox', checked: list.includes(mk.key), onchange: (e) => {
      const i = list.indexOf(mk.key);
      if (e.target.checked && i < 0) list.push(mk.key);
      if (!e.target.checked && i >= 0) list.splice(i, 1);
    } }), mk.name)))
    : h('small.hint', 'Ознак ще немає — навчіть у розширенні: 🎯 → «Кнопки й ознаки» (напр. «Онлайн»)'));

  const hm = sc.human;
  const body = h('div.scenario',
    h('p.muted.lead', 'Що бот робить з кожним чоловіком. Щойно він відповів — бот зупиняється, далі пише жива людина.'),
    h('h3', 'Кроки'),
    stepsBox,
    h('h3', 'Кому писати'),
    h('div.form-grid',
      field('Тільки країни', input('countries', sc.filters.countries, { placeholder: 'USA, Canada, UK — порожньо = усім', oninput: (e) => { sc.filters.countries = e.target.value; } })),
      field('Крім країн', input('excludeCountries', sc.filters.excludeCountries, { placeholder: 'напр. Nigeria', oninput: (e) => { sc.filters.excludeCountries = e.target.value; } })),
      markPick(sc.filters.needMarks, 'Писати тільки тим, у кого є'),
      markPick(sc.filters.skipMarks, 'Пропускати тих, у кого є'),
      h('small.hint.span-2', 'Вік чоловіків задається в анкеті (поля «Вік чоловіків від / до»).')),
    h('h3', 'Обережність — щоб не палити анкету'),
    h('div.form-grid',
      h('div.pair', field('Працювати з, год', num(hm.hoursFrom, { min: 0, max: 24 }, (v) => { hm.hoursFrom = v ?? 0; })), field('до, год', num(hm.hoursTo, { min: 0, max: 24 }, (v) => { hm.hoursTo = v ?? 0; }))),
      field('Не більше повідомлень на годину', num(hm.perHour, { min: 0, max: 500 }, (v) => { hm.perHour = v ?? 0; }), '0 — без обмеження'),
      h('div.pair', field('Перерва кожні, повідомл.', num(hm.breakEvery, { min: 0, max: 500 }, (v) => { hm.breakEvery = v ?? 0; })), field('на, хв', num(hm.breakMinutes, { min: 1, max: 180 }, (v) => { hm.breakMinutes = v ?? 10; }))),
      h('label.check', h('input', { type: 'checkbox', checked: hm.typing, onchange: (e) => { hm.typing = e.target.checked; } }), 'Друкувати текст по літері, як людина'),
      h('small.hint.span-2', 'Час — за часовим поясом агенції. Звичайні паузи між повідомленнями задаються в анкеті або в Налаштуваннях. Числа трохи «гуляють» випадково, щоб не було рівного ритму.')));

  renderSteps();
  const save = h('button.btn.primary', 'Зберегти');
  const m = modal({
    title: `Сценарій: ${site.name}`, body, wide: true,
    actions: [
      h('button.btn.ghost.left', { onclick: async () => {
        if (!(await confirmDialog('Повернути стандартний сценарій: інвайт + 2 повторні через 24 і 48 год?'))) return;
        await put(`/api/sites/${site.id}/scenario`, { reset: true });
        toast('Повернуто стандартний сценарій');
        m.close();
        onSaved?.();
      } }, 'Скинути до стандарту'),
      h('button.btn', { onclick: () => m.close() }, 'Скасувати'),
      save,
    ],
  });
  save.addEventListener('click', () => busy(save, async () => {
    if (sc.steps.some((s, i) => i > 0 && !s.actions.length)) throw new Error('У кроці немає жодної дії — додайте дію або видаліть крок');
    if (sc.steps.some((s) => s.actions.some((a) => a.do === 'click' && !a.action))) throw new Error('Виберіть кнопку для дії «Натиснути кнопку» (або навчіть кнопки в розширенні)');
    if (sc.steps.some((s) => s.actions.some((a) => a.do === 'message' && a.text === 'custom' && !String(a.custom || '').trim()))) throw new Error('Заповніть «Свій текст» або виберіть інше джерело тексту');
    await put(`/api/sites/${site.id}/scenario`, { scenario: sc });
    toast('Сценарій збережено');
    m.close();
    onSaved?.();
  }).catch(() => {}));
}
