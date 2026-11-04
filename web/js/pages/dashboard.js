import { h, fmtInt, fmtPct, ago, avatar, badge, empty } from '../ui.js';
import { get } from '../api.js';
import { columnChart } from '../chart.js';

const BOT_STATE = {
  running: ['Розсилає', 'ok'], limit: ['Ліміт', 'warn'], done: ['Стежить', 'ok'], error: ['Помилка', 'err'], paused: ['Пауза', ''], idle: ['Вимкнено', ''],
};

export function botBadge(p) {
  if (!p.bot_online) return badge('Офлайн', 'muted');
  const [label, kind] = BOT_STATE[p.bot_state] || ['Онлайн', 'ok'];
  return badge(`● ${label}`, kind);
}

function tile(label, value, sub, kind = '') {
  return h(`div.tile${kind ? `.${kind}` : ''}`, h('span.tile-label', label), h('b.tile-value', value), sub ? h('span.tile-sub', sub) : null);
}

const HIDE_KEY = 'agc_onboarding_hidden';
const hidden = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };

const SETUP_TITLES = { site: 'додати сайт', profile: 'створити анкету', extension: 'встановити розширення', teach: 'навчити бота сайту', test: 'запустити 🧪 тест', start: 'натиснути ▶ Старт' };

/** Until the bot has sent its first invite: one banner that leads to the setup wizard. */
function setupBanner(s, navigate, onHide) {
  if (!s?.steps || s.done) return null;
  const doneCount = s.steps.filter((x) => x.done).length;
  const next = s.steps.find((x) => !x.done);
  return h('section.card.onboarding',
    h('div.onb-head', h('h3', '🚀 Підключення', h('span.count', `${doneCount} з ${s.steps.length}`)),
      h('button.btn.sm.ghost', { onclick: onHide }, 'Сховати')),
    h('p', 'Наступний крок: ', h('b', SETUP_TITLES[next.key] || next.key), '. Майстер покаже, що натиснути, і сам поставить ✓.'),
    h('button.btn.primary', { onclick: () => navigate('setup') }, 'Продовжити →'));
}

export default async function dashboard(main, { user, navigate }) {
  let days = 14;
  let timer;
  const page = h('div.page');
  main.replaceChildren(page);

  const periodBtns = [7, 14, 30].map((d) => h('button.seg', { onclick: () => { days = d; load(); } }, `${d} днів`));

  async function load() {
    const [st, onb, me] = await Promise.all([
      get(`/api/stats/overview?days=${days}`),
      !hidden() ? get('/api/stats/setup').catch(() => null) : Promise.resolve(null),
      user.role === 'owner' ? get('/api/auth/me').catch(() => null) : Promise.resolve(null),
    ]);
    const pendingN = me?.user?.pendingCount || 0;
    const pendingBanner = pendingN ? h('a.alert.info.link-alert', { href: '#/team' },
      h('b', `👋 Нові реєстрації в команду: ${pendingN}`), ' — підтвердіть або відхиліть у розділі «Команда» →') : null;
    const onboarding = setupBanner(onb, navigate, () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* ignore */ } load(); });
    periodBtns.forEach((b, i) => b.classList.toggle('on', [7, 14, 30][i] === days));
    const op = user.role === 'operator';

    const tiles = h('div.tiles',
      tile('Інвайтів сьогодні', fmtInt(st.today.sent), st.today.failed ? `${st.today.failed} з помилкою` : 'без помилок'),
      tile('Відповідей сьогодні', fmtInt(st.today.replies), `конверсія інвайтів дня ${fmtPct(st.today.rate)}`),
      tile(`Конверсія за ${days} дн`, fmtPct(st.period.rate), `${fmtInt(st.period.sent)} інвайтів → відповіді`),
      tile('Ботів онлайн', `${st.botsOnline} / ${st.profilesActive}`, 'з активних анкет', st.botsOnline ? 'good' : ''),
      st.plan ? tile('План команди', st.plan.profiles ? `${fmtInt(st.plan.used)} / ${fmtInt(st.plan.profiles)}` : '—',
        !st.plan.profiles ? 'плану ще немає — напишіть постачальнику' : st.plan.used > st.plan.profiles ? '⚠ анкет більше, ніж у плані' : st.plan.until ? `активних анкет · до ${new Date(st.plan.until).toLocaleDateString('uk-UA')}` : 'активних анкет · без терміну',
        !st.plan.profiles || st.plan.used > st.plan.profiles || (st.plan.daysLeft !== null && st.plan.daysLeft <= 5) ? 'warn' : '') : null);

    const charts = h('div.grid-2',
      h('section.card', columnChart({ title: 'Інвайти по днях', data: st.daily.map((d) => ({ day: d.day, value: d.sent })), series: '--series-1', extra: (d) => {
        const row = st.daily.find((x) => x.day === d.day);
        return row.failed ? `${row.failed} помилок` : '';
      } })),
      h('section.card', columnChart({ title: 'Відповіді по днях', data: st.daily.map((d) => ({ day: d.day, value: d.replies })), series: '--series-2' })));

    const profTable = st.profiles.length ? h('table.table',
      h('thead', h('tr', h('th', 'Анкета'), op ? null : h('th', 'Оператор'), h('th', 'Бот'), h('th.num', 'Сьогодні'), h('th.num', 'Відповідей'), h('th.num', 'Конверсія'))),
      h('tbody', st.profiles.map((p) => h('tr',
        h('td', h('div.person', avatar(p.name, p.photo_url), h('span', h('b', p.name), p.age ? `, ${p.age}` : '', p.status === 'paused' ? h('small.muted', ' · пауза') : ''))),
        op ? null : h('td', p.operator_name || h('span.muted', '—')),
        h('td', botBadge(p)),
        h('td.num', fmtInt(p.sent_today)),
        h('td.num', fmtInt(p.replies_today)),
        h('td.num', p.sent_period ? fmtPct(p.replied_period / p.sent_period) : h('span.muted', '—')))))) : empty('Анкет ще немає', user.role === 'owner' ? h('button.btn.primary', { onclick: () => navigate('profiles') }, 'Додати анкету') : null);

    const replies = st.recentReplies.length ? h('ul.feed', st.recentReplies.map((r) => h('li',
      h('div', h('b', r.man_name || `ID ${r.man_id}`), [r.man_age, r.man_country].filter(Boolean).length ? h('span.muted', ` · ${[r.man_age, r.man_country].filter(Boolean).join(', ')}`) : '',
        h('div.small.muted', `→ ${r.profile_name} · ${ago(r.replied_at)}`)),
      r.chat_url ? h('a.btn.sm', { href: r.chat_url, target: '_blank', rel: 'noopener' }, 'Чат') : null))) : empty('Відповідей поки немає. Щойно чоловік відповість — він з’явиться тут, а жінка отримає сповіщення.');

    const operators = !op && st.operators.length ? h('section.card',
      h('h3', `Команда за ${days} дн`),
      h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Оператор'), h('th.num', 'Сьогодні'), h('th.num', 'Інвайтів'), h('th.num', 'Відповідей'), h('th.num', 'Конверсія'))),
        h('tbody', st.operators.map((o) => h('tr', h('td', o.name), h('td.num', fmtInt(o.sent_today)), h('td.num', fmtInt(o.sent_period)), h('td.num', fmtInt(o.replied_period)),
          h('td.num', o.sent_period ? fmtPct(o.replied_period / o.sent_period) : '—'))))))) : null;

    // The team lead: the team first; the full list of profiles (30–50 of them) folded away.
    const body = op ? [
      h('div.grid-main',
        h('section.card', h('h3', 'Мої анкети'), h('div.table-wrap', profTable)),
        h('section.card', h('h3', 'Останні відповіді'), replies)),
    ] : [
      h('div.grid-main', operators || h('section.card', h('h3', 'Команда'), empty('Ще ніхто не працював. Запросіть операторів у розділі «Команда».')),
        h('section.card', h('h3', 'Останні відповіді'), replies)),
      h('details.card.fold', h('summary', h('b', `Усі анкети (${st.profiles.length})`), h('span.small.muted', ' — бот, сьогодні, конверсія')), h('div.table-wrap', profTable)),
    ];
    page.replaceChildren(...[
      h('div.page-head', h('h1', 'Головна'), h('div.seg-group', { role: 'group', 'aria-label': 'Період' }, periodBtns)),
      pendingBanner,
      onboarding,
      tiles,
      charts,
      ...body,
    ].filter(Boolean)); // DOM replaceChildren would print "null"
  }

  await load();
  timer = setInterval(() => load().catch(() => {}), 30000);
  return () => clearInterval(timer);
}
