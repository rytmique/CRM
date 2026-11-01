import { h, field, input, select, formData, busy, toast, modal, badge, empty, fmtInt, fmtDate, copy, safe } from '../ui.js';
import { get, post } from '../api.js';
import { showKeys } from './admin-agencies.js';

const STATE = { active: ['Активна', 'ok'], free: ['Вільна', 'info'], expired: ['Прострочена', 'err'], revoked: ['Відкликана', 'err'] };

export default async function adminLicenses(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const { agencies } = await get('/api/admin/agencies');
  let agencyId = '';

  async function load() {
    const { licenses } = await get(`/api/admin/licenses${agencyId ? `?agency_id=${agencyId}` : ''}`);
    page.replaceChildren(
      h('div.page-head', h('h1', 'Ліцензії', h('span.count', fmtInt(licenses.length))), h('button.btn.primary', { onclick: openIssue, disabled: !agencies.length }, '+ Видати ліцензії')),
      h('div.toolbar', h('select', { 'aria-label': 'Агенція', onchange: (e) => { agencyId = e.target.value; load(); } },
        h('option', { value: '' }, 'Усі агенції'), agencies.map((a) => h('option', { value: a.id, selected: String(a.id) === agencyId }, a.name)))),
      h('div.card.table-wrap', licenses.length ? h('table.table',
        h('thead', h('tr', h('th', 'Ключ'), h('th', 'Агенція'), h('th', 'Статус'), h('th', 'Анкета'), h('th.num', 'Днів'), h('th', 'Діє до'), h('th', ''))),
        h('tbody', licenses.map((l) => h('tr',
          h('td', h('button.key', { onclick: () => copy(l.key) }, l.key), l.note ? h('div.small.muted', l.note) : null),
          h('td', l.agency_name),
          h('td', badge(...(STATE[l.state] || [l.state, '']))),
          h('td', l.profile_name || h('span.muted', '—')),
          h('td.num', l.state === 'revoked' ? '—' : `${l.daysLeft} / ${l.days}`),
          h('td', l.expires_at ? fmtDate(l.expires_at, false) : h('span.muted', 'не активована')),
          h('td.actions',
            h('button.btn.sm', { onclick: () => openExtend(l) }, '+ дні'),
            l.status === 'revoked'
              ? h('button.btn.sm', { onclick: safe(async () => { await post(`/api/admin/licenses/${l.id}/restore`); toast('Відновлено'); load(); }) }, 'Відновити')
              : h('button.btn.sm.ghost', { onclick: safe(async () => { await post(`/api/admin/licenses/${l.id}/revoke`); toast('Відкликано'); load(); }) }, 'Відкликати'))))))
        : empty('Ліцензій немає')));
  }

  function openIssue() {
    const form = h('form.form-grid',
      h('div.span-2', field('Агенція', select('agency_id', agencyId || agencies[0]?.id, agencies.map((a) => [a.id, a.name]), { 'data-num': '' }))),
      field('Кількість', input('count', 5, { type: 'number', min: 1, max: 500, required: true })),
      field('Днів кожна', input('days', 30, { type: 'number', min: 1, max: 3650, required: true })),
      h('div.span-2', field('Примітка', input('note', '', { placeholder: 'напр. рахунок №123' }))));
    const save = h('button.btn.primary', 'Видати');
    const m = modal({ title: 'Видати ліцензії', body: form, actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save] });
    save.addEventListener('click', () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const r = await post('/api/admin/licenses', formData(form));
      m.close();
      load();
      showKeys(r.keys);
    }).catch(() => {}));
  }

  function openExtend(l) {
    const days = input('days', 30, { type: 'number', min: 1, max: 3650 });
    const save = h('button.btn.primary', 'Продовжити');
    const m = modal({ title: `Продовжити ${l.key}`, body: field('Додати днів', days), actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save] });
    save.addEventListener('click', () => busy(save, async () => {
      await post(`/api/admin/licenses/${l.id}/extend`, { days: Number(days.value) });
      toast('Продовжено');
      m.close();
      load();
    }).catch(() => {}));
  }

  await load();
}
