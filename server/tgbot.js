// The platform's Telegram bot: each person links their Telegram from the panel (one tap), then gets the reports of
// what they run and controls their bots with buttons. Long polling — works on Railway without a webhook.
import crypto from 'node:crypto';
import { platformGet, platformSet, now } from './db.js';
import { tgCall, escapeHtml } from './telegram.js';
import { summaryFor } from './reports.js';
import { startBots, stopBotsFor, botStatus } from './control.js';
import { tr, both, langOf } from './i18n.js';
import { getSettings } from './services.js';
import { personShift, inShift, shiftText } from './shift.js';

const BUTTONS = { report: '📊 Звіт', status: '🤖 Стан', start: '▶️ Старт', stop: '⏹ Стоп' };
const keyboard = (lang) => ({ reply_markup: { keyboard: [[{ text: tr(lang, BUTTONS.report) }, { text: tr(lang, BUTTONS.status) }], [{ text: tr(lang, BUTTONS.start) }, { text: tr(lang, BUTTONS.stop) }]], resize_keyboard: true } });
const ROLE = { admin: 'адмін платформи', owner: 'тімлід', operator: 'оператор' };
const STATE = { running: '🟢 працює', watching: '🟢 стежить', paused: '⏸ пауза', limit: '🔵 ліміт', error: '🔴 помилка', done: '⚪ завершив', idle: '⚪ чекає', starting: '🟡 запускається', off: '⚪ вимкнено' };
/** A button pressed in either language (the person may have switched it). */
const pressed = (text, key) => both(BUTTONS[key]).includes(text);

export const platformToken = (db) => platformGet(db, 'tgToken', '') || process.env.TELEGRAM_BOT_TOKEN || '';

/** Saves the platform bot's token (admin) and learns its @name; '' switches the bot off. */
export async function setPlatformBot(db, token) {
  const t = String(token || '').trim();
  if (!t) { platformSet(db, 'tgToken', ''); platformSet(db, 'tgBotName', ''); return { ok: true, name: '' }; }
  const me = await tgCall(t, 'getMe');
  if (!me.ok) return { ok: false, error: me.error || 'Telegram не прийняв токен' };
  platformSet(db, 'tgToken', t);
  platformSet(db, 'tgBotName', me.result?.username || '');
  return { ok: true, name: me.result?.username || '' };
}

/** A one-time link for the panel: «open the bot, press Start» links this person. */
export function linkFor(db, userId) {
  const code = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE users SET tg_code = ?, tg_code_at = ? WHERE id = ?').run(code, now(), userId);
  const name = platformGet(db, 'tgBotName', '');
  return { code, bot: name, url: name ? `https://t.me/${name}?start=${code}` : '' };
}

const send = (db, chatId, text, extra) => tgCall(platformToken(db), 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra ?? {}) });

/** One incoming message from Telegram. */
export async function handleUpdate(db, update) {
  const m = update?.message;
  const chatId = m?.chat?.id;
  const text = String(m?.text || '').trim();
  if (!chatId || !text || m.chat.type !== 'private') return;
  // linking: /start <code> from the panel's button
  const code = /^\/start\s+([\w-]{6,40})$/.exec(text)?.[1];
  if (code) {
    const u = db.prepare('SELECT * FROM users WHERE tg_code = ?').get(code);
    if (!u || !u.active || (u.tg_code_at && now() - u.tg_code_at > 30 * 60000)) { await send(db, chatId, tr(u?.lang, 'Посилання застаріло. Натисніть «Підключити Telegram» у панелі ще раз.')); return; }
    db.prepare("UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?").run(String(chatId), u.id); // one chat — one person
    db.prepare('UPDATE users SET tg_chat_id = ?, tg_code = NULL WHERE id = ?').run(String(chatId), u.id);
    await send(db, chatId, tr(u.lang, '✅ Підключено: <b>{name}</b> ({role}).\nСюди приходитимуть ваші звіти й сповіщення про нові відповіді. Кнопки внизу — звіт, стан і керування ботом.',
      { name: escapeHtml(u.name), role: tr(u.lang, ROLE[u.role] || u.role) }), keyboard(u.lang));
    return;
  }
  const u = db.prepare('SELECT * FROM users WHERE tg_chat_id = ?').get(String(chatId));
  if (!u || !u.active || u.pending) { await send(db, chatId, tr('uk', 'Цей Telegram ще не підключено. У панелі натисніть «Підключити Telegram».')); return; }
  const lang = langOf(u.lang);
  const T = (t, v) => tr(lang, t, v);
  const reply = (t) => send(db, chatId, t, keyboard(lang));
  const user = { ...u, agencyId: u.agency_id };
  const cmd = text.toLowerCase();
  if (cmd === '/report' || pressed(text, 'report')) { await reply(summaryFor(db, u)); return; }
  if (cmd === '/status' || pressed(text, 'status')) {
    if (u.role === 'admin') { await reply(summaryFor(db, u)); return; }
    const bots = botStatus(db, user);
    await reply(bots.length ? bots.map((b) => `${T(STATE[b.state] || b.state)} — <b>${escapeHtml(b.name)}</b>${b.paused ? ` ${T('(анкета на паузі)')}` : ''}${b.info ? `\n   ${escapeHtml(b.info.slice(0, 80))}` : ''}`).join('\n') : T('Анкет немає'));
    return;
  }
  if (cmd === '/run' || cmd === '/start' || pressed(text, 'start')) {
    if (u.role === 'admin') { await reply(T('Адмін керує ботами команд у панелі («Пульт»).')); return; }
    if (u.bot_off) { await reply(T('⛔ Доступ до бота призупинено керівником команди.')); return; }
    // outside the shift the bot does not work (it starts by itself when the shift begins)
    const settings = getSettings(db, u.agency_id);
    const w = personShift(settings, u.prefs);
    if (w.auto && !inShift(Date.now(), settings.timezone, w)) { await reply(T('🌙 Зараз не ваша зміна ({hours}). Бот увімкнеться сам на початку зміни.', { hours: tr(lang, shiftText(w)) })); return; }
    const rows = startBots(db, user);
    await reply(rows.length ? T('▶️ Запускаю ({n}): {names}.\nБот у браузері підхопить протягом хвилини — браузер з ботом має бути відкритий.', { n: rows.length, names: rows.map((r) => escapeHtml(r.name)).join(', ') })
      : T('Немає активних анкет, які можна запустити.'));
    return;
  }
  if (cmd === '/stop' || pressed(text, 'stop')) {
    if (u.role === 'admin') { await reply(T('Адмін керує ботами команд у панелі («Пульт»).')); return; }
    const rows = stopBotsFor(db, user);
    await reply(rows.length ? T('⏹ Зупиняю ({n}): {names}.', { n: rows.length, names: rows.map((r) => escapeHtml(r.name)).join(', ') }) : T('Анкет немає'));
    return;
  }
  await reply(T('Кнопки внизу: {list}', { list: Object.values(BUTTONS).map((b) => T(b)).join(' · ') }));
}

/** One round of long polling (tests call it directly); returns how many updates came. */
export async function pollOnce(db, timeoutSec = 25) {
  const token = platformToken(db);
  if (!token) return 0;
  const offset = Number(platformGet(db, 'tgOffset', '0')) || 0;
  const r = await tgCall(token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 10) * 1000);
  if (!r.ok || !Array.isArray(r.result)) return 0;
  for (const up of r.result) {
    platformSet(db, 'tgOffset', String(up.update_id + 1));
    try { await handleUpdate(db, up); } catch { /* one bad message never stops the bot */ }
  }
  return r.result.length;
}

/** Runs the polling loop for as long as the server lives; picks up a new token without a restart. */
export function startTelegramBot(db, log = console) {
  let stopped = false;
  (async () => {
    // a token from .env (a local test): learn the bot's @name once, so the panel's «Підключити Telegram» works at once
    if (!platformGet(db, 'tgToken', '') && process.env.TELEGRAM_BOT_TOKEN && !platformGet(db, 'tgBotName', '')) {
      const r = await setPlatformBot(db, process.env.TELEGRAM_BOT_TOKEN).catch((e) => ({ ok: false, error: e.message }));
      log.log?.(r.ok ? `  Telegram: @${r.name} підключено з .env` : `  Telegram: токен з .env не прийнято (${r.error})`);
    }
    while (!stopped) {
      if (!platformToken(db)) { await new Promise((r) => setTimeout(r, 15000)); continue; }
      const t = now();
      try { await pollOnce(db); } catch (e) { log.error?.('telegram', e.message); }
      if (now() - t < 1000) await new Promise((r) => setTimeout(r, 3000)); // an error came back at once: do not hammer
    }
  })();
  return () => { stopped = true; };
}
