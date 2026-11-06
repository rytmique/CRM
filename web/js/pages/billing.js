import { h, busy, toast, modal, badge, fmtInt, safe, copy } from '../ui.js';
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

/** "5% до 5 000 $ · 7,5% з того, що вище" (steps) or the old "whole sum at its tier". */
export function tiersText(tiers, cur, mode = 'marginal') {
  const n = (x) => String(x).replace('.', ',');
  if (tiers.length === 1) return `${n(tiers[0].pct)}%`;
  if (mode === 'marginal') {
    return tiers.map((t, i) => (i === 0 ? `${n(t.pct)}% до ${fmtInt(tiers[1].from)} ${cur}` : `${n(t.pct)}% з того, що вище ${fmtInt(t.from)} ${cur}`)).join(' · ');
  }
  return tiers.map((t, i) => (i === 0 ? `до ${fmtInt(tiers[1].from)} ${cur} — ${n(t.pct)}%` : `від ${fmtInt(t.from)} ${cur} — ${n(t.pct)}% на всю суму`)).join(' · ');
}

/** 🎁 The referral card: my link, the message to send, who I brought and what it gives me this month. */
function referralCard(ref, cur) {
  const url = `${location.origin}/#/join/r-${ref.code}`;
  const message = `Привіт! Є бот для операторів на сайтах знайомств: сам пише новим чоловікам у людському темпі, а ти працюєш з тими, хто відповів.\nРеєструйся за моїм посиланням (і командою, і соло — сам по собі):\n${url}\nНалаштування бота на твоєму сайті — безкоштовно.`;
  const active = ref.reward.teams.filter((t) => t.active);
  return h('section.card.stack',
    h('h3', '🎁 Рефералка'),
    h('p.small.muted', `Приведи команду або оператора, що працює сам, — отримуй ${ref.pct}% від їхніх оплат за бота ${ref.months} місяців. Спершу це знижка з твоєї оплати, а що лишиться — виплата грошима. Їм — налаштування бота безкоштовно.`),
    h('div.link-box', h('input', { value: url, readonly: true, 'aria-label': 'Реферальне посилання', onclick: (e) => e.target.select() }),
      h('button.btn.primary', { onclick: () => copy(message) }, 'Скопіювати повідомлення'),
      h('button.btn', { onclick: () => copy(url) }, 'Лише посилання')),
    ref.reward.teams.length || ref.waiting.length ? h('table.table',
      h('thead', h('tr', h('th', 'Кого привів'), h('th', 'Стан'), h('th.num', 'Платять за місяць'), h('th.num', `Тобі ${ref.pct}%`))),
      h('tbody',
        ...ref.waiting.map((w) => h('tr', h('td', w.name, w.solo ? ' ' : null, w.solo ? badge('соло', 'info') : null), h('td', badge('чекає підтвердження', 'warn')), h('td.num', '—'), h('td.num', '—'))),
        ...ref.reward.teams.map((t) => h('tr',
          h('td', t.name, t.solo ? ' ' : null, t.solo ? badge('соло', 'info') : null),
          h('td', t.active ? badge(`місяць ${t.monthNo} з ${ref.months}`, 'ok') : t.monthNo > ref.months ? badge('бонус завершено', 'muted') : badge('ще не почалось', 'muted')),
          h('td.num', money(t.fee, cur)),
          h('td.num', h('b', money(t.reward, cur)))))))
      : h('p.small.muted', 'Ще нікого. Скинь посилання знайомим тімлідам і операторам.'),
    active.length ? h('p', h('b', `Цього місяця тобі: ${money(ref.reward.total, cur)}`)) : null);
}

/** "Оплата за бота": owner — every operator; operator — themself. */
export default async function billingPage(main, { user }) {
  const owner = user.role === 'owner';
  const page = h('div.page');
  main.replaceChildren(page);
  let month = monthOptions()[0];

  let ref = null;
  async function load() {
    const [rep, r] = await Promise.all([get(`/api/billing?month=${month}`), get(`/api/billing/referrals?month=${month}`).catch(() => null)]);
    ref = r;
    render(rep);
  }

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
        h('b', `Оплата за бота: ${tiersText(rep.billing.tiers, cur, rep.billing.mode)} від заробітку оператора`),
        rep.billing.prorate ? ' — лише за час, коли бот реально працював (без простоїв, ночі, очікування й капчі).' : '.',
        ' До кінця місяця заробіток рахується ', h('b', 'орієнтовно'), ' за відповідями на інвайти; в кінці місяця оператор вводить точну суму.'),
      owner ? h('div.stat-row',
        h('div', h('b', money(rep.totals.earnings, cur)), h('span', 'заробіток операторів')),
        h('div', h('b', money(rep.totals.fee, cur)), h('span', 'оплата за бота')),
        h('div', h('b', fmtInt(Math.round(rep.totals.activeHours))), h('span', 'годин роботи бота')),
        h('div', h('b', fmtInt(rep.totals.replies)), h('span', 'відповідей'))) : null,
      h('section.card.table-wrap', rows.length ? h('table.table',
        h('thead', h('tr', h('th', 'Оператор'), h('th.num', 'Інвайтів'), h('th.num', 'Відповідей'), h('th.num', 'Бот працював'), h('th.num', 'Заробіток'), h('th.num', '%'), h('th.num', 'Оплата за бота'), rep.totals.refDiscount ? h('th.num', '🎁 Знижка') : null, rep.totals.refDiscount ? h('th.num', 'До сплати') : null, h('th', ''))),
        h('tbody', rows.map((r) => h('tr',
          h('td', h('b', r.name), r.role === 'owner' ? h('div.small.muted', 'керівник') : null),
          h('td.num', fmtInt(r.sent)),
          h('td.num', fmtInt(r.replies), r.sent ? h('div.small.muted', pct(r.replies / r.sent)) : null),
          h('td.num', `${r.activeHours} год`, rep.billing.prorate ? h('div.small.muted', `${pct(r.share)} з ${Math.round(r.schedHours)} год графіка`) : null),
          h('td.num', money(r.earnings, cur), r.estimated
            ? h('div.small.muted', `≈ орієнтовно: ${r.replies} × ${money(r.perReply, cur)}${r.perReplyLearned ? ' (з минулих місяців)' : ''}`)
            : h('div', badge('введено', 'ok'))),
          h('td.num', `${r.pct}%`),
          h('td.num', rep.totals.refDiscount ? money(r.fee, cur) : h('b', money(r.fee, cur))),
          rep.totals.refDiscount ? h('td.num', r.refDiscount ? `− ${money(r.refDiscount, cur)}` : '—') : null,
          rep.totals.refDiscount ? h('td.num', h('b', money(r.toPay, cur)), r.refPayout ? h('div.small.muted', `+ виплата ${money(r.refPayout, cur)}`) : null) : null,
          h('td', h('button.btn.sm', { onclick: safe(() => enterEarnings(r, cur)) }, r.estimated ? 'Ввести заробіток' : '✎'))))))
        : h('p.muted', 'Ще немає операторів, які запускали бота.')),
      ref ? referralCard(ref, cur) : null,
      h('p.small.muted', `Як рахується: ${rep.billing.mode === 'marginal' ? 'кожна частина заробітку за своїм % (як податок сходинками — без стрибка на порозі)' : 'заробіток × % зі шкали'}${rep.billing.prorate ? ' × частка часу, коли бот реально працював, від годин його графіка за місяць (Сайти → ⚙ Сценарій)' : ''}. Шкалу % встановлює постачальник софту.`),
    ].filter(Boolean));
  }

  await load();
}
