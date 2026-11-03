import { h, badge, empty, fmtInt, fmtDate } from '../ui.js';
import { get } from '../api.js';

function stageBadge(m) {
  if (m.replied_at) return badge('💌 Відповів', 'accent');
  if (m.status !== 'sent') return badge('Помилка', 'err');
  if (m.stage === 'done') return badge('Не відповів · прибрано', 'muted');
  if (m.stage === 'active' && m.next_at) return badge('Чекає повтору', 'info');
  return badge('Надіслано', 'ok');
}

export default async function journalPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const { profiles } = await get('/api/profiles');
  const f = { profile_id: '', status: '', q: '', page: 1 };
  const body = h('div.card.table-wrap');
  const pager = h('div.pager');
  let t;

  async function load() {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v !== null).map(([k, v]) => [k, String(v)]));
    const r = await get(`/api/stats/messages?${qs}`);
    body.replaceChildren(r.messages.length ? h('table.table',
      h('thead', h('tr', h('th', 'Час'), h('th', 'Анкета'), h('th', 'Чоловік'), h('th', 'Статус'), h('th', 'Оператор'), h('th', 'Текст'))),
      h('tbody', r.messages.map((m) => h('tr',
        h('td.nowrap', fmtDate(m.replied_at || m.sent_at)),
        h('td', m.profile_name),
        h('td', h('b', m.man_name || '—'), [m.man_age, m.man_country].filter(Boolean).length ? h('span.muted', ` · ${[m.man_age, m.man_country].filter(Boolean).join(', ')}`) : '', h('div.small.muted', `ID ${m.man_id}`)),
        h('td', stageBadge(m), m.step > 1 ? h('div.small.muted', `спроба ${m.step}`) : null,
          m.stage === 'active' && m.next_at && !m.replied_at ? h('div.small.muted', `наступна: ${fmtDate(m.next_at)}`) : null,
          m.error ? h('div.small.muted', m.error) : null),
        h('td', m.operator_name || '—'),
        h('td.invite-cell', h('span.clamp', { title: m.text }, m.text || '—'))))))
      : empty('Записів немає'));
    pager.replaceChildren(
      h('span.muted', `Усього: ${fmtInt(r.total)}`),
      h('div.row-wrap',
        h('button.btn.sm', { disabled: r.page <= 1, onclick: () => { f.page--; load(); } }, '← Назад'),
        h('span', `${r.page} / ${r.pages}`),
        h('button.btn.sm', { disabled: r.page >= r.pages, onclick: () => { f.page++; load(); } }, 'Далі →')));
  }

  const set = (k) => (e) => { f[k] = e.target.value; f.page = 1; clearTimeout(t); t = setTimeout(load, k === 'q' ? 300 : 0); };
  page.replaceChildren(
    h('div.page-head', h('h1', 'Журнал розсилки')),
    h('div.toolbar',
      h('input.search', { type: 'search', placeholder: 'Ім’я або ID чоловіка', oninput: set('q') }),
      h('select', { onchange: set('profile_id'), 'aria-label': 'Анкета' }, h('option', { value: '' }, 'Усі анкети'), profiles.map((p) => h('option', { value: p.id }, p.name))),
      h('select', { onchange: set('status'), 'aria-label': 'Статус' },
        h('option', { value: '' }, 'Усі статуси'), h('option', { value: 'replied' }, 'Відповіли'), h('option', { value: 'sent' }, 'Без відповіді'), h('option', { value: 'waiting' }, 'Чекають повтору'), h('option', { value: 'done' }, 'Не відповіли на всі спроби'), h('option', { value: 'failed' }, 'Помилки'))),
    body, pager);
  await load();
}
