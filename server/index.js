import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { openDb } from './db.js';
import { createApp, ensureAdmin } from './app.js';
import { seedTestData } from './seed.js';
import { hashPassword } from './auth.js';

// Settings from .env next to package.json (variables already set in the environment win).
try { process.loadEnvFile(path.resolve('.env')); } catch { /* no .env — defaults */ }

// Railway (and similar hosts) tell us the public domain and where the volume is mounted.
const ON_RAILWAY = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
if (ON_RAILWAY) process.env.TRUST_PROXY = process.env.TRUST_PROXY || '1';
// On Railway without a volume the database lives in the container and is wiped on every deploy.
const PERSISTENT = !ON_RAILWAY || Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
if (!PERSISTENT) console.warn('\n  [!] Диск (Volume) не підключено — дані зникнуть після наступного оновлення. Railway → сервіс → Volume → /data\n');
const DEMO_SITE = process.env.DEMO_SITE !== '0';
const TEST_MODE = process.env.TEST_SEED === '1';

function openBrowser(url) {
  try {
    const [cmd, args, opts] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {}];
    spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* no browser available */ }
}

const db = openDb(path.join(DATA_DIR, 'agency.db'));
const cfg = { publicUrl: PUBLIC_URL, demoSite: DEMO_SITE };

const admin = ensureAdmin(db, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
if (admin) {
  const note = `Адміністратор платформи\r\nлогін:  ${admin.email}\r\nпароль: ${admin.password}\r\nпанель: ${PUBLIC_URL}\r\n`;
  if (admin.generated) fs.writeFileSync(path.join(DATA_DIR, 'admin-login.txt'), note);
  console.log('\n  Створено адміністратора платформи:');
  console.log(`    логін:  ${admin.email}`);
  console.log(`    пароль: ${admin.password}${admin.generated ? `   (згенеровано, збережено в ${path.join(DATA_DIR, 'admin-login.txt')})` : ''}\n`);
}

// Forgot the admin password on a host without a console (Railway): set RESET_ADMIN_PASSWORD, redeploy, log in, remove it.
if (process.env.RESET_ADMIN_PASSWORD) {
  if (process.env.RESET_ADMIN_PASSWORD.length < 8) {
    console.warn('  [!] RESET_ADMIN_PASSWORD закороткий (мін. 8 символів) — пароль не змінено.');
  } else {
    const target = db.prepare("SELECT id, email FROM users WHERE role = 'admin' AND (email = ? OR ? = '') ORDER BY id LIMIT 1")
      .get(process.env.ADMIN_EMAIL || '', process.env.ADMIN_EMAIL || '')
      || db.prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(process.env.RESET_ADMIN_PASSWORD), target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    console.log(`\n  Пароль адміністратора ${target.email} змінено з RESET_ADMIN_PASSWORD. Видаліть цю змінну.\n`);
  }
}

let seeded = null;
if (TEST_MODE) seeded = seedTestData(db, cfg, { password: process.env.ADMIN_PASSWORD || 'test12345' });

const app = createApp({ db, publicUrl: PUBLIC_URL, demoSite: DEMO_SITE, persistent: PERSISTENT });
const server = app.listen(PORT, HOST, () => {
  console.log(`  Панель: ${PUBLIC_URL}${TEST_MODE ? '   [ТЕСТОВИЙ СТЕНД — окрема база, реальні дані не зачіпаються]' : ''}`);
  if (TEST_MODE) {
    console.log('\n  Входи тестового стенда (пароль у всіх однаковий):');
    console.log(`    адмін платформи:  ${process.env.ADMIN_EMAIL || 'admin@test'}`);
    console.log('    керівник агенції: owner@test');
    console.log('    оператор (для розширення): operator@test');
    console.log(`    пароль: ${process.env.ADMIN_PASSWORD || 'test12345'}`);
    console.log(`    демо-сайт для бота: ${PUBLIC_URL}/demo-site/search.html${seeded ? '' : '   (дані вже були створені раніше)'}\n`);
  }
  if (!process.env.ANTHROPIC_API_KEY) console.log('  ШІ: ключ ANTHROPIC_API_KEY не задано — інвайти генеруються шаблоном, доки ключ не вказано в Налаштуваннях.');
  console.log('  Зупинити: закрийте це вікно або натисніть Ctrl+C.\n');
  if (process.env.OPEN_BROWSER === '1') openBrowser(PUBLIC_URL);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  [!] Порт ${PORT} уже зайнятий — схоже, панель уже запущена. Відкриваю її в браузері.`);
    console.error('      Щоб запустити ще одну копію, вкажіть інший PORT у файлі .env.\n');
    if (process.env.OPEN_BROWSER === '1') openBrowser(PUBLIC_URL);
  } else {
    console.error(`\n  [!] Не вдалося запустити сервер: ${e.message}\n`);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
