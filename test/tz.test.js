// The client's spec of November 2026: the shift hours (team lead → operator inside them, start/stop by itself),
// the team lead's levers on an operator (suspend the bot, AI key off, delete), only the newest bot works and
// people hear about a new one in Telegram outside their shift, «forgot password» (email + Telegram), UA / RU.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { openDb, platformSet } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setTelegramApi } from '../server/telegram.js';
import { latestBotVersion } from '../server/version.js';
import { profileSettings } from '../server/services.js';
import { announceUpdate } from '../server/updates.js';
import { pollOnce } from '../server/tgbot.js';
import { inShift, insideTeam, personShift } from '../server/shift.js';

let server, base, db, tg, smtp;
const tokens = {};
const tgSent = [];
const tgUpdates = [];
const mails = [];

async function call(method, url, body, who, headers = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}
const login = async (who, email, password, kind = 'web', version = '') => {
  const r = await call('POST', '/api/auth/login', { email, password, kind, version });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tokens[who] = r.data.token;
  return r.data.user;
};
const sentTo = (chat) => tgSent.filter((m) => String(m.chat_id) === String(chat));
const hourUtc = () => new Date().getUTCHours();

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      if (method === 'sendMessage') tgSent.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      const result = method === 'getUpdates' ? tgUpdates.splice(0) : method === 'getMe' ? { username: 'TzTestBot' } : { message_id: tgSent.length };
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => tg.listen(0, r));
  setTelegramApi(`http://127.0.0.1:${tg.address().port}`);
  // a fake mail server: records what the panel sends (plain SMTP with AUTH PLAIN)
  smtp = net.createServer((s) => {
    let buf = '';
    let data = false;
    let text = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; mails.push(text); s.write('250 queued\r\n'); } else text += `${line}\n`;
          continue;
        }
        if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) s.write('235 ok\r\n');
        else if (/^(MAIL|RCPT)/i.test(line)) s.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) { data = true; text = ''; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
        else s.write('500 ?\r\n');
      }
    });
  });
  await new Promise((r) => smtp.listen(0, r));
  process.env.SMTP_URL = `smtp://crm%40test:app-pass@127.0.0.1:${smtp.address().port}`;
  db = openDb(':memory:');
  ensureAdmin(db, { email: 'root@test', password: 'rootpass123' });
  server = createApp({ db, publicUrl: 'http://panel.test', demoSite: true, log: { error() {} } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); tg.close(); smtp.close(); db.close(); setTelegramApi(''); delete process.env.SMTP_URL; });

const V = latestBotVersion();

test('shift windows: crossing midnight, the operator only inside the team lead\'s hours', () => {
  assert.ok(insideTeam({ from: 20, to: 8 }, { from: 22, to: 6 }));
  assert.ok(insideTeam({ from: 20, to: 8 }, { from: 20, to: 8 }));
  assert.ok(!insideTeam({ from: 20, to: 8 }, { from: 18, to: 2 }), 'starts before the team');
  assert.ok(!insideTeam({ from: 20, to: 8 }, { from: 2, to: 10 }), 'ends after the team');
  assert.ok(insideTeam({ from: 0, to: 0 }, { from: 22, to: 6 }), 'around the clock takes any hours');
  // a narrowed window that is not inside → the team's hours
  assert.deepEqual([personShift({ shift: { from: 20, to: 8 } }, JSON.stringify({ shiftFrom: 18, shiftTo: 2 })).from], [20]);
  const t = Date.UTC(2026, 10, 7, 23, 30);
  assert.equal(inShift(t, 'UTC', { from: 20, to: 8 }), true);
  assert.equal(inShift(Date.UTC(2026, 10, 7, 12, 0), 'UTC', { from: 20, to: 8 }), false);
});

test('owner joins by the admin\'s link, names the team, invites operators; the shift starts and stops the bot by itself', async () => {
  await login('admin', 'root@test', 'rootpass123');
  await call('PUT', '/api/admin/telegram', { token: '123:TZ' }, 'admin');
  const link = (await call('POST', '/api/admin/links', { note: 'Тімлід', licenses: 10, days: 0 }, 'admin')).data.link;
  const reg = await call('POST', `/api/auth/join/${link.token}`, { name: 'Lead', email: 'lead@tz', password: 'leadpass1' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  tokens.lead = reg.data.token;
  assert.equal(reg.data.user.teamNameNeeded, true);
  assert.equal((await call('PUT', '/api/auth/team-name', { name: 'Тестова Агенція' }, 'lead')).data.user.agencyName, 'Тестова Агенція');
  // the team lead's hours: in the shift now (UTC)
  const h = hourUtc();
  const now = { from: (h + 23) % 24, to: (h + 2) % 24 };
  const later = { from: (h + 3) % 24, to: (h + 6) % 24 };
  const set = await call('PUT', '/api/settings', { settings: { timezone: 'UTC', shift: { auto: true, ...later } } }, 'lead');
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal((await call('PUT', '/api/settings', { settings: { shift: { from: 25 } } }, 'lead')).status, 400);
  // an operator by the team lead's link → waits → approved
  const tl = (await call('GET', '/api/operators/link', undefined, 'lead')).data.link;
  assert.equal((await call('POST', `/api/auth/join/${tl.token}`, { name: 'Ira', email: 'ira@tz', password: 'irapass12', lang: 'ru' })).status, 201);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ira@tz', password: 'irapass12' })).status, 403, 'waits for the team lead');
  const ira = (await call('GET', '/api/operators', undefined, 'lead')).data.operators.find((o) => o.email === 'ira@tz');
  await call('POST', `/api/operators/${ira.id}/approve`, {}, 'lead');
  await login('ira', 'ira@tz', 'irapass12');
  // her Telegram (Russian)
  const code = (await call('POST', '/api/me/telegram/link', {}, 'ira')).data.code;
  tgUpdates.push({ update_id: 1, message: { chat: { id: 4242, type: 'private' }, text: `/start ${code}` } });
  await pollOnce(db, 0);
  assert.match(sentTo(4242).at(-1).text, /Подключено/, 'Telegram in her language');
  await login('iraBot', 'ira@tz', 'irapass12', 'bot', V);
  const botH = { 'x-bot-version': V };

  // her own hours: only inside the team's
  assert.equal((await call('PUT', '/api/me/prefs', { shiftFrom: (later.from + 22) % 24, shiftTo: later.to }, 'ira')).status, 400);
  assert.equal((await call('PUT', '/api/me/prefs', { shiftFrom: later.from, shiftTo: (later.from + 1) % 24 }, 'ira')).status, 200);
  assert.equal((await call('PUT', '/api/me/prefs', { shiftFrom: null, shiftTo: null }, 'ira')).status, 200, 'back to the team\'s hours');

  // outside the shift: no work, the 🧪 test is fine, Telegram «start» says when
  const off = await call('GET', '/api/bot/workspace', undefined, 'iraBot', botH);
  assert.equal(off.status, 409);
  assert.match(off.data.error, /Сейчас не смена/);
  assert.equal((await call('GET', '/api/bot/workspace?test=1', undefined, 'iraBot', botH)).status, 200);
  assert.deepEqual((await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).data.start, []);
  tgUpdates.push({ update_id: 2, message: { chat: { id: 4242, type: 'private' }, text: '▶️ Старт' } });
  await pollOnce(db, 0);
  assert.match(sentTo(4242).at(-1).text, /не ваша смена/);

  // the shift begins: the bot asks → starts by itself (once), works
  await call('PUT', '/api/settings', { settings: { shift: { auto: true, ...now } } }, 'lead');
  const c1 = (await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).data;
  assert.equal(c1.auto, true);
  assert.equal(c1.start.length, 1, 'starts even before it found her women on the site');
  assert.deepEqual((await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).data.start, [], 'not every minute');
  const ws = await call('GET', '/api/bot/workspace', undefined, 'iraBot', botH);
  assert.equal(ws.status, 200, JSON.stringify(ws.data));
  const site = ws.data.site.id;
  const hers = (await call('POST', '/api/bot/hers', { site_id: site, hers: [{ id: '7001', name: 'Kate', age: 30 }] }, 'iraBot', botH)).data.profiles;
  const kate = hers[0].id;
  const beat = (body = {}) => call('POST', `/api/bot/profiles/${kate}/heartbeat`, { state: 'running', startedAt: Date.now() - 1000, now: Date.now(), ...body }, 'iraBot', botH);
  assert.equal((await beat()).data.stop, false);
  // the shift is over → the bot switches off (a test run goes on)
  await call('PUT', '/api/settings', { settings: { shift: { auto: true, ...later } } }, 'lead');
  const end = (await beat()).data;
  assert.deepEqual([end.stop, end.why], [true, 'shift']);
  assert.equal((await beat({ test: true })).data.stop, false);
  // a manual ⏹ in the shift keeps it off until the next shift
  await call('PUT', '/api/settings', { settings: { shift: { auto: true, ...now } } }, 'lead');
  db.prepare('UPDATE profiles SET stop_at = ? WHERE id = ?').run(Date.now(), kate);
  assert.deepEqual((await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).data.start, []);
});

test('team lead\'s levers: suspend the bot, AI key off, delete — each with a Telegram note in her language', async () => {
  const ira = (await call('GET', '/api/operators', undefined, 'lead')).data.operators.find((o) => o.email === 'ira@tz');
  const kate = db.prepare('SELECT * FROM profiles WHERE operator_id = ?').get(ira.id);
  const botH = { 'x-bot-version': V };
  // the AI key off: no key at all for her texts (templates)
  db.prepare("UPDATE agencies SET settings = json_set(settings, '$.ai.apiKey', 'sk-team') WHERE id = ?").run(kate.agency_id);
  assert.equal(profileSettings(db, kate).ai.apiKey, 'sk-team');
  tgSent.length = 0;
  assert.equal((await call('POST', `/api/operators/${ira.id}/access`, { aiOff: true }, 'lead')).data.aiOff, true);
  const s = profileSettings(db, kate);
  assert.deepEqual([s.ai.apiKey, s.ai.platformKey, s.ai.off], ['', false, true]);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(sentTo(4242).at(-1).text, /ключ ИИ/);
  await call('POST', `/api/operators/${ira.id}/access`, { aiOff: false }, 'lead');
  assert.equal(profileSettings(db, kate).ai.apiKey, 'sk-team');
  // the bot suspended: out at once, cannot log in, the panel works
  const sus = await call('POST', `/api/operators/${ira.id}/access`, { botOff: true, note: 'штраф за листопад' }, 'lead');
  assert.equal(sus.data.botOff, true);
  assert.equal((await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).status, 401, 'the bot session is gone');
  const again = await call('POST', '/api/auth/login', { email: 'ira@tz', password: 'irapass12', kind: 'bot' });
  assert.equal(again.status, 403);
  assert.match(again.data.error, /приостановлен/);
  assert.equal((await call('GET', '/api/auth/me', undefined, 'ira')).data.user.botOff, true, 'the panel still works');
  await new Promise((r) => setTimeout(r, 100));
  assert.match(sentTo(4242).at(-1).text, /штраф за листопад/);
  await call('POST', `/api/operators/${ira.id}/access`, { botOff: false }, 'lead');
  await login('iraBot', 'ira@tz', 'irapass12', 'bot', V);
  // deleted: the panel and the bot are closed, her women stay with the team
  assert.equal((await call('DELETE', `/api/operators/${ira.id}`, undefined, 'lead')).status, 200);
  assert.match(sentTo(4242).at(-1).text, /удалили из команды/);
  assert.equal((await call('GET', '/api/auth/me', undefined, 'ira')).status, 401);
  assert.equal((await call('GET', '/api/bot/control', undefined, 'iraBot', botH)).status, 401);
  assert.ok(db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(kate.id), 'her profiles stay with the team');
});

test('only the newest bot starts; a new version is announced in Telegram outside the shift', async () => {
  const tl = (await call('GET', '/api/operators/link', undefined, 'lead')).data.link;
  await call('POST', `/api/auth/join/${tl.token}`, { name: 'Ola', email: 'ola@tz', password: 'olapass12' });
  const ola = (await call('GET', '/api/operators', undefined, 'lead')).data.operators.find((o) => o.email === 'ola@tz');
  await call('POST', `/api/operators/${ola.id}/approve`, {}, 'lead');
  await login('ola', 'ola@tz', 'olapass12');
  const code = (await call('POST', '/api/me/telegram/link', {}, 'ola')).data.code;
  tgUpdates.push({ update_id: 3, message: { chat: { id: 5151, type: 'private' }, text: `/start ${code}` } });
  await pollOnce(db, 0);
  await login('olaOld', 'ola@tz', 'olapass12', 'bot', '1.0.0');
  const old = await call('GET', '/api/bot/workspace', undefined, 'olaOld', { 'x-bot-version': '1.0.0' });
  assert.equal(old.status, 426);
  assert.match(old.data.error, /застарів.*1\.0\.0.*потрібна/);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(sentTo(5151).at(-1).text, /Бот не запущено: стара версія 1\.0\.0/);
  const n = sentTo(5151).length;
  await call('GET', '/api/bot/workspace', undefined, 'olaOld', { 'x-bot-version': '1.0.0' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sentTo(5151).length, n, 'told once, not on every try');
  platformSet(db, 'strictBotVersion', '0');
  assert.equal((await call('GET', '/api/bot/workspace', undefined, 'olaOld', { 'x-bot-version': '1.0.0' })).status, 200, 'the admin can let old copies work');
  platformSet(db, 'strictBotVersion', '1');
  // the announcement: not in the middle of her shift; after it — once
  const h = hourUtc();
  await call('PUT', '/api/settings', { settings: { shift: { auto: true, from: (h + 23) % 24, to: (h + 2) % 24 } } }, 'lead');
  tgSent.length = 0;
  await announceUpdate(db);
  assert.equal(sentTo(5151).length, 0, 'not during the shift');
  await call('PUT', '/api/settings', { settings: { shift: { auto: true, from: (h + 3) % 24, to: (h + 6) % 24 } } }, 'lead');
  await announceUpdate(db);
  assert.match(sentTo(5151).at(-1)?.text || '', new RegExp(`Нова версія бота ${V.replace(/\./g, '\\.')}[\\s\\S]*не запуститься`));
  await announceUpdate(db);
  assert.equal(sentTo(5151).length, 1, 'once per version');
});

test('forgot password: a one-time link by email and Telegram; the new password signs out everywhere', async () => {
  const unknown = await call('POST', '/api/auth/forgot', { email: 'nobody@tz' });
  assert.equal(unknown.status, 200, 'the same answer for an unknown email');
  tgSent.length = 0;
  mails.length = 0;
  assert.equal((await call('POST', '/api/auth/forgot', { email: 'OLA@tz' })).status, 200);
  for (let i = 0; i < 40 && (!mails.length || !sentTo(5151).length); i++) await new Promise((r) => setTimeout(r, 50));
  const tgText = sentTo(5151).at(-1)?.text || '';
  const url = /http:\/\/panel\.test\/#\/reset\/([\w-]+)/.exec(tgText);
  assert.ok(url, tgText);
  assert.equal(mails.length, 1, 'a letter went out');
  const body = Buffer.from(mails[0].split('\n\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
  assert.ok(body.includes(`/#/reset/${url[1]}`), body);
  assert.match(mails[0], /Subject: =\?UTF-8\?B\?/);
  assert.equal((await call('GET', `/api/auth/reset/${url[1]}`)).status, 200);
  assert.equal((await call('POST', `/api/auth/reset/${url[1]}`, { password: 'short' })).status, 400);
  assert.equal((await call('POST', `/api/auth/reset/${url[1]}`, { password: 'brandnew123' })).status, 200);
  assert.equal((await call('POST', `/api/auth/reset/${url[1]}`, { password: 'again12345' })).status, 404, 'one-time');
  assert.equal((await call('GET', '/api/auth/me', undefined, 'ola')).status, 401, 'signed out everywhere');
  assert.equal((await call('POST', '/api/auth/login', { email: 'ola@tz', password: 'olapass12' })).status, 401);
  await login('ola', 'ola@tz', 'brandnew123');
  // the language of the panel and the Telegram messages
  assert.equal((await call('PUT', '/api/auth/lang', { lang: 'ru' }, 'ola')).data.user.lang, 'ru');
  assert.equal((await call('PUT', '/api/auth/lang', { lang: 'xx' }, 'ola')).data.user.lang, 'uk');
});
