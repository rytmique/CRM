import { h, busy, toast, modal, badge, fmtInt, safe } from '../ui.js';
import { get, patch } from '../api.js';
import { monthOptions, monthName, tiersText } from './billing.js';

const money = (x, cur) => `${(Math.round((x || 0) * 100) / 100).toLocaleString('uk-UA', { maximumFractionDigits: 2 })} ${cur}`;

/** Platform admin: what each agency owes for the bot this month, and the % scale agreed with it. */
export default async function adminBillingPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  let month = monthOptions()[0];

  async function load() {
    const [r, refs] = await Promise.all([get(`/api/admin/billing?month=${month}`), get(`/api/admin/referrals?month=${month}`).catch(() => null)]);
    render(r, refs);
  }

  function editDeal(a) {
    const rows = h('div.tier-list');
    const addRow = (t = { from: 0, pct: 5 }) => rows.append(h('div.tier-row',
      h('span', 'від'), h('input', { type: 'number', min: 0, value: t.from, 'data-f': 'from' }), h('span', `${a.billing.currency} —`),
      h('input', { type: 'number', min: 0, max: 100, step: '0.1', value: t.pct, 'data-f': 'pct' }), h('span', '%'),
      h('button.icon-btn', { type: 'button', title: 'Прибрати', onclick: (e) => e.target.closest('.tier-row').remove() }, '✕')));
    a.billing.tiers.forEach(addRow);
    const prorate = h('input', { type: 'checkbox', checked: a.billing.prorate });
    const steps = h('input', { type: 'checkbox', checked: a.billing.mode !== 'whole' });
    const ok = h('button.btn.primary', 'Зберегти');
    const m = modal({
      title: `Угода: ${a.name}`,
      body: h('div',
        h('p.small.muted', 'Процент від заробітку оператора. Стандарт: 5% до $5 000 і 7,5% з того, що вище.'),
        rows, h('button.btn.sm.ghost', { type: 'button', onclick: () => addRow({ from: '', pct: '' }) }, '+ поріг'),
        h('label.check', steps, h('span', h('b', 'Сходинками'), ' — кожна частина суми за своїм % (як податок, без стрибка на порозі). Без галочки — уся сума за % порогу, якого досягла.')),
        h('label.check', prorate, 'Лише за час, коли бот реально працював (без простоїв)')),
      actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok],
    });
    ok.addEventListener('click', () => busy(ok, async () => {
      const tiers = [...rows.querySelectorAll('.tier-row')].map((r) => ({ from: Number(r.querySelector('[data-f=from]').value) || 0, pct: Number(r.querySelector('[data-f=pct]').value) || 0 }));
      await patch(`/api/admin/agencies/${a.id}`, { billing: { tiers, prorate: prorate.checked, mode: steps.checked ? 'marginal' : 'whole' } });
      toast('Угоду збережено');
      m.close();
      load();
    }).catch(() => {}));
  }

  function render(r, refs) {
    const sel = h('select', { onchange: (e) => { month = e.target.value; load(); }, 'aria-label': 'Місяць' },
      monthOptions().map((m) => h('option', { value: m, selected: m === month }, monthName(m))));
    page.replaceChildren(
      h('div.page-head', h('h1', '💰 Оплата за бота'), sel),
      h('p.small.muted', 'Скільки кожна агенція винна за бота за місяць. «≈» — заробіток ще орієнтовний: оператори введуть точну суму в кінці місяця.'),
      h('section.card.table-wrap', r.agencies.length ? h('table.table',
        h('thead', h('tr', h('th', 'Агенція'), h('th', 'Угода'), h('th.num', 'Годин бота'), h('th.num', 'Відповідей'), h('th.num', 'Заробіток'), h('th.num', 'До оплати'), h('th', ''))),
        h('tbody', r.agencies.map((a) => h('tr',
          h('td', h('b', a.name), a.active ? null : badge('призупинено', 'muted')),
          h('td.small', tiersText(a.billing.tiers, a.billing.currency, a.billing.mode), a.billing.prorate ? h('div.muted', 'лише час роботи бота') : null),
          h('td.num', fmtInt(Math.round(a.activeHours))),
          h('td.num', fmtInt(a.replies)),
          h('td.num', `${a.estimated ? '≈ ' : ''}${money(a.earnings, a.billing.currency)}`),
          h('td.num', h('b', money(a.fee, a.billing.currency))),
          h('td', h('button.btn.sm', { onclick: safe(() => editDeal(a)) }, '% Угода'))))))
        : h('p.muted', 'Агенцій ще немає.')),
      refs ? h('section.card.stack',
        h('h3', '🎁 Рефералка за місяць'),
        h('p.small.muted', 'Хто привів команди й соло-операторів: 10% від їхніх оплат 6 місяців. Спершу це знижка з власної оплати людини, решта — виплата, яку віддаєш ти.'),
        refs.rows.length ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Хто привів'), h('th', 'Кого'), h('th.num', 'Винагорода'), h('th.num', 'Знижкою'), h('th.num', 'Виплатити'))),
          h('tbody', refs.rows.map((x) => h('tr',
            h('td', h('b', x.name), h('div.small.muted', x.team || '')),
            h('td.small', x.teams.map((t) => `${t.name}${t.solo ? ' (соло)' : ''}${t.active ? ` · міс. ${t.monthNo}` : ''}`).join(', ') || '—'),
            h('td.num', money(x.reward, '$')),
            h('td.num', money(x.discount, '$')),
            h('td.num', h('b', money(x.payout, '$'))))))))
          : h('p.muted', 'Ще ніхто нікого не привів.')) : null);
  }

  await load();
}
