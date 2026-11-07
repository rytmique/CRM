// A new version of the bot: everyone who uses the bot hears about it in Telegram — outside their shift, so the update
// happens between shifts. An old copy is not let to start (routes/bot.js startGate), and the note says so plainly.
import { cmpVersion } from './db.js';
import { latestBotVersion } from './version.js';
import { getSettings } from './services.js';
import { sendToUsers } from './reports.js';
import { personShift, inShift, shiftText } from './shift.js';
import { tr } from './i18n.js';

/** One round: returns how many people were told. */
export async function announceUpdate(db, t = Date.now()) {
  const latest = latestBotVersion();
  // people who have used the bot (a bot session or a downloaded copy) and have not heard about this version yet
  const rows = db.prepare(`SELECT u.id, u.agency_id, u.prefs, u.bot_notified,
      (SELECT s.version FROM sessions s WHERE s.user_id = u.id AND s.kind = 'bot' ORDER BY s.last_used_at DESC LIMIT 1) AS version
    FROM users u WHERE u.role IN ('owner','operator') AND u.active = 1 AND u.pending = 0 AND u.bot_off = 0 AND u.bot_notified != ?
      AND (EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.kind = 'bot') OR EXISTS (SELECT 1 FROM extension_builds b WHERE b.user_id = u.id))`).all(latest);
  let told = 0;
  for (const u of rows) {
    // already on the newest one: nothing to say
    if (u.version && cmpVersion(u.version, latest) >= 0) { db.prepare('UPDATE users SET bot_notified = ? WHERE id = ?').run(latest, u.id); continue; }
    const settings = getSettings(db, u.agency_id);
    const w = personShift(settings, u.prefs);
    if (w.auto && inShift(t, settings.timezone, w)) continue; // in the middle of a shift: after it
    const n = await sendToUsers(db, settings, [u.id], (lang) => tr(lang, '🆕 <b>Нова версія бота {v}</b>\nОновіть до початку наступної зміни ({hours}):\n1. Панель → «Завантажити бота».\n2. Розпакуйте в ту саму теку (замінити файли).\n3. Chrome → chrome://extensions → ⟳ біля бота.\n\n⛔ Зі старою версією бот не запуститься.',
      { v: latest, hours: tr(lang, shiftText(w)) }));
    // (no Telegram linked: nothing to send now — marked anyway, the bot itself says it at the start)
    db.prepare('UPDATE users SET bot_notified = ? WHERE id = ?').run(latest, u.id);
    told += n;
  }
  return told;
}

/** Every 10 minutes for as long as the server lives. */
export function startUpdateNotes(db, log = console) {
  const run = () => announceUpdate(db).catch((e) => log.error?.('updates:', e.message));
  setTimeout(run, 30000).unref?.();
  return setInterval(run, 10 * 60000).unref?.();
}
