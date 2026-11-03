import { Router } from 'express';
import { now } from '../db.js';
import { bad, notFound, forbidden, str } from '../util.js';
import { PRESETS, sanitizeScenario } from '../scenario.js';

/** Scenario templates: built-in presets + the agency's own saved ones. */
export default function scenarioRoutes(db) {
  const r = Router();

  const own = (req) => {
    const t = db.prepare('SELECT * FROM scenario_templates WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!t) throw notFound('Шаблон не знайдено');
    if (!mine(req.user, t)) throw forbidden('Цей шаблон створив інший оператор — попросіть керівника');
    return t;
  };
  /** Owner: every template. Operator: the ones they made. */
  const mine = (user, t) => user.role === 'owner' || (user.role === 'operator' && t.created_by === user.id);
  const out = (t, user) => ({
    id: t.id, name: t.name, scenario: sanitizeScenario(JSON.parse(t.scenario)), updated_at: t.updated_at, can_edit: mine(user, t),
    profiles: db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE scenario_id = ?').get(t.id).n,
  });

  r.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM scenario_templates WHERE agency_id = ? ORDER BY name COLLATE NOCASE').all(req.user.agencyId);
    res.json({ templates: rows.map((t) => out(t, req.user)), presets: PRESETS.map((p) => ({ ...p, scenario: sanitizeScenario(p.scenario) })) });
  });

  r.post('/', (req, res) => {
    const name = str(req.body?.name, { required: true, field: 'назва шаблону', max: 80 });
    if (db.prepare('SELECT COUNT(*) AS n FROM scenario_templates WHERE agency_id = ?').get(req.user.agencyId).n >= 50) throw bad('Забагато шаблонів (макс. 50)');
    const sc = sanitizeScenario(req.body?.scenario);
    const t = now();
    const id = Number(db.prepare('INSERT INTO scenario_templates (agency_id, name, scenario, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?)')
      .run(req.user.agencyId, name, JSON.stringify(sc), t, t, req.user.id).lastInsertRowid);
    res.status(201).json({ template: out(db.prepare('SELECT * FROM scenario_templates WHERE id = ?').get(id), req.user) });
  });

  r.put('/:id', (req, res) => {
    const t = own(req);
    const name = str(req.body?.name, { max: 80, field: 'назва шаблону' }) || t.name;
    const sc = req.body?.scenario ? JSON.stringify(sanitizeScenario(req.body.scenario)) : t.scenario;
    db.prepare('UPDATE scenario_templates SET name = ?, scenario = ?, updated_at = ? WHERE id = ?').run(name, sc, now(), t.id);
    res.json({ template: out(db.prepare('SELECT * FROM scenario_templates WHERE id = ?').get(t.id), req.user) });
  });

  r.delete('/:id', (req, res) => {
    const t = own(req);
    db.prepare('UPDATE profiles SET scenario_id = NULL WHERE scenario_id = ?').run(t.id);
    db.prepare('DELETE FROM scenario_templates WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  return r;
}
