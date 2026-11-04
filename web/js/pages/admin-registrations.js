import { h, field, input, busy, toast, modal, confirmDialog, badge, empty, fmtDate, ago, copy, safe } from '../ui.js';
import { get, post, del } from '../api.js';
import { planText } from './admin-agencies.js';

const joinUrl = (token) => `${location.origin}/#/join/${token}`;

/** A ready message with the link for a new team lead. */
function linkModal(token, licenses, days) {
  const url = joinUrl(token);
  const text = [
    'Привіт! Ось посилання на реєстрацію твоєї команди в Agency CRM:',
    url,
    '',
    'Що зробити:',
    '1. Відкрий посилання, введи ім’я, назву команди, email і пароль.',
    '2. Я підтверджу — і входиш з цим email і паролем.',
    '3. У розділі «Команда» буде посилання для твоїх операторів — надішли їм, вони зареєструються, а ти підтвердиш.',
    licenses ? `\nПлан твоєї команди: ${planText(licenses, days)} — вмикається після підтвердження. Нічого роздавати не треба: анкети просто працюють.` : '',
    '\nПосилання одноразове і діє 14 днів.',
  ].join('\n').trim();
  const area = h('textarea.access-text', { rows: 12, readonly: true });
  area.value = text;
  const m = modal({
    title: 'Посилання для тімліда готове',
    body: h('div.stack', h('p', 'Скопіюй і надішли тімліду. Хтось інший за ним зареєструватися не зможе без твого підтвердження.'), area),
    actions: [h('button.btn', { onclick: () => copy(url) }, 'Лише посилання'), h('button.btn', { onclick: () => m.close() }, 'Закрити'), h('button.btn.primary', { onclick: () => copy(text) }, 'Скопіювати повідомлення')],
  });
}

export function inviteLeadForm(onDone) {
  const els = { note: input('note', '', { placeholder: 'напр. Ігор, 10 людей', maxlength: 120 }), licenses: input('licenses', 50, { type: 'number', min: 0, max: 10000 }), days: input('days', 0, { type: 'number', min: 0, max: 3650 }) };
  const ok = h('button.btn.primary', 'Створити посилання');
  const m = modal({
    title: '+ Запросити тімліда',
    body: h('div.stack', h('p.small.muted', 'Тімлід сам вводить ім’я, email і пароль. Після реєстрації ти підтверджуєш — і план команди вмикається сам.'),
      field('Кого запрошуєш (для себе)', els.note), h('div.pair', field('Анкет у плані', els.licenses, 'скільки активних анкет може працювати'), field('Днів', els.days, '0 — без терміну'))),
    actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok],
  });
  ok.addEventListener('click', () => busy(ok, async () => {
    const r = await post('/api/admin/links', { note: els.note.value, licenses: Number(els.licenses.value), days: Number(els.days.value) });
    m.close();
    linkModal(r.link.token, Number(els.licenses.value), Number(els.days.value));
    onDone?.();
  }).catch(() => {}));
}

/** Registrations: invite a team lead by link; approve / reject everyone who registered (team leads and operators). */
export default async function adminRegistrations(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const { pending, links } = await get('/api/admin/registrations');
    page.replaceChildren(
      h('div.page-head', h('h1', 'Реєстрації'), h('button.btn.primary', { onclick: () => inviteLeadForm(load) }, '+ Запросити тімліда')),
      h('section.card.stack', h('h3', `Чекають підтвердження: ${pending.length}`),
        pending.length ? h('div.pending-list', pending.map((u) => h('div.pending-row',
          h('div.who', h('b', u.name), ' ', badge(u.role === 'owner' ? 'тімлід' : 'оператор', u.role === 'owner' ? 'accent' : 'info'),
            h('small', `${u.email} · ${u.agency_name || '—'}${u.link_note ? ` · «${u.link_note}»` : ''} · ${ago(u.created_at)}`)),
          h('button.btn.primary.sm', { onclick: safe(async () => { await post(`/api/admin/users/${u.id}/approve`); toast(`${u.name} підтверджено`); load(); }) }, '✓ Підтвердити'),
          h('button.btn.sm.danger.ghost', { onclick: safe(async () => {
            if (!(await confirmDialog(`Відхилити «${u.name}» (${u.email})?${u.role === 'owner' ? ' Порожню команду теж буде видалено.' : ''}`, { ok: 'Відхилити', danger: true }))) return;
            await post(`/api/admin/users/${u.id}/reject`);
            toast('Відхилено');
            load();
          }) }, '✕ Відхилити'))))
          : h('p.muted', 'Нікого. Операторів зазвичай підтверджує їхній тімлід, але ти теж можеш — тут.')),
      h('section.card', h('h3', 'Посилання для тімлідів'),
        links.length ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Для кого'), h('th', 'План'), h('th', 'Створено'), h('th', 'Стан'), h('th', ''))),
          h('tbody', links.map((l) => {
            const expired = l.expires_at && l.expires_at < Date.now();
            const state = l.used_by ? badge(`використано: ${l.used_by}`, 'ok') : !l.active ? badge('вимкнено', 'muted') : expired ? badge('прострочено', 'muted') : badge('чекає', 'warn');
            return h('tr',
              h('td', l.note || h('span.muted', '—')),
              h('td', planText(l.licenses, l.days) || '—'),
              h('td', fmtDate(l.created_at, false)),
              h('td', state),
              h('td.actions', l.active && !expired && !l.used_by ? h('div.row-actions',
                h('button.btn.sm', { onclick: () => linkModal(l.token, l.licenses, l.days) }, 'Показати'),
                h('button.btn.sm.ghost', { onclick: safe(async () => { await del(`/api/admin/links/${l.id}`); toast('Посилання вимкнено'); load(); }) }, 'Вимкнути')) : null));
          }))))
          : empty('Ще не запрошено жодного тімліда.')));
  }
  await load();
}
