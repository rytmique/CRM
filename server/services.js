import { now } from './db.js';
import { parseSettings, dayKey, notFound } from './util.js';

export const BOT_ONLINE_MS = 2 * 60 * 1000;
const DAY = 86400000;

export function getSettings(db, agencyId) {
  const row = db.prepare('SELECT settings FROM agencies WHERE id = ?').get(agencyId);
  return parseSettings(row?.settings);
}

export function today(db, agencyId) {
  return dayKey(now(), getSettings(db, agencyId).timezone);
}

/** Human status for a license row. */
export function licenseState(l, t = now()) {
  if (!l) return { state: 'none', valid: false, daysLeft: 0 };
  if (l.status === 'revoked') return { state: 'revoked', valid: false, daysLeft: 0 };
  if (!l.activated_at) return { state: l.profile_id ? 'active' : 'free', valid: Boolean(l.profile_id), daysLeft: l.days };
  const daysLeft = Math.max(0, Math.ceil((l.expires_at - t) / DAY));
  if (l.expires_at <= t) return { state: 'expired', valid: false, daysLeft: 0 };
  return { state: l.profile_id ? 'active' : 'free', valid: Boolean(l.profile_id), daysLeft };
}

/** SQL fragment + params limiting profiles to what the user may see. Alias: p */
export function profileScope(user) {
  if (user.role === 'operator') return { where: 'p.agency_id = ? AND p.operator_id = ?', params: [user.agencyId, user.id] };
  return { where: 'p.agency_id = ?', params: [user.agencyId] };
}

export function getVisibleProfile(db, user, id) {
  const scope = profileScope(user);
  const p = db.prepare(`SELECT p.* FROM profiles p WHERE p.id = ? AND ${scope.where}`).get(Number(id), ...scope.params);
  if (!p) throw notFound('Анкету не знайдено');
  return p;
}

export function profileLicense(db, profileId) {
  return db.prepare('SELECT * FROM licenses WHERE profile_id = ?').get(profileId) || null;
}

export function activeInvite(db, profileId) {
  return db.prepare('SELECT * FROM invites WHERE profile_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(profileId) || null;
}

export function limitsFor(profile, settings) {
  const d = settings.defaults;
  const minDelay = profile.min_delay ?? d.minDelay;
  const maxDelay = Math.max(minDelay, profile.max_delay ?? d.maxDelay);
  return { dailyLimit: profile.daily_limit ?? d.dailyLimit, minDelay, maxDelay };
}

/** Messages sent today: first contacts + follow-up messages. */
export function sentToday(db, profileId, day) {
  const first = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND day = ? AND status = 'sent'").get(profileId, day).n;
  const more = db.prepare('SELECT COALESCE(SUM(messages), 0) AS n FROM touches WHERE profile_id = ? AND day = ? AND ok = 1').get(profileId, day).n;
  return first + more;
}

const HOUR = 3600000;

/** Per-hour cap: how many more messages fit into the last 60 minutes, and when the window frees up. */
export function hourWindow(db, profileId, perHour, t = now()) {
  if (!perHour) return { left: null, resetAt: null };
  const from = t - HOUR;
  const times = [
    ...db.prepare("SELECT sent_at AS at FROM messages WHERE profile_id = ? AND status = 'sent' AND sent_at > ?").all(profileId, from),
    ...db.prepare('SELECT at FROM touches WHERE profile_id = ? AND ok = 1 AND messages > 0 AND at > ?').all(profileId, from),
  ].map((r) => r.at).sort((a, b) => a - b);
  const left = Math.max(0, perHour - times.length);
  return { left, resetAt: left > 0 ? null : times[times.length - perHour] + HOUR };
}

export function followupTexts(db, profileId) {
  return new Map(db.prepare('SELECT step, text FROM followups WHERE profile_id = ?').all(profileId).map((r) => [r.step, r.text]));
}

export function saveFollowup(db, { profileId, step, text, source, model }) {
  db.prepare(`INSERT INTO followups (profile_id, step, text, source, model, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(profile_id, step) DO UPDATE SET text = excluded.text, source = excluded.source, model = excluded.model, created_at = excluded.created_at`)
    .run(profileId, step, text, source, model ?? null, now());
  return db.prepare('SELECT * FROM followups WHERE profile_id = ? AND step = ?').get(profileId, step);
}

export function insertInvite(db, { profileId, text, source, model, userId }) {
  db.prepare('UPDATE invites SET active = 0 WHERE profile_id = ?').run(profileId);
  const r = db.prepare('INSERT INTO invites (profile_id, text, source, model, active, created_by, created_at) VALUES (?,?,?,?,1,?,?)')
    .run(profileId, text, source, model ?? null, userId ?? null, now());
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(r.lastInsertRowid);
}
