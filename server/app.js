import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from './util.js';
import { authenticate, hashPassword } from './auth.js';
import { now } from './db.js';
import { buildZip } from './zip.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import operatorRoutes from './routes/operators.js';
import profileRoutes from './routes/profiles.js';
import licenseRoutes from './routes/licenses.js';
import siteRoutes from './routes/sites.js';
import settingsRoutes from './routes/settings.js';
import statsRoutes from './routes/stats.js';
import botRoutes from './routes/bot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db, publicUrl = 'http://localhost:3000', demoSite = true, log = console }) {
  const cfg = { publicUrl: publicUrl.replace(/\/$/, ''), demoSite };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // The extension calls the API from chrome-extension://… ; auth is a Bearer token (no cookies), so * is safe.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: now() }));
  app.use('/api/auth', authRoutes(db));

  const api = express.Router();
  api.use(authenticate(db));
  api.use('/admin', adminRoutes(db, cfg));
  api.use((req, _res, next) => (req.user.role === 'admin' ? next(new HttpError(403, 'Цей розділ доступний лише обліковим записам агенції')) : next()));
  api.use('/bot', botRoutes(db));
  api.use('/operators', operatorRoutes(db));
  api.use('/profiles', profileRoutes(db));
  api.use('/licenses', licenseRoutes(db));
  api.use('/sites', siteRoutes(db, cfg));
  api.use('/settings', settingsRoutes(db));
  api.use('/stats', statsRoutes(db));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Невідомий метод API')));

  // Extension download, pre-configured with this server's address.
  app.get('/download/extension.zip', (_req, res) => {
    const dir = path.join(ROOT, 'extension');
    const files = [];
    const walk = (d, rel = '') => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(abs, r);
        else if (r !== 'config.js') files.push({ name: `agency-bot/${r}`, data: fs.readFileSync(abs) });
      }
    };
    walk(dir);
    files.push({ name: 'agency-bot/config.js', data: Buffer.from(`self.AGENCY_DEFAULT_SERVER = ${JSON.stringify(cfg.publicUrl)};\n`) });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="agency-bot.zip"');
    res.send(buildZip(files));
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

/** Creates the platform admin on first start. Returns generated password if one was created. */
export function ensureAdmin(db, { email, password }) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return null;
  const pass = password || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (agency_id, role, name, email, pass_hash, created_at) VALUES (NULL, 'admin', 'Адміністратор', ?, ?, ?)")
    .run(email || 'admin@local', hashPassword(pass), now());
  return { email: email || 'admin@local', password: pass, generated: !password };
}

