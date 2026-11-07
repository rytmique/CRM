import crypto from 'node:crypto';
import { HttpError, forbidden } from './util.js';
import { now } from './db.js';
import { tr } from './i18n.js';

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
  db.prepare('INSERT INTO sessions (token_hash, user_id, kind, created_at, expires_at, last_used_at, ip, agent, build, version) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(sha256(token), userId, kind, t, t + (SESSION_TTL[kind] || SESSION_TTL.web), t,
      String(meta.ip || '').slice(0, 64), String(meta.agent || '').slice(0, 200), String(meta.build || '').slice(0, 40), String(meta.version || '').slice(0, 20));
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
    SELECT s.token_hash, s.kind, s.expires_at, s.last_used_at, s.version,
           u.id, u.agency_id, u.role, u.name, u.email, u.active, u.pending, u.tg_chat_id, u.lang, u.bot_off, u.prefs,
           a.active AS agency_active, a.name AS agency_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN agencies a ON a.id = u.agency_id
    WHERE s.token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?');
  const setVersion = db.prepare('UPDATE sessions SET version = ? WHERE token_hash = ?');

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
    // the team lead suspended this person's bot: the bot is refused (and stops), the panel keeps working
    if (row.kind === 'bot' && row.bot_off) return next(new HttpError(403, tr(row.lang, 'Доступ до бота призупинено керівником команди.')));
    if (t - row.last_used_at > 60000) touch.run(t, row.token_hash);
    // which version of the bot this device runs (the bot sends it with every call)
    const botVersion = String(req.get('x-bot-version') || '').slice(0, 20);
    if (botVersion && botVersion !== row.version) setVersion.run(botVersion, row.token_hash);
    req.token = token;
    req.user = {
      id: row.id, agencyId: row.agency_id, role: row.role, name: row.name, email: row.email,
      tgChatId: row.tg_chat_id, agencyName: row.agency_name, sessionKind: row.kind, botVersion: botVersion || row.version || '',
      lang: row.lang === 'ru' ? 'ru' : 'uk', prefs: row.prefs,
    };
    next();
  };
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};

/**
 * Login brute force: 10 wrong tries / 10 min per address+email, and 40 per address whatever the emails
 * (someone trying many accounts from one place).
 */
const attempts = new Map();
const blocked = (key, max) => { const rec = attempts.get(key); return rec && now() - rec.first < 600000 && rec.count >= max; };
export function loginLimiter(req, _res, next) {
  const key = `${req.ip}|${String(req.body?.email || '').toLowerCase()}`;
  if (blocked(key, 10) || blocked(`${req.ip}|*`, 40)) {
    return next(new HttpError(429, 'Забагато спроб входу. Спробуйте за 10 хвилин.'));
  }
  req.loginAttemptKey = key;
  next();
}
export function registerFailedLogin(key) {
  const t = now();
  for (const k of [key, `${String(key).split('|')[0]}|*`]) {
    const rec = attempts.get(k);
    if (!rec || t - rec.first > 600000) attempts.set(k, { first: t, count: 1 });
    else rec.count++;
  }
  if (attempts.size > 5000) attempts.clear();
}
/** A wrong email costs the same time as a wrong password (nobody can tell by timing which emails exist). */
const DUMMY = hashPassword('not-a-real-password');
export const checkPassword = (password, stored) => verifyPassword(password, stored || DUMMY) && Boolean(stored);
export function clearLoginAttempts(key) {
  attempts.delete(key);
}

export function destroyOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken));
}
