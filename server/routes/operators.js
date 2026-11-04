import { Router } from 'express';
import { requireRole, hashPassword, destroyUserSessions } from '../auth.js';
import { now, cmpVersion } from '../db.js';
import { latestBotVersion } from '../version.js';
import { bad, notFound, str, updateSql } from '../util.js';
import { today, BOT_ONLINE_MS } from '../services.js';
import { operatorLink, resetOperatorLink, approveUser, rejectUser, checkOperatorCap, stopBots, setUserActive } from '../team.js';

export default function operatorRoutes(db) {
  const r = Router();
  r.use(requireRole('owner'));

  r.get('/', (req, res) => {
    const day = today(db, req.user.agencyId);
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.tg_chat_id, u.active, u.pending, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM profiles p WHERE p.operator_id = u.id) AS profiles,
        (SELECT COUNT(*) FROM profiles p WHERE p.operator_id = u.id AND p.bot_last_seen > ?) AS bots_online,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.day = ? AND m.status = 'sent') AS sent_today,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.reply_day = ?) AS replies_today,
        (SELECT s.version FROM sessions s WHERE s.user_id = u.id AND s.kind = 'bot' AND s.expires_at > ? ORDER BY s.last_used_at DESC LIMIT 1) AS bot_version
      FROM users u WHERE u.agency_id = ? AND u.role = 'operator' ORDER BY u.name COLLATE NOCASE`)
      .all(now() - BOT_ONLINE_MS, day, day, now(), req.user.agencyId);
    const latest = latestBotVersion();
    res.json({ operators: rows.map((o) => ({ ...o, bot_outdated: o.bot_version != null && cmpVersion(o.bot_version, latest) < 0 })), latestBot: latest });
  });

  // ---------- the team's registration link ----------
  const linkView = (l) => ({ token: l.token, uses: l.uses, created_at: l.created_at });
  r.get('/link', (req, res) => res.json({ link: linkView(operatorLink(db, req.user.agencyId, req.user.id)) }));
  r.post('/link/reset', (req, res) => res.json({ link: linkView(resetOperatorLink(db, req.user.agencyId, req.user.id)) }));

  const mine = (id, req) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND agency_id = ? AND role = 'operator'").get(Number(id), req.user.agencyId);
    if (!u) throw notFound('Оператора не знайдено');
    return u;
  };
  r.post('/:id/approve', (req, res) => { approveUser(db, mine(req.params.id, req).id); res.json({ ok: true }); });
  r.post('/:id/reject', (req, res) => { rejectUser(db, mine(req.params.id, req).id); res.json({ ok: true }); });
  /** Stops this operator's bots now (they can start again by hand). */
  r.post('/:id/stop-bots', (req, res) => {
    const u = mine(req.params.id, req);
    res.json({ ok: true, profiles: stopBots(db, 'operator_id = ? AND agency_id = ?', [u.id, req.user.agencyId]) });
  });

  r.post('/', (req, res) => {
    const name = str(req.body?.name, { required: true, field: 'ім’я', max: 120 });
    const email = str(req.body?.email, { required: true, field: 'email / логін', max: 200 });
    const password = String(req.body?.password || '');
    if (password.length < 6) throw bad('Пароль — мінімум 6 символів');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('Такий email / логін вже зайнятий');
    checkOperatorCap(db, req.user.agencyId);
    const out = db.prepare('INSERT INTO users (agency_id, role, name, email, pass_hash, tg_chat_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.user.agencyId, 'operator', name, email, hashPassword(password), str(req.body?.tg_chat_id, { max: 64 }) || null, now());
    res.status(201).json({ id: Number(out.lastInsertRowid) });
  });

  r.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const op = db.prepare("SELECT * FROM users WHERE id = ? AND agency_id = ? AND role = 'operator'").get(id, req.user.agencyId);
    if (!op) throw notFound('Оператора не знайдено');
    const email = str(req.body?.email, { max: 200, field: 'email' });
    if (email && email.toLowerCase() !== op.email.toLowerCase() && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw bad('Такий email / логін вже зайнятий');
    }
    let passHash;
    if (req.body?.password) {
      if (String(req.body.password).length < 6) throw bad('Пароль — мінімум 6 символів');
      passHash = hashPassword(String(req.body.password));
    }
    const active = req.body?.active === undefined ? undefined : (req.body.active ? 1 : 0);
    const upd = updateSql({
      name: str(req.body?.name, { max: 120, field: 'ім’я' }) || undefined,
      email: email || undefined,
      tg_chat_id: req.body?.tg_chat_id === undefined ? undefined : (str(req.body.tg_chat_id, { max: 64 }) || null),
      pass_hash: passHash,
      active,
    });
    if (!upd.empty) db.prepare(`UPDATE users SET ${upd.sql} WHERE id = ?`).run(...upd.values, id);
    if (active === 0) setUserActive(db, id, false);
    else if (passHash) destroyUserSessions(db, id);
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    const out = db.prepare("DELETE FROM users WHERE id = ? AND agency_id = ? AND role = 'operator'").run(Number(req.params.id), req.user.agencyId);
    if (!out.changes) throw notFound('Оператора не знайдено');
    res.json({ ok: true });
  });

  return r;
}
