import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from './util.js';
import { authenticate, hashPassword } from './auth.js';
import { now } from './db.js';
import { buildZip } from './zip.js';
import { stripJs } from './strip.js';
import { onAiUsage } from './ai.js';
import { dayKey } from './util.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import pultRoutes from './routes/pult.js';
import operatorRoutes from './routes/operators.js';
import profileRoutes from './routes/profiles.js';
import licenseRoutes from './routes/licenses.js';
import siteRoutes from './routes/sites.js';
import settingsRoutes from './routes/settings.js';
import statsRoutes from './routes/stats.js';
import billingRoutes from './routes/billing.js';
import botRoutes from './routes/bot.js';
import scenarioRoutes from './routes/scenarios.js';
import promptRoutes from './routes/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db, publicUrl = 'http://localhost:3000', demoSite = true, persistent = true, mediaDir, log = console }) {
  const cfg = {
    publicUrl: publicUrl.replace(/\/$/, ''), demoSite, persistent,
    mediaDir: mediaDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agency-media-')),
  };
  const app = express();
  app.disable('x-powered-by');
  // every AI text is counted for the team and the person whose profile it is (the team lead sees who uses the key how much)
  const addUsage = db.prepare(`INSERT INTO ai_usage (agency_id, user_id, day, calls, input_tokens, output_tokens) VALUES (?,?,?,1,?,?)
    ON CONFLICT(agency_id, user_id, day) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`);
  onAiUsage(({ agencyId, userId, timezone, usage }) => {
    addUsage.run(agencyId, userId, dayKey(now(), timezone || 'Europe/Kyiv'), Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0);
  });
  // Behind Caddy/nginx in another container: TRUST_PROXY=1 so the login limiter sees real client IPs.
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? true : 'loopback');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // The extension calls the API from chrome-extension://… ; auth is a Bearer token (no cookies), so * is safe.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Bot-Version');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: now(), persistentStorage: cfg.persistent }));
  app.use('/api/auth', authRoutes(db, cfg));

  const api = express.Router();
  api.use(authenticate(db));
  /** The bot, only after logging in: each download is a separate marked copy (who took it; it can be switched off). */
  api.get('/extension/download', (req, res) => {
    const build = crypto.randomBytes(8).toString('base64url');
    db.prepare('INSERT INTO extension_builds (build, user_id, agency_id, ip, created_at) VALUES (?,?,?,?,?)')
      .run(build, req.user.id, req.user.agencyId ?? null, String(req.ip || '').slice(0, 64), now());
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="agency-bot.zip"');
    res.set('Cache-Control', 'no-store');
    res.send(extensionZip(cfg.publicUrl, build));
  });
  api.use('/admin', adminRoutes(db, cfg));
  api.use('/admin', pultRoutes(db, cfg));
  api.use((req, _res, next) => (req.user.role === 'admin' ? next(new HttpError(403, 'Цей розділ доступний лише обліковим записам агенції')) : next()));
  api.use('/bot', botRoutes(db, cfg));
  api.use('/operators', operatorRoutes(db));
  api.use('/profiles', profileRoutes(db, cfg));
  api.use('/licenses', licenseRoutes(db));
  api.use('/sites', siteRoutes(db, cfg));
  api.use('/scenarios', scenarioRoutes(db));
  api.use('/settings', settingsRoutes(db));
  api.use('/stats', statsRoutes(db));
  api.use('/billing', billingRoutes(db));
  api.use('/prompts', promptRoutes(db));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Невідомий метод API')));

  // The old open download: the bot is now taken only from the panel after logging in.
  app.get('/download/extension.zip', (_req, res) => {
    res.status(403).type('text/plain; charset=utf-8').send('Бот завантажується лише з панелі після входу: «⬇ Бот».');
  });

  if (demoSite) app.use('/demo-site', express.static(path.join(ROOT, 'demo-site')));
  app.use(express.static(path.join(ROOT, 'web'), { index: 'index.html', extensions: ['html'] }));

  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON' });
    if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) return res.status(409).json({ error: 'Такий запис уже існує' });
    log.error?.(`[${req.method} ${req.originalUrl}]`, err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  });

  return app;
}

/** The extension folder as a zip: this server's address and the copy's mark baked in, code without comments. */
export function extensionZip(publicUrl, build = '') {
  const dir = path.join(ROOT, 'extension');
  const files = [];
  const walk = (d, rel = '') => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (r === 'config.js') continue;
      else if (r.endsWith('.js')) files.push({ name: `agency-bot/${r}`, data: Buffer.from(stripJs(fs.readFileSync(abs, 'utf8'))) });
      else files.push({ name: `agency-bot/${r}`, data: fs.readFileSync(abs) });
    }
  };
  walk(dir);
  files.push({ name: 'agency-bot/config.js', data: Buffer.from(`self.AGENCY_DEFAULT_SERVER = ${JSON.stringify(publicUrl)};\nself.AGENCY_BUILD = ${JSON.stringify(build)};\n`) });
  return buildZip(files);
}

/** Creates the platform admin on first start. Returns generated password if one was created. */
export function ensureAdmin(db, { email, password }) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return null;
  const pass = password || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (agency_id, role, name, email, pass_hash, created_at) VALUES (NULL, 'admin', 'Адміністратор', ?, ?, ?)")
    .run(email || 'admin@local', hashPassword(pass), now());
  return { email: email || 'admin@local', password: pass, generated: !password };
}

