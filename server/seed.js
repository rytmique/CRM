import { tx, now } from './db.js';
import { hashPassword } from './auth.js';
import { createAgency, issueLicenses } from './routes/admin.js';
import { insertInvite, getSettings } from './services.js';
import { templateInvite } from './ai.js';
import { dayKey } from './util.js';

const DAY = 86400000;

const PROFILES = [
  { name: 'Anna', age: 32, city: 'Kyiv', country: 'Ukraine', interests: 'yoga, travel, cooking', looking_for: 'a kind and honest man',
    bio: 'Paediatric nurse. Loves long walks by the river and baking on Sundays.', daily_limit: 20, min_delay: 5, max_delay: 10, rate: 0.12, perDay: [30, 55] },
  { name: 'Maria', age: 27, city: 'Lviv', country: 'Ukraine', interests: 'dancing, books, coffee', looking_for: 'a caring partner for a serious relationship',
    bio: 'Marketing specialist with a big smile, salsa on Fridays.', daily_limit: 20, min_delay: 5, max_delay: 10, rate: 0.09, perDay: [20, 45] },
  { name: 'Olha', age: 38, city: 'Odesa', country: 'Ukraine', interests: 'sea, photography, gardening', looking_for: 'a mature and calm man',
    bio: 'Accountant, mother of a teenage son, loves the sea at sunrise.', daily_limit: 20, min_delay: 5, max_delay: 10, rate: 0.15, perDay: [10, 25], status: 'paused' },
];
const MEN = ['Michael', 'David', 'James', 'Robert', 'John', 'William', 'Richard', 'Thomas', 'Mark', 'Steven', 'Paul', 'Andrew', 'Kevin', 'Brian', 'George'];
const COUNTRIES = ['USA', 'Canada', 'UK', 'Australia', 'Germany', 'Ireland'];

/**
 * Test stand data (start-test.bat / TEST_SEED=1): one agency with an owner, an operator,
 * three profiles on the demo site and two weeks of sample statistics. Runs only on an empty database.
 * Sample men use IDs from 900000, so they never block the demo site (100000+) for real test runs.
 */
export function seedTestData(db, cfg, { password = 'test12345' } = {}) {
  if (db.prepare('SELECT 1 FROM agencies LIMIT 1').get()) return null;
  const agencyId = createAgency(db, cfg, { name: 'Тестова агенція', ownerName: 'Керівник (тест)', ownerEmail: 'owner@test', ownerPassword: password });
  const t0 = now();
  const operatorId = Number(db.prepare("INSERT INTO users (agency_id, role, name, email, pass_hash, created_at) VALUES (?, 'operator', ?, ?, ?, ?)")
    .run(agencyId, 'Оператор (тест)', 'operator@test', hashPassword(password), t0).lastInsertRowid);
  issueLicenses(db, { agencyId, count: 5, days: 30, note: 'тестові' });
  const site = db.prepare('SELECT id FROM sites WHERE agency_id = ? ORDER BY id LIMIT 1').get(agencyId);
  const licenses = db.prepare('SELECT id, days FROM licenses WHERE agency_id = ? ORDER BY id').all(agencyId);
  const tz = getSettings(db, agencyId).timezone;

  tx(db, () => {
    let manSeq = 900000;
    PROFILES.forEach((p, idx) => {
      const { rate, perDay, ...fields } = p;
      const cols = { ...fields, agency_id: agencyId, operator_id: operatorId, site_id: site?.id ?? null, created_at: t0 - 20 * DAY };
      const keys = Object.keys(cols);
      const profileId = Number(db.prepare(`INSERT INTO profiles (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .run(...keys.map((k) => cols[k])).lastInsertRowid);
      if (idx < 2) {
        const l = licenses[idx];
        db.prepare('UPDATE licenses SET profile_id = ?, activated_at = ?, expires_at = ? WHERE id = ?').run(profileId, t0 - 10 * DAY, t0 + (l.days - 10) * DAY, l.id);
      }
      const invite = insertInvite(db, { profileId, text: templateInvite(fields), source: 'template', userId: operatorId });

      // 13 past days of sample history (today stays empty for live testing).
      const ins = db.prepare(`INSERT INTO messages (agency_id, profile_id, operator_id, site_id, man_id, man_name, man_age, man_country, invite_id, text, status, error, day, sent_at, replied_at, reply_day)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (let d = 13; d >= 1; d--) {
        const n = perDay[0] + Math.floor(Math.random() * (perDay[1] - perDay[0]));
        for (let i = 0; i < n; i++) {
          const sentAt = t0 - d * DAY + Math.floor(Math.random() * 8 * 3600000);
          const failed = Math.random() < 0.03;
          const replied = !failed && Math.random() < rate;
          const repliedAt = replied ? Math.min(t0 - 60000, sentAt + Math.floor(Math.random() * 20 * 3600000)) : null;
          const name = MEN[manSeq % MEN.length];
          ins.run(agencyId, profileId, operatorId, site?.id ?? null, String(manSeq), name, 30 + (manSeq % 35), COUNTRIES[manSeq % COUNTRIES.length],
            invite.id, invite.text.replace('{name}', name), failed ? 'failed' : 'sent', failed ? 'кнопка «Надіслати» недоступна' : '',
            dayKey(sentAt, tz), sentAt, repliedAt, repliedAt ? dayKey(repliedAt, tz) : null);
          manSeq++;
        }
      }
    });
  });
  return { owner: 'owner@test', operator: 'operator@test', password };
}
