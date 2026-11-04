import { Router } from 'express';
import { requireRole } from '../auth.js';
import { tx, now } from '../db.js';
import { bad, notFound, str, int, oneOf, updateSql, ah } from '../util.js';
import {
  getSettings, profileSettings, today, licenseState, profileScope, getVisibleProfile,
  activeInvite, limitsFor, insertInvite, BOT_ONLINE_MS, followupTexts, saveFollowup, autoLicense,
} from '../services.js';
import { checkProfileCap } from '../team.js';
import { generateInvite, generateFollowup, generateReengage, generateLetter } from '../ai.js';
import express from 'express';
import { profileScenario, followupSteps, usesLetters } from '../scenario.js';
import { listMedia, saveMedia, removeMedia, mediaFile, readSteps } from '../media.js';
import { personalize } from '../personalize.js';
import { REENGAGE_STEP, LETTER_STEP } from './bot.js';
import { inviteStats, bestOf, memoryLines } from '../learning.js';

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
    scenario_id: int(b.scenario_id, { min: 1, field: 'сценарій' }),
  };
  if (out.name === '') throw bad('Заповніть: ім’я');
  return out;
}

export default function profileRoutes(db, cfg) {
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
    if (body.operator_id && !db.prepare("SELECT 1 FROM users WHERE id = ? AND agency_id = ? AND role IN ('operator','owner') AND pending = 0").get(body.operator_id, agencyId)) {
      throw bad('Оператора не знайдено');
    }
    if (body.site_id && !db.prepare('SELECT 1 FROM sites WHERE id = ? AND agency_id = ?').get(body.site_id, agencyId)) {
      throw bad('Сайт не знайдено');
    }
    if (body.scenario_id && !db.prepare('SELECT 1 FROM scenario_templates WHERE id = ? AND agency_id = ?').get(body.scenario_id, agencyId)) {
      throw bad('Шаблон сценарію не знайдено');
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
    const invites = inviteStats(db, p.id, { all: true }).reverse().slice(0, 50);
    const best = bestOf(invites.filter((i) => i.active));
    const site = p.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id) : null;
    const scenario = profileScenario(db, p, site);
    const allFollowups = db.prepare('SELECT * FROM followups WHERE profile_id = ? ORDER BY step').all(p.id);
    const followups = allFollowups.filter((f) => f.step < REENGAGE_STEP);
    const reengage = allFollowups.find((f) => f.step === REENGAGE_STEP) || null;
    const letter = allFollowups.find((f) => f.step === LETTER_STEP) || null;
    const funnel = db.prepare(`SELECT
        COALESCE(SUM(stage = 'active' AND next_at IS NOT NULL), 0) AS waiting,
        COALESCE(SUM(stage = 'done'), 0) AS done,
        COALESCE(SUM(replied_at IS NOT NULL), 0) AS replied,
        COALESCE(SUM(stage = 'replied' AND bonus_left > 0), 0) AS talking,
        COALESCE(SUM(reply_mood = 'negative'), 0) AS negative
      FROM messages WHERE profile_id = ? AND status = 'sent'`).get(p.id);
    const scenarioName = p.scenario_id ? db.prepare('SELECT name FROM scenario_templates WHERE id = ?').get(p.scenario_id)?.name : null;
    res.json({
      profile: decorate(db, req.user, p), invites, followups, followupSteps: followupSteps(scenario), steps: scenario.steps.length, funnel,
      reengage, afterReply: scenario.afterReply, bestInvite: best?.id ?? null, letter, usesLetters: usesLetters(scenario),
      variantsWanted: getSettings(db, req.user.agencyId).ai.variants,
      media: listMedia(db, p.id), scenarioName,
    });
  });

  /** Owner creates for anyone; an operator creates their own profile and gets a free license from the pool. */
  r.post('/', (req, res) => {
    const body = readProfileBody(req.body, { creating: true });
    const isOp = req.user.role === 'operator';
    if (isOp) body.operator_id = req.user.id;
    checkRefs(req.user.agencyId, body);
    checkProfileCap(db, req.user.agencyId);
    const auto = isOp || req.body?.license_id === 'auto';
    const licenseId = auto ? undefined : int(req.body?.license_id, { min: 1, field: 'ліцензія' });
    const out = tx(db, () => {
      const cols = Object.keys(body).filter((k) => body[k] !== undefined);
      const ins = db.prepare(`INSERT INTO profiles (agency_id, created_at, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(req.user.agencyId, now(), ...cols.map((k) => body[k]));
      const pid = Number(ins.lastInsertRowid);
      if (auto) return { id: pid, license: autoLicense(db, req.user.agencyId, pid) };
      assignLicense(req.user.agencyId, pid, licenseId);
      return { id: pid, license: licenseId ?? null };
    });
    res.status(201).json({ id: out.id, licensed: Boolean(out.license) });
  });

  /** "Take a free license" for a profile that has none (operators can't pick licenses by hand). */
  r.post('/:id/license/auto', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const cur = db.prepare('SELECT * FROM licenses WHERE profile_id = ?').get(p.id);
    if (cur && licenseState(cur).valid) return res.json({ ok: true, licensed: true });
    const id = tx(db, () => {
      if (cur) db.prepare('UPDATE licenses SET profile_id = NULL WHERE id = ?').run(cur.id); // expired/revoked one goes back
      return autoLicense(db, req.user.agencyId, p.id);
    });
    if (!id) throw bad('Вільних ліцензій немає — попросіть керівника докупити');
    res.json({ ok: true, licensed: true });
  });

  r.patch('/:id', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const body = readProfileBody(req.body, { creating: false });
    // Operators edit their own profiles fully, but can't hand them to someone else.
    if (req.user.role === 'operator') delete body.operator_id;
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
    removeMedia(db, cfg, db.prepare('SELECT * FROM media WHERE profile_id = ?').all(p.id));
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
    const settings = profileSettings(db, p);
    const live = inviteStats(db, p.id);
    const variant = Boolean(req.body?.variant);
    const best = bestOf(live);
    const gen = await generateInvite({
      profile: p, settings, previous: variant ? live.map((v) => v.text).join('\n---\n') : (activeInvite(db, p.id)?.text || ''),
      bestExample: variant && best?.replies ? best.text : '', memory: memoryLines(db, settings),
    });
    if (variant && live.length >= 5) throw bad('Уже 5 варіантів у ротації — вимкніть слабший');
    const invite = insertInvite(db, { profileId: p.id, text: gen.text, source: gen.source, model: gen.model, userId: req.user.id, keepOthers: variant });
    res.status(201).json({ invite, preview: personalize(invite.text, { name: 'Michael', age: 45, country: 'USA' }) });
  }));

  /** Try a prompt on this profile without saving anything (master prompt editor, profile prompt). */
  r.post('/:id/invites/preview', ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = profileSettings(db, p);
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
    const variant = Boolean(req.body?.variant);
    if (variant && inviteStats(db, p.id).length >= 5) throw bad('Уже 5 варіантів у ротації — вимкніть слабший');
    res.status(201).json({ invite: insertInvite(db, { profileId: p.id, text, source: 'manual', userId: req.user.id, keepOthers: variant }) });
  });

  // ---------- files attached to messages ----------
  const getMedia = (req) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const m = db.prepare('SELECT * FROM media WHERE id = ? AND profile_id = ?').get(Number(req.params.mediaId), p.id);
    if (!m) throw notFound('Файл не знайдено');
    return m;
  };

  r.get('/:id/media', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    res.json({ media: listMedia(db, p.id) });
  });

  /** Upload one file: body = the file itself, name in X-File-Name (URI-encoded), steps in ?steps=1,2 */
  r.post('/:id/media', express.raw({ type: () => true, limit: '16mb' }), (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    let name = 'file';
    try { name = decodeURIComponent(String(req.get('x-file-name') || 'file')); } catch { /* keep default */ }
    const st = req.query.steps ? readSteps(String(req.query.steps).split(',')) : [1];
    const media = saveMedia(db, cfg, { agencyId: p.agency_id, profileId: p.id, name, type: req.get('content-type'), buf: req.body, steps: st });
    res.status(201).json({ media });
  });

  r.get('/:id/media/:mediaId/file', (req, res) => {
    const m = getMedia(req);
    res.set('Content-Type', m.type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(mediaFile(cfg, m));
  });

  r.patch('/:id/media/:mediaId', (req, res) => {
    const m = getMedia(req);
    db.prepare('UPDATE media SET steps = ? WHERE id = ?').run(JSON.stringify(readSteps(req.body?.steps)), m.id);
    res.json({ ok: true });
  });

  r.delete('/:id/media/:mediaId', (req, res) => {
    removeMedia(db, cfg, [getMedia(req)]);
    res.json({ ok: true });
  });

  // ---------- follow-ups (2nd, 3rd… attempt) ----------
  const stepParam = (req) => {
    const step = int(req.params.step, { min: 2, max: LETTER_STEP, field: 'крок' });
    if (step > 50 && step !== REENGAGE_STEP && step !== LETTER_STEP) throw bad('Невідомий крок');
    return step;
  };

  r.post('/:id/followups/:step/generate', ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const step = stepParam(req);
    const settings = profileSettings(db, p);
    const have = followupTexts(db, p.id);
    const previous = [activeInvite(db, p.id)?.text, ...[...have.entries()].filter(([k]) => k !== step).sort((a, b) => a[0] - b[0]).map(([, t]) => t)];
    const gen = step === REENGAGE_STEP ? await generateReengage({ profile: p, settings })
      : step === LETTER_STEP ? await generateLetter({ profile: p, settings, memory: memoryLines(db, settings) })
        : await generateFollowup({ profile: p, settings, step, previous });
    const followup = saveFollowup(db, { profileId: p.id, step, text: gen.text, source: gen.source, model: gen.model });
    res.status(201).json({ followup, preview: personalize(followup.text, { name: 'Michael', age: 45, country: 'USA' }) });
  }));

  r.put('/:id/followups/:step', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const step = stepParam(req);
    const text = str(req.body?.text, { required: true, field: 'текст', max: step >= REENGAGE_STEP ? 3000 : 1000 });
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

  /** Make it the only live invite, or (body.add) one more live variant. */
  r.post('/:id/invites/:inviteId/activate', (req, res) => {
    const inv = getInvite(req);
    tx(db, () => {
      if (!req.body?.add) db.prepare('UPDATE invites SET active = 0 WHERE profile_id = ?').run(inv.profile_id);
      else if (inviteStats(db, inv.profile_id).length >= 5) throw bad('Уже 5 варіантів у ротації — вимкніть слабший');
      db.prepare('UPDATE invites SET active = 1, retired_at = NULL WHERE id = ?').run(inv.id);
    });
    res.json({ ok: true });
  });

  /** Take a variant out of rotation (the last live one stays). */
  r.post('/:id/invites/:inviteId/retire', (req, res) => {
    const inv = getInvite(req);
    if (inv.active && inviteStats(db, inv.profile_id).length <= 1) throw bad('Це останній інвайт у ротації — спершу додайте інший');
    db.prepare('UPDATE invites SET active = 0, retired_at = ? WHERE id = ?').run(now(), inv.id);
    res.json({ ok: true });
  });

  r.delete('/:id/invites/:inviteId', (req, res) => {
    const inv = getInvite(req);
    db.prepare('DELETE FROM invites WHERE id = ?').run(inv.id);
    res.json({ ok: true });
  });

  return r;
}
