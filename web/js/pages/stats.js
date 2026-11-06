import { h, fmtInt, dayLabel, select } from '../ui.js';
import { get, session } from '../api.js';

/**
 * 📊 Detailed stats: per night and mode (what the bot wrote, how many answered, conversion), per profile,
 * and the AI used. Operators — their own profiles; team lead — the team (and who used how much AI).
 */
export default async function statsPage(main, arg) {
  const nights = typeof arg === 'number' ? arg : 7; // the router passes its own options object
  const page = h('div.page');
  main.replaceChildren(page);
  const owner = session.user.role === 'owner';
  const [shift, conf] = await Promise.all([get(`/api/stats/shift?nights=${nights}`), owner ? get('/api/settings') : Promise.resolve(null)]);
  const pct = (x) => `${(x || 0).toLocaleString('uk-UA')}%`;
  const cell = (m) => h('td.num', fmtInt(m.sent), h('span.small.muted', ` / ${fmtInt(m.replies)}`), h('div.small.muted', pct(m.conv)));
  const sum = shift.nights.reduce((a, n) => ({
    chance: { sent: a.chance.sent + n.chance.sent, replies: a.chance.replies + n.chance.replies },
    allchat: { sent: a.allchat.sent + n.allchat.sent, replies: a.allchat.replies + n.allchat.replies },
    other: { sent: a.other.sent + n.other.sent, replies: a.other.replies + n.other.replies },
    ai: { calls: a.ai.calls + n.ai.calls, tokens: a.ai.tokens + n.ai.input + n.ai.output },
  }), { chance: { sent: 0, replies: 0 }, allchat: { sent: 0, replies: 0 }, other: { sent: 0, replies: 0 }, ai: { calls: 0, tokens: 0 } });
  const conv = (m) => (m.sent ? Math.round((m.replies / m.sent) * 1000) / 10 : 0);

  const range = select('nights', nights, [[7, '7 ночей'], [14, '14 ночей'], [30, '30 ночей']], { style: 'width:auto' });
  range.addEventListener('change', () => statsPage(main, Number(range.value)));
  const tile = (label, m) => h('div.tile.good', h('span.tile-label', label), h('span.tile-value', pct(conv(m))), h('span.tile-sub', `${fmtInt(m.sent)} надіслано · ${fmtInt(m.replies)} відповідей`));

  page.replaceChildren(...[ // (DOM replaceChildren would print «null»)
    h('div.page-head', h('h1', '📊 Статистика'), range),
    h('div.tiles',
      tile('🎯 Шанс — конверсія', sum.chance),
      tile('💬 Аллчат — конверсія', sum.allchat),
      tile('📋 Інше (підказки, пошук)', sum.other),
      h('div.tile', h('span.tile-label', '🤖 ШІ за період'), h('span.tile-value', fmtInt(sum.ai.calls)), h('span.tile-sub', `текстів · ${fmtInt(sum.ai.tokens)} токенів`))),
    h('section.card', h('h3', 'По ночах'),
      h('table.table', h('thead', h('tr', h('th', 'Ніч'), h('th.num', '🎯 Шанс'), h('th.num', '💬 Аллчат'), h('th.num', '📋 Інше'), h('th.num', 'Разом'), h('th.num', '🤖 ШІ'))),
        h('tbody', [...shift.nights].reverse().map((n) => h('tr', h('td', dayLabel(n.night)), cell(n.chance), cell(n.allchat), cell(n.other), cell(n.total),
          h('td.num', fmtInt(n.ai.calls), h('div.small.muted', `${fmtInt(n.ai.input + n.ai.output)} ток.`)))))),
      h('p.small.muted', 'У клітинці: надіслано / відповіли, нижче — конверсія. Ніч — дата початку зміни.')),
    h('section.card', h('h3', 'Анкети за останню ніч'),
      shift.profiles.length ? h('table.table', h('thead', h('tr', h('th', 'Анкета'), h('th.num', '🎯 Шанс'), h('th.num', '💬 Аллчат'), h('th.num', 'Відповіді'), h('th', 'Бот'))),
        h('tbody', shift.profiles.map((p) => h('tr', h('td', p.name), h('td.num', fmtInt(p.chance)), h('td.num', fmtInt(p.allchat)), h('td.num', fmtInt(p.replies)),
          h('td', p.online ? '🟢 на зв’язку' : '⚪ офлайн'))))) : h('p.muted', 'Анкет немає')),
    owner && conf?.usage?.length ? h('section.card', h('h3', 'Хто скільки використав ШІ (цей місяць)'),
      h('table.table', h('thead', h('tr', h('th', 'Хто'), h('th.num', 'Текстів'), h('th.num', 'Токенів'))),
        h('tbody', conf.usage.map((u) => h('tr', h('td', u.name), h('td.num', fmtInt(u.calls)), h('td.num', fmtInt((u.input || 0) + (u.output || 0))))))),
      h('p.small.muted', 'Точна сума в доларах — у console.anthropic.com → Usage.')) : null,
    h('p.small', h('a', { href: '#/dashboard' }, 'Стара детальна статистика по днях →'), ' · ', h('a', { href: '#/journal' }, 'Журнал повідомлень →'))].filter(Boolean));
}
