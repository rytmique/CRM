import { Router } from 'express';
import { startBots, stopBotsFor, botStatus } from '../control.js';

const ids = (body) => (Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : []);

/** ▶ / ⏹ the bots from the panel (each person — their own profiles). */
export default function controlRoutes(db) {
  const r = Router();
  r.get('/', (req, res) => res.json({ bots: botStatus(db, req.user) }));
  r.post('/start', (req, res) => res.json({ ok: true, started: startBots(db, req.user, ids(req.body)) }));
  r.post('/stop', (req, res) => res.json({ ok: true, stopped: stopBotsFor(db, req.user, ids(req.body)) }));
  return r;
}
