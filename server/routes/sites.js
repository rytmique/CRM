import { Router } from 'express';
import { requireRole } from '../auth.js';
import { now } from '../db.js';
import { notFound, str } from '../util.js';
import { SITE_FIELDS, sanitizeSiteConfig, demoSiteConfig } from '../sites.js';
import { siteScenario, sanitizeScenario, DEFAULT_SCENARIO } from '../scenario.js';

export default function siteRoutes(db, cfg) {
  const r = Router();

  const out = (s) => ({ ...s, config: JSON.parse(s.config || '{}'), scenario: siteScenario(s), customScenario: Boolean(s.scenario) });

  r.get('/', (req, res) => {
    const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM profiles p WHERE p.site_id = s.id) AS profiles
                             FROM sites s WHERE s.agency_id = ? ORDER BY s.id`).all(req.user.agencyId);
    res.json({ sites: rows.map(out), fields: SITE_FIELDS, demoAvailable: cfg.demoSite, defaultScenario: DEFAULT_SCENARIO });
  });

  r.post('/', requireRole('owner'), (req, res) => {
    const name = str(req.body?.name, { required: true, field: 'назва', max: 120 });
    const preset = req.body?.preset === 'demo' && cfg.demoSite ? demoSiteConfig(cfg.publicUrl) : {};
    const config = sanitizeSiteConfig({ ...preset, ...(req.body?.config || {}) });
    const baseUrl = str(req.body?.base_url, { max: 300 }) || (preset.searchUrl ? `${cfg.publicUrl}/demo-site/` : '');
    const r2 = db.prepare('INSERT INTO sites (agency_id, name, base_url, config, created_at) VALUES (?,?,?,?,?)')
      .run(req.user.agencyId, name, baseUrl, JSON.stringify(config), now());
    res.status(201).json({ id: Number(r2.lastInsertRowid) });
  });

  r.put('/:id', requireRole('owner'), (req, res) => {
    const s = db.prepare('SELECT * FROM sites WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!s) throw notFound('Сайт не знайдено');
    const name = str(req.body?.name, { required: true, field: 'назва', max: 120 });
    const baseUrl = str(req.body?.base_url, { max: 300 }) ?? s.base_url;
    const body = req.body?.config || {};
    const prev = JSON.parse(s.config || '{}');
    // Taught buttons/marks are kept unless the form sends its own list.
    const config = sanitizeSiteConfig({ actions: prev.actions, marks: prev.marks, ...body });
    db.prepare('UPDATE sites SET name = ?, base_url = ?, config = ? WHERE id = ?').run(name, baseUrl, JSON.stringify(config), s.id);
    res.json({ ok: true });
  });

  /** Scenario: steps per man, filters, caution. Body { scenario } or { reset: true }. */
  r.put('/:id/scenario', requireRole('owner'), (req, res) => {
    const s = db.prepare('SELECT * FROM sites WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!s) throw notFound('Сайт не знайдено');
    const scenario = req.body?.reset ? null : sanitizeScenario(req.body?.scenario);
    db.prepare('UPDATE sites SET scenario = ? WHERE id = ?').run(scenario ? JSON.stringify(scenario) : '', s.id);
    res.json({ ok: true, scenario: scenario || siteScenario({}) });
  });

  r.delete('/:id', requireRole('owner'), (req, res) => {
    const x = db.prepare('DELETE FROM sites WHERE id = ? AND agency_id = ?').run(Number(req.params.id), req.user.agencyId);
    if (!x.changes) throw notFound('Сайт не знайдено');
    res.json({ ok: true });
  });

  return r;
}
