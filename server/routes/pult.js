/**
 * The platform admin's control panel ("пульт"): everything and everyone in one place.
 * Overview, a team's card (people, caps, AI, devices), registrations, devices and copies of the bot.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireRole, hashPassword, destroyUserSessions } from '../auth.js';
import { now, platformGet, platformSet, cmpVersion } from '../db.js';
import { latestBotVersion } from '../version.js';
import { bad, notFound, str, int, mergeSettings } from '../util.js';
import { getSettings, today, BOT_ONLINE_MS, planOf } from '../services.js';
import { ownerLink, operatorLink, pendingUsers, approveUser, rejectUser, stopBots, setUserActive, setPlan, mergeSolo } from '../team.js';
import { billingReport, referralReward, currentMonth, validMonth } from '../billing.js';

const DAY = 86400000;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function randomPassword(len = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(len), (b) => abc[b % abc.length]).join('');
}

/** "Chrome 131 · Windows" from a user agent (enough to tell devices apart). */
export function deviceName(ua = '') {
  const browser = /OPR\/(\d+)/.exec(ua) ? `Opera ${/OPR\/(\d+)/.exec(ua)[1]}` : /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)[1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)[1]}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}`
      : /Safari\//.test(ua) ? 'Safari' : ua ? 'Браузер' : '—';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

export default function pultRoutes(db) {
  const r = Router();
  r.use(requireRole('admin'));

  // ---------- overview ----------
  r.get('/overview', (_req, res) => {
    const t = now();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
    const n = (sql, ...p) => db.prepare(sql).get(...p).n;
    const totals = {
      agencies: n('SELECT COUNT(*) AS n FROM agencies WHERE active = 1'),
      operators: n("SELECT COUNT(*) AS n FROM users WHERE role IN ('owner','operator') AND pending = 0 AND active = 1"),
      profiles: n('SELECT COUNT(*) AS n FROM profiles'),
      botsOnline: n('SELECT COUNT(*) AS n FROM profiles WHERE bot_last_seen > ?', t - BOT_ONLINE_MS),
      sentToday: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND day = ?", day),
      repliesToday: n('SELECT COUNT(*) AS n FROM messages WHERE reply_day = ?', day),
      sent30: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND sent_at > ?", t - 30 * DAY),
      replies30: n("SELECT COUNT(*) AS n FROM messages WHERE replied_at > ? AND reply_mood != 'negative'", t - 30 * DAY),
      pending: n('SELECT COUNT(*) AS n FROM users WHERE pending = 1'),
      devices: n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND last_used_at > ?', t, t - 7 * DAY),
    };
    // what needs a look: registrations, licenses running out, bots stuck on a captcha / block, teams with no key
    const attention = [];
    if (totals.pending) attention.push({ kind: 'pending', text: `Нові реєстрації чекають підтвердження: ${totals.pending}`, go: 'registrations' });
    for (const a of db.prepare('SELECT id, name FROM agencies WHERE active = 1').all()) {
      const p = planOf(db, a.id);
      if (!p.profiles) attention.push({ kind: 'plan', text: `«${a.name}»: немає плану анкет — бот не працюватиме`, go: `agency?id=${a.id}` });
      else if (p.until && p.until < t + 5 * DAY) attention.push({ kind: 'plan', text: `«${a.name}»: план ${p.until < t ? 'закінчився' : `закінчується ${new Date(p.until).toLocaleDateString('uk-UA')}`}`, go: `agency?id=${a.id}` });
      else if (p.used > p.profiles) attention.push({ kind: 'plan', text: `«${a.name}»: активних анкет ${p.used}, а в плані ${p.profiles} — зайві не працюють`, go: `agency?id=${a.id}` });
    }
    const blocked = db.prepare(`SELECT p.name, a.name AS agency, a.id AS agency_id FROM profiles p JOIN agencies a ON a.id = p.agency_id
      WHERE p.bot_state = 'error' AND p.bot_last_seen > ? ORDER BY p.bot_last_seen DESC LIMIT 5`).all(t - BOT_ONLINE_MS);
    for (const b of blocked) attention.push({ kind: 'bot', text: `«${b.agency}» · ${b.name}: бот зупинився з помилкою або на капчі`, go: `agency?id=${b.agency_id}` });
    const teams = db.prepare(`SELECT a.id, a.name,
        (SELECT COUNT(*) FROM users u WHERE u.agency_id = a.id AND u.pending = 0 AND u.role IN ('owner','operator')) AS people,
        (SELECT COUNT(*) FROM profiles p WHERE p.agency_id = a.id) AS profiles,
        (SELECT COUNT(*) FROM profiles p WHERE p.agency_id = a.id AND p.bot_last_seen > ?) AS bots_online,
        (SELECT COUNT(*) FROM messages m WHERE m.agency_id = a.id AND m.status = 'sent' AND m.day = ?) AS sent_today,
        (SELECT COUNT(*) FROM messages m WHERE m.agency_id = a.id AND m.reply_day = ?) AS replies_today
      FROM agencies a WHERE a.active = 1 ORDER BY sent_today DESC, a.name COLLATE NOCASE LIMIT 50`).all(t - BOT_ONLINE_MS, day, day);
    res.json({ totals, attention, teams, aiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
  });

  // ---------- a team's card ----------
  const agencyOr404 = (id) => {
    const a = db.prepare('SELECT * FROM agencies WHERE id = ?').get(Number(id));
    if (!a) throw notFound('Команду не знайдено');
    return a;
  };

  r.get('/agencies/:id/card', (req, res) => {
    const a = agencyOr404(req.params.id);
    const s = getSettings(db, a.id);
    const t = now();
    const day = today(db, a.id);
    const month = day.slice(0, 7);
    const people = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, u.pending, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM profiles p WHERE p.operator_id = u.id) AS profiles,
        (SELECT COUNT(*) FROM profiles p WHERE p.operator_id = u.id AND p.bot_last_seen > ?) AS bots_online,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.status = 'sent' AND m.day = ?) AS sent_today,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.reply_day = ?) AS replies_today,
        (SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ?) AS devices,
        (SELECT COALESCE(SUM(calls), 0) FROM ai_usage g WHERE g.agency_id = u.agency_id AND g.user_id = u.id AND g.day LIKE ?) AS ai_calls
      FROM users u WHERE u.agency_id = ? ORDER BY u.role = 'owner' DESC, u.pending DESC, u.name COLLATE NOCASE`)
      .all(t - BOT_ONLINE_MS, day, day, t, `${month}%`, a.id);
    const plan = planOf(db, a.id);
    const usage = db.prepare('SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output FROM ai_usage WHERE agency_id = ? AND day LIKE ?').get(a.id, `${month}%`);
    const link = db.prepare("SELECT token, uses FROM signup_links WHERE kind = 'operator' AND agency_id = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(a.id);
    res.json({
      agency: {
        id: a.id, name: a.name, active: Boolean(a.active), created_at: a.created_at, solo: Boolean(a.solo),
        referrer: a.referred_by ? db.prepare('SELECT u.name, x.name AS team FROM users u LEFT JOIN agencies x ON x.id = u.agency_id WHERE u.id = ?').get(a.referred_by) || null : null,
      },
      caps: s.caps,
      defaults: s.defaults,
      ai: { model: s.ai.model, variants: s.ai.variants, autoOptimize: s.ai.autoOptimize !== false, sharedMemory: s.ai.sharedMemory !== false, platformKey: s.ai.platformKey !== false, teamKey: Boolean(s.ai.apiKey), platformKeySet: Boolean(process.env.ANTHROPIC_API_KEY), usage },
      billing: s.billing,
      people,
      profiles: db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE agency_id = ?').get(a.id).n,
      plan: { profiles: plan.profiles, used: plan.used, until: plan.until },
      link: link ? { token: link.token, uses: link.uses } : null,
      models: MODELS,
    });
  });

  /** Caps and AI of a team: only the admin changes these. */
  r.put('/agencies/:id/control', (req, res) => {
    const a = agencyOr404(req.params.id);
    const cur = getSettings(db, a.id);
    const patch = {};
    const c = req.body?.caps;
    if (c && typeof c === 'object') {
      patch.caps = {
        dailyMax: int(c.dailyMax, { min: 0, max: 5000, field: 'макс. денний ліміт' }) ?? 0,
        minDelayFloor: int(c.minDelayFloor, { min: 0, max: 3600, field: 'мін. пауза' }) ?? 0,
        maxOperators: int(c.maxOperators, { min: 0, max: 1000, field: 'макс. операторів' }) ?? 0,
        maxProfiles: int(c.maxProfiles, { min: 0, max: 10000, field: 'макс. анкет' }) ?? 0,
      };
    }
    const ai = req.body?.ai;
    if (ai && typeof ai === 'object') {
      patch.ai = {};
      if (ai.model !== undefined) {
        const m = str(ai.model, { max: 80 });
        if (!m) throw bad('Вкажіть модель');
        patch.ai.model = m;
      }
      if (ai.variants !== undefined) patch.ai.variants = int(ai.variants, { min: 1, max: 5, field: 'варіантів інвайту' }) ?? 3;
      for (const k of ['autoOptimize', 'sharedMemory', 'platformKey']) if (ai[k] !== undefined) patch.ai[k] = Boolean(ai[k]);
    }
    db.prepare('UPDATE agencies SET settings = ? WHERE id = ?').run(JSON.stringify(mergeSettings(cur, patch)), a.id);
    // the plan: how many active profiles, until when (until: a date or null = no end)
    const pl = req.body?.plan;
    if (pl && typeof pl === 'object') {
      const profiles = int(pl.profiles, { min: 0, max: 10000, field: 'анкет у плані' }) ?? 0;
      let until = null;
      if (pl.until) { until = Date.parse(pl.until); if (!Number.isFinite(until)) throw bad('Невірна дата плану'); }
      setPlan(db, a.id, { profiles, until });
    }
    res.json({ ok: true });
  });

  /** A solo operator joins a real team (their profiles, sites and numbers go with them). */
  r.post('/agencies/:id/merge', (req, res) => {
    const a = agencyOr404(req.params.id);
    const into = Number(req.body?.into);
    mergeSolo(db, a.id, into);
    res.json({ ok: true, into });
  });

  /** 🎁 Referral program: who brought whom, and what each person gets this month (discount first, the rest paid out). */
  r.get('/referrals', (req, res) => {
    const month = validMonth(req.query.month) ? req.query.month : currentMonth('Europe/Kyiv');
    const people = db.prepare(`SELECT DISTINCT u.id, u.name, u.email, u.agency_id, x.name AS team FROM agencies a JOIN users u ON u.id = a.referred_by
      LEFT JOIN agencies x ON x.id = u.agency_id`).all();
    const rows = people.map((p) => {
      const reward = referralReward(db, p.id, month, getSettings);
      const own = p.agency_id ? billingReport(db, { agencyId: p.agency_id, month, settings: getSettings(db, p.agency_id), onlyUserId: p.id, refs: false }).rows[0] : null;
      const fee = own?.fee || 0;
      const discount = Math.round(Math.min(reward.total, fee) * 100) / 100;
      return { user_id: p.id, name: p.name, email: p.email, team: p.team, teams: reward.teams, reward: reward.total, discount, payout: Math.round((reward.total - discount) * 100) / 100 };
    }).sort((x, y) => y.reward - x.reward);
    res.json({ month, rows, totals: { reward: rows.reduce((s, r2) => s + r2.reward, 0), payout: rows.reduce((s, r2) => s + r2.payout, 0) } });
  });

  /** Remote stop: every bot of the team stops within ~30 s (they can be started again). */
  r.post('/agencies/:id/stop-bots', (req, res) => {
    const a = agencyOr404(req.params.id);
    res.json({ ok: true, profiles: stopBots(db, 'agency_id = ?', [a.id]) });
  });

  /** The team's link for operators (the admin can hand it out too, or switch it). */
  r.post('/agencies/:id/link', (req, res) => {
    const a = agencyOr404(req.params.id);
    const owner = db.prepare("SELECT id FROM users WHERE agency_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(a.id);
    const l = operatorLink(db, a.id, owner?.id ?? req.user.id);
    res.json({ link: { token: l.token, uses: l.uses } });
  });

  // ---------- people ----------
  const userOr404 = (id) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role != 'admin'").get(Number(id));
    if (!u) throw notFound('Людину не знайдено');
    return u;
  };
  r.post('/users/:id/approve', (req, res) => { approveUser(db, userOr404(req.params.id).id); res.json({ ok: true }); });
  r.post('/users/:id/reject', (req, res) => { rejectUser(db, userOr404(req.params.id).id); res.json({ ok: true }); });
  r.post('/users/:id/block', (req, res) => { setUserActive(db, userOr404(req.params.id).id, false); res.json({ ok: true }); });
  r.post('/users/:id/unblock', (req, res) => { setUserActive(db, userOr404(req.params.id).id, true); res.json({ ok: true }); });
  r.post('/users/:id/signout', (req, res) => { destroyUserSessions(db, userOr404(req.params.id).id); res.json({ ok: true }); });
  r.post('/users/:id/stop-bots', (req, res) => {
    const u = userOr404(req.params.id);
    res.json({ ok: true, profiles: stopBots(db, 'operator_id = ?', [u.id]) });
  });
  r.post('/users/:id/password', (req, res) => {
    const u = userOr404(req.params.id);
    const password = randomPassword();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
    destroyUserSessions(db, u.id);
    res.json({ email: u.email, password });
  });

  // ---------- registrations ----------
  const linkRows = () => db.prepare(`SELECT l.id, l.token, l.note, l.licenses, l.days, l.uses, l.max_uses, l.active, l.created_at, l.expires_at,
      (SELECT a.name FROM users u JOIN agencies a ON a.id = u.agency_id WHERE u.signup_link_id = l.id LIMIT 1) AS used_by
    FROM signup_links l WHERE l.kind = 'owner' ORDER BY l.id DESC LIMIT 50`).all();
  r.get('/registrations', (_req, res) => res.json({ pending: pendingUsers(db), links: linkRows() }));
  r.post('/links', (req, res) => {
    const note = str(req.body?.note, { max: 120 }) || '';
    // the team's plan written on the link: how many profiles, days (0 = no end)
    const licenses = int(req.body?.planProfiles ?? req.body?.licenses, { min: 0, max: 10000, field: 'анкет у плані' }) ?? 0;
    const days = int(req.body?.planDays ?? req.body?.days, { min: 0, max: 3650, field: 'днів' }) ?? 0;
    const l = ownerLink(db, req.user.id, { note, licenses, days });
    res.status(201).json({ link: { id: l.id, token: l.token, expires_at: l.expires_at } });
  });
  r.delete('/links/:id', (req, res) => {
    db.prepare("UPDATE signup_links SET active = 0 WHERE id = ? AND kind = 'owner'").run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- devices and copies of the bot ----------
  r.get('/devices', (req, res) => {
    const t = now();
    const agencyId = Number(req.query.agency_id) || 0;
    const rows = db.prepare(`SELECT s.rowid AS id, s.kind, s.ip, s.agent, s.build, s.version, s.created_at, s.last_used_at, u.id AS user_id, u.name, u.email, u.role,
        a.id AS agency_id, a.name AS agency_name, b.revoked_at AS build_revoked, b.agency_id AS build_agency
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN agencies a ON a.id = u.agency_id LEFT JOIN extension_builds b ON b.build = s.build AND s.build != ''
      WHERE s.expires_at > ? ${agencyId ? 'AND u.agency_id = ?' : ''} ORDER BY s.last_used_at DESC LIMIT 500`).all(t, ...(agencyId ? [agencyId] : []));
    const latest = latestBotVersion();
    res.json({
      devices: rows.map((d) => ({ ...d, device: deviceName(d.agent), foreignBuild: Boolean(d.build && d.build_agency && d.build_agency !== d.agency_id),
        outdated: d.kind === 'bot' && cmpVersion(d.version, latest) < 0 })),
      requireBuild: platformGet(db, 'requireBuild', '0') === '1',
      oldCopies: rows.filter((d) => d.kind === 'bot' && !d.build).length,
      latest, minBotVersion: platformGet(db, 'minBotVersion', ''),
      outdated: rows.filter((d) => d.kind === 'bot' && cmpVersion(d.version, latest) < 0).length,
    });
  });
  r.delete('/devices/:id', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE rowid = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });
  r.get('/builds', (_req, res) => {
    const rows = db.prepare(`SELECT b.id, b.build, b.ip, b.created_at, b.revoked_at, u.name, u.email, a.name AS agency_name,
        (SELECT COUNT(*) FROM sessions s WHERE s.build = b.build AND s.expires_at > ?) AS sessions,
        (SELECT MAX(s.last_used_at) FROM sessions s WHERE s.build = b.build) AS last_used
      FROM extension_builds b LEFT JOIN users u ON u.id = b.user_id LEFT JOIN agencies a ON a.id = b.agency_id ORDER BY b.id DESC LIMIT 300`).all(now());
    res.json({ builds: rows });
  });
  /** Switches a copy of the bot off: it is signed out now and can never log in again. */
  r.post('/builds/:id/revoke', (req, res) => {
    const b = db.prepare('SELECT * FROM extension_builds WHERE id = ?').get(Number(req.params.id));
    if (!b) throw notFound('Копію не знайдено');
    db.prepare('UPDATE extension_builds SET revoked_at = ? WHERE id = ?').run(now(), b.id);
    db.prepare('DELETE FROM sessions WHERE build = ?').run(b.build);
    res.json({ ok: true });
  });
  r.put('/security', (req, res) => {
    if (req.body?.requireBuild !== undefined) platformSet(db, 'requireBuild', req.body.requireBuild ? '1' : '0');
    // the oldest bot that may still start (older ones are told to update); '' = any
    if (req.body?.minBotVersion !== undefined) {
      const v = String(req.body.minBotVersion || '').trim();
      if (v && !/^\d+(\.\d+){0,3}$/.test(v)) throw bad('Версія виглядає як 1.3.0');
      if (v && cmpVersion(v, latestBotVersion()) > 0) throw bad(`Найновіша версія бота — ${latestBotVersion()}`);
      platformSet(db, 'minBotVersion', v);
    }
    res.json({ requireBuild: platformGet(db, 'requireBuild', '0') === '1', minBotVersion: platformGet(db, 'minBotVersion', '') });
  });

  return r;
}
