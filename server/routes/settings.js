import { Router } from 'express';
import { requireRole } from '../auth.js';
import { bad, mask, mergeSettings, ah, int, str, dayKey } from '../util.js';
import { getSettings } from '../services.js';
import { platformGet } from '../db.js';
import { DEFAULT_PROMPT, PROMPT_VARS } from '../ai.js';
import { sendTelegram } from '../telegram.js';
import { memoryLines } from '../learning.js';

const isMasked = (v) => typeof v === 'string' && v.includes('••••');
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export default function settingsRoutes(db) {
  const r = Router();

  /** What the profile form needs for the prompt editor — for operators too. */
  r.get('/prompt-info', (req, res) => {
    const s = getSettings(db, req.user.agencyId);
    res.json({ defaultPrompt: DEFAULT_PROMPT, promptVars: PROMPT_VARS, masterPrompt: s.ai?.masterPrompt || '' });
  });

  r.use(requireRole('owner'));

  const view = (s) => ({
    ...s,
    ai: { ...s.ai, apiKey: mask(s.ai.apiKey), hasKey: Boolean(s.ai.apiKey), envKey: Boolean(process.env.ANTHROPIC_API_KEY) },
    telegram: { ...s.telegram, botToken: mask(s.telegram.botToken), hasToken: Boolean(s.telegram.botToken) },
  });

  /** AI texts this month per person (the team's key): who uses it how much. */
  const usageOf = (agencyId, month) => db.prepare(`SELECT g.user_id, COALESCE(u.name, '—') AS name, SUM(g.calls) AS calls, SUM(g.input_tokens) AS input, SUM(g.output_tokens) AS output
    FROM ai_usage g LEFT JOIN users u ON u.id = g.user_id WHERE g.agency_id = ? AND g.day LIKE ? GROUP BY g.user_id ORDER BY calls DESC`).all(agencyId, `${month}%`);

  r.get('/', (req, res) => {
    const agency = db.prepare('SELECT name FROM agencies WHERE id = ?').get(req.user.agencyId);
    const s = getSettings(db, req.user.agencyId);
    res.json({
      settings: view(s), agencyName: agency?.name || '', defaultPrompt: DEFAULT_PROMPT, promptVars: PROMPT_VARS,
      memory: memoryLines(db, { ai: { sharedMemory: true } }),
      usage: usageOf(req.user.agencyId, dayKey(Date.now(), s.timezone).slice(0, 7)),
      usageDays: db.prepare(`SELECT day, SUM(calls) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ai_usage
        WHERE agency_id = ? AND day >= ? GROUP BY day ORDER BY day`).all(req.user.agencyId, dayKey(Date.now() - 29 * 86400000, s.timezone)),
      models: MODELS,
      platformKey: s.ai.platformKey !== false && Boolean(process.env.ANTHROPIC_API_KEY),
      autoReplyOpen: platformGet(db, 'autoReply', '0') === '1',
    });
  });

  r.put('/', (req, res) => {
    const cur = getSettings(db, req.user.agencyId);
    const patch = structuredClone(req.body?.settings || {});
    // the platform admin's switches: caps, model, learning — the team cannot change them
    delete patch.caps;
    if (patch.ai) for (const k of ['variants', 'autoOptimize', 'sharedMemory', 'platformKey', 'operatorPrompt', 'examples']) delete patch.ai[k];
    // the team lead chooses the model (only the known ones)
    if (patch.ai?.model !== undefined && !MODELS.includes(patch.ai.model)) delete patch.ai.model;
    if (patch.ai && (patch.ai.apiKey === undefined || isMasked(patch.ai.apiKey))) delete patch.ai.apiKey;
    if (patch.telegram && (patch.telegram.botToken === undefined || isMasked(patch.telegram.botToken))) delete patch.telegram.botToken;
    if (patch.billing) {
      const b = patch.billing;
      patch.billing = {
        ...cur.billing,
        perReply: b.perReply === undefined ? cur.billing.perReply : Math.max(0, Math.min(100000, Number(b.perReply) || 0)),
        currency: b.currency === undefined ? cur.billing.currency : (str(b.currency, { max: 8 }) || '$'),
      };
    }
    if (patch.timezone) {
      try { new Intl.DateTimeFormat('en', { timeZone: patch.timezone }); } catch { throw bad('Невідомий часовий пояс'); }
    }
    if (patch.defaults) {
      patch.defaults = {
        dailyLimit: int(patch.defaults.dailyLimit, { min: 1, max: 5000, field: 'денний ліміт' }) ?? cur.defaults.dailyLimit,
        minDelay: int(patch.defaults.minDelay, { min: 5, max: 3600, field: 'мін. пауза' }) ?? cur.defaults.minDelay,
        maxDelay: int(patch.defaults.maxDelay, { min: 5, max: 3600, field: 'макс. пауза' }) ?? cur.defaults.maxDelay,
      };
      if (patch.defaults.maxDelay < patch.defaults.minDelay) throw bad('Макс. пауза має бути не меншою за мінімальну');
    }
    if (patch.modes) {
      // «Шанс» / «Аллчат»: sane numbers only; «auto reply» only once the platform admin opened it
      const m = patch.modes;
      const n = (v, a, b, d) => { const x = Number(v); return v === undefined || !Number.isFinite(x) ? d : Math.min(b, Math.max(a, Math.round(x))); };
      const c = cur.modes;
      patch.modes = {
        chance: { on: m.chance?.on === undefined ? c.chance.on : Boolean(m.chance.on), everyMin: n(m.chance?.everyMin, 10, 240, c.chance.everyMin),
          onlineOnly: m.chance?.onlineOnly === undefined ? c.chance.onlineOnly : Boolean(m.chance.onlineOnly) },
        allchat: { on: m.allchat?.on === undefined ? c.allchat.on : Boolean(m.allchat.on), perNight: n(m.allchat?.perNight, 1, 6, c.allchat.perNight),
          who: ['silent', 'replied', 'all'].includes(m.allchat?.who) ? m.allchat.who : c.allchat.who,
          silentHours: n(m.allchat?.silentHours, 1, 72, c.allchat.silentHours), gapHours: n(m.allchat?.gapHours, 1, 12, c.allchat.gapHours),
          maxPerPass: n(m.allchat?.maxPerPass, 1, 200, c.allchat.maxPerPass) },
        autoReply: { on: platformGet(db, 'autoReply', '0') === '1' ? Boolean(m.autoReply?.on ?? c.autoReply.on) : false },
      };
    }
    if (patch.reports) patch.reports = { eachPass: patch.reports.eachPass === undefined ? cur.reports.eachPass : Boolean(patch.reports.eachPass) };
    if (patch.inboxCheckEvery !== undefined) patch.inboxCheckEvery = int(patch.inboxCheckEvery, { min: 0, max: 500, field: 'перевірка вхідних' }) ?? 0;
    if (patch.ai) {
      for (const k of ['model', 'language', 'instructions']) {
        if (patch.ai[k] !== undefined) patch.ai[k] = str(patch.ai[k], { max: k === 'instructions' ? 2000 : 80 }) || '';
      }
      if (patch.ai.model === '') patch.ai.model = 'claude-opus-5-5';
      if (patch.ai.variants !== undefined) patch.ai.variants = int(patch.ai.variants, { min: 1, max: 5, field: 'варіантів інвайту' }) ?? 3;
      for (const k of ['autoOptimize', 'sharedMemory']) if (patch.ai[k] !== undefined) patch.ai[k] = Boolean(patch.ai[k]);
      if (patch.ai.masterPrompt !== undefined) {
        const mp = String(patch.ai.masterPrompt ?? '').replace(/\r\n/g, '\n').trim();
        if (mp.length > 8000) throw bad('Майстер-промт задовгий (макс. 8000 символів)');
        // The built-in prompt saved as-is means "use the default" (so future improvements of it apply).
        patch.ai.masterPrompt = mp === DEFAULT_PROMPT.trim() ? '' : mp;
      }
    }
    const next = mergeSettings(cur, patch);
    db.prepare('UPDATE agencies SET settings = ? WHERE id = ?').run(JSON.stringify(next), req.user.agencyId);
    if (req.body?.agencyName) {
      db.prepare('UPDATE agencies SET name = ? WHERE id = ?').run(str(req.body.agencyName, { max: 120 }), req.user.agencyId);
    }
    res.json({ settings: view(next) });
  });

  r.post('/telegram-test', ah(async (req, res) => {
    const s = getSettings(db, req.user.agencyId);
    const chatId = str(req.body?.chatId, { max: 64 }) || s.telegram.chatId;
    if (!s.telegram.botToken) throw bad('Спочатку збережіть токен Telegram-бота');
    if (!chatId) throw bad('Вкажіть chat id');
    const out = await sendTelegram(s.telegram.botToken, chatId, '✅ Тестове сповіщення: сповіщення про відповіді працюють.');
    if (!out.ok) throw bad(`Telegram: ${out.error || 'не вдалося надіслати'}`);
    res.json({ ok: true });
  }));

  return r;
}
