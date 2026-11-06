import { Router } from 'express';
import { now } from '../db.js';
import { bad, forbidden, notFound, str } from '../util.js';
import { getSettings } from '../services.js';
import { billingReport, currentMonth, validMonth, referralReward, REF_PCT, REF_MONTHS } from '../billing.js';
import { refCode } from '../team.js';

/** Payment for the bot: the owner sees everyone, an operator only themself. */
export default function billingRoutes(db) {
  const r = Router();

  r.get('/', (req, res) => {
    const settings = getSettings(db, req.user.agencyId);
    const month = validMonth(req.query.month) ? req.query.month : currentMonth(settings.timezone);
    res.json(billingReport(db, { agencyId: req.user.agencyId, month, settings, onlyUserId: req.user.role === 'owner' ? null : req.user.id, getSettings }));
  });

  /** 🎁 My referral link and the teams I brought: who is waiting, who pays, what it gives me this month. */
  r.get('/referrals', (req, res) => {
    const settings = getSettings(db, req.user.agencyId);
    const month = validMonth(req.query.month) ? req.query.month : currentMonth(settings.timezone);
    const reward = referralReward(db, req.user.id, month, getSettings);
    const waiting = db.prepare(`SELECT a.name, a.solo, u.created_at FROM agencies a JOIN users u ON u.agency_id = a.id AND u.role = 'owner'
      WHERE a.referred_by = ? AND u.pending = 1 ORDER BY u.id DESC`).all(req.user.id);
    res.json({ code: refCode(db, req.user.id), pct: REF_PCT, months: REF_MONTHS, month, reward, waiting, currency: settings.billing?.currency || '$' });
  });

  /** The month's real earnings (end of the month). Operator: own; owner: anyone of the agency. amount null = back to the estimate. */
  r.put('/earnings', (req, res) => {
    const settings = getSettings(db, req.user.agencyId);
    const month = String(req.body?.month || '');
    if (!validMonth(month)) throw bad('Невірний місяць');
    if (month > currentMonth(settings.timezone)) throw bad('Цей місяць ще не настав');
    const userId = req.user.role === 'owner' ? Number(req.body?.operator_id) || req.user.id : req.user.id;
    if (req.user.role !== 'owner' && req.body?.operator_id && Number(req.body.operator_id) !== req.user.id) throw forbidden();
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND agency_id = ?').get(userId, req.user.agencyId)) throw notFound('Оператора не знайдено');
    if (req.body?.amount === null || req.body?.amount === '') {
      db.prepare('DELETE FROM earnings WHERE operator_id = ? AND month = ?').run(userId, month);
    } else {
      const amount = Number(req.body?.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw bad('Вкажіть суму заробітку');
      db.prepare(`INSERT INTO earnings (agency_id, operator_id, month, amount, note, entered_by, updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(operator_id, month) DO UPDATE SET amount = excluded.amount, note = excluded.note, entered_by = excluded.entered_by, updated_at = excluded.updated_at`)
        .run(req.user.agencyId, userId, month, Math.round(amount * 100) / 100, str(req.body?.note, { max: 200 }) || '', req.user.id, now());
    }
    res.json(billingReport(db, { agencyId: req.user.agencyId, month, settings, onlyUserId: req.user.role === 'owner' ? null : req.user.id, getSettings }));
  });

  return r;
}
