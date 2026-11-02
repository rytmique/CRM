import { Router } from 'express';
import { now } from '../db.js';
import { HttpError, bad, str, int, oneOf, ah, dayKey } from '../util.js';
import {
  getSettings, licenseState, profileScope, getVisibleProfile, profileLicense, activeInvite,
  limitsFor, sentToday, insertInvite,
} from '../services.js';
import { generateInvite } from '../ai.js';
import { personalize } from '../personalize.js';
import { sendTelegram, escapeHtml } from '../telegram.js';

/** API used by the browser extension (the bot). */
export default function botRoutes(db) {
  const r = Router();

  const readMan = (m) => {
    if (!m || typeof m !== 'object') return null;
    const id = String(m.id ?? '').trim().slice(0, 120);
    if (!id) return null;
    const age = Number.parseInt(m.age, 10);
    return {
      id,
      name: String(m.name ?? '').trim().slice(0, 80),
      age: Number.isInteger(age) && age >= 18 && age < 100 ? age : null,
      country: String(m.country ?? '').trim().slice(0, 80),
    };
  };

  /** Loads a profile and verifies it may run right now. */
  const runnable = (req) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const lic = licenseState(profileLicense(db, p.id));
    if (!lic.valid) {
      const why = { none: 'не має ліцензії', expired: 'має прострочену ліцензію', revoked: 'має відкликану ліцензію' }[lic.state] || 'не має дійсної ліцензії';
      throw new HttpError(402, `Анкета «${p.name}» ${why}. Зверніться до керівника.`);
    }
    if (p.status !== 'active') throw new HttpError(409, `Анкету «${p.name}» поставлено на паузу в панелі.`);
    const settings = getSettings(db, req.user.agencyId);
    const day = dayKey(now(), settings.timezone);
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    return { p, lic, settings, day, limits, remaining };
  };

  r.get('/profiles', (req, res) => {
    const scope = profileScope(req.user);
    const rows = db.prepare(`SELECT p.id, p.name, p.age, p.photo_url, p.status, p.site_profile_id, s.name AS site_name, s.base_url
      FROM profiles p LEFT JOIN sites s ON s.id = p.site_id WHERE ${scope.where} ORDER BY p.name COLLATE NOCASE`).all(...scope.params);
    const settings = getSettings(db, req.user.agencyId);
    const day = dayKey(now(), settings.timezone);
    res.json({
      profiles: rows.map((p) => {
        const full = db.prepare('SELECT * FROM profiles WHERE id = ?').get(p.id);
        const limits = limitsFor(full, settings);
        return {
          ...p,
          license: licenseState(profileLicense(db, p.id)),
          sentToday: sentToday(db, p.id, day),
          dailyLimit: limits.dailyLimit,
        };
      }),
    });
  });

  r.get('/profiles/:id/config', ah(async (req, res) => {
    const { p, lic, settings, limits, remaining } = runnable(req);
    if (!p.site_id) throw bad('Для анкети не вибрано сайт. Вкажіть сайт у панелі.');
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id);
    let invite = activeInvite(db, p.id);
    if (!invite) {
      const gen = await generateInvite({ profile: p, settings });
      invite = insertInvite(db, { profileId: p.id, text: gen.text, source: gen.source, model: gen.model, userId: req.user.id });
    }
    res.json({
      profile: { id: p.id, name: p.name, age: p.age, site_profile_id: p.site_profile_id },
      site: { id: site.id, name: site.name, base_url: site.base_url, config: JSON.parse(site.config || '{}') },
      invite: { id: invite.id, text: invite.text },
      limits: { ...limits, remaining },
      license: lic,
      inboxCheckEvery: settings.inboxCheckEvery,
    });
  }));

  r.post('/profiles/:id/filter', (req, res) => {
    const { p, settings, remaining } = runnable(req);
    const list = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 300) : [];
    const men = [];
    const seen = new Set();
    for (const raw of list) {
      const m = readMan(raw);
      if (m && !seen.has(m.id)) { seen.add(m.id); men.push(m); }
    }
    const invite = activeInvite(db, p.id);
    if (!invite) throw new HttpError(409, 'У анкети немає активного інвайту');
    const contacted = db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'");
    const contactedByAgency = db.prepare("SELECT 1 FROM messages WHERE agency_id = ? AND site_id IS ? AND man_id = ? AND status = 'sent' LIMIT 1");
    const skipped = { contacted: 0, age: 0, limit: 0 };
    const allowed = [];
    // Test mode in the extension never sends, so it is not bound by the daily limit.
    const cap = req.body?.test ? 5 : remaining;
    for (const m of men) {
      if (contacted.get(p.id, m.id) || (settings.dedupeAcrossAgency && contactedByAgency.get(p.agency_id, p.site_id, m.id))) { skipped.contacted++; continue; }
      if (m.age && ((p.target_age_min && m.age < p.target_age_min) || (p.target_age_max && m.age > p.target_age_max))) { skipped.age++; continue; }
      if (allowed.length >= cap) { skipped.limit++; continue; }
      allowed.push({ ...m, text: personalize(invite.text, m), invite_id: invite.id });
    }
    res.json({ allowed, remaining, skipped });
  });

  r.post('/profiles/:id/sent', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const man = readMan(req.body?.man);
    if (!man) throw bad('Немає даних чоловіка');
    const ok = Boolean(req.body?.ok);
    const t = now();
    const day = dayKey(t, settings.timezone);
    const inviteId = int(req.body?.invite_id, { min: 1, field: 'invite_id' }) ?? null;
    const validInvite = inviteId && db.prepare('SELECT 1 FROM invites WHERE id = ? AND profile_id = ?').get(inviteId, p.id) ? inviteId : null;
    db.prepare(`INSERT INTO messages (agency_id, profile_id, operator_id, site_id, man_id, man_name, man_age, man_country, invite_id, text, status, error, day, sent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id, man_id) DO UPDATE SET
        status = excluded.status, error = excluded.error, day = excluded.day, sent_at = excluded.sent_at,
        text = excluded.text, invite_id = excluded.invite_id, operator_id = excluded.operator_id,
        man_name = excluded.man_name, man_age = excluded.man_age, man_country = excluded.man_country
      WHERE messages.status = 'failed'`)
      .run(p.agency_id, p.id, req.user.id, p.site_id, man.id, man.name, man.age, man.country, validInvite,
        str(req.body?.text, { max: 2000 }) || '', ok ? 'sent' : 'failed', ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), day, t);
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    res.json({ ok: true, remaining, stop: remaining === 0 });
  });

  r.post('/profiles/:id/replies', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const list = Array.isArray(req.body?.men) ? req.body.men.slice(0, 300) : [];
    const t = now();
    const day = dayKey(t, settings.timezone);
    const mark = db.prepare("UPDATE messages SET replied_at = ?, reply_day = ? WHERE profile_id = ? AND man_id = ? AND status = 'sent' AND replied_at IS NULL");
    const fresh = [];
    for (const raw of list) {
      const m = readMan(raw);
      if (!m) continue;
      if (mark.run(t, day, p.id, m.id).changes) {
        fresh.push(db.prepare('SELECT * FROM messages WHERE profile_id = ? AND man_id = ?').get(p.id, m.id));
      }
    }
    if (fresh.length) notifyReplies(db, p, settings, fresh, req.user);
    res.json({ ok: true, new: fresh.length, men: fresh.map((m) => ({ id: m.man_id, name: m.man_name })) });
  });

  r.post('/profiles/:id/heartbeat', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const state = oneOf(req.body?.state || 'running', ['running', 'paused', 'idle', 'error', 'limit', 'done'], 'state');
    db.prepare('UPDATE profiles SET bot_state = ?, bot_info = ?, bot_last_seen = ? WHERE id = ?')
      .run(state, str(req.body?.info, { max: 300 }) || '', state === 'idle' ? null : now(), p.id);
    const fresh = db.prepare('SELECT status FROM profiles WHERE id = ?').get(p.id);
    res.json({ ok: true, paused: fresh.status !== 'active' });
  });

  return r;
}

function notifyReplies(db, profile, settings, msgs, user) {
  const token = settings.telegram.botToken;
  if (!token) return;
  const site = profile.site_id ? db.prepare('SELECT config FROM sites WHERE id = ?').get(profile.site_id) : null;
  let chatTpl = '';
  try { chatTpl = JSON.parse(site?.config || '{}').chatUrl || ''; } catch { /* ignore */ }
  const lines = msgs.map((m) => {
    const who = [m.man_name || `ID ${m.man_id}`, m.man_age, m.man_country].filter(Boolean).map(escapeHtml).join(', ');
    const link = chatTpl ? ` — <a href="${escapeHtml(chatTpl.replace('{id}', encodeURIComponent(m.man_id)))}">відкрити чат</a>` : '';
    return `• <b>${who}</b>${link}`;
  });
  const text = `💌 Нові відповіді для анкети <b>${escapeHtml(profile.name)}</b> (${msgs.length}):\n${lines.join('\n')}\n\nЧас відповідати особисто 🙂`;
  const operator = profile.operator_id ? db.prepare('SELECT tg_chat_id FROM users WHERE id = ?').get(profile.operator_id) : null;
  const targets = new Set([profile.tg_chat_id, operator?.tg_chat_id, settings.telegram.chatId, user.tgChatId].filter(Boolean));
  for (const chatId of targets) sendTelegram(token, chatId, text).catch(() => {});
}
