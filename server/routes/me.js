import { Router } from 'express';
import { platformGet } from '../db.js';
import { linkFor, platformToken } from '../tgbot.js';

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
  r.delete('/telegram', (req, res) => {
    db.prepare('UPDATE users SET tg_chat_id = NULL, tg_code = NULL WHERE id = ?').run(req.user.id);
    res.json({ ok: true, linked: false });
  });
  return r;
}
