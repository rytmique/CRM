import crypto from 'node:crypto';
import { HttpError, forbidden } from './util.js';
import { now } from './db.js';

const SESSION_TTL = { web: 14 * 86400000, bot: 60 * 86400000 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** meta: where it came from (ip, browser) and which copy of the bot — shown to the admin as "devices". */
export function createSession(db, userId, kind = 'web', meta = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, kind, created_at, expires_at, last_used_at, ip, agent, build) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sha256(token), userId, kind, t, t + (SESSION_TTL[kind] || SESSION_TTL.web), t,
      String(meta.ip || '').slice(0, 64), String(meta.agent || '').slice(0, 200), String(meta.build || '').slice(0, 40));
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, userId);
  return token;
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Express middleware: resolves Bearer token into req.user (or 401). */
export function authenticate(db) {
  const findSession = db.prepare(`
    SELECT s.token_hash, s.kind, s.expires_at, s.last_used_at,
           u.id, u.agency_id, u.role, u.name, u.email, u.active, u.pending, u.tg_chat_id,
           a.active AS agency_active, a.name AS agency_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN agencies a ON a.id = u.agency_id
    WHERE s.token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?');

  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return next(new HttpError(401, 'Потрібен вхід'));
    const row = findSession.get(sha256(token));
    const t = now();
    if (!row || row.expires_at < t) return next(new HttpError(401, 'Сесія завершилась, увійдіть знову'));
    if (!row.active) return next(new HttpError(401, 'Обліковий запис вимкнено'));
    if (row.pending) return next(new HttpError(401, 'Реєстрацію ще не підтверджено'));
    if (row.role !== 'admin' && !row.agency_active) return next(new HttpError(403, 'Агенцію призупинено. Зверніться до постачальника.'));
    if (t - row.last_used_at > 60000) touch.run(t, row.token_hash);
    req.token = token;
    req.user = {
      id: row.id, agencyId: row.agency_id, role: row.role, name: row.name, email: row.email,
      tgChatId: row.tg_chat_id, agencyName: row.agency_name, sessionKind: row.kind,
    };
    next();
  };
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};

/** Very small in-memory limiter for login brute force: 10 attempts / 10 min per ip+email. */
const attempts = new Map();
export function loginLimiter(req, _res, next) {
  const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
  const t = now();
  const rec = attempts.get(key);
  if (rec && t - rec.first < 600000 && rec.count >= 10) {
    return next(new HttpError(429, 'Забагато спроб входу. Спробуйте за 10 хвилин.'));
  }
  req.loginAttemptKey = key;
  next();
}
export function registerFailedLogin(key) {
  const t = now();
  const rec = attempts.get(key);
  if (!rec || t - rec.first > 600000) attempts.set(key, { first: t, count: 1 });
  else rec.count++;
  if (attempts.size > 5000) attempts.clear();
}
export function clearLoginAttempts(key) {
  attempts.delete(key);
}

export function destroyOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken));
}
