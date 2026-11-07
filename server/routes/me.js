import { Router } from 'express';
import { platformGet } from '../db.js';
import { linkFor, platformToken } from '../tgbot.js';
import { getSettings, readPrefs } from '../services.js';
import { bad } from '../util.js';
import { DEFAULT_PROMPT } from '../ai.js';

/** The person's own things, for every role (the platform admin too): their Telegram link. */
export default function meRoutes(db) {
  const r = Router();
  const view = (u) => ({ linked: Boolean(u?.tg_chat_id), bot: platformGet(db, 'tgBotName', ''), ready: Boolean(platformToken(db) && platformGet(db, 'tgBotName', '')) });
  r.get('/telegram', (req, res) => res.json(view(db.prepare('SELECT tg_chat_id FROM users WHERE id = ?').get(req.user.id))));
  /** «Підключити Telegram»: a one-time link that opens the bot; pressing Start there links this person. */
  r.post('/telegram/link', (req, res) => {
    if (!platformToken(db)) return res.status(409).json({ error: 'Telegram-бот платформи ще не налаштований — напишіть адміну' });
    res.json({ ...linkFor(db, req.user.id), ...view(db.prepare('SELECT tg_chat_id FROM users WHERE id = ?').get(req.user.id)) });
  });
  /** My few settings: the master prompt for my texts, how often «Шанс», how many «Аллчат» passes a night. */
  const prefsView = (u) => {
    const conf = u.agency_id ? getSettings(db, u.agency_id) : null;
    const team = conf?.modes;
    const p = readPrefs(u.prefs);
    return { prompt: u.prompt || '', defaultPrompt: DEFAULT_PROMPT, teamPrompt: conf?.ai?.masterPrompt || '', chanceEveryMin: p.chanceEveryMin ?? team?.chance.everyMin ?? 30,
      allchatPerNight: p.allchatPerNight ?? team?.allchat.perNight ?? 2 };
  };
  const me = (id) => db.prepare('SELECT id, agency_id, prompt, prefs FROM users WHERE id = ?').get(id);
  r.get('/prefs', (req, res) => res.json(prefsView(me(req.user.id))));
  r.put('/prefs', (req, res) => {
    const u = me(req.user.id);
    const cur = readPrefs(u.prefs);
    const b = req.body || {};
    const num = (v, a, z, name) => {
      if (v === undefined || v === null || v === '') return undefined;
      const x = Math.round(Number(v));
      if (!Number.isFinite(x) || x < a || x > z) throw bad(`${name}: від ${a} до ${z}`);
      return x;
    };
    const next = {
      chanceEveryMin: b.chanceEveryMin === undefined ? cur.chanceEveryMin : num(b.chanceEveryMin, 10, 240, 'Шанс — кожні N хвилин'),
      allchatPerNight: b.allchatPerNight === undefined ? cur.allchatPerNight : num(b.allchatPerNight, 1, 6, 'Аллчат — разів за ніч'),
    };
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), u.id);
    if (b.prompt !== undefined) {
      const p = String(b.prompt ?? '').replace(/\r\n/g, '\n').trim();
      if (p.length > 8000) throw bad('Промпт задовгий (макс. 8000 символів)');
      const team = (u.agency_id ? getSettings(db, u.agency_id).ai?.masterPrompt : '') || '';
      // the built-in or the team's one unchanged = «use the default»
      db.prepare('UPDATE users SET prompt = ? WHERE id = ?').run(p === DEFAULT_PROMPT.trim() || (team && p === team.trim()) ? '' : p, u.id);
    }
    res.json(prefsView(me(u.id)));
  });

  r.delete('/telegram', (req, res) => {
    db.prepare('UPDATE users SET tg_chat_id = NULL, tg_code = NULL WHERE id = ?').run(req.user.id);
    res.json({ ok: true, linked: false });
  });
  return r;
}
