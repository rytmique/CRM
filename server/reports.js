// Shift reports: which «night» a moment belongs to, the mini report after each pass of a mode, sent to Telegram.
import { platformGet, now } from './db.js';
import { profileSettings } from './services.js';
import { dayKey } from './util.js';
import { sendTelegram, escapeHtml } from './telegram.js';
import { tr } from './i18n.js';

const HOUR = 3600000;

/** Local hour (0–23) of a moment in a timezone. */
function localHour(t, tz) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(t)); } catch { return new Date(t).getUTCHours(); }
}

/**
 * The shift a moment belongs to, as the date it started on: a night shift 20:00–06:00 is one «night» across midnight.
 * Without working hours (around the clock) the day changes at 06:00.
 */
export function shiftKey(t = now(), tz = 'UTC', human = {}) {
  const from = Number(human.hoursFrom ?? 0);
  const to = Number(human.hoursTo ?? 0);
  if (from === to) return dayKey(t - 6 * HOUR, tz);
  if (from > to && localHour(t, tz) < to) return dayKey(t - 24 * HOUR, tz); // after midnight of a night shift
  return dayKey(t, tz);
}

/** The Telegram bot that sends: the platform's own (set by the admin) — or the team's, if it set one up. */
export function tgToken(db, settings) {
  return platformGet(db, 'tgToken', '') || process.env.TELEGRAM_BOT_TOKEN || settings?.telegram?.botToken || '';
}

/**
 * Sends a text to people (by user id) who linked their Telegram; returns how many got it.
 * `text` may be a function of the person's language (uk / ru): each gets it in their own.
 */
export async function sendToUsers(db, settings, userIds, text, extra) {
  const token = tgToken(db, settings);
  if (!token) return 0;
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const rows = db.prepare(`SELECT tg_chat_id, lang FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND active = 1 AND tg_chat_id IS NOT NULL AND tg_chat_id != ''`).all(...ids);
  let n = 0;
  for (const r of rows) if ((await sendTelegram(token, r.tg_chat_id, typeof text === 'function' ? text(r.lang) : text, extra)).ok) n++;
  return n;
}

const MODE_TITLE = { chance: '🎯 Шанс', allchat: '💬 Аллчат', hint: '💡 Підказки сайту', list: '📋 Пошук', due: '🔁 Повторні' };
const modeTitle = (lang, m) => (MODE_TITLE[m] ? tr(lang, MODE_TITLE[m]) : m);

/** Totals of a profile for one night: by mode, and the replies that came in since the shift began. */
export function nightTotals(db, profileId, night) {
  const by = Object.fromEntries(db.prepare('SELECT mode, SUM(sent) AS sent, SUM(failed) AS failed, MIN(started_at) AS start FROM passes WHERE profile_id = ? AND night = ? GROUP BY mode')
    .all(profileId, night).map((r) => [r.mode, r]));
  const start = Math.min(...Object.values(by).map((r) => r.start), now());
  const replies = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND replied_at >= ?").get(profileId, start).n
    + db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE profile_id = ? AND replied_at >= ?').get(profileId, start).n;
  return { by, replies };
}

/** The mini report text for one pass, in the reader's language. */
export function passText(db, pass, profile, lang = 'uk') {
  let info = {};
  try { info = JSON.parse(pass.info || '{}'); } catch { /* none */ }
  const T = (t, v) => tr(lang, t, v);
  const mins = Math.max(1, Math.round((pass.ended_at - pass.started_at) / 60000));
  const lines = [`${pass.failed ? '⚠️' : '✅'} <b>${modeTitle(lang, pass.mode)}</b> · ${escapeHtml(profile.name)}`];
  if (pass.mode === 'chance') {
    lines.push(T('Листів з фото: <b>{n}</b>', { n: pass.sent }) + (pass.seen ? T(' (онлайн {n}{more})', { n: pass.seen, more: info.contacted ? T(', уже писали {n}', { n: info.contacted }) : '' }) : ''));
  } else if (pass.mode === 'allchat') {
    const why = [info.waits && T('чекають відповіді людини {n}', { n: info.waits }), info.nightLimit && T('ліміт ночі {n}', { n: info.nightLimit }),
      info.notQuiet && T('ще не замовкли {n}', { n: info.notQuiet }), info.tooSoon && T('рано {n}', { n: info.tooSoon }),
      info.neverReplied && T('ще не відповідали {n}', { n: info.neverReplied })].filter(Boolean);
    lines.push(T('Повідомлень на тему розмови: <b>{n}</b>', { n: pass.sent }) + (pass.seen ? T(' з {n} діалогів', { n: pass.seen }) : ''));
    if (why.length) lines.push(T('Пропущено: {list}', { list: why.join(' · ') }));
  } else {
    lines.push(T('Надіслано: <b>{n}</b>', { n: pass.sent }));
  }
  if (pass.failed) lines.push(T('Помилок: {n}', { n: pass.failed }) + (info.error ? ` — ${escapeHtml(String(info.error).slice(0, 120))}` : ''));
  if (info.captcha) lines.push(T('🛑 Сайт показав капчу — бот чекає людину'));
  const tot = nightTotals(db, pass.profile_id, pass.night);
  const parts = Object.entries(tot.by).map(([m, r]) => `${modeTitle(lang, m).split(' ').slice(1).join(' ')} ${r.sent}`);
  lines.push(T('За ніч: {parts} · відповідей {replies} · {mins} хв', { parts: parts.join(' · ') || '—', replies: tot.replies, mins }));
  if (info.next) lines.push(T('Наступний прохід ≈ {at}', { at: escapeHtml(String(info.next).slice(0, 10)) }));
  return lines.join('\n');
}

/** After each pass: the mini report to the person who runs the bot and to the profile's operator (each in their language). */
export async function reportPass(db, passId) {
  const pass = db.prepare('SELECT * FROM passes WHERE id = ?').get(passId);
  if (!pass) return 0;
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(pass.profile_id);
  if (!profile) return 0;
  const settings = profileSettings(db, profile);
  return sendToUsers(db, settings, [pass.operator_id, profile.operator_id], (lang) => passText(db, pass, profile, lang));
}

/** A summary of the night for one person: everything they may see (operator — their profiles, owner — the team, admin — everyone). */
export function summaryFor(db, user) {
  const scope = user.role === 'admin' ? { where: '1 = 1', params: [] }
    : user.role === 'operator' ? { where: 'p.agency_id = ? AND p.operator_id = ?', params: [user.agency_id, user.id] }
      : { where: 'p.agency_id = ?', params: [user.agency_id] };
  const profiles = db.prepare(`SELECT p.* FROM profiles p WHERE ${scope.where} ORDER BY p.name LIMIT 60`).all(...scope.params);
  const lines = [];
  let sum = { chance: 0, allchat: 0, replies: 0 };
  for (const p of profiles) {
    // the profile's latest night (its own working hours decide where a night ends)
    const night = db.prepare('SELECT night FROM passes WHERE profile_id = ? ORDER BY id DESC LIMIT 1').get(p.id)?.night;
    const tot = night ? nightTotals(db, p.id, night) : { by: {}, replies: 0 };
    const ch = tot.by.chance?.sent || 0;
    const ac = tot.by.allchat?.sent || 0;
    sum = { chance: sum.chance + ch, allchat: sum.allchat + ac, replies: sum.replies + tot.replies };
    const state = { running: '🟢', paused: '⏸', limit: '🔵', error: '🔴', done: '⚪', idle: '⚪' }[p.bot_state] || '⚪';
    const fresh = p.bot_last_seen && now() - p.bot_last_seen < 5 * 60000;
    lines.push(`${fresh ? state : '⚪'} ${tr(user.lang, '<b>{name}</b>: Шанс {chance} · Аллчат {allchat} · відповідей {replies}', { name: escapeHtml(p.name), chance: ch, allchat: ac, replies: tot.replies })}`);
  }
  return [tr(user.lang, '📊 <b>Звіт за ніч</b>'), tr(user.lang, 'Шанс {chance} · Аллчат {allchat} · відповідей {replies}', sum), '',
    ...(lines.length ? lines : [tr(user.lang, 'Анкет немає')])].join('\n');
}
