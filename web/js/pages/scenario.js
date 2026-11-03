import { h, field, input, busy, toast, modal, confirmDialog } from '../ui.js';
import { get, post, put } from '../api.js';

const ACTIONS = [
  ['message', '✉ Написати повідомлення'],
  ['click', '👆 Натиснути кнопку'],
  ['view', '👀 Переглянути його профіль'],
  ['pause', '⏸ Пауза'],
];
const FILES = [
  ['all', '📎 файли анкети для цього кроку'],
  ['one', '📎 один випадковий файл'],
  ['none', 'без файлів'],
];
const TEXTS = [
  ['invite', 'Інвайт анкети'],
  ['followup', 'Повторне повідомлення (пише ШІ)'],
  ['letter', 'Лист (пише ШІ, довший)'],
  ['custom', 'Свій текст'],
];
const VIA = [
  ['chat', '💬 у чат'],
  ['letter', '✉ листом'],
];

const clone = (x) => JSON.parse(JSON.stringify(x));

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
/** "9:00–13:00, 15:00–23:00" or "цілодобово". */
function windowsSummary(hm) {
  const w = hm.windows?.length ? hm.windows : [[hm.hoursFrom, hm.hoursTo]];
  if (w.length === 1 && (w[0][0] === w[0][1] || (w[0][0] === 0 && w[0][1] === 24))) return 'цілодобово';
  return w.map(([a, b]) => `${a}:00–${b}:00`).join(', ');
}
/** "Пн–Пт", "щодня", "Пн, Ср, Пт". */
export function daysText(days) {
  const d = (days?.length ? days : [1, 2, 3, 4, 5, 6, 7]).slice().sort();
  if (d.length === 7) return 'щодня';
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run && d.length > 2 ? `${DAY_NAMES[d[0] - 1]}–${DAY_NAMES[d.at(-1) - 1]}` : d.map((x) => DAY_NAMES[x - 1]).join(', ');
}

/** One-line summary of a scenario for the site card. */
export function scenarioSummary(sc) {
  const tries = sc.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length;
  const hm = sc.human;
  return [
    `${tries} ${tries === 1 ? 'спроба' : tries < 5 ? 'спроби' : 'спроб'}`,
    hm.days && hm.days.length < 7 ? daysText(hm.days) : null,
    windowsSummary(hm),
    hm.spread ? 'рівномірно на день' : null,
    hm.perHour ? `до ${hm.perHour}/год` : null,
    hm.typing ? 'друкує як людина' : null,
    sc.afterReply?.attempts ? `після відповіді +${sc.afterReply.attempts}` : null,
  ].filter(Boolean).join(' · ');
}

const selectEl = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
  options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));

const num = (value, attrs, onchange) => h('input', { type: 'number', value: value ?? '', ...attrs, oninput: (e) => onchange(e.target.value === '' ? null : Number(e.target.value)) });

/** Taught buttons / marks of all sites, for templates that are not tied to one site. */
export function unionLists(sites, kind) {
  const map = new Map();
  for (const s of sites) for (const a of s.config?.[kind] || []) if (!map.has(a.key)) map.set(a.key, a);
  return [...map.values()];
}

/** Site scenario editor. */
export function openScenario(site, onSaved) {
  return openScenarioEditor({
    title: `Сценарій: ${site.name}`,
    scenario: site.scenario,
    taught: site.config.actions || [],
    marks: site.config.marks || [],
    save: (sc) => put(`/api/sites/${site.id}/scenario`, { scenario: sc }),
    reset: () => put(`/api/sites/${site.id}/scenario`, { reset: true }),
    onSaved,
  });
}

/**
 * Scenario editor: steps per man, filters, caution, templates.
 * opts: { title, scenario, taught, marks, save(sc), reset?(), onSaved?(), name? (template name → editable) }
 */
export async function openScenarioEditor(opts) {
  let sc = clone(opts.scenario);
  const { taught, marks } = opts;
  const stepsBox = h('div.steps');
  const lib = await get('/api/scenarios').catch(() => ({ templates: [], presets: [] }));

  const defaultAction = (kind) => ({
    message: { do: 'message', text: 'followup', files: 'all' },
    click: { do: 'click', action: taught[0]?.key || '', chance: 100 },
    view: { do: 'view', chance: 30, seconds: 8 },
    pause: { do: 'pause', seconds: 5 },
  }[kind]);

  function actionRow(step, a, i) {
    const parts = [selectEl(a.do, ACTIONS, (v) => { step.actions[i] = defaultAction(v); if (v === 'message' && step === sc.steps[0]) step.actions[i].text = 'invite'; renderSteps(); })];
    if (a.do === 'message') {
      parts.push(selectEl(a.text, TEXTS, (v) => { a.text = v; if (v === 'custom' && !a.custom) a.custom = ''; if (v === 'letter') a.via = 'letter'; renderSteps(); }));
      parts.push(selectEl(a.via || 'chat', VIA, (v) => { a.via = v; renderSteps(); }));
      parts.push(selectEl(a.files || 'all', FILES, (v) => { a.files = v; }));
    } else if (a.do === 'click') {
      const known = taught.some((t) => t.key === a.action);
      const opts2 = taught.map((t) => [t.key, t.name]);
      if (a.action && !known) opts2.unshift([a.action, `${a.action} (не навчено на цьому сайті)`]);
      parts.push(opts2.length
        ? selectEl(a.action, opts2, (v) => { a.action = v; })
        : h('span.small.muted', 'Кнопок ще немає — навчіть у розширенні: 🎯 → «Кнопки й ознаки»'),
      h('label.inline', 'шанс', num(a.chance ?? 100, { min: 0, max: 100, step: 10 }, (v) => { a.chance = v ?? 100; }), '%'));
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
    if (a.do === 'message' && a.text === 'followup') return h('div', row, h('small.hint', 'ШІ один раз пише текст для кожної анкети. Побачити й змінити — в анкеті, розділ «Повторні повідомлення». Файли вибираються в анкеті → «Файли».'));
    if (a.do === 'message' && a.via === 'letter') return h('div', row, h('small.hint', '✉ Лист іде через пошту сайту. Навчіть бота: 🎯 → вкладка «Листи» (кнопка-конверт, поле, «Надіслати»). Текст листа ШІ пише один раз — в анкеті, розділ «Лист».'));
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
      h('p.step-end', `Після кроку ${n} без відповіді чоловік зникає зі списку бота. Спроб написати: ${sc.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length}. Відповів — дивіться «Після відповіді» нижче.`));
  }

  const markPick = (list, label) => h('div.field', h('label', label), marks.length
    ? h('div.row-wrap', marks.map((mk) => h('label.check', h('input', { type: 'checkbox', checked: list.includes(mk.key), onchange: (e) => {
      const i = list.indexOf(mk.key);
      if (e.target.checked && i < 0) list.push(mk.key);
      if (!e.target.checked && i >= 0) list.splice(i, 1);
    } }), mk.name)))
    : h('small.hint', 'Ознак ще немає — навчіть у розширенні: 🎯 → «Кнопки й ознаки» (напр. «Онлайн»)'));

  const nameInput = opts.name !== undefined ? input('tplname', opts.name, { maxlength: 80, placeholder: 'Назва шаблону' }) : null;
  const choices = [['', '— вибрати шаблон —'], ...lib.presets.map((p) => [p.id, `⭐ ${p.name}`]), ...lib.templates.map((t) => [`t:${t.id}`, t.name])];
  let picked = '';
  const tplBar = h('div.tpl-bar',
    h('select', { 'aria-label': 'Шаблон', onchange: (e) => { picked = e.target.value; } }, choices.map(([v, l]) => h('option', { value: v }, l))),
    h('button.btn.sm', { type: 'button', onclick: async () => {
      const src = picked.startsWith('t:') ? lib.templates.find((t) => `t:${t.id}` === picked) : lib.presets.find((p) => p.id === picked);
      if (!src) { toast('Спочатку виберіть шаблон', 'warn'); return; }
      if (!(await confirmDialog(`Замінити кроки й налаштування на шаблон «${src.name}»? Збережеться після «Зберегти».`))) return;
      sc = clone(src.scenario);
      body.replaceWith(body = buildBody());
      renderSteps();
    } }, '⬇ Завантажити'),
    h('button.btn.sm', { type: 'button', onclick: () => saveAsTemplate() }, '💾 Зберегти як шаблон'));

  function saveAsTemplate() {
    const nm = input('n', '', { maxlength: 80, placeholder: 'напр. Активний з фото', required: true });
    const ok = h('button.btn.primary', 'Зберегти шаблон');
    const mm = modal({ title: 'Новий шаблон сценарію', body: h('div', field('Назва', nm), h('p.small.muted', 'Шаблон можна застосувати до будь-якого сайту або вибрати для окремої анкети.')), actions: [h('button.btn', { onclick: () => mm.close() }, 'Скасувати'), ok] });
    ok.addEventListener('click', () => busy(ok, async () => {
      if (!nm.value.trim()) throw new Error('Вкажіть назву');
      check();
      const r = await post('/api/scenarios', { name: nm.value.trim(), scenario: sc });
      lib.templates.push(r.template);
      toast(`Шаблон «${r.template.name}» збережено`);
      mm.close();
    }).catch(() => {}));
  }

  let body = buildBody();
  function buildBody() {
  const hm = sc.human;
  /** "from – to" seconds pair of hm.<name>From / hm.<name>To. */
  const range = (label, name, { min, max, empty }, hint) => field(label, h('div.pair',
    num(hm[`${name}From`], { min, max, placeholder: empty || 'від' }, (v) => { hm[`${name}From`] = v; }),
    num(hm[`${name}To`], { min, max, placeholder: empty || 'до' }, (v) => { hm[`${name}To`] = v; })), hint);
  const windowsText = (hm.windows?.length ? hm.windows : [[hm.hoursFrom, hm.hoursTo]])
    .map(([a, b]) => (a === b ? '0-24' : `${a}-${b}`)).join(', ');
  sc.afterReply ||= { attempts: 10, silenceHours: 48, everyHours: 48 };
  const ar = sc.afterReply;
  return h('div.scenario',
    nameInput ? field('Назва шаблону', nameInput) : null,
    h('p.muted.lead', 'Що бот робить з кожним чоловіком. Щойно він відповів — бот зупиняється, далі пише жива людина (а якщо чоловік знову замовк — бот нагадає).'),
    tplBar,
    h('h3', 'Кроки'),
    stepsBox,
    h('h3', 'Кому писати'),
    h('div.form-grid',
      field('Тільки країни', input('countries', sc.filters.countries, { placeholder: 'USA, Canada, UK — порожньо = усім', oninput: (e) => { sc.filters.countries = e.target.value; } })),
      field('Крім країн', input('excludeCountries', sc.filters.excludeCountries, { placeholder: 'напр. Nigeria', oninput: (e) => { sc.filters.excludeCountries = e.target.value; } })),
      markPick(sc.filters.needMarks, 'Писати тільки тим, у кого є'),
      markPick(sc.filters.skipMarks, 'Пропускати тих, у кого є'),
      h('small.hint.span-2', 'Вік чоловіків задається в анкеті (поля «Вік чоловіків від / до»).')),
    h('h3', 'Після відповіді'),
    h('p.small.muted', 'Відповів — пише жива людина. Якщо він знову замовк, бот сам нагадає про себе короткими повідомленнями. Кожна позитивна відповідь додає ще стільки ж спроб; «не цікаво» — бот більше не пише.'),
    h('div.form-grid',
      field('Спроб після відповіді', num(ar.attempts, { min: 0, max: 50 }, (v) => { ar.attempts = v ?? 0; }), '0 — не нагадувати'),
      field('Нагадати, якщо мовчить, год', num(ar.silenceHours, { min: 1, max: 720 }, (v) => { ar.silenceHours = v ?? 48; })),
      field('Далі кожні, год', num(ar.everyHours, { min: 1, max: 720 }, (v) => { ar.everyHours = v ?? 48; }))),
    h('h3', 'Розклад і темп — щоб не палити анкету'),
    h('div.form-grid',
      field('Робочі години', input('windows', windowsText, { placeholder: '9-13, 15-23', oninput: (e) => { hm.windows = e.target.value; } }),
        'Кілька вікон через кому, напр. 9-13, 15-23. Цілодобово: 0-24'),
      h('div.field', h('label', 'Робочі дні'), h('div.row-wrap', DAY_NAMES.map((name, i) => {
        hm.days ||= [1, 2, 3, 4, 5, 6, 7];
        return h('label.check', h('input', { type: 'checkbox', checked: hm.days.includes(i + 1), onchange: (e) => {
          hm.days = e.target.checked ? [...new Set([...hm.days, i + 1])].sort() : hm.days.filter((x) => x !== i + 1);
        } }), name);
      }))),
      h('label.check.span-2', h('input', { type: 'checkbox', checked: hm.spread !== false, onchange: (e) => { hm.spread = e.target.checked; } }),
        'Рівномірно на весь робочий день — денний ліміт розтягується до кінця робочого часу, а не витрачається за пів години'),
      h('small.hint.span-2', '⏰ Автопілот у розширенні сам вмикає бота в робочий час і вимикає після. Галочка «Автопілот» — у вікні розширення.'),
      field('Не більше повідомлень на годину', num(hm.perHour, { min: 0, max: 500 }, (v) => { hm.perHour = v ?? 0; }), '0 — без обмеження'),
      h('div.pair', field('Перерва кожні, повідомл.', num(hm.breakEvery, { min: 0, max: 500 }, (v) => { hm.breakEvery = v ?? 0; }), '0 — без перерв'),
        field('на, хв (від–до)', h('div.pair', num(hm.breakMinutes, { min: 1, max: 180 }, (v) => { hm.breakMinutes = v ?? 10; }), num(hm.breakMinutesTo ?? hm.breakMinutes, { min: 1, max: 240 }, (v) => { hm.breakMinutesTo = v ?? hm.breakMinutes; })))),
      h('label.check', h('input', { type: 'checkbox', checked: hm.typing, onchange: (e) => { hm.typing = e.target.checked; } }), 'Друкувати текст по літері, як людина'),
      field('Швидкість друку, знаків за хвилину', num(hm.typeSpeed ?? 600, { min: 60, max: 1500, step: 10 }, (v) => { hm.typeSpeed = v ?? 600; }), 'Довгий текст однаково друкується не довше ~25 с'),
      h('h4.span-2', '⏱ Паузи (секунди, кожен раз випадково між «від» і «до»)'),
      range('Між чоловіками', 'gap', { min: 5, max: 7200, empty: 'з анкети' }, 'Порожньо — як в анкеті (Розсилка → Пауза) або в Налаштуваннях'),
      range('Подумати перед текстом', 'think', { min: 0, max: 120 }, 'Після того, як відкрився його чат'),
      range('Між діями кроку', 'actionGap', { min: 0, max: 300 }, 'Напр. між лайком і повідомленням'),
      range('Перед наступною сторінкою', 'pageGap', { min: 0, max: 600 }),
      range('Реакція на підказку сайту', 'react', { min: 0, max: 1800 }, 'Сайт підкинув «напиши йому» — людина відкриває не за секунду'),
      field('Інколи просто гортати список, %', num(hm.idleChance ?? 30, { min: 0, max: 100, step: 5 }, (v) => { hm.idleChance = v ?? 0; }), 'Між чоловіками погортати й подивитись, як людина. 0 — ніколи'),
      h('small.hint.span-2', 'Час — за часовим поясом агенції. Пауза між чоловіками: якщо задана в анкеті — береться з анкети, інакше звідси, інакше з Налаштувань. Усі числа «гуляють» випадково, щоб не було рівного ритму.')));
  }

  function check() {
    if (sc.steps.some((s, i) => i > 0 && !s.actions.length)) throw new Error('У кроці немає жодної дії — додайте дію або видаліть крок');
    if (sc.steps.some((s) => s.actions.some((a) => a.do === 'click' && !a.action))) throw new Error('Виберіть кнопку для дії «Натиснути кнопку» (або навчіть кнопки в розширенні)');
    if (sc.steps.some((s) => s.actions.some((a) => a.do === 'message' && a.text === 'custom' && !String(a.custom || '').trim()))) throw new Error('Заповніть «Свій текст» або виберіть інше джерело тексту');
  }

  renderSteps();
  const wrap = h('div', body);
  const save = h('button.btn.primary', 'Зберегти');
  const m = modal({
    title: opts.title, body: wrap, wide: true,
    actions: [
      opts.reset ? h('button.btn.ghost.left', { onclick: async () => {
        if (!(await confirmDialog('Повернути стандартний сценарій: інвайт + 2 повторні через 24 і 48 год?'))) return;
        await opts.reset();
        toast('Повернуто стандартний сценарій');
        m.close();
        opts.onSaved?.();
      } }, 'Скинути до стандарту') : null,
      h('button.btn', { onclick: () => m.close() }, 'Скасувати'),
      save,
    ].filter(Boolean),
  });
  save.addEventListener('click', () => busy(save, async () => {
    check();
    if (nameInput && !nameInput.value.trim()) throw new Error('Вкажіть назву шаблону');
    await opts.save(sc, nameInput?.value.trim());
    toast('Збережено');
    m.close();
    opts.onSaved?.();
  }).catch(() => {}));
}
