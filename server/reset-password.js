// Reset any user's password from the server console:
//   node server/reset-password.js <email> <new-password>
//   docker compose exec app node server/reset-password.js <email> <new-password>
import path from 'node:path';
import { openDb } from './db.js';
import { hashPassword, destroyUserSessions } from './auth.js';

try { process.loadEnvFile(path.resolve('.env')); } catch { /* no .env */ }
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Використання: node server/reset-password.js <email> <новий-пароль (мін. 8 символів)>');
  process.exit(1);
}
const db = openDb(path.join(path.resolve(process.env.DATA_DIR || 'data'), 'agency.db'));
const user = db.prepare('SELECT id, role, name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`Користувача ${email} не знайдено.`);
  process.exit(1);
}
db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
destroyUserSessions(db, user.id);
db.close();
console.log(`Пароль для ${email} (${user.name}, ${user.role}) змінено.`);
