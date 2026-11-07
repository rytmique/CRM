import { Router } from 'express';
import { platformGet } from '../db.js';
import { linkFor, platformToken } from '../tgbot.js';
import { getSettings, readPrefs, readSamples } from '../services.js';
import { bad } from '../util.js';
import { DEFAULT_PROMPT, DEFAULT_SAMPLES } from '../ai.js';
import { teamShift, personShift, insideTeam, shiftText } from '../shift.js';

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
    const own = readSamples(u.samples);
    const teamS = readSamples(conf?.ai?.samples);
    const teamSamples = teamS.invites.length || teamS.letters.length ? teamS : DEFAULT_SAMPLES;
    return { prompt: u.prompt || '', defaultPrompt: DEFAULT_PROMPT, teamPrompt: conf?.ai?.masterPrompt || '',
      samples: own.invites.length || own.letters.length ? own : null, teamSamples, chanceEveryMin: p.chanceEveryMin ?? team?.chance.everyMin ?? 30,
      allchatPerNight: p.allchatPerNight ?? team?.allchat.perNight ?? 2,
      // the shift: the team lead's hours, and mine inside them (an operator can only narrow it)
      teamShift: conf ? { ...teamShift(conf), text: shiftText(teamShift(conf)) } : null,
      myShift: conf ? (({ from, to, own: mine }) => ({ from, to, own: mine }))(personShift(conf, u.prefs)) : null };
  };
  const me = (id) => db.prepare('SELECT id, agency_id, prompt, prefs, samples FROM users WHERE id = ?').get(id);
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
      shiftFrom: cur.shiftFrom, shiftTo: cur.shiftTo,
    };
    // my own hours: inside the team lead's shift only; null = the team's hours
    if (b.shiftFrom !== undefined || b.shiftTo !== undefined) {
      if (b.shiftFrom === null || b.shiftFrom === '' || b.shiftTo === null || b.shiftTo === '') { next.shiftFrom = undefined; next.shiftTo = undefined; }
      else {
        const own = { from: num(b.shiftFrom, 0, 23, 'Початок'), to: num(b.shiftTo, 0, 23, 'Кінець') };
        const team = teamShift(u.agency_id ? getSettings(db, u.agency_id) : {});
        if (!insideTeam(team, own)) throw bad(`Ваші години мають бути в межах зміни команди: ${shiftText(team)}`);
        next.shiftFrom = own.from;
        next.shiftTo = own.to;
      }
    }
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), u.id);
    if (b.samples !== undefined) {
      // her own samples; the same as the team's (or none) = use the team's
      const sm = readSamples(b.samples);
      const conf = u.agency_id ? getSettings(db, u.agency_id) : null;
      const teamS = readSamples(conf?.ai?.samples);
      const team = teamS.invites.length || teamS.letters.length ? teamS : DEFAULT_SAMPLES;
      const same = sm.invites.join('\u0000') === team.invites.join('\u0000') && sm.letters.join('\u0000') === team.letters.join('\u0000');
      db.prepare('UPDATE users SET samples = ? WHERE id = ?').run(JSON.stringify(same ? {} : sm), u.id);
    }
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
