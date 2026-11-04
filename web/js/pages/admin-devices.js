import { h, badge, toast, ago, fmtDate, safe, confirmDialog, empty, busy } from '../ui.js';
import { get, put, post, del } from '../api.js';

/** Signed-in devices: the panel and the bot; any of them can be switched off at once. */
export function devicesTable(devices, reload, { team = false } = {}) {
  if (!devices.length) return empty('Зараз ніхто не увійшов.');
  return h('table.table',
    h('thead', h('tr', h('th', 'Хто'), team ? h('th', 'Команда') : null, h('th', 'Що'), h('th', 'Пристрій'), h('th', 'IP'), h('th', 'Активність'), h('th', ''))),
    h('tbody', devices.map((d) => h('tr',
      h('td', h('b', d.name), h('div.small.muted', d.email)),
      team ? h('td', d.agency_name || h('span.muted', '—')) : null,
      h('td', d.kind === 'bot' ? badge('🧩 бот', 'info') : badge('🖥 панель', 'muted'),
        d.kind === 'bot' ? h('div.small.muted', d.build ? (d.build_revoked ? 'копію вимкнено' : d.foreignBuild ? '⚠ копія іншої команди' : `копія ${d.build}`) : 'стара копія (без мітки)') : null),
      h('td', d.device),
      h('td', h('code.small', d.ip || '—')),
      h('td', ago(d.last_used_at)),
      h('td.actions', h('button.btn.sm.ghost', { onclick: safe(async () => {
        await del(`/api/admin/devices/${d.id}`);
        toast('Пристрій відключено: там треба буде увійти знову');
        reload();
      }) }, 'Відключити'))))));
}

/** Devices and copies of the bot: who is signed in where; each download is a marked copy that can be switched off. */
export default async function adminDevices(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const [d, { builds }] = await Promise.all([get('/api/admin/devices'), get('/api/admin/builds')]);
    const strict = h('input', { type: 'checkbox', checked: d.requireBuild });
    strict.addEventListener('change', () => busy(null, async () => {
      if (strict.checked && d.oldCopies && !(await confirmDialog(`Зараз ${d.oldCopies} бот(ів) працюють зі старих копій без мітки — вони не зможуть увійти, доки люди не завантажать бота заново з панелі. Увімкнути?`, { ok: 'Увімкнути' }))) { strict.checked = false; return; }
      await put('/api/admin/security', { requireBuild: strict.checked });
      toast(strict.checked ? 'Тепер бот входить лише з копій, завантажених з панелі' : 'Вимкнено');
      load();
    }).catch(() => {}));
    page.replaceChildren(
      h('div.page-head', h('h1', 'Пристрої й копії бота')),
      h('div.callout', h('b', 'Як захищено бота. '), 'Без нашого сервера, підтвердженого акаунта й ліцензії бот нічого не вміє: тексти, навчання, сценарії й налаштування сайтів живуть на сервері. ',
        'Кожне завантаження — окрема копія з міткою (видно, хто взяв). Код у копії без коментарів. Будь-яку копію чи пристрій можна вимкнути тут одним кліком.'),
      h('section.card.stack',
        h('label.check', strict, h('span', h('b', 'Пускати лише копії бота, завантажені з панелі'), h('div.small.muted', 'Злита чи стара копія не зможе увійти. Копія іншої команди — теж.'))),
        d.oldCopies ? h('p.small', `⚠ Зараз працюють старі копії без мітки: ${d.oldCopies}. Попроси людей завантажити бота заново (меню «Завантажити бота»), потім вмикай.`) : null),
      h('section.card', h('h3', `Хто зараз увійшов (${d.devices.length})`), h('div.table-wrap', devicesTable(d.devices, load, { team: true }))),
      h('section.card', h('h3', 'Копії бота (завантаження)'),
        builds.length ? h('div.table-wrap', h('table.table',
          h('thead', h('tr', h('th', 'Копія'), h('th', 'Хто взяв'), h('th', 'Команда'), h('th', 'Коли'), h('th', 'Остання робота'), h('th.num', 'Входів'), h('th', ''))),
          h('tbody', builds.map((b) => h('tr',
            h('td', h('code', b.build), b.revoked_at ? h('div', badge('вимкнено', 'err')) : null),
            h('td', b.name || '—', h('div.small.muted', b.email || '')),
            h('td', b.agency_name || h('span.muted', '—')),
            h('td', fmtDate(b.created_at), h('div.small.muted', b.ip || '')),
            h('td', b.last_used ? ago(b.last_used) : h('span.muted', 'ще не входила')),
            h('td.num', String(b.sessions)),
            h('td.actions', b.revoked_at ? null : h('button.btn.sm.danger.ghost', { onclick: safe(async () => {
              if (!(await confirmDialog(`Вимкнути копію ${b.build}? Бот з неї одразу вийде і більше не зможе увійти.`, { ok: 'Вимкнути', danger: true }))) return;
              await post(`/api/admin/builds/${b.id}/revoke`);
              toast('Копію вимкнено');
              load();
            }) }, 'Вимкнути копію'))))))) : empty('Бота ще ніхто не завантажував.')));
  }
  await load();
}
