import { h, busy, toast, modal, badge, fmtInt, safe } from '../ui.js';
import { get, put } from '../api.js';

const money = (x, cur) => `${(Math.round((x || 0) * 100) / 100).toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${cur}`;
const pct = (x) => `${Math.round((x || 0) * 1000) / 10}%`;

/** Months to choose from: this one and 11 before it. */
export function monthOptions() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 12; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}
export const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });

export function tiersText(tiers, cur) {
  if (tiers.length === 1) return `${tiers[0].pct}%`;
  return tiers.map((t, i) => (i === 0 ? `до ${fmtInt(tiers[1].from)} ${cur} — ${t.pct}%` : `від ${fmtInt(t.from)} ${cur} — ${t.pct}%`)).join(' · ');
}

/** "Оплата за бота": owner — every operator; operator — themself. */
export default async function billingPage(main, { user }) {
  const owner = user.role === 'owner';
  const page = h('div.page');
  main.replaceChildren(page);
  let month = monthOptions()[0];

  async function load() { render(await get(`/api/billing?month=${month}`)); }

  function enterEarnings(row, cur) {
    const amount = h('input', { type: 'number', min: 0, step: '0.01', value: row.estimated ? '' : row.earnings, placeholder: `напр. ${Math.round(row.earnings) || 1000}` });
    const note = h('input', { maxlength: 200, value: row.note || '', placeholder: 'Коментар (необов’язково)' });
    const ok = h('button.btn.primary', 'Зберегти');
    const clear = h('button.btn.ghost.left', { hidden: row.estimated }, 'Повернути орієнтовну');
    const m = modal({
      title: `Заробіток за ${monthName(month)} — ${row.name}`,
      body: h('div', h('p.small.muted', 'Скільки оператор реально заробив за місяць. До того система рахує орієнтовно за відповідями на інвайти.'),
        h('div.field', h('label', `Сума, ${cur}`), amount), h('div.field', h('label', 'Коментар'), note)),
      actions: [clear, h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok],
    });
    ok.addEventListener('click', () => busy(ok, async () => {
      render(await put('/api/billing/earnings', { month, amount: amount.value, note: note.value, operator_id: row.user_id }));
      toast('Збережено');
      m.close();
    }).catch(() => {}));
    clear.addEventListener('click', () => busy(clear, async () => {
      render(await put('/api/billing/earnings', { month, amount: null, operator_id: row.user_id }));
      m.close();
    }).catch(() => {}));
  }

  function render(rep) {
    const cur = rep.billing.currency;
    const sel = h('select', { onchange: (e) => { month = e.target.value; load(); }, 'aria-label': 'Місяць' },
      monthOptions().map((m) => h('option', { value: m, selected: m === month }, monthName(m))));
    const rows = rep.rows;
    page.replaceChildren(...[
      h('div.page-head', h('h1', owner ? '💰 Оплата за бота' : '💰 Мій заробіток і бот'), sel),
      h('div.callout',
        h('b', `Оплата за бота: ${tiersText(rep.billing.tiers, cur)} від заробітку оператора`),
        rep.billing.prorate ? ' — лише за час, коли бот реально працював (без простоїв, ночі, очікування й капчі).' : '.',
        ' До кінця місяця заробіток рахується ', h('b', 'орієнтовно'), ' за відповідями на інвайти; в кінці місяця оператор вводить точну суму.'),
      owner ? h('div.stat-row',
        h('div', h('b', money(rep.totals.earnings, cur)), h('span', 'заробіток операторів')),
        h('div', h('b', money(rep.totals.fee, cur)), h('span', 'оплата за бота')),
        h('div', h('b', fmtInt(Math.round(rep.totals.activeHours))), h('span', 'годин роботи бота')),
        h('div', h('b', fmtInt(rep.totals.replies)), h('span', 'відповідей'))) : null,
      h('section.card.table-wrap', rows.length ? h('table.table',
        h('thead', h('tr', h('th', 'Оператор'), h('th.num', 'Інвайтів'), h('th.num', 'Відповідей'), h('th.num', 'Бот працював'), h('th.num', 'Заробіток'), h('th.num', '%'), h('th.num', 'Оплата за бота'), h('th', ''))),
        h('tbody', rows.map((r) => h('tr',
          h('td', h('b', r.name), r.role === 'owner' ? h('div.small.muted', 'керівник') : null),
          h('td.num', fmtInt(r.sent)),
          h('td.num', fmtInt(r.replies), r.sent ? h('div.small.muted', pct(r.replies / r.sent)) : null),
          h('td.num', `${r.activeHours} год`, rep.billing.prorate ? h('div.small.muted', `${pct(r.share)} з ${Math.round(r.schedHours)} год графіка`) : null),
          h('td.num', money(r.earnings, cur), r.estimated
            ? h('div.small.muted', `≈ орієнтовно: ${r.replies} × ${money(r.perReply, cur)}${r.perReplyLearned ? ' (з минулих місяців)' : ''}`)
            : h('div', badge('введено', 'ok'))),
          h('td.num', `${r.pct}%`),
          h('td.num', h('b', money(r.fee, cur))),
          h('td', h('button.btn.sm', { onclick: safe(() => enterEarnings(r, cur)) }, r.estimated ? 'Ввести заробіток' : '✎'))))))
        : h('p.muted', 'Ще немає операторів, які запускали бота.')),
      h('p.small.muted', `Як рахується: заробіток × % зі шкали${rep.billing.prorate ? ' × частка часу, коли бот реально працював, від годин його графіка за місяць (Сайти → ⚙ Сценарій)' : ''}. Шкалу % встановлює постачальник софту.`),
    ].filter(Boolean));
  }

  await load();
}
