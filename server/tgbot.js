// The platform's Telegram bot: each person links their Telegram from the panel (one tap), then gets the reports of
// what they run and controls their bots with buttons. Long polling — works on Railway without a webhook.
import crypto from 'node:crypto';
import { platformGet, platformSet, now } from './db.js';
import { tgCall, escapeHtml } from './telegram.js';
import { summaryFor } from './reports.js';
import { startBots, stopBotsFor, botStatus } from './control.js';

const BUTTONS = { report: '📊 Звіт', status: '🤖 Стан', start: '▶️ Старт', stop: '⏹ Стоп' };
const KEYBOARD = { reply_markup: { keyboard: [[{ text: BUTTONS.report }, { text: BUTTONS.status }], [{ text: BUTTONS.start }, { text: BUTTONS.stop }]], resize_keyboard: true } };
const ROLE = { admin: 'адмін платформи', owner: 'тімлід', operator: 'оператор' };
const STATE = { running: '🟢 працює', watching: '🟢 стежить', paused: '⏸ пауза', limit: '🔵 ліміт', error: '🔴 помилка', done: '⚪ завершив', idle: '⚪ чекає', starting: '🟡 запускається', off: '⚪ вимкнено' };

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
  db.prepare('UPDATE users SET tg_code = ? WHERE id = ?').run(code, userId);
  const name = platformGet(db, 'tgBotName', '');
  return { code, bot: name, url: name ? `https://t.me/${name}?start=${code}` : '' };
}

const send = (db, chatId, text, extra = KEYBOARD) => tgCall(platformToken(db), 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

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
    if (!u || !u.active) { await send(db, chatId, 'Посилання застаріло. Натисніть «Підключити Telegram» у панелі ще раз.', {}); return; }
    db.prepare("UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?").run(String(chatId), u.id); // one chat — one person
    db.prepare('UPDATE users SET tg_chat_id = ?, tg_code = NULL WHERE id = ?').run(String(chatId), u.id);
    await send(db, chatId, `✅ Підключено: <b>${escapeHtml(u.name)}</b> (${ROLE[u.role] || u.role}).\nСюди приходитимуть звіти після кожної розсилки. Кнопки внизу — звіт, стан і керування ботом.`);
    return;
  }
  const u = db.prepare('SELECT * FROM users WHERE tg_chat_id = ?').get(String(chatId));
  if (!u || !u.active || u.pending) { await send(db, chatId, 'Цей Telegram ще не підключено. У панелі натисніть «Підключити Telegram».', {}); return; }
  const user = { ...u, agencyId: u.agency_id };
  const cmd = text.toLowerCase();
  if (cmd === '/report' || text === BUTTONS.report) { await send(db, chatId, summaryFor(db, u)); return; }
  if (cmd === '/status' || text === BUTTONS.status) {
    if (u.role === 'admin') { await send(db, chatId, summaryFor(db, u)); return; }
    const bots = botStatus(db, user);
    await send(db, chatId, bots.length ? bots.map((b) => `${STATE[b.state] || b.state} — <b>${escapeHtml(b.name)}</b>${b.paused ? ' (анкета на паузі)' : ''}${b.info ? `\n   ${escapeHtml(b.info.slice(0, 80))}` : ''}`).join('\n') : 'Анкет немає');
    return;
  }
  if (cmd === '/run' || cmd === '/start' || text === BUTTONS.start) {
    if (u.role === 'admin') { await send(db, chatId, 'Адмін керує ботами команд у панелі («Пульт»).'); return; }
    const rows = startBots(db, user);
    await send(db, chatId, rows.length ? `▶️ Запускаю (${rows.length}): ${rows.map((r) => escapeHtml(r.name)).join(', ')}.\nБот у браузері підхопить протягом хвилини — браузер з ботом має бути відкритий.` : 'Немає активних анкет, які можна запустити.');
    return;
  }
  if (cmd === '/stop' || text === BUTTONS.stop) {
    if (u.role === 'admin') { await send(db, chatId, 'Адмін керує ботами команд у панелі («Пульт»).'); return; }
    const rows = stopBotsFor(db, user);
    await send(db, chatId, rows.length ? `⏹ Зупиняю (${rows.length}): ${rows.map((r) => escapeHtml(r.name)).join(', ')}.` : 'Анкет немає.');
    return;
  }
  await send(db, chatId, `Кнопки внизу: ${Object.values(BUTTONS).join(' · ')}`);
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
