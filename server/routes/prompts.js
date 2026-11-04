/**
 * Prompts: each person writes their own (their tricks), the team lead keeps the team's base one,
 * and "what works" shows, by real replies, whose prompts and which invites get answered — anyone can take them.
 */
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { now } from '../db.js';
import { bad, str, mergeSettings } from '../util.js';
import { getSettings } from '../services.js';
import { DEFAULT_PROMPT, PROMPT_VARS } from '../ai.js';

const DAY = 86400000;
const MIN_SENT = 20; // fewer sends say nothing yet

function readExamples(raw) {
  try {
    const ex = JSON.parse(raw || '[]');
    return Array.isArray(ex) ? ex.map((e) => ({ text: String(e.text || e).slice(0, 1000), from: String(e.from || '') })).filter((e) => e.text) : [];
  } catch { return []; }
}

export default function promptRoutes(db) {
  const r = Router();

  r.get('/', (req, res) => {
    const a = req.user.agencyId;
    const s = getSettings(db, a);
    const me = db.prepare('SELECT prompt, prompt_examples FROM users WHERE id = ?').get(req.user.id);
    const since = now() - 30 * DAY;
    // the team by real replies over 30 days (positive replies only)
    const people = db.prepare(`SELECT u.id, u.name, u.role, u.prompt, u.prompt_examples,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.status = 'sent' AND m.sent_at > ?) AS sent,
        (SELECT COUNT(*) FROM messages m WHERE m.operator_id = u.id AND m.status = 'sent' AND m.sent_at > ? AND m.replied_at IS NOT NULL AND m.reply_mood != 'negative') AS replies
      FROM users u WHERE u.agency_id = ? AND u.pending = 0 AND u.active = 1 AND u.role IN ('owner','operator')`).all(since, since, a)
      .map((u) => ({
        id: u.id, name: u.name, role: u.role, me: u.id === req.user.id,
        promptSource: u.prompt.trim() ? 'own' : s.ai.masterPrompt.trim() ? 'team' : 'default',
        prompt: u.prompt.trim() || '',
        examples: readExamples(u.prompt_examples).length,
        sent: u.sent, replies: u.replies, rate: u.sent ? u.replies / u.sent : null, enough: u.sent >= MIN_SENT,
      }))
      .sort((x, y) => (y.enough - x.enough) || ((y.rate ?? -1) - (x.rate ?? -1)) || (y.sent - x.sent));
    const best = db.prepare(`SELECT i.id, i.text, p.name AS profile_name, u.name AS operator_name,
        COUNT(m.id) AS sent, SUM(m.replied_at IS NOT NULL AND m.reply_mood != 'negative') AS replies
      FROM invites i JOIN profiles p ON p.id = i.profile_id LEFT JOIN users u ON u.id = p.operator_id
      JOIN messages m ON m.invite_id = i.id AND m.status = 'sent'
      WHERE p.agency_id = ? GROUP BY i.id HAVING COUNT(m.id) >= ?
      ORDER BY (SUM(m.replied_at IS NOT NULL AND m.reply_mood != 'negative') + 1.0) / (COUNT(m.id) + 2) DESC LIMIT 8`).all(a, MIN_SENT)
      .map((i) => ({ ...i, replies: i.replies || 0, rate: (i.replies || 0) / i.sent }));
    res.json({
      mine: { prompt: me?.prompt || '', examples: readExamples(me?.prompt_examples) },
      team: { prompt: s.ai.masterPrompt || '', canEdit: req.user.role === 'owner' },
      defaultPrompt: DEFAULT_PROMPT, promptVars: PROMPT_VARS,
      people, best, minSent: MIN_SENT,
    });
  });

  /** My own prompt and examples ("what works for me"): used for all my profiles that have no prompt of their own. */
  r.put('/mine', (req, res) => {
    const out = {};
    if (req.body?.prompt !== undefined) {
      const p = String(req.body.prompt ?? '').replace(/\r\n/g, '\n').trim();
      if (p.length > 8000) throw bad('Промпт задовгий (макс. 8000 символів)');
      out.prompt = p === DEFAULT_PROMPT.trim() ? '' : p;
    }
    if (req.body?.examples !== undefined) {
      if (!Array.isArray(req.body.examples)) throw bad('Приклади — списком');
      const ex = req.body.examples.map((e) => ({ text: str(e?.text ?? e, { max: 1000 }) || '', from: str(e?.from, { max: 80 }) || '' }))
        .filter((e) => e.text.length >= 15).slice(0, 10);
      out.prompt_examples = JSON.stringify(ex);
    }
    for (const [k, v] of Object.entries(out)) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, req.user.id);
    res.json({ ok: true });
  });

  /** The team's base prompt (for everyone who has no prompt of their own). */
  r.put('/team', requireRole('owner'), (req, res) => {
    const p = String(req.body?.prompt ?? '').replace(/\r\n/g, '\n').trim();
    if (p.length > 8000) throw bad('Промпт задовгий (макс. 8000 символів)');
    const cur = getSettings(db, req.user.agencyId);
    const next = mergeSettings(cur, { ai: { masterPrompt: p === DEFAULT_PROMPT.trim() ? '' : p } });
    db.prepare('UPDATE agencies SET settings = ? WHERE id = ?').run(JSON.stringify(next), req.user.agencyId);
    res.json({ ok: true });
  });

  return r;
}
