import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { openDb } from './db.js';
import { createApp, ensureAdmin } from './app.js';
import { seedTestData } from './seed.js';

// Settings from .env next to package.json (variables already set in the environment win).
try { process.loadEnvFile(path.resolve('.env')); } catch { /* no .env — defaults */ }

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
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

let seeded = null;
if (TEST_MODE) seeded = seedTestData(db, cfg, { password: process.env.ADMIN_PASSWORD || 'test12345' });

const app = createApp({ db, publicUrl: PUBLIC_URL, demoSite: DEMO_SITE });
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
