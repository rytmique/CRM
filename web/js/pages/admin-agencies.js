import { h, field, input, formData, busy, toast, modal, badge, empty, fmtInt, fmtDate, copy, safe } from '../ui.js';
import { get, post, patch } from '../api.js';

export function showKeys(keys) {
  const text = keys.join('\n');
  modal({
    title: `Видано ключів: ${keys.length}`,
    body: h('div', h('p.small.muted', 'Ключі вже з’явилися в розділі «Ліцензії» агенції. Керівник прив’язує їх до анкет.'), h('pre.keys', text)),
    actions: [h('button.btn.primary', { onclick: () => copy(text) }, 'Скопіювати всі')],
  });
}

export default async function adminAgencies(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const { agencies } = await get('/api/admin/agencies');
    page.replaceChildren(
      h('div.page-head', h('h1', 'Агенції', h('span.count', fmtInt(agencies.length))), h('button.btn.primary', { onclick: openForm }, '+ Нова агенція')),
      h('div.card.table-wrap', agencies.length ? h('table.table',
        h('thead', h('tr', h('th', 'Агенція'), h('th', 'Керівник'), h('th.num', 'Операторів'), h('th.num', 'Анкет'), h('th.num', 'Діючих ліцензій'), h('th.num', 'Інвайтів за 30 дн'), h('th', 'Створено'), h('th', 'Статус'))),
        h('tbody', agencies.map((a) => h('tr',
          h('td', h('b', a.name)),
          h('td', a.owner_email || '—'),
          h('td.num', fmtInt(a.operators)),
          h('td.num', fmtInt(a.profiles)),
          h('td.num', fmtInt(a.licenses_live)),
          h('td.num', fmtInt(a.sent_30d)),
          h('td', fmtDate(a.created_at, false)),
          h('td', h('button.btn.sm', { onclick: safe(async () => {
            await patch(`/api/admin/agencies/${a.id}`, { active: !a.active });
            toast(a.active ? 'Агенцію призупинено' : 'Агенцію активовано');
            load();
          }) }, a.active ? badge('Активна', 'ok') : badge('Призупинена', 'err'))))))) : empty('Агенцій ще немає. Створіть першу — керівник отримає доступ до панелі.')));
  }

  function openForm() {
    const form = h('form.form-grid',
      h('div.span-2', field('Назва агенції *', input('name', '', { required: true }))),
      field('Ім’я керівника *', input('ownerName', '', { required: true })),
      field('Email керівника (логін) *', input('ownerEmail', '', { required: true, type: 'email' })),
      field('Пароль керівника *', input('ownerPassword', '', { required: true, minlength: 8, autocomplete: 'new-password' }), 'Мінімум 8 символів'),
      h('div.pair', field('Ліцензій одразу', input('licenses', 0, { type: 'number', min: 0, max: 500 })), field('днів кожна', input('days', 30, { type: 'number', min: 1, max: 3650 }))));
    const save = h('button.btn.primary', 'Створити');
    const m = modal({ title: 'Нова агенція', body: form, actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save] });
    const submit = () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const r = await post('/api/admin/agencies', formData(form));
      m.close();
      toast('Агенцію створено');
      load();
      if (r.keys.length) showKeys(r.keys);
    }).catch(() => {});
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  await load();
}
