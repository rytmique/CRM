import { Router } from 'express';
import {
  verifyPassword, hashPassword, createSession, destroySession, authenticate,
  loginLimiter, registerFailedLogin, clearLoginAttempts, destroyOtherSessions,
} from '../auth.js';
import { HttpError, bad, str, oneOf } from '../util.js';
import { now, tx, platformGet } from '../db.js';
import { activeLink } from '../team.js';
import { createAgency } from './admin.js';
import { getSettings } from '../services.js';
import { sendTelegram } from '../telegram.js';

const EMAIL = /^[^\s@]+@[^\s@]+$/; // like the logins made by hand (owner@test is fine too)

/** Which copy of the bot logs in: a switched-off copy never; with the platform switch on — only copies downloaded from the panel. */
function checkBuild(db, u, build) {
  const b = build ? db.prepare('SELECT * FROM extension_builds WHERE build = ?').get(build) : null;
  if (b?.revoked_at) throw new HttpError(403, 'Цю копію бота вимкнено. Завантажте нову в панелі: «⬇ Бот».');
  if (platformGet(db, 'requireBuild', '0') !== '1' || u.role === 'admin') return;
  if (!b) throw new HttpError(403, 'Ця копія бота застаріла або не з панелі. Завантажте нову в панелі: «⬇ Бот».');
  if (b.agency_id !== u.agency_id) throw new HttpError(403, 'Ця копія бота належить іншій команді. Завантажте свою в панелі: «⬇ Бот».');
}

export default function authRoutes(db, cfg = {}) {
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
    if (u.pending) {
      throw new HttpError(403, u.role === 'owner'
        ? 'Реєстрацію ще не підтверджено. Щойно постачальник її підтвердить — увійдіть знову.'
        : 'Реєстрацію ще не підтверджено. Щойно керівник команди її підтвердить — увійдіть знову.');
    }
    if (!u.active) throw new HttpError(403, 'Обліковий запис вимкнено');
    if (u.role !== 'admin' && !u.agency_active) throw new HttpError(403, 'Агенцію призупинено. Зверніться до постачальника.');
    const build = str(req.body?.build, { max: 40 });
    if (kind === 'bot') checkBuild(db, u, build);
    clearLoginAttempts(req.loginAttemptKey);
    const token = createSession(db, u.id, kind, { ip: req.ip, agent: req.get('user-agent'), build });
    res.json({ token, user: publicUser(db, u.id) });
  });

  // ---------- registration by link ----------
  const joinView = (l) => {
    const agency = l.agency_id ? db.prepare('SELECT name FROM agencies WHERE id = ?').get(l.agency_id) : null;
    return { kind: l.kind, agencyName: agency?.name || '', note: l.kind === 'owner' ? l.note : '' };
  };
  r.get('/join/:token', (req, res) => {
    const l = activeLink(db, req.params.token);
    if (!l) throw new HttpError(404, 'Посилання недійсне або вже вимкнене. Попросіть нове у того, хто його дав.');
    res.json(joinView(l));
  });

  r.post('/join/:token', joinLimiter, (req, res) => {
    const l = activeLink(db, req.params.token);
    if (!l) throw new HttpError(404, 'Посилання недійсне або вже вимкнене. Попросіть нове у того, хто його дав.');
    const name = str(req.body?.name, { required: true, field: 'ім’я', max: 120 });
    const email = str(req.body?.email, { required: true, field: 'email', max: 200 }).toLowerCase();
    if (!EMAIL.test(email)) throw bad('Схоже, email з помилкою');
    const password = String(req.body?.password || '');
    if (password.length < 8) throw bad('Пароль — мінімум 8 символів');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Цей email уже зареєстрований. Увійдіть або попросіть керівника скинути пароль.');
    tx(db, () => {
      if (l.kind === 'owner') {
        const agencyName = str(req.body?.agencyName, { max: 120 }) || `Команда ${name}`;
        createAgency(db, cfg, { name: agencyName, ownerName: name, ownerEmail: email, ownerPassword: password, pending: true, signupLinkId: l.id });
      } else {
        db.prepare('INSERT INTO users (agency_id, role, name, email, pass_hash, created_at, pending, signup_link_id) VALUES (?,?,?,?,?,?,1,?)')
          .run(l.agency_id, 'operator', name, email, hashPassword(password), now(), l.id);
      }
      db.prepare('UPDATE signup_links SET uses = uses + 1, active = CASE WHEN max_uses IS NOT NULL AND uses + 1 >= max_uses THEN 0 ELSE active END WHERE id = ?').run(l.id);
    });
    if (l.kind === 'operator') notifyTeam(db, l.agency_id, `👋 Нова реєстрація в команду: <b>${escapeHtml(name)}</b> (${escapeHtml(email)}).\nПідтвердіть або відхиліть у панелі → «Команда».`);
    res.status(201).json({ ok: true, pending: true });
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

/** Registration attempts: at most 20 an hour from one address (a leaked link cannot be flooded). */
const joins = new Map();
function joinLimiter(req, _res, next) {
  const t = now();
  const rec = joins.get(req.ip);
  if (rec && t - rec.first < 3600000 && rec.count >= 20) return next(new HttpError(429, 'Забагато спроб реєстрації. Спробуйте за годину.'));
  if (!rec || t - rec.first >= 3600000) joins.set(req.ip, { first: t, count: 1 });
  else rec.count++;
  if (joins.size > 5000) joins.clear();
  next();
}

const escapeHtml = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** A short Telegram note to the team (its chat + the team lead), if the team set Telegram up. */
function notifyTeam(db, agencyId, text) {
  const s = getSettings(db, agencyId);
  if (!s.telegram.botToken) return;
  const owner = db.prepare("SELECT tg_chat_id FROM users WHERE agency_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(agencyId);
  for (const chat of new Set([s.telegram.chatId, owner?.tg_chat_id].filter(Boolean))) sendTelegram(s.telegram.botToken, chat, text).catch(() => {});
}

export function publicUser(db, id) {
  const u = db.prepare(`SELECT u.id, u.agency_id, u.role, u.name, u.email, u.tg_chat_id, a.name AS agency_name
                        FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = ?`).get(id);
  if (!u) return u;
  // registrations waiting for this person's approval (team lead: their team; admin: everyone)
  const pendingCount = u.role === 'owner' ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND pending = 1').get(u.agency_id).n
    : u.role === 'admin' ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE pending = 1').get().n : 0;
  return {
    id: u.id, role: u.role, name: u.name, email: u.email, tgChatId: u.tg_chat_id || '',
    agencyId: u.agency_id, agencyName: u.agency_name || '', pendingCount,
  };
}
