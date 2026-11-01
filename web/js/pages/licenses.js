import { h, badge, empty, fmtInt, fmtDate, toast, copy, safe } from '../ui.js';
import { get, post } from '../api.js';

const STATE = { active: ['Активна', 'ok'], free: ['Вільна', 'info'], expired: ['Прострочена', 'err'], revoked: ['Відкликана', 'err'] };

export default async function licensesPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const [{ licenses, summary }, { profiles }] = await Promise.all([get('/api/licenses'), get('/api/profiles')]);
    const licensed = new Set(licenses.filter((l) => l.profile_id).map((l) => l.profile_id));
    const assign = (l) => {
      const usable = l.state === 'active' || l.state === 'free';
      const sel = h('select', { disabled: !usable, 'aria-label': `Анкета для ${l.key}`, onchange: safe(async (e) => {
        await post(`/api/licenses/${l.id}/assign`, { profile_id: e.target.value ? Number(e.target.value) : null });
        toast(e.target.value ? 'Ліцензію прив’язано' : 'Ліцензію звільнено');
        load();
      }) },
      h('option', { value: '' }, '— вільна —'),
      profiles.filter((p) => p.id === l.profile_id || !licensed.has(p.id)).map((p) => h('option', { value: p.id, selected: p.id === l.profile_id }, p.name)));
      return sel;
    };
    page.replaceChildren(
      h('div.page-head', h('h1', 'Ліцензії', h('span.count', fmtInt(summary.total)))),
      h('div.tiles',
        h('div.tile.good', h('span.tile-label', 'Активні'), h('b.tile-value', fmtInt(summary.active))),
        h('div.tile', h('span.tile-label', 'Вільні'), h('b.tile-value', fmtInt(summary.free))),
        h(`div.tile${summary.expiringSoon ? '.warn' : ''}`, h('span.tile-label', 'Закінчуються ≤ 3 дн'), h('b.tile-value', fmtInt(summary.expiringSoon))),
        h('div.tile', h('span.tile-label', 'Прострочені / відкликані'), h('b.tile-value', fmtInt((summary.expired || 0) + (summary.revoked || 0))))),
      h('p.muted.lead', 'Одна ліцензія = одна анкета, на якій може працювати бот. Термін починає йти з першої прив’язки. Нові ліцензії та продовження — у постачальника.'),
      h('div.card.table-wrap', licenses.length ? h('table.table',
        h('thead', h('tr', h('th', 'Ключ'), h('th', 'Статус'), h('th', 'Анкета'), h('th.num', 'Залишилось'), h('th', 'Діє до'))),
        h('tbody', licenses.map((l) => h('tr',
          h('td', h('button.key', { onclick: () => copy(l.key), title: 'Скопіювати' }, l.key), l.note ? h('div.small.muted', l.note) : null),
          h('td', badge(...(STATE[l.state] || [l.state, '']))),
          h('td', assign(l)),
          h('td.num', l.state === 'active' || l.state === 'free' ? `${l.daysLeft} дн` : '—'),
          h('td', l.expires_at ? fmtDate(l.expires_at, false) : h('span.muted', `${l.days} дн після прив’язки`))))))
        : empty('Ліцензій ще немає. Зверніться до постачальника, щоб отримати ключі.')));
  }

  await load();
}
