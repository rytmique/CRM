import { Router } from 'express';
import { requireRole } from '../auth.js';
import { now } from '../db.js';
import { bad, notFound, int } from '../util.js';
import { licenseState } from '../services.js';

const DAY = 86400000;

export default function licenseRoutes(db) {
  const r = Router();
  r.use(requireRole('owner'));

  r.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT l.*, p.name AS profile_name FROM licenses l LEFT JOIN profiles p ON p.id = l.profile_id
      WHERE l.agency_id = ? ORDER BY (l.profile_id IS NULL), l.expires_at, l.id`).all(req.user.agencyId);
    const licenses = rows.map((l) => ({ ...l, ...licenseState(l) }));
    const summary = { total: licenses.length, active: 0, free: 0, expired: 0, revoked: 0, expiringSoon: 0 };
    for (const l of licenses) {
      summary[l.state] = (summary[l.state] || 0) + 1;
      if (l.state === 'active' && l.activated_at && l.daysLeft <= 3) summary.expiringSoon++;
    }
    res.json({ licenses, summary });
  });

  r.post('/:id/assign', (req, res) => {
    const l = db.prepare('SELECT * FROM licenses WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!l) throw notFound('Ліцензію не знайдено');
    const profileId = int(req.body?.profile_id, { min: 1, field: 'анкета' });
    if (!profileId) {
      db.prepare('UPDATE licenses SET profile_id = NULL WHERE id = ?').run(l.id);
      return res.json({ ok: true });
    }
    const st = licenseState(l);
    if (st.state === 'revoked' || st.state === 'expired') throw bad('Ця ліцензія недійсна (прострочена або відкликана)');
    if (!db.prepare('SELECT 1 FROM profiles WHERE id = ? AND agency_id = ?').get(profileId, req.user.agencyId)) throw bad('Анкету не знайдено');
    db.prepare('UPDATE licenses SET profile_id = NULL WHERE profile_id = ? AND id != ?').run(profileId, l.id);
    const t = now();
    if (!l.activated_at) {
      db.prepare('UPDATE licenses SET profile_id = ?, activated_at = ?, expires_at = ? WHERE id = ?').run(profileId, t, t + l.days * DAY, l.id);
    } else {
      db.prepare('UPDATE licenses SET profile_id = ? WHERE id = ?').run(profileId, l.id);
    }
    res.json({ ok: true });
  });

  return r;
}
