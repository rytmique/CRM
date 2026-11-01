import { Router } from 'express';
import {
  verifyPassword, hashPassword, createSession, destroySession, authenticate,
  loginLimiter, registerFailedLogin, clearLoginAttempts, destroyOtherSessions,
} from '../auth.js';
import { HttpError, bad, str, oneOf } from '../util.js';

export default function authRoutes(db) {
  const r = Router();

  r.post('/login', loginLimiter, (req, res) => {
    const email = str(req.body?.email, { required: true, field: 'email', max: 200 });
    const password = String(req.body?.password || '');
    const kind = oneOf(req.body?.kind || 'web', ['web', 'bot'], 'kind');
    const u = db.prepare(`SELECT u.*, a.active AS agency_active FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.email = ?`).get(email);
    if (!u || !verifyPassword(password, u.pass_hash)) {
      registerFailedLogin(req.loginAttemptKey);
      throw new HttpError(401, 'Невірний email або пароль');
    }
    if (!u.active) throw new HttpError(403, 'Обліковий запис вимкнено');
    if (u.role !== 'admin' && !u.agency_active) throw new HttpError(403, 'Агенцію призупинено. Зверніться до постачальника.');
    clearLoginAttempts(req.loginAttemptKey);
    const token = createSession(db, u.id, kind);
    res.json({ token, user: publicUser(db, u.id) });
  });

  r.use(authenticate(db));

  r.get('/me', (req, res) => res.json({ user: publicUser(db, req.user.id) }));

  r.post('/logout', (req, res) => {
    destroySession(db, req.token);
    res.json({ ok: true });
  });

  r.post('/password', (req, res) => {
    const current = String(req.body?.current || '');
    const next = String(req.body?.next || '');
    if (next.length < 8) throw bad('Новий пароль — мінімум 8 символів');
    const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, u.pass_hash)) throw bad('Поточний пароль невірний');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    destroyOtherSessions(db, req.user.id, req.token);
    res.json({ ok: true });
  });

  return r;
}

export function publicUser(db, id) {
  const u = db.prepare(`SELECT u.id, u.agency_id, u.role, u.name, u.email, u.tg_chat_id, a.name AS agency_name
                        FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = ?`).get(id);
  return u && {
    id: u.id, role: u.role, name: u.name, email: u.email, tgChatId: u.tg_chat_id || '',
    agencyId: u.agency_id, agencyName: u.agency_name || '',
  };
}
