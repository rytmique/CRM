import { h, field, input, busy, toast, modal, confirmDialog, empty, safe } from '../ui.js';
import { get, post, put, del } from '../api.js';
import { openScenario, openScenarioEditor, scenarioSummary, unionLists } from './scenario.js';

export default async function sitesPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const [{ sites, fields, demoAvailable }, lib] = await Promise.all([get('/api/sites'), get('/api/scenarios')]);
    const editTemplate = (t) => openScenarioEditor({
      title: t ? `Шаблон: ${t.name}` : 'Новий шаблон сценарію',
      name: t?.name || '',
      scenario: t?.scenario || lib.presets[0].scenario,
      taught: unionLists(sites, 'actions'),
      marks: unionLists(sites, 'marks'),
      save: (sc, name) => (t ? put(`/api/scenarios/${t.id}`, { name, scenario: sc }) : post('/api/scenarios', { name, scenario: sc })),
      onSaved: load,
    });
    const templates = h('section.card.templates',
      h('div.row-wrap', h('h3', 'Шаблони сценаріїв'), h('button.btn.sm.right-push', { onclick: () => editTemplate(null) }, '+ Новий шаблон')),
      h('p.small.muted', 'Збережені сценарії: застосуйте до сайту (⚙ Сценарій → вибрати шаблон) або виберіть для окремої анкети (Анкета → Редагувати → Сценарій). ⭐ — готові шаблони.'),
      lib.templates.length ? h('ul.tpl-list', lib.templates.map((t) => h('li',
        h('div', h('b', t.name), h('div.small.muted', scenarioSummary(t.scenario), t.profiles ? ` · анкет: ${t.profiles}` : '')),
        h('div.row-wrap',
          h('button.btn.sm', { onclick: () => editTemplate(t) }, '✎ Змінити'),
          h('button.btn.sm.ghost', { onclick: safe(async () => {
            if (!(await confirmDialog(`Видалити шаблон «${t.name}»?${t.profiles ? ` ${t.profiles} анкет повернуться до сценарію сайту.` : ''}`, { ok: 'Видалити', danger: true }))) return;
            await del(`/api/scenarios/${t.id}`);
            toast('Шаблон видалено');
            load();
          }) }, '✕')))))
        : h('p.small.muted', 'Своїх шаблонів ще немає. Відкрийте ⚙ Сценарій сайту → «💾 Зберегти як шаблон» або натисніть «+ Новий шаблон».'));
    page.replaceChildren(
      h('div.page-head', h('h1', 'Сайти'),
        h('div.row-wrap',
          demoAvailable && !sites.some((s) => s.name.startsWith('Демо')) ? h('button.btn', { onclick: safe(async () => { await post('/api/sites', { name: 'Демо-сайт (для тесту)', preset: 'demo' }); toast('Демо-сайт додано'); load(); }) }, '+ Демо-сайт') : null,
          h('button.btn.primary', { onclick: () => openForm(null, fields) }, '+ Додати сайт'))),
      h('div.callout',
        h('b', '🎯 Найпростіше — навчити бота кліками.'),
        ' Відкрийте сайт знайомств, натисніть значок розширення → «🎯 Навчити бота на цьому сайті» і клікайте по картці чоловіка, кнопці «Написати», полю вводу. Ручне налаштування нижче — для тонких правок.'),
      sites.length ? h('div.cards', sites.map((s) => {
        const filled = fields.filter((f) => s.config[f.key]).length;
        const ready = fields.filter((f) => f.required).every((f) => s.config[f.key]);
        return h('article.card.site-card',
          h('div.row-wrap', h('h3', s.name), h('span.muted.small', `${s.profiles} анкет`)),
          h('div.small.muted', s.config.searchUrl || s.base_url || 'URL пошуку не вказано'),
          h('div.small', ready ? '✓ ' : '⚠ ', `Налаштовано полів: ${filled} з ${fields.length}`,
            (s.config.actions || []).length ? ` · кнопок: ${s.config.actions.map((a) => a.name).join(', ')}` : '',
            (s.config.marks || []).length ? ` · ознак: ${s.config.marks.map((a) => a.name).join(', ')}` : ''),
          h('div.small', h('b', 'Сценарій: '), scenarioSummary(s.scenario), s.customScenario ? '' : h('span.muted', ' (стандарт)')),
          h('div.row-wrap',
            h('button.btn.sm.primary', { onclick: () => openScenario(s, load) }, '⚙ Сценарій'),
            h('button.btn.sm', { onclick: () => openForm(s, fields) }, '✎ Налаштувати вручну')));
      }))
        : empty('Сайтів ще немає', h('button.btn.primary', { onclick: () => openForm(null, fields) }, '+ Додати сайт')),
      templates);
  }

  /** Editable list of taught buttons / marks: name + selector (+ where for buttons). */
  function listBox(kind, list) {
    const isAct = kind === 'actions';
    const rows = h('div.taught-list');
    const addRow = (it = { key: '', name: '', sel: '', where: 'card' }) => {
      const row = h('div.taught-row', { 'data-kind': kind, 'data-key': it.key },
        h('input', { 'data-f': 'name', value: it.name, placeholder: isAct ? 'Лайк' : 'Онлайн', 'aria-label': 'Назва' }),
        h('input.mono', { 'data-f': 'sel', value: it.sel, placeholder: isAct ? '.btn-like' : '.online', spellcheck: 'false', 'aria-label': 'Селектор' }),
        isAct ? h('select', { 'data-f': 'where', 'aria-label': 'Де' }, h('option', { value: 'card', selected: it.where !== 'page' }, 'у картці'), h('option', { value: 'page', selected: it.where === 'page' }, 'на його сторінці')) : null,
        h('button.icon-btn', { type: 'button', title: 'Видалити', onclick: () => row.remove() }, '✕'));
      rows.append(row);
    };
    list.forEach(addRow);
    return h('div.span-2.field', h('label', isAct ? 'Кнопки' : 'Ознаки'), rows,
      h('button.btn.sm.ghost', { type: 'button', onclick: () => addRow() }, isAct ? '+ кнопка' : '+ ознака'));
  }

  function readLists(form) {
    const out = { actions: [], marks: [] };
    for (const row of form.querySelectorAll('.taught-row')) {
      const f = (n) => row.querySelector(`[data-f=${n}]`)?.value.trim() || '';
      const name = f('name');
      const sel = f('sel');
      if (!sel) continue;
      const base = (row.dataset.key || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || row.dataset.kind.slice(0, 3)).slice(0, 16);
      let key = base;
      let i = 2;
      while (out[row.dataset.kind].some((x) => x.key === key)) key = `${base}-${i++}`;
      out[row.dataset.kind].push(row.dataset.kind === 'actions' ? { key, name: name || key, sel, where: f('where') || 'card' } : { key, name: name || key, sel });
    }
    return out;
  }

  function openForm(s, fields) {
    const groups = {};
    for (const f of fields) (groups[f.group] ||= []).push(f);
    const form = h('form.form-grid',
      field('Назва *', input('name', s?.name, { required: true })),
      field('Адреса сайту', input('base_url', s?.base_url, { placeholder: 'https://site.com' })),
      Object.entries(groups).map(([g, list]) => [
        h('h4.span-2', g),
        list.map((f) => field(`${f.label}${f.required ? ' *' : ''}`, input(`cfg.${f.key}`, s?.config?.[f.key], { required: Boolean(f.required), class: 'mono', spellcheck: 'false' }), f.hint)),
      ]),
      h('h4.span-2', 'Кнопки (лайк, підморгнути…) і ознаки в картці (онлайн…)'),
      h('p.small.muted.span-2', 'Зазвичай їх додають кліками в розширенні (🎯 → «Кнопки й ознаки»). Тут можна перейменувати або видалити.'),
      listBox('actions', s?.config?.actions || []),
      listBox('marks', s?.config?.marks || []),
      h('p.small.muted.span-2', 'Формат витягування даних: «.name» — текст елемента; «.link@href» — атрибут елемента; «@data-id» — атрибут самої картки. Можна писати button:has-text("Like") і кілька варіантів через кому. Перевірити — кнопкою 🧪 тест у розширенні.'));
    const save = h('button.btn.primary', 'Зберегти');
    const actions = [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save];
    if (s) actions.unshift(h('button.btn.danger.ghost.left', { onclick: safe(async () => {
      if (!(await confirmDialog(`Видалити сайт «${s.name}»? В анкетах цього сайту треба буде вибрати інший.`, { ok: 'Видалити', danger: true }))) return;
      await del(`/api/sites/${s.id}`);
      m.close();
      load();
    }) }, 'Видалити'));
    const m = modal({ title: s ? `Сайт: ${s.name}` : 'Новий сайт', body: form, wide: true, actions });
    const submit = () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const config = {};
      let name = '', baseUrl = '';
      for (const el of form.querySelectorAll('[name]')) {
        if (el.name.startsWith('cfg.')) config[el.name.slice(4)] = el.value.trim();
        else if (el.name === 'name') name = el.value;
        else if (el.name === 'base_url') baseUrl = el.value;
      }
      Object.assign(config, readLists(form));
      if (s) await put(`/api/sites/${s.id}`, { name, base_url: baseUrl, config });
      else await post('/api/sites', { name, base_url: baseUrl, config });
      toast('Збережено');
      m.close();
      load();
    }).catch(() => {});
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  await load();
}
