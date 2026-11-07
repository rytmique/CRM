import { Router } from 'express';
import {
  verifyPassword, hashPassword, createSession, destroySession, authenticate,
  loginLimiter, registerFailedLogin, clearLoginAttempts, destroyOtherSessions, checkPassword,
} from '../auth.js';
import { HttpError, bad, str, oneOf } from '../util.js';
import { now, tx, platformGet } from '../db.js';
import crypto from 'node:crypto';
import { activeLink, referrerByCode, setPlan, approveUser } from '../team.js';
import { createAgency } from './admin.js';
import { getSettings } from '../services.js';
import { sendTelegram } from '../telegram.js';
import { sendToUsers } from '../reports.js';
import { tr, langOf } from '../i18n.js';
import { sendMail, mailReady } from '../mail.js';

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
    if (!checkPassword(password, u?.pass_hash)) {
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
    if (kind === 'bot' && u.bot_off) throw new HttpError(403, tr(u.lang, 'Доступ до бота призупинено керівником команди.'));
    clearLoginAttempts(req.loginAttemptKey);
    const token = createSession(db, u.id, kind, { ip: req.ip, agent: req.get('user-agent'), build, version: kind === 'bot' ? str(req.body?.version, { max: 20 }) : '' });
    res.json({ token, user: publicUser(db, u.id) });
  });

  // ---------- registration by link ----------
  const joinView = (l) => {
    const agency = l.agency_id ? db.prepare('SELECT name FROM agencies WHERE id = ?').get(l.agency_id) : null;
    return { kind: l.kind, agencyName: agency?.name || '', note: l.kind === 'owner' ? l.note : '' };
  };
  // a personal referral link (#/join/r-<code>): a new team or a solo operator, brought by someone
  const REF_PLAN = { team: 50, solo: 20 }; // profiles in the plan until the admin changes it
  const referrerOf = (token) => (String(token).startsWith('r-') ? referrerByCode(db, String(token).slice(2)) : null);

  r.get('/join/:token', (req, res) => {
    if (String(req.params.token).startsWith('r-')) {
      const ref = referrerOf(req.params.token);
      if (!ref) throw new HttpError(404, 'Посилання недійсне. Попросіть нове у того, хто його дав.');
      return res.json({ kind: 'owner', referral: true, referrer: ref.name, agencyName: '' });
    }
    const l = activeLink(db, req.params.token);
    if (!l) throw new HttpError(404, 'Посилання недійсне або вже вимкнене. Попросіть нове у того, хто його дав.');
    res.json(joinView(l));
  });

  r.post('/join/:token', joinLimiter, (req, res) => {
    const ref = referrerOf(req.params.token);
    const l = ref ? { kind: 'owner', referral: true } : activeLink(db, req.params.token);
    if (!l) throw new HttpError(404, 'Посилання недійсне або вже вимкнене. Попросіть нове у того, хто його дав.');
    const name = str(req.body?.name, { required: true, field: 'ім’я', max: 120 });
    const email = str(req.body?.email, { required: true, field: 'email', max: 200 }).toLowerCase();
    if (!EMAIL.test(email)) throw bad('Схоже, email з помилкою');
    const password = String(req.body?.password || '');
    if (password.length < 8) throw bad('Пароль — мінімум 8 символів');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Цей email уже зареєстрований. Увійдіть або попросіть керівника скинути пароль.');
    const lang = langOf(req.body?.lang);
    let ownerId = null;
    tx(db, () => {
      if (l.kind === 'owner') {
        const solo = Boolean(l.referral && req.body?.solo);
        const agencyName = str(req.body?.agencyName, { max: 120 }) || (solo ? `Соло: ${name}` : `Команда ${name}`);
        const agencyId = createAgency(db, cfg, { name: agencyName, ownerName: name, ownerEmail: email, ownerPassword: password, pending: true, signupLinkId: l.id ?? null });
        ownerId = db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'owner'").get(agencyId).id;
        db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, ownerId);
        if (l.referral) {
          db.prepare('UPDATE agencies SET referred_by = ?, solo = ? WHERE id = ?').run(ref.id, solo ? 1 : 0, agencyId);
          setPlan(db, agencyId, { profiles: solo ? REF_PLAN.solo : REF_PLAN.team });
        } else {
          // the admin's personal one-time link is the approval itself: in at once, the team is named on the next screen
          db.prepare('UPDATE agencies SET named = 0 WHERE id = ?').run(agencyId);
          approveUser(db, ownerId);
        }
      } else {
        db.prepare('INSERT INTO users (agency_id, role, name, email, pass_hash, created_at, pending, signup_link_id, lang) VALUES (?,?,?,?,?,?,1,?,?)')
          .run(l.agency_id, 'operator', name, email, hashPassword(password), now(), l.id, lang);
      }
      if (l.id) db.prepare('UPDATE signup_links SET uses = uses + 1, active = CASE WHEN max_uses IS NOT NULL AND uses + 1 >= max_uses THEN 0 ELSE active END WHERE id = ?').run(l.id);
    });
    if (ref) notifyTeam(db, ref.agency_id, (lg) => tr(lg, req.body?.solo ? '🎁 За вашим посиланням зареєструвався соло-оператор: <b>{name}</b>. Після підтвердження ви отримуватимете 10% від його оплат 6 місяців.'
      : '🎁 За вашим посиланням зареєструвалась нова команда: <b>{name}</b>. Після підтвердження ви отримуватимете 10% від її оплат 6 місяців.', { name: escapeHtml(name) }), ref.id);
    if (l.kind === 'operator') notifyTeam(db, l.agency_id, (lg) => tr(lg, '👋 Нова реєстрація в команду: <b>{name}</b> ({email}).\nПідтвердіть або відхиліть у панелі → «Команда».', { name: escapeHtml(name), email: escapeHtml(email) }));
    if (l.kind === 'owner' && !l.referral) {
      const token = createSession(db, ownerId, 'web', { ip: req.ip, agent: req.get('user-agent') });
      return res.status(201).json({ ok: true, pending: false, token, user: publicUser(db, ownerId) });
    }
    res.status(201).json({ ok: true, pending: true });
  });

  // ---------- «forgot password»: a one-time link to the email (if the server can send mail) and to the linked Telegram ----------
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  r.post('/forgot', forgotLimiter, ah(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    const u = email ? db.prepare('SELECT id, email, lang, tg_chat_id, active, pending, agency_id FROM users WHERE email = ?').get(email) : null;
    // the same answer whether the email exists or not (nobody can probe who is registered)
    res.json({ ok: true });
    if (!u || !u.active || u.pending) return;
    const token = crypto.randomBytes(24).toString('base64url');
    const t = now();
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(u.id, t);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha(token), u.id, t, t + 3600000);
    const url = `${cfg.publicUrl || ''}/#/reset/${token}`;
    if (mailReady()) {
      sendMail({ to: u.email, subject: tr(u.lang, 'Скидання пароля — Agency CRM'), text: tr(u.lang, 'Вітаю!\n\nЩоб задати новий пароль в Agency CRM, відкрийте посилання (діє 1 годину):\n{url}\n\nЯкщо ви не просили скинути пароль — просто нічого не робіть.', { url }) })
        .catch((e) => console.error('mail:', e.message));
    }
    if (u.tg_chat_id) sendToUsers(db, u.agency_id ? getSettings(db, u.agency_id) : null, [u.id], (lg) => tr(lg, '🔑 Скидання пароля в Agency CRM.\nВідкрийте посилання (діє 1 годину):\n{url}\n\nЯкщо це не ви — просто нічого не робіть.', { url })).catch(() => {});
  }));
  const resetRow = (token) => {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha(String(token || '')));
    if (!row || row.used_at || row.expires_at < now()) throw new HttpError(404, 'Посилання недійсне або застаріло. Попросіть нове: «Забули пароль?».');
    return row;
  };
  r.get('/reset/:token', (req, res) => { resetRow(req.params.token); res.json({ ok: true }); });
  r.post('/reset/:token', forgotLimiter, (req, res) => {
    const row = resetRow(req.params.token);
    const password = String(req.body?.password || '');
    if (password.length < 8) throw bad('Пароль — мінімум 8 символів');
    tx(db, () => {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
      destroyUserSessionsAll(db, row.user_id); // signed out everywhere (the old password may have leaked)
    });
    res.json({ ok: true });
  });

  r.use(authenticate(db));

  r.get('/me', (req, res) => res.json({ user: publicUser(db, req.user.id) }));

  /** The language of the panel, the bot and the Telegram messages. */
  r.put('/lang', (req, res) => {
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(langOf(req.body?.lang), req.user.id);
    res.json({ user: publicUser(db, req.user.id) });
  });

  /** A new team lead names the team (the screen right after registering). */
  r.put('/team-name', (req, res) => {
    if (req.user.role !== 'owner') throw new HttpError(403, 'Лише керівник команди');
    const name = str(req.body?.name, { required: true, field: 'назва команди', max: 120 });
    db.prepare('UPDATE agencies SET name = ?, named = 1 WHERE id = ?').run(name, req.user.agencyId);
    res.json({ user: publicUser(db, req.user.id) });
  });

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

/** «Forgot password» and the new password: 5 tries in 15 minutes from one address. */
const forgots = new Map();
function forgotLimiter(req, _res, next) {
  const t = now();
  const rec = forgots.get(req.ip);
  if (rec && t - rec.first < 900000 && rec.count >= 5) return next(new HttpError(429, 'Забагато спроб. Спробуйте за 15 хвилин.'));
  if (!rec || t - rec.first >= 900000) forgots.set(req.ip, { first: t, count: 1 });
  else rec.count++;
  if (forgots.size > 5000) forgots.clear();
  next();
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const destroyUserSessionsAll = (db, userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

/** A short Telegram note to the team lead (the platform bot, in their language) and the team's own chat, if it has one. */
function notifyTeam(db, agencyId, text, ownerId = null) {
  const s = getSettings(db, agencyId);
  const owners = ownerId ? [ownerId] : db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'owner'").all(agencyId).map((o) => o.id);
  sendToUsers(db, s, owners, text).catch(() => {});
  if (s.telegram.botToken && s.telegram.chatId) sendTelegram(s.telegram.botToken, s.telegram.chatId, text('uk')).catch(() => {});
}

export function publicUser(db, id) {
  const u = db.prepare(`SELECT u.id, u.agency_id, u.role, u.name, u.email, u.tg_chat_id, u.lang, u.bot_off, u.bot_off_note, u.ai_off, a.name AS agency_name, a.named
                        FROM users u LEFT JOIN agencies a ON a.id = u.agency_id WHERE u.id = ?`).get(id);
  if (!u) return u;
  // registrations waiting for this person's approval (team lead: their team; admin: everyone)
  const pendingCount = u.role === 'owner' ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND pending = 1').get(u.agency_id).n
    : u.role === 'admin' ? db.prepare('SELECT COUNT(*) AS n FROM users WHERE pending = 1').get().n : 0;
  return {
    id: u.id, role: u.role, name: u.name, email: u.email, tgChatId: u.tg_chat_id || '',
    agencyId: u.agency_id, agencyName: u.agency_name || '', pendingCount,
    lang: u.lang === 'ru' ? 'ru' : 'uk',
    teamNameNeeded: u.role === 'owner' && u.named === 0, // right after registering: the «name your team» screen
    botOff: Boolean(u.bot_off), botOffNote: u.bot_off ? u.bot_off_note || '' : '', aiOff: Boolean(u.ai_off),
  };
}
