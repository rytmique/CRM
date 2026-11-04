import { h, fmtInt, fmtPct, empty } from '../ui.js';
import { get } from '../api.js';

const tile = (label, value, sub, kind = '') => h(`div.tile${kind ? `.${kind}` : ''}`, h('span.tile-label', label), h('b.tile-value', value), sub ? h('span.tile-sub', sub) : null);

/** The admin's control panel, first page: everything at a glance and what needs a look. */
export default async function adminOverview(main, { navigate }) {
  const page = h('div.page');
  main.replaceChildren(page);
  const [o, health] = await Promise.all([get('/api/admin/overview'), get('/api/health')]);
  const t = o.totals;
  page.replaceChildren(...[
    health.persistentStorage === false ? h('div.alert.err', { role: 'alert' },
      h('b', '⚠ Диск не підключено — після наступного оновлення всі дані зникнуть.'),
      h('div', 'Railway → твій сервіс → правий клік → Attach Volume → шлях /data.')) : null,
    h('div.page-head', h('h1', 'Пульт'), h('div.row-wrap',
      h('button.btn', { onclick: () => navigate('agencies') }, 'Команди'),
      h('button.btn.primary', { onclick: () => navigate('registrations') }, '+ Запросити тімліда'))),
    h('div.tiles',
      tile('Команд', fmtInt(t.agencies), `людей ${fmtInt(t.operators)} · анкет ${fmtInt(t.profiles)}`),
      tile('Ботів працює зараз', fmtInt(t.botsOnline), 'за останні 2 хв', t.botsOnline ? 'good' : ''),
      tile('Інвайтів сьогодні', fmtInt(t.sentToday), `відповідей ${fmtInt(t.repliesToday)}`),
      tile('Конверсія 30 дн', fmtPct(t.sent30 ? t.replies30 / t.sent30 : 0), `${fmtInt(t.sent30)} інвайтів → ${fmtInt(t.replies30)}`),
      tile('Пристроїв (7 дн)', fmtInt(t.devices), 'панель + боти', ''),
      tile('Нові реєстрації', fmtInt(t.pending), t.pending ? 'чекають тебе' : 'немає', t.pending ? 'warn' : '')),
    o.attention.length ? h('section.card.stack', h('h3', '⚠ Потребує уваги'),
      h('div.attention', o.attention.map((a) => h('a', { href: `#/${a.go}` }, a.text, h('span', { style: 'margin-left:auto' }, '→'))))) : null,
    h('section.card', h('h3', 'Команди сьогодні'),
      o.teams.length ? h('div.table-wrap', h('table.table.hover',
        h('thead', h('tr', h('th', 'Команда'), h('th.num', 'Людей'), h('th.num', 'Анкет'), h('th.num', 'Ботів зараз'), h('th.num', 'Інвайтів'), h('th.num', 'Відповідей'))),
        h('tbody', o.teams.map((x) => h('tr', { tabindex: 0, onclick: () => navigate(`agency?id=${x.id}`) },
          h('td', h('b', x.name)), h('td.num', fmtInt(x.people)), h('td.num', fmtInt(x.profiles)),
          h('td.num', x.bots_online ? h('span.badge.ok', `● ${x.bots_online}`) : h('span.muted', '0')),
          h('td.num', fmtInt(x.sent_today)), h('td.num', fmtInt(x.replies_today)))))))
        : empty('Команд ще немає. Натисни «+ Запросити тімліда» — він сам зареєструється за посиланням.')),
    !o.aiKey ? h('p.small.muted', 'Ключа ШІ платформи (ANTHROPIC_API_KEY) немає: команди працюють своїм ключем або шаблонами.') : null,
  ].filter(Boolean));
}
