// The night shift: «Шанс» (letters with a photo to online men), «Аллчат» (a few messages a night on the topic of a talk),
// pass reports to Telegram, start/stop from the panel, stats per night and mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, platformSet } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setTelegramApi } from '../server/telegram.js';
import { shiftKey } from '../server/reports.js';
import { pollOnce } from '../server/tgbot.js';

let server, base, db, tg, tgBase;
const tokens = {};
const tgSent = [];
const tgUpdates = [];

async function call(method, url, body, who) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}
const login = async (who, email, password, kind = 'web') => {
  const r = await call('POST', '/api/auth/login', { email, password, kind });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tokens[who] = r.data.token;
  return r.data.user;
};

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  // a fake Telegram Bot API: records what the platform sends
  tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      if (method === 'sendMessage') tgSent.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      const result = method === 'getUpdates' ? tgUpdates.splice(0) : method === 'getMe' ? { username: 'NightTestBot' } : { message_id: tgSent.length };
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => tg.listen(0, r));
  tgBase = `http://127.0.0.1:${tg.address().port}`;
  setTelegramApi(tgBase);
  db = openDb(':memory:');
  ensureAdmin(db, { email: 'root@test', password: 'rootpass123' });
  server = createApp({ db, publicUrl: 'http://localhost:9', demoSite: true, log: { error() {} } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); tg.close(); db.close(); setTelegramApi(''); });

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('night shift: «Шанс», «Аллчат», reports, start/stop and stats', async () => {
  await login('admin', 'root@test', 'rootpass123');
  const ag = await call('POST', '/api/admin/agencies', { name: 'Night', ownerName: 'Lead', ownerEmail: 'lead@night', ownerPassword: 'leadpass1', licenses: 3, days: 30 }, 'admin');
  assert.equal(ag.status, 201, JSON.stringify(ag.data));
  await login('owner', 'lead@night', 'leadpass1');
  const siteId = (await call('GET', '/api/sites', undefined, 'owner')).data.sites[0].id;
  const op = await call('POST', '/api/operators', { name: 'Ira', email: 'ira@night', password: 'irapass1' }, 'owner');
  const other = await call('POST', '/api/operators', { name: 'Oksana', email: 'oks@night', password: 'okspass1' }, 'owner');
  const p = (await call('POST', '/api/profiles', { name: 'Kate', age: 29, operator_id: op.data.id, site_id: siteId }, 'owner')).data;
  const p2 = (await call('POST', '/api/profiles', { name: 'Maria', age: 27, operator_id: other.data.id, site_id: siteId }, 'owner')).data;
  await login('bot', 'ira@night', 'irapass1', 'bot');
  await login('bot2', 'oks@night', 'okspass1', 'bot');

  // ---- settings: sane numbers; «auto reply» cannot be switched on while it is closed ----
  const put = await call('PUT', '/api/settings', { settings: { modes: { chance: { everyMin: 5, onlineOnly: true }, allchat: { perNight: 2, who: 'silent', silentHours: 2, gapHours: 2 }, autoReply: { on: true } } } }, 'owner');
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.settings.modes.chance.everyMin, 10, 'at least every 10 minutes');
  assert.equal(put.data.settings.modes.autoReply.on, false, 'closed until the platform admin opens it');
  const cfg = await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'bot');
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.deepEqual(cfg.data.modes.chance, { on: true, everyMin: 10, onlineOnly: true });
  assert.equal(cfg.data.modes.autoReply.locked, true);

  // ---- «Шанс»: only online men, her letter with the invite, the photo chosen for «Шанс» ----
  const up = await fetch(`${base}/api/profiles/${p.id}/media?steps=300`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'chance.png', authorization: `Bearer ${tokens.owner}` }, body: png });
  assert.equal(up.status, 201, await up.text());
  const f = await call('POST', `/api/bot/profiles/${p.id}/filter`, { mode: 'chance', candidates: [
    { id: '700001', name: 'Robert', age: 50, online: true, via: 'letter' },
    { id: '700002', name: 'David', age: 55, online: false, via: 'letter' },
    { id: '700003', name: 'john_1960', age: 61, online: true, via: 'letter' },
  ] }, 'bot');
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.deepEqual(f.data.allowed.map((m) => m.id), ['700001', '700003'], 'offline men are skipped');
  assert.equal(f.data.skipped.offline, 1);
  const robert = f.data.allowed[0];
  assert.equal(robert.mode, 'chance');
  assert.equal(robert.actions.length, 1);
  assert.equal(robert.actions[0].via, 'letter');
  assert.match(robert.actions[0].text, /^Hello Robert!/, 'the letter greets him by name');
  assert.deepEqual(robert.actions[0].files.map((x) => x.name), ['chance.png']);
  const sent = await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: robert, ok: true, text: robert.text, mode: 'chance' }, 'bot');
  assert.equal(sent.status, 200);
  const row = db.prepare('SELECT mode, night, stage, next_at FROM messages WHERE profile_id = ? AND man_id = ?').get(p.id, '700001');
  assert.equal(row.mode, 'chance');
  assert.equal(row.stage, 'done', 'no scenario follow-ups after a «Шанс» letter («Аллчат» does that)');
  assert.equal(row.next_at, null);
  assert.ok(row.night, 'the night is stored');
  const again = await call('POST', `/api/bot/profiles/${p.id}/filter`, { mode: 'chance', candidates: [{ id: '700001', name: 'Robert', online: true }] }, 'bot');
  assert.equal(again.data.allowed.length, 0, 'never the same man twice');

  // he answers the letter: a person replies; no scenario reminders are scheduled
  await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '700001', name: 'Robert', text: 'Hi Kate!' }] }, 'bot');
  const replied = db.prepare('SELECT stage, bonus_left, next_at FROM messages WHERE profile_id = ? AND man_id = ?').get(p.id, '700001');
  assert.deepEqual([replied.stage, replied.bonus_left, replied.next_at], ['replied', 0, null]);

  // ---- «Аллчат» ----
  const man = { id: '800001', name: 'Thomas' };
  const talk = [{ mine: false, text: 'I love fishing on the lake' }, { mine: true, text: 'Fishing sounds peaceful! What do you catch?' }];
  const check = (h = talk, who = 'bot', m = man, prof = p.id) => call('POST', `/api/bot/profiles/${prof}/allchat/check`, { man: m, history: h }, who);
  // his message last: he waits for an answer — a person answers, not the bot
  assert.equal((await check([...talk, { mine: false, text: 'Mostly pike. And you?' }])).data.reason, 'waits');
  // first time the bot sees this last message: it has to stay unchanged for «silentHours» (the operator may have just written)
  assert.equal((await check()).data.reason, 'not-quiet');
  db.prepare('UPDATE dialogs SET fp_at = fp_at - ? WHERE profile_id = ? AND man_id = ?').run(3 * 3600000, p.id, man.id);
  const ok1 = await check();
  assert.equal(ok1.data.write, true, JSON.stringify(ok1.data));
  const msg = await call('POST', `/api/bot/profiles/${p.id}/allchat/compose`, { man, history: talk }, 'bot');
  assert.equal(msg.status, 200);
  assert.ok(msg.data.text.length > 20, 'a message on the topic (template without an AI key)');
  assert.equal((await call('POST', `/api/bot/profiles/${p.id}/allchat/sent`, { man, ok: true, text: msg.data.text }, 'bot')).status, 200);
  const after1 = [...talk, { mine: true, text: msg.data.text }];
  assert.equal((await check(after1)).data.reason, 'too-soon', 'a pause between two messages to him');
  db.prepare('UPDATE allchat_log SET at = at - ? WHERE profile_id = ?').run(3 * 3600000, p.id);
  db.prepare('UPDATE dialogs SET fp_at = fp_at - ? WHERE profile_id = ?').run(3 * 3600000, p.id);
  assert.equal((await check(after1)).data.write, true);
  await call('POST', `/api/bot/profiles/${p.id}/allchat/sent`, { man, ok: true, text: 'second' }, 'bot');
  db.prepare('UPDATE allchat_log SET at = at - ? WHERE profile_id = ?').run(3 * 3600000, p.id);
  db.prepare('UPDATE dialogs SET fp_at = fp_at - ? WHERE profile_id = ?').run(3 * 3600000, p.id);
  assert.equal((await check([...after1, { mine: true, text: 'second' }])).data.reason, 'night-limit', '2 a night');
  // «only men who answered at least once»
  await call('PUT', '/api/settings', { settings: { modes: { allchat: { who: 'replied' } } } }, 'owner');
  const quiet = { id: '800002', name: 'Paul' };
  await check([{ mine: true, text: 'Hello Paul' }], 'bot', quiet);
  db.prepare('UPDATE dialogs SET fp_at = fp_at - ? WHERE man_id = ?').run(10 * 3600000, quiet.id);
  assert.equal((await check([{ mine: true, text: 'Hello Paul' }], 'bot', quiet)).data.reason, 'never-replied');
  // another operator cannot touch Kate's dialogs
  assert.equal((await check(talk, 'bot2')).status, 404);
  // he answered after the «Аллчат» message: counted
  await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: man.id, name: man.name, text: 'Hi again!' }] }, 'bot');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE man_id = ? AND replied_at IS NOT NULL').get(man.id).n, 1, 'one reply counts once');

  // ---- a pass report goes to the person who runs the bot (their Telegram), not to others ----
  platformSet(db, 'tgToken', 'TEST:TOKEN');
  db.prepare("UPDATE users SET tg_chat_id = '1001' WHERE id = ?").run(op.data.id);
  db.prepare("UPDATE users SET tg_chat_id = '2002' WHERE id = ?").run(other.data.id);
  const pass = await call('POST', `/api/bot/profiles/${p.id}/pass`, { mode: 'chance', seen: 2, sent: 1, failed: 0, skipped: 1, info: { contacted: 1 }, startedAt: Date.now() - 120000 }, 'bot');
  assert.equal(pass.status, 200, JSON.stringify(pass.data));
  for (let i = 0; i < 20 && !tgSent.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tgSent.length, 1, JSON.stringify(tgSent));
  assert.equal(tgSent[0].chat_id, '1001');
  assert.match(tgSent[0].text, /Шанс/);
  assert.match(tgSent[0].text, /Листів з фото: <b>1<\/b>/);
  assert.match(tgSent[0].text, /За ніч:/);

  // ---- start / stop from the panel: each person only their own ----
  await login('ira', 'ira@night', 'irapass1');
  const st = await call('POST', '/api/bots/start', { ids: [p2.id] }, 'ira');
  assert.deepEqual(st.data.started, [], 'an operator cannot start someone else\'s profile');
  const st2 = await call('POST', '/api/bots/start', {}, 'owner');
  assert.equal(st2.data.started.length, 2, 'the team lead starts the whole team');
  const ctl = await call('GET', '/api/bot/control', undefined, 'bot');
  assert.deepEqual(ctl.data.start.map((x) => x.id), [p.id], 'the bot sees only its own profiles to start');
  db.prepare('UPDATE profiles SET bot_beat_at = ? WHERE id = ?').run(Date.now() + 1000, p.id); // it started
  assert.equal((await call('GET', '/api/bot/control', undefined, 'bot')).data.start.length, 0);
  const stop = await call('POST', '/api/bots/stop', { ids: [p.id] }, 'ira');
  assert.equal(stop.data.stopped.length, 1);
  assert.ok(db.prepare('SELECT stop_at FROM profiles WHERE id = ?').get(p.id).stop_at);

  // ---- stats per night and mode ----
  const stats = await call('GET', '/api/stats/shift?nights=3', undefined, 'owner');
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  const night = stats.data.nights.find((x) => x.chance.sent || x.allchat.sent);
  assert.ok(night, JSON.stringify(stats.data.nights));
  assert.equal(night.chance.sent, 1);
  assert.equal(night.allchat.sent, 2);
  assert.equal(night.allchat.replies, 1);
  const mine = await call('GET', '/api/stats/shift?nights=3', undefined, 'ira');
  assert.deepEqual(mine.data.profiles.map((x) => x.name), ['Kate'], 'an operator sees only her own profiles');
});

test('a night shift is one «night» across midnight', () => {
  const tz = 'UTC';
  const human = { hoursFrom: 20, hoursTo: 6 };
  assert.equal(shiftKey(Date.parse('2026-11-06T22:00:00Z'), tz, human), '2026-11-06');
  assert.equal(shiftKey(Date.parse('2026-11-07T03:00:00Z'), tz, human), '2026-11-06');
  assert.equal(shiftKey(Date.parse('2026-11-07T21:00:00Z'), tz, human), '2026-11-07');
  assert.equal(shiftKey(Date.parse('2026-11-07T10:00:00Z'), tz, { hoursFrom: 9, hoursTo: 18 }), '2026-11-07');
});

test('Telegram: the admin sets one bot; each person links with one tap and controls only their own bots', async () => {
  await login('admin2', 'root@test', 'rootpass123');
  const set = await call('PUT', '/api/admin/telegram', { token: '123:ABC' }, 'admin2');
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.bot, 'NightTestBot');
  await login('ira2', 'ira@night', 'irapass1');
  const link = await call('POST', '/api/me/telegram/link', {}, 'ira2');
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.url, /^https:\/\/t\.me\/NightTestBot\?start=[\w-]+$/);
  const msg = (chat, text, id) => ({ update_id: id, message: { chat: { id: chat, type: 'private' }, text } });
  tgSent.length = 0;
  tgUpdates.push(msg(5555, `/start ${link.data.code}`, 1));
  await pollOnce(db, 0);
  assert.match(tgSent[0].text, /Підключено: <b>Ira<\/b> \(оператор\)/);
  assert.equal((await call('GET', '/api/me/telegram', undefined, 'ira2')).data.linked, true);
  // the link works once
  tgUpdates.push(msg(6666, `/start ${link.data.code}`, 2));
  await pollOnce(db, 0);
  assert.match(tgSent[1].text, /застаріло/);
  // buttons: report, start (only her own profile)
  tgUpdates.push(msg(5555, '📊 Звіт', 3), msg(5555, '▶️ Старт', 4), msg(7777, '⏹ Стоп', 5));
  await pollOnce(db, 0);
  assert.match(tgSent[2].text, /Звіт за ніч/);
  assert.match(tgSent[2].text, /Kate/);
  assert.doesNotMatch(tgSent[2].text, /Maria/, 'an operator sees only her own profiles');
  assert.match(tgSent[3].text, /Запускаю \(1\): Kate/);
  assert.match(tgSent[4].text, /не підключено/, 'a stranger cannot control anything');
  const kate = db.prepare("SELECT start_at FROM profiles WHERE name = 'Kate'").get();
  assert.ok(kate.start_at);
});

test('the operator sets only her own: master prompt, «Шанс» interval, «Аллчат» count; the bot picks her women from the site itself', async () => {
  await login('admin3', 'root@test', 'rootpass123');
  const ag = await call('POST', '/api/admin/agencies', { name: 'Auto', ownerName: 'Lead', ownerEmail: 'lead@auto', ownerPassword: 'leadpass1', licenses: 3, days: 30 }, 'admin3');
  assert.equal(ag.status, 201, JSON.stringify(ag.data));
  await login('lead3', 'lead@auto', 'leadpass1');
  const siteId = (await call('GET', '/api/sites', undefined, 'lead3')).data.sites[0].id;
  await call('POST', '/api/operators', { name: 'Ola', email: 'ola@auto', password: 'olapass1' }, 'lead3');
  await call('POST', '/api/operators', { name: 'Nina', email: 'nina@auto', password: 'ninapass1' }, 'lead3');
  await login('ola', 'ola@auto', 'olapass1');
  await login('olaBot', 'ola@auto', 'olapass1', 'bot');
  await login('ninaBot', 'nina@auto', 'ninapass1', 'bot');

  // ---- her settings ----
  const before = (await call('GET', '/api/me/prefs', undefined, 'ola')).data;
  assert.equal(before.prompt, '');
  assert.ok(before.defaultPrompt.length > 50, 'she sees the built-in prompt to start from');
  assert.equal(before.chanceEveryMin, 30, 'the team value until she changes it');
  assert.equal((await call('PUT', '/api/me/prefs', { chanceEveryMin: 3 }, 'ola')).status, 400, 'at least every 10 minutes');
  assert.equal((await call('PUT', '/api/me/prefs', { allchatPerNight: 9 }, 'ola')).status, 400);
  const saved = await call('PUT', '/api/me/prefs', { prompt: 'Write warm and short. Mention the sea.', chanceEveryMin: 20, allchatPerNight: 4 }, 'ola');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual([saved.data.chanceEveryMin, saved.data.allchatPerNight], [20, 4]);

  // ---- the bot: the site of the team, her women from the site ----
  const ws = await call('GET', '/api/bot/workspace', undefined, 'olaBot');
  assert.equal(ws.status, 200, JSON.stringify(ws.data));
  assert.equal(ws.data.site.id, siteId);
  assert.deepEqual(ws.data.profiles, []);
  const hers = (who, list) => call('POST', '/api/bot/hers', { site_id: siteId, hers: list }, who);
  const a = await hers('olaBot', [{ id: '5000000001', name: 'Alina', age: 31 }, { id: '5000000002', name: 'Bella', age: 28 }]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data.profiles.map((p) => [p.name, p.site_profile_id, p.status]), [['Alina', '5000000001', 'active'], ['Bella', '5000000002', 'active']]);
  // seen again with a new name: updated, not doubled
  const again = await hers('olaBot', [{ id: '5000000001', name: 'Alina K', age: 31 }]);
  assert.equal(again.data.added.length, 0);
  assert.ok(again.data.profiles.some((p) => p.name === 'Alina K'));
  // another operator sees the same woman: never taken from Ola; her own new one is added; beyond the plan — paused
  const n = await hers('ninaBot', [{ id: '5000000001', name: 'Alina' }, { id: '5000000003', name: 'Chloe' }, { id: '5000000004', name: 'Dana' }]);
  assert.deepEqual(n.data.profiles.map((p) => [p.name, p.status]), [['Chloe', 'active'], ['Dana', 'paused']]);
  assert.equal(db.prepare("SELECT operator_id FROM profiles WHERE site_profile_id = '5000000001'").get().operator_id,
    db.prepare("SELECT id FROM users WHERE email = 'ola@auto'").get().id);

  // ---- her numbers reach the bot ----
  const alina = a.data.profiles.find((p) => p.site_profile_id === '5000000001');
  const cfg = await call('GET', `/api/bot/profiles/${alina.id}/config`, undefined, 'olaBot');
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.modes.chance.everyMin, 20);
  assert.equal(cfg.data.modes.allchat.perNight, 4);
  const chloe = n.data.profiles[0];
  const cfg2 = await call('GET', `/api/bot/profiles/${chloe.id}/config`, undefined, 'ninaBot');
  assert.equal(cfg2.data.modes.chance.everyMin, 30, 'Nina keeps the team value');
});
