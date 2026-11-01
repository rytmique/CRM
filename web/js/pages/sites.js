import { h, field, input, busy, toast, modal, confirmDialog, empty, safe } from '../ui.js';
import { get, post, put, del } from '../api.js';

export default async function sitesPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const { sites, fields, demoAvailable } = await get('/api/sites');
    page.replaceChildren(
      h('div.page-head', h('h1', 'Сайти'),
        h('div.row-wrap',
          demoAvailable && !sites.some((s) => s.name.startsWith('Демо')) ? h('button.btn', { onclick: safe(async () => { await post('/api/sites', { name: 'Демо-сайт (для тесту)', preset: 'demo' }); toast('Демо-сайт додано'); load(); }) }, '+ Демо-сайт') : null,
          h('button.btn.primary', { onclick: () => openForm(null, fields) }, '+ Додати сайт'))),
      h('p.muted.lead', 'Налаштування сайту — це CSS-селектори, за якими бот знаходить чоловіків, кнопку «Написати», поле вводу та вхідні. Один раз налаштували — працює для всіх анкет цього сайту.'),
      sites.length ? h('div.cards', sites.map((s) => h('article.card.site-card',
        h('div.row-wrap', h('h3', s.name), h('span.muted.small', `${s.profiles} анкет`)),
        h('div.small.muted', s.config.searchUrl || s.base_url || 'URL пошуку не вказано'),
        h('div.small', `Заповнено полів: ${Object.values(s.config).filter(Boolean).length} з ${fields.length}`),
        h('div.row-wrap', h('button.btn.sm', { onclick: () => openForm(s, fields) }, '✎ Налаштувати')))))
        : empty('Сайтів ще немає', h('button.btn.primary', { onclick: () => openForm(null, fields) }, '+ Додати сайт')));
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
      h('p.small.muted.span-2', 'Формат витягування даних: «.name» — текст елемента; «.link@href» — атрибут елемента; «@data-id» — атрибут самої картки. Перевірити налаштування можна кнопкою 🔍 у розширенні, відкривши сторінку пошуку.'));
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
