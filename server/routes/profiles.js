import { Router } from 'express';
import { requireRole } from '../auth.js';
import { tx, now } from '../db.js';
import { bad, notFound, forbidden, str, int, oneOf, updateSql, ah } from '../util.js';
import {
  getSettings, today, licenseState, profileScope, getVisibleProfile,
  activeInvite, limitsFor, insertInvite, BOT_ONLINE_MS, followupTexts, saveFollowup,
} from '../services.js';
import { generateInvite, generateFollowup } from '../ai.js';
import { siteScenario, followupSteps } from '../scenario.js';
import { personalize } from '../personalize.js';

const DAY = 86400000;

function readProfileBody(body, { creating }) {
  const b = body || {};
  const out = {
    name: str(b.name, { required: creating, field: 'ім’я', max: 80 }),
    age: int(b.age, { min: 18, max: 99, field: 'вік' }),
    city: str(b.city, { max: 80 }),
    country: str(b.country, { max: 80 }),
    site_profile_id: str(b.site_profile_id, { max: 120 }),
    photo_url: str(b.photo_url, { max: 500 }),
    bio: str(b.bio, { max: 3000 }),
    interests: str(b.interests, { max: 500 }),
    looking_for: str(b.looking_for, { max: 500 }),
    tone: str(b.tone, { max: 120 }),
    language: str(b.language, { max: 40 }),
    notes: str(b.notes, { max: 2000 }),
    prompt: b.prompt === undefined ? undefined : (str(b.prompt, { max: 8000, field: 'промт анкети' }) || ''),
    status: oneOf(b.status, ['active', 'paused'], 'статус'),
    daily_limit: int(b.daily_limit, { min: 1, max: 5000, field: 'денний ліміт' }),
    min_delay: int(b.min_delay, { min: 5, max: 3600, field: 'мін. пауза' }),
    max_delay: int(b.max_delay, { min: 5, max: 3600, field: 'макс. пауза' }),
    target_age_min: int(b.target_age_min, { min: 18, max: 99, field: 'вік від' }),
    target_age_max: int(b.target_age_max, { min: 18, max: 99, field: 'вік до' }),
    tg_chat_id: b.tg_chat_id === undefined ? undefined : (str(b.tg_chat_id, { max: 64 }) || null),
    operator_id: int(b.operator_id, { min: 1, field: 'оператор' }),
    site_id: int(b.site_id, { min: 1, field: 'сайт' }),
  };
  if (out.name === '') throw bad('Заповніть: ім’я');
  return out;
}

export default function profileRoutes(db) {
  const r = Router();

  const listQuery = (user, extraWhere = '', extraParams = []) => {
    const scope = profileScope(user);
    const day = today(db, user.agencyId);
    return db.prepare(`
      SELECT p.*, u.name AS operator_name, s.name AS site_name,
        l.id AS license_id, l.key AS license_key, l.status AS license_status, l.activated_at AS license_activated_at,
        l.expires_at AS license_expires_at, l.days AS license_days, l.profile_id AS license_profile_id,
        (SELECT text FROM invites i WHERE i.profile_id = p.id AND i.active = 1 ORDER BY i.id DESC LIMIT 1) AS invite_text,
        (SELECT COUNT(*) FROM messages m WHERE m.profile_id = p.id AND m.day = ? AND m.status = 'sent') AS sent_today,
        (SELECT COUNT(*) FROM messages m WHERE m.profile_id = p.id AND m.reply_day = ?) AS replies_today,
        (SELECT COUNT(*) FROM messages m WHERE m.profile_id = p.id AND m.status = 'sent') AS sent_total,
        (SELECT COUNT(*) FROM messages m WHERE m.profile_id = p.id AND m.replied_at IS NOT NULL) AS replies_total
      FROM profiles p
      LEFT JOIN users u ON u.id = p.operator_id
      LEFT JOIN sites s ON s.id = p.site_id
      LEFT JOIN licenses l ON l.profile_id = p.id
      WHERE ${scope.where} ${extraWhere}
      ORDER BY p.status = 'active' DESC, p.name COLLATE NOCASE`).all(day, day, ...scope.params, ...extraParams);
  };

  const decorate = (db, user, p) => {
    const settings = getSettings(db, user.agencyId);
    const lic = p.license_id ? licenseState({
      status: p.license_status, activated_at: p.license_activated_at, expires_at: p.license_expires_at,
      days: p.license_days, profile_id: p.license_profile_id,
    }) : licenseState(null);
    return {
      ...p,
      license: { id: p.license_id, key: p.license_key, ...lic, expiresAt: p.license_expires_at },
      limits: limitsFor(p, settings),
      bot_online: Boolean(p.bot_last_seen && now() - p.bot_last_seen < BOT_ONLINE_MS),
    };
  };

  const checkRefs = (agencyId, body) => {
    if (body.operator_id && !db.prepare("SELECT 1 FROM users WHERE id = ? AND agency_id = ? AND role IN ('operator','owner')").get(body.operator_id, agencyId)) {
      throw bad('Оператора не знайдено');
    }
    if (body.site_id && !db.prepare('SELECT 1 FROM sites WHERE id = ? AND agency_id = ?').get(body.site_id, agencyId)) {
      throw bad('Сайт не знайдено');
    }
  };

  const assignLicense = (agencyId, profileId, licenseId) => {
    if (licenseId === undefined) return;
    db.prepare('UPDATE licenses SET profile_id = NULL WHERE profile_id = ?').run(profileId);
    if (licenseId === null) return;
    const l = db.prepare('SELECT * FROM licenses WHERE id = ? AND agency_id = ?').get(licenseId, agencyId);
    if (!l) throw bad('Ліцензію не знайдено');
    const st = licenseState(l);
    if (st.state === 'revoked' || st.state === 'expired') throw bad('Ця ліцензія недійсна (прострочена або відкликана)');
    if (l.profile_id && l.profile_id !== profileId) throw bad('Ця ліцензія вже прив’язана до іншої анкети');
    const t = now();
    if (!l.activated_at) {
      db.prepare('UPDATE licenses SET profile_id = ?, activated_at = ?, expires_at = ? WHERE id = ?').run(profileId, t, t + l.days * DAY, l.id);
    } else {
      db.prepare('UPDATE licenses SET profile_id = ? WHERE id = ?').run(profileId, l.id);
    }
  };

  r.get('/', (req, res) => {
    res.json({ profiles: listQuery(req.user).map((p) => decorate(db, req.user, p)) });
  });

  r.get('/:id', (req, res) => {
    const rows = listQuery(req.user, 'AND p.id = ?', [Number(req.params.id)]);
    if (!rows.length) throw notFound('Анкету не знайдено');
    const p = rows[0];
    const invites = db.prepare('SELECT * FROM invites WHERE profile_id = ? ORDER BY id DESC LIMIT 50').all(p.id);
    const site = p.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id) : null;
    const scenario = siteScenario(site);
    const followups = db.prepare('SELECT * FROM followups WHERE profile_id = ? ORDER BY step').all(p.id);
    const funnel = db.prepare(`SELECT
        COALESCE(SUM(stage = 'active' AND next_at IS NOT NULL), 0) AS waiting,
        COALESCE(SUM(stage = 'done'), 0) AS done,
        COALESCE(SUM(stage = 'replied'), 0) AS replied
      FROM messages WHERE profile_id = ? AND status = 'sent'`).get(p.id);
    res.json({ profile: decorate(db, req.user, p), invites, followups, followupSteps: followupSteps(scenario), steps: scenario.steps.length, funnel });
  });

  r.post('/', requireRole('owner'), (req, res) => {
    const body = readProfileBody(req.body, { creating: true });
    checkRefs(req.user.agencyId, body);
    const licenseId = int(req.body?.license_id, { min: 1, field: 'ліцензія' });
    const id = tx(db, () => {
      const cols = Object.keys(body).filter((k) => body[k] !== undefined);
      const out = db.prepare(`INSERT INTO profiles (agency_id, created_at, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(req.user.agencyId, now(), ...cols.map((k) => body[k]));
      const pid = Number(out.lastInsertRowid);
      assignLicense(req.user.agencyId, pid, licenseId);
      return pid;
    });
    res.status(201).json({ id });
  });

  r.patch('/:id', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    let body = readProfileBody(req.body, { creating: false });
    if (req.user.role === 'operator') {
      // Operators may only pause/resume their own profiles.
      body = { status: body.status };
    }
    checkRefs(req.user.agencyId, body);
    tx(db, () => {
      const upd = updateSql(body);
      if (!upd.empty) db.prepare(`UPDATE profiles SET ${upd.sql} WHERE id = ?`).run(...upd.values, p.id);
      if (req.user.role === 'owner') assignLicense(req.user.agencyId, p.id, int(req.body?.license_id, { min: 1, field: 'ліцензія' }));
    });
    res.json({ ok: true });
  });

  r.delete('/:id', requireRole('owner'), (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  // ---------- invites ----------
  r.get('/:id/invites', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    res.json({ invites: db.prepare('SELECT * FROM invites WHERE profile_id = ? ORDER BY id DESC LIMIT 50').all(p.id) });
  });

  r.post('/:id/invites/generate', ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const previous = activeInvite(db, p.id)?.text || '';
    const gen = await generateInvite({ profile: p, settings, previous });
    const invite = insertInvite(db, { profileId: p.id, text: gen.text, source: gen.source, model: gen.model, userId: req.user.id });
    res.status(201).json({ invite, preview: personalize(invite.text, { name: 'Michael', age: 45, country: 'USA' }) });
  }));

  /** Try a prompt on this profile without saving anything (master prompt editor, profile prompt). */
  r.post('/:id/invites/preview', requireRole('owner'), ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const prompt = str(req.body?.prompt, { max: 8000, field: 'промт' }) || '';
    // Unsaved form values (profile editor) take part in the preview.
    const draft = {};
    const f = req.body?.fields && typeof req.body.fields === 'object' ? req.body.fields : {};
    for (const k of ['name', 'city', 'country', 'bio', 'interests', 'looking_for', 'tone', 'language', 'notes']) {
      if (typeof f[k] === 'string') draft[k] = f[k].slice(0, 3000);
    }
    if (f.age !== undefined && f.age !== null && f.age !== '') draft.age = Number(f.age) || p.age;
    const gen = await generateInvite({ profile: { ...p, ...draft, prompt: '' }, settings, promptOverride: prompt });
    res.json({ ...gen, preview: personalize(gen.text, { name: 'Michael', age: 45, country: 'USA' }) });
  }));

  r.post('/:id/invites', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const text = str(req.body?.text, { required: true, field: 'текст', max: 1000 });
    if (text.length < 10) throw bad('Текст занадто короткий');
    res.status(201).json({ invite: insertInvite(db, { profileId: p.id, text, source: 'manual', userId: req.user.id }) });
  });

  // ---------- follow-ups (2nd, 3rd… attempt) ----------
  const stepParam = (req) => int(req.params.step, { min: 2, max: 50, field: 'крок' });

  r.post('/:id/followups/:step/generate', ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const step = stepParam(req);
    const settings = getSettings(db, req.user.agencyId);
    const have = followupTexts(db, p.id);
    const previous = [activeInvite(db, p.id)?.text, ...[...have.entries()].filter(([k]) => k !== step).sort((a, b) => a[0] - b[0]).map(([, t]) => t)];
    const gen = await generateFollowup({ profile: p, settings, step, previous });
    const followup = saveFollowup(db, { profileId: p.id, step, text: gen.text, source: gen.source, model: gen.model });
    res.status(201).json({ followup, preview: personalize(followup.text, { name: 'Michael', age: 45, country: 'USA' }) });
  }));

  r.put('/:id/followups/:step', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const step = stepParam(req);
    const text = str(req.body?.text, { required: true, field: 'текст', max: 1000 });
    if (text.length < 10) throw bad('Текст занадто короткий');
    res.json({ followup: saveFollowup(db, { profileId: p.id, step, text, source: 'manual' }) });
  });

  const getInvite = (req) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const inv = db.prepare('SELECT * FROM invites WHERE id = ? AND profile_id = ?').get(Number(req.params.inviteId), p.id);
    if (!inv) throw notFound('Інвайт не знайдено');
    return inv;
  };

  r.patch('/:id/invites/:inviteId', (req, res) => {
    const inv = getInvite(req);
    const text = str(req.body?.text, { required: true, field: 'текст', max: 1000 });
    if (text.length < 10) throw bad('Текст занадто короткий');
    db.prepare("UPDATE invites SET text = ?, source = CASE WHEN source = 'manual' OR source LIKE '%+edit' THEN source ELSE source || '+edit' END WHERE id = ?")
      .run(text, inv.id);
    res.json({ invite: db.prepare('SELECT * FROM invites WHERE id = ?').get(inv.id) });
  });

  r.post('/:id/invites/:inviteId/activate', (req, res) => {
    const inv = getInvite(req);
    tx(db, () => {
      db.prepare('UPDATE invites SET active = 0 WHERE profile_id = ?').run(inv.profile_id);
      db.prepare('UPDATE invites SET active = 1 WHERE id = ?').run(inv.id);
    });
    res.json({ ok: true });
  });

  r.delete('/:id/invites/:inviteId', (req, res) => {
    if (req.user.role !== 'owner') throw forbidden();
    const inv = getInvite(req);
    db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id);
    res.json({ ok: true });
  });

  return r;
}
