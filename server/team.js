/**
 * Team: registration by link, approval, caps of the platform admin, remote stop of bots.
 *
 * - The platform admin makes a one-time link for a team lead (owner). Whoever registers by it waits until the admin approves;
 *   then the licenses written on the link are issued.
 * - A team lead has one link for operators (reusable; a new link switches the old one off). Whoever registers by it waits
 *   until the team lead (or the admin) approves — so a leaked link gives nothing by itself.
 */
import crypto from 'node:crypto';
import { now, tx } from './db.js';
import { bad, notFound } from './util.js';
import { getSettings } from './services.js';
import { destroyUserSessions } from './auth.js';

const DAY = 86400000;

export const newToken = () => crypto.randomBytes(18).toString('base64url');

/** A link that still works: switched on, not expired, uses left. */
export function activeLink(db, token) {
  const l = db.prepare('SELECT * FROM signup_links WHERE token = ?').get(String(token || ''));
  if (!l || !l.active) return null;
  if (l.expires_at && l.expires_at < now()) return null;
  if (l.max_uses != null && l.uses >= l.max_uses) return null;
  return l;
}

/** The team's link for operators (made on first use). */
export function operatorLink(db, agencyId, userId) {
  let l = db.prepare("SELECT * FROM signup_links WHERE kind = 'operator' AND agency_id = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(agencyId);
  if (!l) {
    db.prepare("INSERT INTO signup_links (token, kind, agency_id, created_by, created_at) VALUES (?, 'operator', ?, ?, ?)").run(newToken(), agencyId, userId, now());
    l = db.prepare("SELECT * FROM signup_links WHERE kind = 'operator' AND agency_id = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(agencyId);
  }
  return l;
}

/** A new link for operators: the old one stops working at once (e.g. it leaked). */
export function resetOperatorLink(db, agencyId, userId) {
  db.prepare("UPDATE signup_links SET active = 0 WHERE kind = 'operator' AND agency_id = ?").run(agencyId);
  return operatorLink(db, agencyId, userId);
}

/** A one-time link for a new team lead (the platform admin). */
export function ownerLink(db, adminId, { note = '', licenses = 0, days = 30, validDays = 14 } = {}) {
  const t = now();
  const r = db.prepare("INSERT INTO signup_links (token, kind, created_by, note, licenses, days, max_uses, created_at, expires_at) VALUES (?, 'owner', ?, ?, ?, ?, 1, ?, ?)")
    .run(newToken(), adminId, note, licenses, days, t, t + validDays * DAY);
  return db.prepare('SELECT * FROM signup_links WHERE id = ?').get(Number(r.lastInsertRowid));
}

/** How many operators the team has (approved ones) and whether one more fits the admin's cap. */
export function checkOperatorCap(db, agencyId) {
  const cap = getSettings(db, agencyId).caps.maxOperators;
  if (!cap) return;
  const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND role = 'operator' AND pending = 0").get(agencyId).n;
  if (n >= cap) throw bad(`Ліміт операторів для команди: ${cap}. Щоб додати більше — зверніться до постачальника.`);
}

export function checkProfileCap(db, agencyId) {
  const cap = getSettings(db, agencyId).caps.maxProfiles;
  if (!cap) return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE agency_id = ?').get(agencyId).n;
  if (n >= cap) throw bad(`Ліміт анкет для команди: ${cap}. Щоб додати більше — зверніться до постачальника.`);
}

/** Approves a registration. Owners: only the platform admin; the licenses of the link are issued then. */
export function approveUser(db, userId, { issueLicenses } = {}) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !u.pending) throw notFound('Заявку не знайдено');
  if (u.role === 'operator') checkOperatorCap(db, u.agency_id);
  tx(db, () => {
    db.prepare('UPDATE users SET pending = 0, approved_at = ? WHERE id = ?').run(now(), u.id);
    if (u.role === 'owner' && u.signup_link_id && issueLicenses) {
      const l = db.prepare('SELECT licenses, days FROM signup_links WHERE id = ?').get(u.signup_link_id);
      if (l?.licenses) issueLicenses(db, { agencyId: u.agency_id, count: l.licenses, days: l.days, note: 'з реєстрації' });
    }
  });
  return u;
}

/** Rejects a registration: the person is removed (a team lead — with the empty team made for them). */
export function rejectUser(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !u.pending) throw notFound('Заявку не знайдено');
  if (u.role === 'owner') db.prepare('DELETE FROM agencies WHERE id = ?').run(u.agency_id);
  else db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return u;
}

/** Waiting registrations: of one team, or all of the platform. */
export function pendingUsers(db, agencyId = null) {
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.agency_id, u.created_at, a.name AS agency_name, l.kind AS link_kind, l.note AS link_note
    FROM users u LEFT JOIN agencies a ON a.id = u.agency_id LEFT JOIN signup_links l ON l.id = u.signup_link_id
    WHERE u.pending = 1 ${agencyId ? 'AND u.agency_id = ?' : ''} ORDER BY u.id DESC`).all(...(agencyId ? [agencyId] : []));
}

/** Stops the bots of these profiles at their next heartbeat (~30 s). */
export function stopBots(db, where, params) {
  return db.prepare(`UPDATE profiles SET stop_at = ? WHERE ${where}`).run(now(), ...params).changes;
}

/** Blocks or unblocks a person: blocked ones are signed out everywhere at once (their bots stop). */
export function setUserActive(db, userId, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
  if (!active) destroyUserSessions(db, userId);
}
