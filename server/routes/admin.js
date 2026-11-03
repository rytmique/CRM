import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireRole, hashPassword, destroyUserSessions } from '../auth.js';
import { tx, now } from '../db.js';
import { bad, notFound, str, int, licenseKey, updateSql } from '../util.js';
import { licenseState } from '../services.js';
import { demoSiteConfig } from '../sites.js';
import { refreshMemory } from '../learning.js';
import { rankingState } from '../scoring.js';

const DAY = 86400000;

function randomPassword(len = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => abc[b % abc.length]).join('');
}

export function createAgency(db, cfg, { name, ownerName, ownerEmail, ownerPassword }) {
  return tx(db, () => {
    const t = now();
    const a = db.prepare('INSERT INTO agencies (name, active, settings, created_at) VALUES (?,1,?,?)').run(name, '{}', t);
    const agencyId = Number(a.lastInsertRowid);
    db.prepare('INSERT INTO users (agency_id, role, name, email, pass_hash, created_at) VALUES (?,?,?,?,?,?)')
      .run(agencyId, 'owner', ownerName, ownerEmail, hashPassword(ownerPassword), t);
    if (cfg.demoSite) {
      db.prepare('INSERT INTO sites (agency_id, name, base_url, config, created_at) VALUES (?,?,?,?,?)')
        .run(agencyId, 'Демо-сайт (для тесту)', `${cfg.publicUrl}/demo-site/`, JSON.stringify(demoSiteConfig(cfg.publicUrl)), t);
    }
    return agencyId;
  });
}

export function issueLicenses(db, { agencyId, count, days, note = '' }) {
  const ins = db.prepare('INSERT INTO licenses (agency_id, key, days, note, issued_at) VALUES (?,?,?,?,?)');
  const keys = [];
  tx(db, () => {
    for (let i = 0; i < count; i++) {
      const key = licenseKey();
      ins.run(agencyId, key, days, note, now());
      keys.push(key);
    }
  });
  return keys;
}

export default function adminRoutes(db, cfg) {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/agencies', (_req, res) => {
    const t = now();
    const rows = db.prepare(`
      SELECT a.id, a.name, a.active, a.created_at,
        (SELECT email FROM users WHERE agency_id = a.id AND role = 'owner' ORDER BY id LIMIT 1) AS owner_email,
        (SELECT COUNT(*) FROM users WHERE agency_id = a.id AND role = 'operator') AS operators,
        (SELECT COUNT(*) FROM profiles WHERE agency_id = a.id) AS profiles,
        (SELECT COUNT(*) FROM licenses WHERE agency_id = a.id AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)) AS licenses_live,
        (SELECT COUNT(*) FROM messages WHERE agency_id = a.id AND sent_at > ?) AS sent_30d
      FROM agencies a ORDER BY a.id DESC`).all(t, t - 30 * DAY);
    res.json({ agencies: rows });
  });

  r.post('/agencies', (req, res) => {
    const name = str(req.body?.name, { required: true, field: 'назва агенції', max: 120 });
    const ownerName = str(req.body?.ownerName, { required: true, field: 'ім’я керівника', max: 120 });
    const ownerEmail = str(req.body?.ownerEmail, { required: true, field: 'email керівника', max: 200 });
    const ownerPassword = String(req.body?.ownerPassword || '');
    if (ownerPassword.length < 8) throw bad('Пароль керівника — мінімум 8 символів');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(ownerEmail)) throw bad('Такий email вже зайнятий');
    const agencyId = createAgency(db, cfg, { name, ownerName, ownerEmail, ownerPassword });
    const count = int(req.body?.licenses, { min: 0, max: 500, field: 'кількість ліцензій' }) || 0;
    const days = int(req.body?.days, { min: 1, max: 3650, field: 'днів' }) || 30;
    const keys = count ? issueLicenses(db, { agencyId, count, days }) : [];
    res.status(201).json({ id: agencyId, keys });
  });

  r.patch('/agencies/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(id)) throw notFound('Агенцію не знайдено');
    const upd = updateSql({
      name: str(req.body?.name, { max: 120, field: 'назва' }),
      active: req.body?.active === undefined ? undefined : (req.body.active ? 1 : 0),
    });
    if (!upd.empty) db.prepare(`UPDATE agencies SET ${upd.sql} WHERE id = ?`).run(...upd.values, id);
    if (req.body?.active === false) {
      for (const u of db.prepare('SELECT id FROM users WHERE agency_id = ?').all(id)) destroyUserSessions(db, u.id);
    }
    res.json({ ok: true });
  });

  /** New random password for the agency owner (client forgot it) — shown once to the admin. */
  r.post('/agencies/:id/reset-owner', (req, res) => {
    const owner = db.prepare("SELECT id, email FROM users WHERE agency_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(Number(req.params.id));
    if (!owner) throw notFound('У агенції немає керівника');
    const password = randomPassword();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), owner.id);
    destroyUserSessions(db, owner.id);
    res.json({ email: owner.email, password });
  });

  /** Whole database as one file (consistent snapshot via VACUUM INTO). */
  r.get('/backup', (req, res, next) => {
    const file = path.join(os.tmpdir(), `agency-backup-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      db.exec(`VACUUM INTO '${file}'`);
    } catch (e) { return next(e); }
    const day = new Date().toISOString().slice(0, 10);
    res.download(file, `agency-backup-${day}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  r.get('/licenses', (req, res) => {
    const agencyId = req.query.agency_id ? Number(req.query.agency_id) : null;
    const rows = db.prepare(`
      SELECT l.*, a.name AS agency_name, p.name AS profile_name
      FROM licenses l JOIN agencies a ON a.id = l.agency_id LEFT JOIN profiles p ON p.id = l.profile_id
      ${agencyId ? 'WHERE l.agency_id = ?' : ''} ORDER BY l.id DESC LIMIT 2000`).all(...(agencyId ? [agencyId] : []));
    res.json({ licenses: rows.map((l) => ({ ...l, ...licenseState(l) })) });
  });

  r.post('/licenses', (req, res) => {
    const agencyId = int(req.body?.agency_id, { min: 1, field: 'агенція', nullable: false });
    if (!db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(agencyId)) throw notFound('Агенцію не знайдено');
    const count = int(req.body?.count, { min: 1, max: 500, field: 'кількість', nullable: false });
    const days = int(req.body?.days, { min: 1, max: 3650, field: 'днів', nullable: false });
    const note = str(req.body?.note, { max: 200 }) || '';
    res.status(201).json({ keys: issueLicenses(db, { agencyId, count, days, note }) });
  });

  r.post('/licenses/:id/extend', (req, res) => {
    const days = int(req.body?.days, { min: 1, max: 3650, field: 'днів', nullable: false });
    const l = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!l) throw notFound('Ліцензію не знайдено');
    if (!l.activated_at) {
      db.prepare('UPDATE licenses SET days = days + ? WHERE id = ?').run(days, l.id);
    } else {
      const from = Math.max(l.expires_at, now());
      db.prepare('UPDATE licenses SET days = days + ?, expires_at = ? WHERE id = ?').run(days, from + days * DAY, l.id);
    }
    res.json({ ok: true });
  });

  r.post('/licenses/:id/revoke', (req, res) => {
    const out = db.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").run(Number(req.params.id));
    if (!out.changes) throw notFound('Ліцензію не знайдено');
    res.json({ ok: true });
  });

  r.post('/licenses/:id/restore', (req, res) => {
    const out = db.prepare("UPDATE licenses SET status = 'active' WHERE id = ?").run(Number(req.params.id));
    if (!out.changes) throw notFound('Ліцензію не знайдено');
    res.json({ ok: true });
  });

  // ---------- shared memory of the platform (lessons for invites) ----------
  const memoryView = () => {
    const lessons = db.prepare("SELECT * FROM ai_memory WHERE text != '' ORDER BY source = 'admin' DESC, id").all();
    const invites = db.prepare("SELECT COUNT(*) AS n FROM invites WHERE active = 1").get().n;
    const sent = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get().n;
    const replied = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE replied_at IS NOT NULL AND reply_mood != 'negative'").get().n;
    const updated = db.prepare("SELECT MAX(created_at) AS t FROM ai_memory WHERE source != 'admin'").get().t;
    return { lessons, stats: { invites, sent, replied, updated, ranking: rankingState(db), aiKey: Boolean(process.env.ANTHROPIC_API_KEY) } };
  };

  r.get('/memory', (_req, res) => res.json(memoryView()));

  r.post('/memory', (req, res) => {
    const text = str(req.body?.text, { required: true, field: 'урок', max: 300 });
    if (text.length < 10) throw bad('Занадто коротко');
    db.prepare("INSERT INTO ai_memory (text, source, active, created_at) VALUES (?, 'admin', 1, ?)").run(text, now());
    res.status(201).json(memoryView());
  });

  r.patch('/memory/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM ai_memory WHERE id = ?').get(Number(req.params.id));
    if (!m) throw notFound('Урок не знайдено');
    const text = req.body?.text === undefined ? m.text : str(req.body.text, { max: 300 });
    const active = req.body?.active === undefined ? m.active : (req.body.active ? 1 : 0);
    db.prepare('UPDATE ai_memory SET text = ?, active = ? WHERE id = ?').run(text, active, m.id);
    res.json(memoryView());
  });

  r.delete('/memory/:id', (req, res) => {
    db.prepare('DELETE FROM ai_memory WHERE id = ?').run(Number(req.params.id));
    res.json(memoryView());
  });

  r.post('/memory/refresh', async (_req, res, next) => {
    try {
      const out = await refreshMemory(db, { force: true });
      res.json({ ...memoryView(), refreshed: out });
    } catch (e) { next(e); }
  });

  return r;
}
