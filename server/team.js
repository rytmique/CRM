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
import { bad, notFound, mergeSettings } from './util.js';
import { getSettings, planOf } from './services.js';
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

/** One more active profile must fit into the team's plan (paused ones do not count). */
export function checkProfileCap(db, agencyId) {
  const plan = planOf(db, agencyId);
  if (plan.profiles && plan.used >= plan.profiles) {
    throw bad(`У плані команди ${plan.profiles} анкет — усі зайняті. Поставте непотрібну анкету на паузу або попросіть більше в постачальника.`);
  }
}

/** The team's plan: how many active profiles, and until when (days = 0 / empty → no end). */
export function setPlan(db, agencyId, { profiles, days, until } = {}) {
  const cur = getSettings(db, agencyId);
  const plan = { ...cur.plan };
  if (profiles !== undefined) plan.profiles = Math.max(0, Math.min(10000, Number(profiles) || 0));
  if (until !== undefined) plan.until = until ? Number(until) : null;
  else if (days !== undefined) plan.until = Number(days) > 0 ? now() + Number(days) * DAY : null;
  db.prepare('UPDATE agencies SET settings = ? WHERE id = ?').run(JSON.stringify(mergeSettings(cur, { plan })), agencyId);
  return plan;
}

/** Approves a registration. Owners: only the platform admin; the plan written on the link starts then. */
export function approveUser(db, userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !u.pending) throw notFound('Заявку не знайдено');
  if (u.role === 'operator') checkOperatorCap(db, u.agency_id);
  tx(db, () => {
    db.prepare('UPDATE users SET pending = 0, approved_at = ? WHERE id = ?').run(now(), u.id);
    if (u.role === 'owner' && u.signup_link_id) {
      const l = db.prepare('SELECT licenses, days FROM signup_links WHERE id = ?').get(u.signup_link_id);
      if (l?.licenses) setPlan(db, u.agency_id, { profiles: l.licenses, days: l.days });
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
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.agency_id, u.created_at, a.name AS agency_name, l.kind AS link_kind, l.note AS link_note,
      a.solo, (SELECT r.name FROM users r WHERE r.id = a.referred_by) AS referrer_name
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

// ---------- referral program ----------
const REF_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A person's own referral code (made on first use): their link brings new teams or solo operators. */
export function refCode(db, userId) {
  const u = db.prepare('SELECT ref_code FROM users WHERE id = ?').get(userId);
  if (u?.ref_code) return u.ref_code;
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), (b) => REF_ABC[b % REF_ABC.length]).join('');
    if (!db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code)) {
      db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, userId);
      return code;
    }
  }
}

/** Who owns this referral code (only an approved, active team lead or operator). */
export function referrerByCode(db, code) {
  const u = db.prepare(`SELECT u.id, u.name, u.agency_id, a.name AS agency_name FROM users u JOIN agencies a ON a.id = u.agency_id
    WHERE u.ref_code = ? AND u.pending = 0 AND u.active = 1 AND u.role IN ('owner','operator') AND a.active = 1`).get(String(code || ''));
  return u || null;
}

/**
 * Moves a solo operator (a team of one) into another team: profiles, sites, numbers and history go with them,
 * they become an operator there, the empty solo team is removed.
 */
export function mergeSolo(db, fromId, intoId) {
  if (fromId === intoId) throw bad('Це та сама команда');
  const people = db.prepare('SELECT id FROM users WHERE agency_id = ?').all(fromId);
  if (people.length !== 1) throw bad('Переносити можна лише команду з однієї людини (соло)');
  if (!db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(intoId)) throw notFound('Команду не знайдено');
  const userId = people[0].id;
  tx(db, () => {
    for (const table of ['sites', 'profiles', 'messages', 'touches', 'scenario_templates', 'media', 'bot_activity', 'earnings', 'extension_builds']) {
      db.prepare(`UPDATE ${table} SET agency_id = ? WHERE agency_id = ?`).run(intoId, fromId);
    }
    db.prepare('UPDATE OR IGNORE ai_usage SET agency_id = ? WHERE agency_id = ?').run(intoId, fromId);
    db.prepare("UPDATE users SET agency_id = ?, role = 'operator' WHERE id = ?").run(intoId, userId);
    db.prepare('DELETE FROM agencies WHERE id = ?').run(fromId);
  });
  return userId;
}
