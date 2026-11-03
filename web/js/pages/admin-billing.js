import { h, busy, toast, modal, badge, fmtInt, safe } from '../ui.js';
import { get, patch } from '../api.js';
import { monthOptions, monthName, tiersText } from './billing.js';

const money = (x, cur) => `${(Math.round((x || 0) * 100) / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} ${cur}`;

/** Platform admin: what each agency owes for the bot this month, and the % scale agreed with it. */
export default async function adminBillingPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  let month = monthOptions()[0];

  async function load() { render(await get(`/api/admin/billing?month=${month}`)); }

  function editDeal(a) {
    const rows = h('div.tier-list');
    const addRow = (t = { from: 0, pct: 5 }) => rows.append(h('div.tier-row',
      h('span', 'від'), h('input', { type: 'number', min: 0, value: t.from, 'data-f': 'from' }), h('span', `${a.billing.currency} —`),
      h('input', { type: 'number', min: 0, max: 100, step: '0.1', value: t.pct, 'data-f': 'pct' }), h('span', '%'),
      h('button.icon-btn', { type: 'button', title: 'Прибрати', onclick: (e) => e.target.closest('.tier-row').remove() }, '✕')));
    a.billing.tiers.forEach(addRow);
    const prorate = h('input', { type: 'checkbox', checked: a.billing.prorate });
    const ok = h('button.btn.primary', 'Зберегти');
    const m = modal({
      title: `Угода: ${a.name}`,
      body: h('div',
        h('p.small.muted', 'Процент від заробітку оператора. Що більша сума за місяць — то більший %: уся сума рахується за % того порогу, якого вона досягла.'),
        rows, h('button.btn.sm.ghost', { type: 'button', onclick: () => addRow({ from: '', pct: '' }) }, '+ поріг'),
        h('label.check', prorate, 'Лише за час, коли бот реально працював (без простоїв)')),
      actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok],
    });
    ok.addEventListener('click', () => busy(ok, async () => {
      const tiers = [...rows.querySelectorAll('.tier-row')].map((r) => ({ from: Number(r.querySelector('[data-f=from]').value) || 0, pct: Number(r.querySelector('[data-f=pct]').value) || 0 }));
      await patch(`/api/admin/agencies/${a.id}`, { billing: { tiers, prorate: prorate.checked } });
      toast('Угоду збережено');
      m.close();
      load();
    }).catch(() => {}));
  }

  function render(r) {
    const sel = h('select', { onchange: (e) => { month = e.target.value; load(); }, 'aria-label': 'Місяць' },
      monthOptions().map((m) => h('option', { value: m, selected: m === month }, monthName(m))));
    page.replaceChildren(
      h('div.page-head', h('h1', '💰 Оплата за бота'), sel),
      h('p.small.muted', 'Скільки кожна агенція винна за бота за місяць. «≈» — заробіток ще орієнтовний: оператори введуть точну суму в кінці місяця.'),
      h('section.card.table-wrap', r.agencies.length ? h('table.table',
        h('thead', h('tr', h('th', 'Агенція'), h('th', 'Угода'), h('th.num', 'Годин бота'), h('th.num', 'Відповідей'), h('th.num', 'Заробіток'), h('th.num', 'До оплати'), h('th', ''))),
        h('tbody', r.agencies.map((a) => h('tr',
          h('td', h('b', a.name), a.active ? null : badge('призупинено', 'muted')),
          h('td.small', tiersText(a.billing.tiers, a.billing.currency), a.billing.prorate ? h('div.muted', 'лише час роботи бота') : null),
          h('td.num', fmtInt(Math.round(a.activeHours))),
          h('td.num', fmtInt(a.replies)),
          h('td.num', `${a.estimated ? '≈ ' : ''}${money(a.earnings, a.billing.currency)}`),
          h('td.num', h('b', money(a.fee, a.billing.currency))),
          h('td', h('button.btn.sm', { onclick: safe(() => editDeal(a)) }, '% Угода'))))))
        : h('p.muted', 'Агенцій ще немає.')));
  }

  await load();
}
