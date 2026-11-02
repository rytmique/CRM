import { Router } from 'express';
import { requireRole } from '../auth.js';
import { bad, mask, mergeSettings, ah, int, str } from '../util.js';
import { getSettings } from '../services.js';
import { DEFAULT_PROMPT, PROMPT_VARS } from '../ai.js';
import { sendTelegram } from '../telegram.js';

const isMasked = (v) => typeof v === 'string' && v.includes('••••');

export default function settingsRoutes(db) {
  const r = Router();
  r.use(requireRole('owner'));

  const view = (s) => ({
    ...s,
    ai: { ...s.ai, apiKey: mask(s.ai.apiKey), hasKey: Boolean(s.ai.apiKey), envKey: Boolean(process.env.ANTHROPIC_API_KEY) },
    telegram: { ...s.telegram, botToken: mask(s.telegram.botToken), hasToken: Boolean(s.telegram.botToken) },
  });

  r.get('/', (req, res) => {
    const agency = db.prepare('SELECT name FROM agencies WHERE id = ?').get(req.user.agencyId);
    res.json({ settings: view(getSettings(db, req.user.agencyId)), agencyName: agency?.name || '', defaultPrompt: DEFAULT_PROMPT, promptVars: PROMPT_VARS });
  });

  r.put('/', (req, res) => {
    const cur = getSettings(db, req.user.agencyId);
    const patch = structuredClone(req.body?.settings || {});
    if (patch.ai && (patch.ai.apiKey === undefined || isMasked(patch.ai.apiKey))) delete patch.ai.apiKey;
    if (patch.telegram && (patch.telegram.botToken === undefined || isMasked(patch.telegram.botToken))) delete patch.telegram.botToken;
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
    if (patch.inboxCheckEvery !== undefined) patch.inboxCheckEvery = int(patch.inboxCheckEvery, { min: 0, max: 500, field: 'перевірка вхідних' }) ?? 0;
    if (patch.ai) {
      for (const k of ['model', 'language', 'instructions']) {
        if (patch.ai[k] !== undefined) patch.ai[k] = str(patch.ai[k], { max: k === 'instructions' ? 2000 : 80 }) || '';
      }
      if (patch.ai.model === '') patch.ai.model = 'claude-opus-5-5';
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
