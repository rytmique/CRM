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

/** "First steps": only the next thing to do is highlighted. */
function onboardingCard(steps, navigate, onHide) {
  const required = steps.filter((s) => !s.optional);
  if (!steps.length || (required.every((s) => s.done) && steps.every((s) => s.done || s.optional))) return null;
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done && !s.optional) || steps.find((s) => !s.done);
  return h('section.card.onboarding',
    h('div.onb-head', h('h3', 'Перші кроки', h('span.count', `${doneCount} з ${steps.length}`)),
      h('button.btn.sm.ghost', { onclick: onHide }, 'Сховати')),
    h('ol.onb-list', steps.map((s) => h(`li${s === next ? '.next' : ''}${s.done ? '.done' : ''}`,
      h('span.onb-mark', { 'aria-hidden': 'true' }, s.done ? '✓' : s === next ? '→' : ''),
      h('div.onb-text', h('b', s.title, s.optional ? h('span.muted', ' · необов’язково') : ''), s === next || !s.done ? h('div.small.muted', s.hint) : null),
      s.done ? null : h(`button.btn.sm${s === next ? '.primary' : ''}`, { onclick: () => navigate(s.page) }, s === next ? 'Зробити →' : 'Відкрити')))));
}

export default async function dashboard(main, { user, navigate }) {
  let days = 14;
  let timer;
  const page = h('div.page');
  main.replaceChildren(page);

  const periodBtns = [7, 14, 30].map((d) => h('button.seg', { onclick: () => { days = d; load(); } }, `${d} днів`));

  async function load() {
    const [st, onb] = await Promise.all([
      get(`/api/stats/overview?days=${days}`),
      user.role === 'owner' && !hidden() ? get('/api/stats/onboarding') : Promise.resolve({ steps: [] }),
    ]);
    const onboarding = onboardingCard(onb.steps, navigate, () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* ignore */ } load(); });
    periodBtns.forEach((b, i) => b.classList.toggle('on', [7, 14, 30][i] === days));
    const op = user.role === 'operator';

    const tiles = h('div.tiles',
      tile('Інвайтів сьогодні', fmtInt(st.today.sent), st.today.failed ? `${st.today.failed} з помилкою` : 'без помилок'),
      tile('Відповідей сьогодні', fmtInt(st.today.replies), `конверсія інвайтів дня ${fmtPct(st.today.rate)}`),
      tile(`Конверсія за ${days} дн`, fmtPct(st.period.rate), `${fmtInt(st.period.sent)} інвайтів → відповіді`),
      tile('Ботів онлайн', `${st.botsOnline} / ${st.profilesActive}`, 'з активних анкет', st.botsOnline ? 'good' : ''),
      st.licenses ? tile('Ліцензії', fmtInt(st.licenses.active), st.licenses.expiringSoon ? `⚠ ${st.licenses.expiringSoon} закінчуються ≤ 3 дн` : `${st.licenses.free} вільних`, st.licenses.expiringSoon ? 'warn' : '') : null);

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
      h('h3', `Оператори за ${days} дн`),
      h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Оператор'), h('th.num', 'Сьогодні'), h('th.num', 'Інвайтів'), h('th.num', 'Відповідей'), h('th.num', 'Конверсія'))),
        h('tbody', st.operators.map((o) => h('tr', h('td', o.name), h('td.num', fmtInt(o.sent_today)), h('td.num', fmtInt(o.sent_period)), h('td.num', fmtInt(o.replied_period)),
          h('td.num', o.sent_period ? fmtPct(o.replied_period / o.sent_period) : '—'))))))) : null;

    page.replaceChildren(
      h('div.page-head', h('h1', 'Дашборд'), h('div.seg-group', { role: 'group', 'aria-label': 'Період' }, periodBtns)),
      onboarding,
      tiles,
      charts,
      h('div.grid-main',
        h('section.card', h('h3', 'Анкети'), h('div.table-wrap', profTable)),
        h('section.card', h('h3', 'Останні відповіді'), replies)),
      operators);
  }

  await load();
  timer = setInterval(() => load().catch(() => {}), 30000);
  return () => clearInterval(timer);
}
