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

export function sentToday(db, profileId, day) {
  return db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND day = ? AND status = 'sent'").get(profileId, day).n;
}

export function insertInvite(db, { profileId, text, source, model, userId }) {
  db.prepare('UPDATE invites SET active = 0 WHERE profile_id = ?').run(profileId);
  const r = db.prepare('INSERT INTO invites (profile_id, text, source, model, active, created_by, created_at) VALUES (?,?,?,?,1,?,?)')
    .run(profileId, text, source, model ?? null, userId ?? null, now());
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(r.lastInsertRowid);
}
