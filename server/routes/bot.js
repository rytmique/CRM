import { Router } from 'express';
import { now, tx } from '../db.js';
import { HttpError, bad, forbidden, notFound, str, int, oneOf, ah, dayKey } from '../util.js';
import {
  getSettings, licenseState, profileScope, getVisibleProfile, profileLicense, activeInvite,
  limitsFor, sentToday, insertInvite, hourWindow, followupTexts, saveFollowup, canEditSite,
} from '../services.js';
import { generateInvite, generateFollowup, templateFollowup } from '../ai.js';
import { personalize } from '../personalize.js';
import { sendTelegram, escapeHtml } from '../telegram.js';
import { SITE_FIELDS, sanitizeSiteConfig, fillUrl } from '../sites.js';
import { profileScenario, followupSteps, filterReason, pickVariant, attempts } from '../scenario.js';
import { filesForStep, mediaFile } from '../media.js';

const HOUR = 3600000;
const MAX_STEP_FAILS = 3;

/** API used by the browser extension (the bot). */
export default function botRoutes(db, cfg) {
  const r = Router();

  const readMan = (m) => {
    if (!m || typeof m !== 'object') return null;
    const id = String(m.id ?? '').trim().slice(0, 120);
    if (!id) return null;
    const age = Number.parseInt(m.age, 10);
    const url = String(m.url ?? '').trim();
    return {
      id,
      name: String(m.name ?? '').trim().slice(0, 80),
      age: Number.isInteger(age) && age >= 18 && age < 100 ? age : null,
      country: String(m.country ?? '').trim().slice(0, 80),
      url: /^https?:\/\//i.test(url) ? url.slice(0, 500) : '',
      marks: Array.isArray(m.marks) ? m.marks.map(String).slice(0, 20) : [],
    };
  };

  const siteOf = (p) => (p.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id) : null);
  const configOf = (site) => { try { return JSON.parse(site?.config || '{}'); } catch { return {}; } };

  /** Everything needed to turn a scenario step into concrete actions for one man. */
  const stepContext = (p) => {
    const site = siteOf(p);
    const config = configOf(site);
    return {
      p, site, config, scenario: profileScenario(db, p, site),
      invite: activeInvite(db, p.id), followups: followupTexts(db, p.id),
    };
  };

  const fillHer = (t, p) => String(t || '').replaceAll('{her_name}', p.name || '').replaceAll('{her_age}', p.age ? String(p.age) : '');

  /** Step index (0-based) → [{do:'message', text} | {do:'click', sel…} | {do:'view'…} | {do:'pause'…}] */
  const resolveStep = (ctx, idx, man) => {
    const step = ctx.scenario.steps[idx];
    const out = [];
    let inviteId = null;
    for (const a of step?.actions || []) {
      if (a.do === 'message') {
        let t = '';
        if (a.text === 'invite') { t = ctx.invite?.text || ''; inviteId = ctx.invite?.id ?? null; }
        else if (a.text === 'followup') t = ctx.followups.get(idx + 1) || ctx.invite?.text || '';
        else t = pickVariant(a.custom);
        t = personalize(fillHer(t, ctx.p), man);
        const files = filesForStep(db, ctx.p.id, idx + 1, a.files);
        if (t || files.length) out.push({ do: 'message', text: t, files });
      } else if (a.do === 'click') {
        const def = (ctx.config.actions || []).find((x) => x.key === a.action);
        if (def) out.push({ do: 'click', key: def.key, name: def.name, sel: def.sel, where: def.where, chance: a.chance ?? 100 });
      } else {
        out.push({ ...a });
      }
    }
    return { actions: out, inviteId, messages: out.filter((a) => a.do === 'message').length };
  };

  const manUrl = (ctx, id, stored) => fillUrl(ctx.config.manUrl, id) || stored || '';

  /** Next step time or "done" after the step with index `done` (0-based) has been completed at time t. */
  const dueNow = (pid, t = now()) => db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND status = 'sent' AND stage = 'active' AND replied_at IS NULL AND next_at IS NOT NULL AND next_at <= ?").get(pid, t).n;

  const after = (scenario, done, t) => {
    const next = scenario.steps[done + 1];
    return next ? { stage: 'active', next_at: t + Math.round(next.wait * HOUR) } : { stage: 'done', next_at: null };
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
    const scenario = profileScenario(db, p, site);
    // Follow-up texts are written once per profile and step, like the invite.
    const have = followupTexts(db, p.id);
    const previous = [invite.text];
    for (const step of followupSteps(scenario)) {
      if (!have.has(step)) {
        let gen;
        try { gen = await generateFollowup({ profile: p, settings, step, previous }); } catch { gen = templateFollowup(p, step); } // AI down must not stop the bot
        saveFollowup(db, { profileId: p.id, step, text: gen.text, source: gen.source, model: gen.model });
        have.set(step, gen.text);
      }
      previous.push(have.get(step));
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND status = 'sent' AND stage = 'active' AND next_at IS NOT NULL").get(p.id).n;
    res.json({
      profile: { id: p.id, name: p.name, age: p.age, site_profile_id: p.site_profile_id },
      site: { id: site.id, name: site.name, base_url: site.base_url, config: JSON.parse(site.config || '{}') },
      invite: { id: invite.id, text: invite.text },
      limits: { ...limits, remaining },
      license: lic,
      inboxCheckEvery: settings.inboxCheckEvery,
      timezone: settings.timezone,
      scenario: { steps: scenario.steps.length, attempts: attempts(scenario), human: scenario.human, followups: scenario.steps.length > 1 },
      pending,
    });
  }));

  /** A file to attach (her photo…): only files of profiles this user may run. */
  r.get('/media/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM media WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!m) throw notFound('Файл не знайдено');
    getVisibleProfile(db, req.user, m.profile_id);
    res.set('Content-Type', m.type);
    res.set('X-File-Name', encodeURIComponent(m.name));
    res.sendFile(mediaFile(cfg, m));
  });

  /** Site adapter for the click-to-teach panel in the extension. */
  r.get('/profiles/:id/site', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const site = siteOf(p);
    if (!site) throw bad('Для анкети не вибрано сайт. Виберіть сайт у панелі (Анкети → Редагувати).');
    res.json({ site: { id: site.id, name: site.name, config: configOf(site) }, fields: SITE_FIELDS });
  });

  /** Saves what the operator taught by clicking. Owner: any site of the agency; operator: sites of own profiles. */
  r.put('/sites/:id', (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!site) throw notFound('Сайт не знайдено');
    if (!canEditSite(db, req.user, site)) throw forbidden('Цей сайт не прив’язаний до ваших анкет');
    const config = sanitizeSiteConfig(req.body?.config || {});
    db.prepare('UPDATE sites SET config = ? WHERE id = ?').run(JSON.stringify(config), site.id);
    res.json({ ok: true, config });
  });

  r.post('/profiles/:id/filter', (req, res) => {
    const { p, settings, remaining } = runnable(req);
    const list = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 300) : [];
    const men = [];
    const seen = new Set();
    for (const raw of list) {
      const m = readMan(raw);
      if (m && !seen.has(m.id)) { seen.add(m.id); men.push(m); }
    }
    const ctx = stepContext(p);
    if (!ctx.invite) throw new HttpError(409, 'У анкети немає активного інвайту');
    const contacted = db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'");
    const contactedByAgency = db.prepare("SELECT 1 FROM messages WHERE agency_id = ? AND site_id IS ? AND man_id = ? AND status = 'sent' LIMIT 1");
    const skipped = { contacted: 0, age: 0, filter: 0, limit: 0 };
    const allowed = [];
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour);
    // Test mode in the extension never sends, so it is not bound by the daily limit.
    const cap = req.body?.test ? 5 : remaining;
    for (const m of men) {
      if (contacted.get(p.id, m.id) || (settings.dedupeAcrossAgency && contactedByAgency.get(p.agency_id, p.site_id, m.id))) { skipped.contacted++; continue; }
      if (m.age && ((p.target_age_min && m.age < p.target_age_min) || (p.target_age_max && m.age > p.target_age_max))) { skipped.age++; continue; }
      if (filterReason(m, ctx.scenario.filters)) { skipped.filter++; continue; }
      if (allowed.length >= cap) { skipped.limit++; continue; }
      const step = resolveStep(ctx, 0, m);
      const first = step.actions.find((a) => a.do === 'message');
      allowed.push({ ...m, url: manUrl(ctx, m.id, m.url), step: 1, actions: step.actions, text: first?.text || '', invite_id: step.inviteId });
    }
    res.json({ allowed, remaining, skipped, hourLeft: hour.left, hourResetAt: hour.resetAt });
  });

  /** Men whose next scenario step is due (he has not replied yet). */
  r.get('/profiles/:id/due', (req, res) => {
    const { p, remaining } = runnable(req);
    const ctx = stepContext(p);
    const limit = int(req.query.limit, { min: 1, max: 20, field: 'limit' }) || 5;
    const t = now();
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour, t);
    const out = [];
    if (remaining > 0) {
      const rows = db.prepare(`SELECT * FROM messages WHERE profile_id = ? AND status = 'sent' AND stage = 'active' AND replied_at IS NULL
        AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?`).all(p.id, t, limit * 2);
      const finish = db.prepare("UPDATE messages SET stage = 'done', next_at = NULL WHERE id = ?");
      const later = db.prepare('UPDATE messages SET next_at = ? WHERE id = ?');
      for (const m of rows) {
        if (out.length >= limit) break;
        if (m.step >= ctx.scenario.steps.length) { finish.run(m.id); continue; } // the scenario got shorter
        const man = { id: m.man_id, name: m.man_name, age: m.man_age, country: m.man_country };
        const url = manUrl(ctx, m.man_id, m.man_url);
        if (!url) { later.run(t + 6 * HOUR, m.id); continue; } // nowhere to go until "URL профілю чоловіка" is set
        const step = resolveStep(ctx, m.step, man);
        out.push({ ...man, url, step: m.step + 1, of: ctx.scenario.steps.length, actions: step.actions });
      }
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND status = 'sent' AND stage = 'active' AND next_at IS NOT NULL").get(p.id).n;
    const nextAt = db.prepare("SELECT MIN(next_at) AS t FROM messages WHERE profile_id = ? AND status = 'sent' AND stage = 'active' AND next_at IS NOT NULL").get(p.id).t;
    res.json({ men: out, remaining, pending, nextAt, hourLeft: hour.left, hourResetAt: hour.resetAt, noManUrl: !ctx.config.manUrl });
  });

  /** Result of a follow-up step (2, 3…) for one man. */
  r.post('/profiles/:id/step', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const ctx = stepContext(p);
    const manId = String(req.body?.man?.id ?? req.body?.man_id ?? '').trim();
    const stepNo = int(req.body?.step, { min: 2, max: 50, field: 'step' });
    if (!manId || !stepNo) throw bad('Немає даних кроку');
    const m = db.prepare("SELECT * FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'").get(p.id, manId);
    if (!m) throw notFound('Цьому чоловіку анкета ще не писала');
    const ok = Boolean(req.body?.ok);
    const t = now();
    const day = dayKey(t, settings.timezone);
    const messages = ok ? Math.min(10, int(req.body?.messages, { min: 0, max: 10, field: 'messages' }) ?? 0) : 0;
    let state = { stage: m.stage, next_at: m.next_at };
    if (m.step === stepNo - 1 && m.stage === 'active') {
      tx(db, () => {
        db.prepare('INSERT INTO touches (agency_id, profile_id, operator_id, man_id, step, ok, messages, text, error, day, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(p.agency_id, p.id, req.user.id, manId, stepNo, ok ? 1 : 0, messages, str(req.body?.text, { max: 2000 }) || '', ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), day, t);
        if (ok) {
          state = after(ctx.scenario, stepNo - 1, t);
          db.prepare('UPDATE messages SET step = ?, stage = ?, next_at = ?, last_at = ?, fails = 0 WHERE id = ?').run(stepNo, state.stage, state.next_at, t, m.id);
        } else {
          const fails = m.fails + 1;
          state = fails >= MAX_STEP_FAILS ? { stage: 'done', next_at: null } : { stage: 'active', next_at: t + HOUR };
          db.prepare('UPDATE messages SET stage = ?, next_at = ?, fails = ?, error = ? WHERE id = ?')
            .run(state.stage, state.next_at, fails, str(req.body?.error, { max: 300 }) || 'помилка', m.id);
        }
      });
    }
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour, t);
    res.json({ ok: true, stage: state.stage, remaining, stop: remaining === 0, hourLeft: hour.left, hourResetAt: hour.resetAt, due: dueNow(p.id, t) });
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
    const scenario = profileScenario(db, p, siteOf(p));
    const next = ok ? after(scenario, 0, t) : { stage: 'active', next_at: null };
    db.prepare(`INSERT INTO messages (agency_id, profile_id, operator_id, site_id, man_id, man_name, man_age, man_country, invite_id, text, status, error, day, sent_at,
        step, stage, next_at, man_url, last_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
      ON CONFLICT(profile_id, man_id) DO UPDATE SET
        status = excluded.status, error = excluded.error, day = excluded.day, sent_at = excluded.sent_at,
        text = excluded.text, invite_id = excluded.invite_id, operator_id = excluded.operator_id,
        man_name = excluded.man_name, man_age = excluded.man_age, man_country = excluded.man_country,
        step = 1, stage = excluded.stage, next_at = excluded.next_at, man_url = excluded.man_url, last_at = excluded.last_at
      WHERE messages.status = 'failed'`)
      .run(p.agency_id, p.id, req.user.id, p.site_id, man.id, man.name, man.age, man.country, validInvite,
        str(req.body?.text, { max: 2000 }) || '', ok ? 'sent' : 'failed', ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), day, t,
        next.stage, next.next_at, man.url, t);
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    const hour = hourWindow(db, p.id, scenario.human.perHour, t);
    res.json({ ok: true, remaining, stop: remaining === 0, hourLeft: hour.left, hourResetAt: hour.resetAt, due: dueNow(p.id, t) });
  });

  r.post('/profiles/:id/replies', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const list = Array.isArray(req.body?.men) ? req.body.men.slice(0, 300) : [];
    const t = now();
    const day = dayKey(t, settings.timezone);
    // A reply stops his scenario: from here on a live person writes to him.
    const mark = db.prepare("UPDATE messages SET replied_at = ?, reply_day = ?, stage = 'replied', next_at = NULL WHERE profile_id = ? AND man_id = ? AND status = 'sent' AND replied_at IS NULL");
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
