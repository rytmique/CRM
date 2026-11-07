import { Router } from 'express';
import { startBots, stopBotsFor, botStatus } from '../control.js';
import { HttpError } from '../util.js';
import { getSettings } from '../services.js';
import { personShift, inShift, shiftText } from '../shift.js';
import { tr } from '../i18n.js';

const ids = (body) => (Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200) : []);

/** ▶ / ⏹ the bots from the panel (each person — their own profiles). */
export default function controlRoutes(db) {
  const r = Router();
  r.get('/', (req, res) => res.json({ bots: botStatus(db, req.user) }));
  r.post('/start', (req, res) => {
    if (req.user.role !== 'admin') {
      const settings = getSettings(db, req.user.agencyId);
      const w = personShift(settings, req.user.role === 'operator' ? req.user.prefs : null);
      if (w.auto && !inShift(Date.now(), settings.timezone, w)) throw new HttpError(409, tr(req.user.lang, 'Зараз не зміна ({hours}). Бот увімкнеться сам на початку зміни.', { hours: tr(req.user.lang, shiftText(w)) }));
    }
    res.json({ ok: true, started: startBots(db, req.user, ids(req.body)) });
  });
  r.post('/stop', (req, res) => res.json({ ok: true, stopped: stopBotsFor(db, req.user, ids(req.body)) }));
  return r;
}
