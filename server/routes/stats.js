import { Router } from 'express';
import { now } from '../db.js';
import { int, lastDays } from '../util.js';
import { getSettings, BOT_ONLINE_MS, licenseState } from '../services.js';

export default function statsRoutes(db) {
  const r = Router();

  /** One call that feeds the whole dashboard. Operators see only their own profiles. */
  r.get('/overview', (req, res) => {
    const u = req.user;
    const settings = getSettings(db, u.agencyId);
    const days = int(req.query.days, { min: 1, max: 90, field: 'днів' }) || 14;
    const range = lastDays(days, settings.timezone);
    const from = range[0];
    const today = range[range.length - 1];
    const isOp = u.role === 'operator';
    const pScope = isOp ? 'p.agency_id = ? AND p.operator_id = ?' : 'p.agency_id = ?';
    const pParams = isOp ? [u.agencyId, u.id] : [u.agencyId];
    const mScope = `m.profile_id IN (SELECT p.id FROM profiles p WHERE ${pScope})`;

    const sentByDay = db.prepare(`SELECT m.day, SUM(m.status = 'sent') AS sent, SUM(m.status = 'failed') AS failed
      FROM messages m WHERE ${mScope} AND m.day >= ? GROUP BY m.day`).all(...pParams, from);
    const repliesByDay = db.prepare(`SELECT m.reply_day AS day, COUNT(*) AS replies FROM messages m
      WHERE ${mScope} AND m.reply_day >= ? GROUP BY m.reply_day`).all(...pParams, from);
    const map = new Map(range.map((d) => [d, { day: d, sent: 0, failed: 0, replies: 0 }]));
    for (const x of sentByDay) if (map.has(x.day)) Object.assign(map.get(x.day), { sent: x.sent, failed: x.failed });
    for (const x of repliesByDay) if (map.has(x.day)) map.get(x.day).replies = x.replies;
    const daily = [...map.values()];

    const todayRow = map.get(today);
    const period = daily.reduce((a, d) => ({ sent: a.sent + d.sent, failed: a.failed + d.failed, replies: a.replies + d.replies }), { sent: 0, failed: 0, replies: 0 });
    // Reply rate = of the invites sent in the period, how many got an answer (cohort).
    const cohort = db.prepare(`SELECT COUNT(*) AS sent, SUM(m.replied_at IS NOT NULL) AS replied
      FROM messages m WHERE ${mScope} AND m.status = 'sent' AND m.day >= ?`).get(...pParams, from);
    period.rate = cohort.sent ? (cohort.replied || 0) / cohort.sent : 0;
    const todayCohort = db.prepare(`SELECT COUNT(*) AS sent, SUM(m.replied_at IS NOT NULL) AS replied
      FROM messages m WHERE ${mScope} AND m.status = 'sent' AND m.day = ?`).get(...pParams, today);

    const t = now();
    const profiles = db.prepare(`
      SELECT p.id, p.name, p.age, p.photo_url, p.status, p.bot_state, p.bot_last_seen, u.name AS operator_name,
        COALESCE(SUM(m.status = 'sent' AND m.day = ?), 0) AS sent_today,
        COALESCE(SUM(m.reply_day = ?), 0) AS replies_today,
        COALESCE(SUM(m.status = 'sent'), 0) AS sent_period,
        COALESCE(SUM(m.status = 'sent' AND m.replied_at IS NOT NULL), 0) AS replied_period
      FROM profiles p
      LEFT JOIN users u ON u.id = p.operator_id
      LEFT JOIN messages m ON m.profile_id = p.id AND m.day >= ?
      WHERE ${pScope}
      GROUP BY p.id ORDER BY sent_period DESC, p.name COLLATE NOCASE`).all(today, today, from, ...pParams)
      .map((p) => ({ ...p, bot_online: Boolean(p.bot_last_seen && t - p.bot_last_seen < BOT_ONLINE_MS) }));

    const operators = isOp ? [] : db.prepare(`
      SELECT u.id, u.name,
        COALESCE(SUM(m.status = 'sent'), 0) AS sent_period,
        COALESCE(SUM(m.status = 'sent' AND m.replied_at IS NOT NULL), 0) AS replied_period,
        COALESCE(SUM(m.status = 'sent' AND m.day = ?), 0) AS sent_today
      FROM users u LEFT JOIN messages m ON m.operator_id = u.id AND m.day >= ?
      WHERE u.agency_id = ? AND u.role IN ('operator','owner')
      GROUP BY u.id HAVING sent_period > 0 OR u.role = 'operator'
      ORDER BY sent_period DESC`).all(today, from, u.agencyId);

    const recentReplies = db.prepare(`
      SELECT m.id, m.man_id, m.man_name, m.man_age, m.man_country, m.replied_at, m.sent_at, p.id AS profile_id, p.name AS profile_name,
             s.config AS site_config
      FROM messages m JOIN profiles p ON p.id = m.profile_id LEFT JOIN sites s ON s.id = m.site_id
      WHERE ${mScope} AND m.replied_at IS NOT NULL ORDER BY m.replied_at DESC LIMIT 15`).all(...pParams)
      .map(({ site_config, ...m }) => {
        let chatUrl = '';
        try { chatUrl = (JSON.parse(site_config || '{}').chatUrl || '').replace('{id}', encodeURIComponent(m.man_id)); } catch { /* ignore */ }
        return { ...m, chat_url: chatUrl };
      });

    let licenses = null;
    if (!isOp) {
      const ls = db.prepare('SELECT * FROM licenses WHERE agency_id = ?').all(u.agencyId).map((l) => licenseState(l, t));
      licenses = {
        active: ls.filter((l) => l.state === 'active').length,
        free: ls.filter((l) => l.state === 'free').length,
        expiringSoon: ls.filter((l) => l.state === 'active' && l.daysLeft <= 3).length,
      };
    }

    res.json({
      range: { from, to: today, days },
      today: { sent: todayRow.sent, failed: todayRow.failed, replies: todayRow.replies, rate: todayCohort.sent ? (todayCohort.replied || 0) / todayCohort.sent : 0 },
      period,
      botsOnline: profiles.filter((p) => p.bot_online).length,
      profilesActive: profiles.filter((p) => p.status === 'active').length,
      profilesTotal: profiles.length,
      daily, profiles, operators, recentReplies, licenses,
    });
  });

  /** Outreach log with filters + pagination. */
  r.get('/messages', (req, res) => {
    const u = req.user;
    const isOp = u.role === 'operator';
    const where = [isOp ? 'p.agency_id = ? AND p.operator_id = ?' : 'p.agency_id = ?'];
    const params = isOp ? [u.agencyId, u.id] : [u.agencyId];
    if (req.query.profile_id) { where.push('m.profile_id = ?'); params.push(Number(req.query.profile_id)); }
    if (req.query.status === 'replied') where.push('m.replied_at IS NOT NULL');
    else if (req.query.status === 'sent') where.push("m.status = 'sent' AND m.replied_at IS NULL");
    else if (req.query.status === 'failed') where.push("m.status = 'failed'");
    if (req.query.q) {
      where.push('(m.man_name LIKE ? OR m.man_id LIKE ?)');
      const q = `%${String(req.query.q).slice(0, 80)}%`;
      params.push(q, q);
    }
    const limit = int(req.query.limit, { min: 1, max: 200, field: 'limit' }) || 50;
    const page = int(req.query.page, { min: 1, max: 100000, field: 'page' }) || 1;
    const base = `FROM messages m JOIN profiles p ON p.id = m.profile_id LEFT JOIN users u ON u.id = m.operator_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
    const rows = db.prepare(`SELECT m.*, p.name AS profile_name, u.name AS operator_name ${base}
      ORDER BY COALESCE(m.replied_at, m.sent_at) DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
    res.json({ messages: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  });

  return r;
}
