import { h, field, input, formData, busy, toast, modal, confirmDialog, badge, empty, fmtInt, ago, safe } from '../ui.js';
import { get, post, patch, del } from '../api.js';

export default async function operatorsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const { operators } = await get('/api/operators');
    page.replaceChildren(
      h('div.page-head', h('h1', 'Оператори', h('span.count', fmtInt(operators.length))), h('button.btn.primary', { onclick: () => openForm() }, '+ Додати оператора')),
      h('p.muted.lead', 'Оператор входить у розширення під своїм логіном і запускає бота для призначених йому анкет.'),
      h('div.card.table-wrap', operators.length ? h('table.table.hover',
        h('thead', h('tr', h('th', 'Оператор'), h('th', 'Логін'), h('th.num', 'Анкет'), h('th.num', 'Ботів онлайн'), h('th.num', 'Інвайтів сьогодні'), h('th.num', 'Відповідей сьогодні'), h('th', 'Останній вхід'), h('th', 'Статус'))),
        h('tbody', operators.map((o) => h('tr', { onclick: () => openForm(o), tabindex: 0 },
          h('td', h('b', o.name), o.tg_chat_id ? h('div.small.muted', `Telegram: ${o.tg_chat_id}`) : null),
          h('td', o.email),
          h('td.num', fmtInt(o.profiles)),
          h('td.num', o.bots_online ? badge(`● ${o.bots_online}`, 'ok') : h('span.muted', '0')),
          h('td.num', fmtInt(o.sent_today)),
          h('td.num', fmtInt(o.replies_today)),
          h('td', ago(o.last_login_at)),
          h('td', o.active ? badge('Активний', 'ok') : badge('Вимкнено', 'muted'))))))
        : h('div.empty', h('p', 'Операторів ще немає.'), h('button.btn.primary', { onclick: () => openForm() }, '+ Додати оператора'))));
  }

  function openForm(o = null) {
    const form = h('form.form-grid',
      field('Ім’я *', input('name', o?.name, { required: true })),
      field('Email / логін *', input('email', o?.email, { required: true, autocomplete: 'off' })),
      field(o ? 'Новий пароль' : 'Пароль *', input('password', '', { type: 'text', minlength: 6, required: !o, autocomplete: 'new-password', placeholder: o ? 'залиште порожнім, щоб не міняти' : 'мінімум 6 символів' })),
      field('Telegram chat id', input('tg_chat_id', o?.tg_chat_id), 'Куди слати сповіщення про відповіді'),
      o ? h('label.check.span-2', h('input', { type: 'checkbox', name: 'active', checked: Boolean(o.active) }), 'Активний (вимкнений не зможе увійти)') : null);
    const save = h('button.btn.primary', o ? 'Зберегти' : 'Створити');
    const actions = [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save];
    if (o) actions.unshift(h('button.btn.danger.ghost.left', { onclick: safe(async () => {
      if (!(await confirmDialog(`Видалити оператора «${o.name}»? Його анкети залишаться без оператора.`, { ok: 'Видалити', danger: true }))) return;
      await del(`/api/operators/${o.id}`);
      toast('Оператора видалено');
      m.close();
      load();
    }) }, 'Видалити'));
    const m = modal({ title: o ? `Оператор: ${o.name}` : 'Новий оператор', body: form, actions });
    const submit = () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const data = formData(form);
      if (o && !data.password) delete data.password;
      if (o) await patch(`/api/operators/${o.id}`, data);
      else await post('/api/operators', data);
      toast(o ? 'Збережено' : 'Оператора створено. Передайте йому логін і пароль для розширення.');
      m.close();
      load();
    }).catch(() => {});
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  await load();
}
