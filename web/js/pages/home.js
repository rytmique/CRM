import { h, select, busy, toast, fmtInt, dayLabel, badge, safe } from '../ui.js';
import { get, post, del, session } from '../api.js';
import { downloadBot } from './extension.js';

const STATE = {
  running: ['🟢 пише', 'ok'], watching: ['🟢 стежить за відповідями', 'ok'], waiting: ['🟢 чекає черги', 'ok'], sleeping: ['🌙 неробочий час', ''],
  paused: ['⏸ пауза', 'warn'], blocked: ['🛑 капча — потрібна людина', 'err'], limit: ['🔵 ліміт на сьогодні', ''], error: ['🔴 помилка', 'err'],
  done: ['⚪ завершив', ''], idle: ['⚪ чекає', ''], starting: ['🟡 запускається…', 'warn'], off: ['⚪ вимкнено', ''],
};
const ON = ['running', 'watching', 'waiting', 'sleeping', 'blocked', 'starting', 'paused', 'limit', 'idle'];
const pct = (x) => `${(x || 0).toLocaleString('uk-UA')}%`;

/**
 * 🏠 Головна: the bot on / off, what it did tonight and over the nights, the profiles the bot found on the site, Telegram.
 * Team lead — the whole team, by person, or one person; operator — their own.
 */
export default async function homePage(main, opts = {}) {
  const page = h('div.page');
  main.replaceChildren(page);
  const owner = session.user.role === 'owner';
  const nights = Number(opts.nights) || 7;
  const who = owner ? String(opts.who || 'all') : 'mine';
  const reload = (o = {}) => homePage(main, { nights, who, ...o });
  const [{ bots }, shift, tg] = await Promise.all([
    get('/api/bots'), get(`/api/stats/shift?nights=${nights}&who=${encodeURIComponent(who)}`), get('/api/me/telegram')]);

  // ---- on / off ----
  const mine = (ids) => ids.length ? { ids } : {};
  const control = async (path, ids = []) => {
    const r = await post(`/api/bots/${path}`, mine(ids));
    if (path === 'start') toast(r.started.length ? 'Вмикаю. Бот у браузері підхопить протягом хвилини' : 'Немає активних анкет', r.started.length ? 'ok' : 'warn');
    else toast('Вимикаю — бот зупиниться протягом хвилини');
    setTimeout(() => reload(), 1500);
  };
  const onBtn = h('button.btn.primary', owner ? '▶ Увімкнути всіх' : '▶ Увімкнути');
  const offBtn = h('button.btn', owner ? '⏹ Вимкнути всіх' : '⏹ Вимкнути');
  onBtn.addEventListener('click', () => busy(onBtn, () => control('start')).catch(() => {}));
  offBtn.addEventListener('click', () => busy(offBtn, () => control('stop')).catch(() => {}));
  const working = bots.filter((b) => ON.includes(b.state));

  // ---- the period ----
  const sum = shift.nights.reduce((a, n) => {
    for (const k of ['chance', 'allchat', 'other', 'total']) { a[k].sent += n[k].sent; a[k].replies += n[k].replies; }
    a.ai += n.ai.calls;
    return a;
  }, { chance: { sent: 0, replies: 0 }, allchat: { sent: 0, replies: 0 }, other: { sent: 0, replies: 0 }, total: { sent: 0, replies: 0 }, ai: 0 });
  const conv = (m) => (m.sent ? Math.round((m.replies / m.sent) * 1000) / 10 : 0);
  const tile = (label, m, kind = 'good') => h(`div.tile.${kind}`, h('span.tile-label', label), h('span.tile-value', fmtInt(m.sent)),
    h('span.tile-sub', `відповіли ${fmtInt(m.replies)} · ${pct(conv(m))}`));

  const range = select('nights', nights, [[1, 'Остання ніч'], [7, '7 ночей'], [14, '14 ночей'], [30, '30 ночей']], { style: 'width:auto', 'aria-label': 'Період' });
  range.addEventListener('change', () => reload({ nights: Number(range.value) }));
  const whoSel = owner ? select('who', who, [['all', 'Уся команда'], ['mine', 'Мої анкети'],
    ...(shift.operators || []).filter((o) => o.id !== session.user.id).map((o) => [String(o.id), o.name])], { style: 'width:auto', 'aria-label': 'Чия статистика' }) : null;
  whoSel?.addEventListener('change', () => reload({ who: whoSel.value }));

  // ---- the team by person (team lead, the whole team) ----
  const people = owner && who === 'all' && shift.people?.length ? h('section.card', h('h3', '👥 Команда за період'),
    h('div.table-wrap', h('table.table.hover',
      h('thead', h('tr', h('th', 'Хто'), h('th.num', 'Анкет'), h('th.num', '🎯 Шанс'), h('th.num', '💬 Аллчат'), h('th.num', '💌 Відповіді'), h('th.num', 'Конверсія'), h('th.num', '🤖 ШІ'), h('th', 'Бот'))),
      h('tbody', shift.people.map((p) => h('tr', { tabindex: 0, title: 'Статистика цієї людини', onclick: () => reload({ who: p.id === session.user.id ? 'mine' : String(p.id) }) },
        h('td', h('b', p.name), p.role === 'owner' ? h('span.small.muted', ' (ви)') : null),
        h('td.num', fmtInt(p.profiles)), h('td.num', fmtInt(p.chance)), h('td.num', fmtInt(p.allchat)), h('td.num', fmtInt(p.replies)), h('td.num', pct(p.conv)),
        h('td.num', fmtInt(p.ai.calls)),
        h('td', p.bots ? badge('● працює', 'ok') : h('span.muted', 'вимкнено'))))))),
    h('p.small.muted', 'Клік по людині — її статистика. 🤖 ШІ — скільки текстів написав ШІ для її анкет.')) : null;

  // ---- profiles: the bot finds them on the site by itself ----
  const byId = new Map(shift.profiles.map((p) => [p.id, p]));
  const shown = owner && who !== 'all' ? bots.filter((b) => byId.has(b.id)) : bots;
  const opStop = (opId) => {
    const ids = shift.profiles.filter((p) => p.operator_id === opId).map((p) => p.id);
    return ids.length ? ids : [-1]; // (never an empty list: that would mean the whole team)
  };
  const profilesCard = h('section.card', h('h3', '👩 Анкети'),
    shown.length ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Анкета'), owner ? h('th', 'Оператор') : null, h('th', 'Що зараз'), h('th.num', '🎯 Шанс'), h('th.num', '💬 Аллчат'), h('th.num', '💌 Відповіді'), owner ? h('th', '') : null)),
      h('tbody', shown.map((b) => {
        const [label, kind] = STATE[b.state] || [b.state, ''];
        const st = byId.get(b.id) || {};
        const ids = owner ? (st.operator_id ? opStop(st.operator_id) : [b.id]) : [];
        return h('tr',
          h('td', h('b', b.name), b.paused ? h('div.small.muted', 'понад план — на паузі') : null),
          owner ? h('td', st.operator || '—') : null,
          h('td', badge(label, kind), b.info ? h('div.small.muted.clamp', { title: b.info }, b.info) : null),
          h('td.num', fmtInt(st.chance)), h('td.num', fmtInt(st.allchat)), h('td.num', fmtInt(st.replies)),
          owner ? h('td.num', ON.includes(b.state)
            ? h('button.btn.sm', { title: 'Вимкнути бота цього оператора', onclick: safe(() => control('stop', ids)) }, '⏹')
            : h('button.btn.sm', { title: 'Увімкнути бота цього оператора', onclick: safe(() => control('start', ids)) }, '▶')) : null);
      })))) : start(),
    shown.length ? h('p.small.muted', 'Анкети бот бере з сайту сам: увійдіть на сайт у браузері з ботом і натисніть «Увімкнути». Цифри — за останню ніч.') : null);

  // ---- by night ----
  const cell = (m) => h('td.num', fmtInt(m.sent), h('span.small.muted', ` / ${fmtInt(m.replies)}`), h('div.small.muted', pct(m.conv)));
  const other = sum.other.sent > 0; // messages outside the night modes (the old search / site hints) — only when there are some
  const byNight = h('section.card', h('h3', '🌙 По ночах'),
    h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Ніч'), h('th.num', '🎯 Шанс'), h('th.num', '💬 Аллчат'), other ? h('th.num', '📋 Інше') : null, h('th.num', 'Разом'), h('th.num', '🤖 ШІ'))),
      h('tbody', [...shift.nights].reverse().map((n) => h('tr', h('td', dayLabel(n.night)), cell(n.chance), cell(n.allchat), other ? cell(n.other) : null, cell(n.total), h('td.num', fmtInt(n.ai.calls))))))),
    h('p.small.muted', 'У клітинці: надіслано / відповіли, нижче — конверсія. Ніч — дата початку зміни.'));

  page.replaceChildren(...[
    h('div.page-head', h('h1', '🏠 Головна'), h('div.row-wrap', onBtn, offBtn)),
    h('div.row-wrap.filters', whoSel, range),
    h('div.tiles',
      tile('🎯 Шанс', sum.chance),
      tile('💬 Аллчат', sum.allchat),
      h('div.tile', h('span.tile-label', '💌 Відповідей'), h('span.tile-value', fmtInt(sum.total.replies)), h('span.tile-sub', `конверсія ${pct(conv(sum.total))}`)),
      h('div.tile', h('span.tile-label', '🤖 Бот'), h('span.tile-value', working.length ? '🟢' : '⚪'),
        h('span.tile-sub', working.length ? `працює: ${working.length} з ${bots.length} анкет` : bots.length ? 'вимкнено' : 'ще не запускався'))),
    people,
    profilesCard,
    byNight,
    telegramCard(tg),
  ].filter(Boolean));
}

/** No profiles yet: the three steps to start. */
function start() {
  const dl = h('button.btn.primary', { onclick: (e) => downloadBot(e.currentTarget) }, '⬇ Завантажити бота');
  return h('div.start-steps',
    h('ol.steps',
      h('li', dl, ' — це ваша особиста копія.'),
      h('li', 'Chrome → ', h('code', 'chrome://extensions'), ' → «Режим розробника» → «Завантажити розпаковане» → тека бота.'),
      h('li', 'Відкрийте сайт, увійдіть в анкету, у вікні бота — ваш логін і «▶ Увімкнути». Анкети бот знайде сам.')));
}

/** 📲 Telegram: each person links their own. */
export function telegramCard(info) {
  const box = h('section.card');
  const render = (i) => {
    const link = h('button.btn.primary', i.linked ? 'Підключити заново' : 'Підключити Telegram');
    link.addEventListener('click', () => busy(link, async () => {
      const r = await post('/api/me/telegram/link', {});
      if (r.url) window.open(r.url, '_blank', 'noopener');
      toast('Відкрийте бота й натисніть «Старт» — і все');
    }).catch(() => {}));
    const off = h('button.btn.ghost', 'Відключити');
    off.addEventListener('click', () => busy(off, async () => render({ ...(await del('/api/me/telegram')), bot: i.bot, ready: i.ready })).catch(() => {}));
    box.replaceChildren(...[h('h3', '📲 Telegram'),
      h('p', i.linked ? '✅ Підключено. Після кожної розсилки — міні-звіт; кнопки в боті: 📊 Звіт, 🤖 Стан, ▶️ Старт, ⏹ Стоп.'
        : 'Звіти після кожної розсилки й ▶/⏹ з телефону. Кнопка → відкриється бот → «Старт».'),
      i.ready ? h('div.row-wrap', link, i.linked ? off : null) : h('p.small.muted', 'Telegram-бот платформи ще не налаштований — напишіть адміну.')].filter(Boolean));
  };
  render(info);
  return box;
}


