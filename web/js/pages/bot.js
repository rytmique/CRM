import { h, field, input, select, busy, toast, fmtInt, safe, badge } from '../ui.js';
import { get, put, post, del, session } from '../api.js';

const STATE = {
  running: ['🟢 працює', 'ok'], watching: ['🟢 стежить за відповідями', 'ok'], waiting: ['🟢 пауза між чоловіками', 'ok'], sleeping: ['🌙 неробочий час', ''],
  paused: ['⏸ пауза', 'warn'], blocked: ['🛑 капча — потрібна людина', 'err'], limit: ['🔵 ліміт на сьогодні', ''], error: ['🔴 помилка', 'err'],
  done: ['⚪ завершив', ''], idle: ['⚪ чекає', ''], starting: ['🟡 запускається…', 'warn'], off: ['⚪ вимкнено', ''],
};
const WHO = [['silent', 'Хто замовк'], ['replied', 'Хто колись відповідав'], ['all', 'Усім чатам']];

/**
 * 🤖 The bot: start / stop, what it does tonight, the few settings of the shift and the Telegram link.
 * Team lead — the whole team and the settings; operator — their own profiles (settings read-only).
 */
export default async function botPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const owner = session.user.role === 'owner';
  const [{ bots }, shift, tgInfo, conf] = await Promise.all([
    get('/api/bots'), get('/api/stats/shift?nights=2'), get('/api/me/telegram'), owner ? get('/api/settings') : Promise.resolve(null),
  ]);
  const last = shift.nights.at(-1);
  const byId = new Map(shift.profiles.map((p) => [p.id, p]));

  const startAll = h('button.btn.primary', '▶ Запустити всіх');
  const stopAll = h('button.btn', '⏹ Зупинити всіх');
  startAll.addEventListener('click', () => busy(startAll, async () => {
    const r = await post('/api/bots/start', {});
    toast(r.started.length ? `Запуск: ${r.started.length}. Бот у браузері підхопить протягом хвилини` : 'Немає активних анкет', r.started.length ? 'ok' : 'warn');
    setTimeout(() => botPage(main), 1500);
  }).catch(() => {}));
  stopAll.addEventListener('click', () => busy(stopAll, async () => {
    const r = await post('/api/bots/stop', {});
    toast(`Зупиняю: ${r.stopped.length}`);
    setTimeout(() => botPage(main), 1500);
  }).catch(() => {}));

  const tile = (label, value, sub, kind = '') => h(`div.tile${kind ? `.${kind}` : ''}`, h('span.tile-label', label), h('span.tile-value', value), sub ? h('span.tile-sub', sub) : null);
  const tiles = h('div.tiles',
    tile('🎯 Шанс за ніч', fmtInt(last?.chance.sent), `відповіли ${fmtInt(last?.chance.replies)} · ${last?.chance.conv || 0}%`, 'good'),
    tile('💬 Аллчат за ніч', fmtInt(last?.allchat.sent), `відповіли ${fmtInt(last?.allchat.replies)} · ${last?.allchat.conv || 0}%`, 'good'),
    tile('💌 Відповідей', fmtInt(last?.total.replies), `конверсія ${last?.total.conv || 0}%`),
    tile('🤖 Працює ботів', fmtInt(bots.filter((b) => !['off', 'idle', 'done', 'error'].includes(b.state)).length), `з ${bots.length} анкет`));

  const row = (b) => {
    const [label, kind] = STATE[b.state] || [b.state, ''];
    const st = byId.get(b.id) || {};
    const one = (path, text) => h('button.btn.sm', { onclick: safe(async () => {
      const r = await post(`/api/bots/${path}`, { ids: [b.id] });
      toast(path === 'start' ? (r.started.length ? 'Запуск протягом хвилини' : 'Анкета на паузі') : 'Зупиняю');
      setTimeout(() => botPage(main), 1200);
    }) }, text);
    return h('tr', h('td', h('b', b.name), b.paused ? h('span.small.muted', ' (анкета на паузі)') : null),
      h('td', badge(label, kind), b.info ? h('div.small.muted.clamp', { title: b.info }, b.info) : null),
      h('td.num', fmtInt(st.chance)), h('td.num', fmtInt(st.allchat)), h('td.num', fmtInt(st.replies)),
      h('td.num', ['running', 'watching', 'waiting', 'sleeping', 'blocked', 'starting'].includes(b.state) ? one('stop', '⏹') : one('start', '▶')));
  };
  const table = bots.length
    ? h('table.table', h('thead', h('tr', h('th', 'Анкета'), h('th', 'Що зараз'), h('th.num', 'Шанс'), h('th.num', 'Аллчат'), h('th.num', 'Відповіді'), h('th', ''))), h('tbody', bots.map(row)))
    : h('p.muted', 'Анкет ще немає — додайте в «Анкети».');

  // ---- Telegram: each person links their own ----
  const tgBox = h('section.card', h('h3', '📲 Telegram'));
  const renderTg = (info) => {
    const linkBtn = h('button.btn.primary', info.linked ? 'Підключити заново' : 'Підключити Telegram');
    linkBtn.addEventListener('click', () => busy(linkBtn, async () => {
      const r = await post('/api/me/telegram/link', {});
      if (r.url) window.open(r.url, '_blank', 'noopener');
      toast('Відкрийте бота й натисніть «Старт» — і все');
    }).catch(() => {}));
    const off = h('button.btn.ghost', 'Відключити');
    off.addEventListener('click', () => busy(off, async () => { renderTg({ ...(await del('/api/me/telegram')), bot: info.bot, ready: info.ready }); }).catch(() => {}));
    tgBox.replaceChildren(h('h3', '📲 Telegram'),
      h('p', info.linked ? '✅ Підключено. Після кожної розсилки сюди приходить міні-звіт, а кнопки в боті — 📊 Звіт, 🤖 Стан, ▶️ Старт, ⏹ Стоп.'
        : 'Звіти після кожної розсилки й керування ботом з телефону. Натисніть кнопку → відкриється бот → «Старт».'),
      info.ready ? h('div.row-wrap', linkBtn, info.linked ? off : null) : h('p.small.muted', 'Telegram-бот платформи ще не налаштований — напишіть адміну.'));
  };
  renderTg(tgInfo);

  page.replaceChildren(
    h('div.page-head', h('h1', '🤖 Бот'), h('div.row-wrap', startAll, stopAll)),
    tiles,
    h('section.card', h('h3', 'Анкети зараз'), table,
      h('p.small.muted', 'Бот працює в браузері оператора: браузер має бути відкритий, бот — увійти. «▶» з панелі чи Telegram він підхоплює протягом хвилини.')),
    h('div.settings-grid', owner ? modesCard(conf, () => botPage(main)) : modesView(bots.length), tgBox));
}

/** The team lead's few settings of the shift. */
function modesCard(conf, reload) {
  const m = conf.settings.modes;
  const chanceOn = h('input', { type: 'checkbox', checked: m.chance.on });
  const every = select('everyMin', m.chance.everyMin, [[15, 'кожні 15 хв'], [20, 'кожні 20 хв'], [30, 'кожні 30 хв'], [45, 'кожні 45 хв'], [60, 'щогодини'], [90, 'кожні 1,5 год'], [120, 'кожні 2 год']]);
  const online = h('input', { type: 'checkbox', checked: m.chance.onlineOnly });
  const acOn = h('input', { type: 'checkbox', checked: m.allchat.on });
  const perNight = select('perNight', m.allchat.perNight, [[1, '1 раз за ніч'], [2, '2 рази за ніч'], [3, '3 рази за ніч'], [4, '4 рази за ніч']]);
  const who = select('who', m.allchat.who, WHO);
  const silent = input('silentHours', m.allchat.silentHours, { type: 'number', min: 1, max: 72 });
  const gap = input('gapHours', m.allchat.gapHours, { type: 'number', min: 1, max: 12 });
  const reports = h('input', { type: 'checkbox', checked: conf.settings.reports.eachPass });
  const auto = h('input', { type: 'checkbox', checked: m.autoReply.on, disabled: !conf.autoReplyOpen });
  const save = h('button.btn.primary', 'Зберегти');
  save.addEventListener('click', () => busy(save, async () => {
    await put('/api/settings', { settings: {
      modes: {
        chance: { on: chanceOn.checked, everyMin: Number(every.value), onlineOnly: online.checked },
        allchat: { on: acOn.checked, perNight: Number(perNight.value), who: who.value, silentHours: Number(silent.value), gapHours: Number(gap.value) },
        autoReply: { on: auto.checked },
      },
      reports: { eachPass: reports.checked },
    } });
    toast('Збережено. Бот візьме нове при наступному запуску');
    reload();
  }).catch(() => {}));
  return h('section.card', h('h3', '⚙ Що робить бот за зміну'),
    h('label.check', chanceOn, h('b', '🎯 Шанс'), ' — лист-інвайт з фото кожному, кому ще не писали'),
    h('div.pair', field('Як часто', every), h('label.check', online, 'Лише тим, хто онлайн')),
    h('label.check', acOn, h('b', '💬 Аллчат'), ' — повідомлення на тему розмови в постійні чати'),
    h('div.pair', field('Скільки разів', perNight), field('Кому', who)),
    h('div.pair', field('«Замовк» — мовчить годин', silent), field('Пауза між повідомленнями, год', gap)),
    h('p.small.muted', 'Бот ніколи не пише туди, де чоловік чекає відповіді, і не відкриває непрочитані — відповідає жива людина.'),
    h('label.check', auto, '🔒 Бот сам продовжує розмову після відповіді', conf.autoReplyOpen ? null : h('span.small.muted', ' — скоро')),
    h('label.check', reports, '📲 Звіт у Telegram після кожної розсилки'),
    h('p.small.muted', 'Фото для «Шансу» — у картці анкети (позначка «🎯 Шанс»). Робочі години й темп — як у сценарії сайту.'),
    save);
}

/** Operators see what the team lead set. */
function modesView() {
  return h('section.card', h('h3', '⚙ Що робить бот за зміну'),
    h('p', '🎯 Шанс — лист-інвайт з фото онлайн-чоловікам, кому ще не писали. 💬 Аллчат — кілька разів за ніч повідомлення на тему розмови в постійні чати.'),
    h('p.small.muted', 'Як часто і кому — налаштовує керівник команди. Фото для «Шансу» — у картці вашої анкети (позначка «🎯 Шанс»).'));
}
