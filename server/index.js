import path from 'node:path';
import { openDb } from './db.js';
import { createApp, ensureAdmin } from './app.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const DEMO_SITE = process.env.DEMO_SITE !== '0';

const db = openDb(path.join(DATA_DIR, 'agency.db'));
const admin = ensureAdmin(db, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
if (admin) {
  console.log('\n  Створено адміністратора платформи:');
  console.log(`    логін:  ${admin.email}`);
  console.log(`    пароль: ${admin.password}${admin.generated ? '   (згенеровано — збережіть!)' : ''}\n`);
}

const app = createApp({ db, publicUrl: PUBLIC_URL, demoSite: DEMO_SITE });
const server = app.listen(PORT, HOST, () => {
  console.log(`  Панель: ${PUBLIC_URL}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log('  ШІ: ANTHROPIC_API_KEY не задано — інвайти генеруються шаблоном, доки ключ не вказано в Налаштуваннях.');
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
