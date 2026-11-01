import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setAiClientFactory } from '../server/ai.js';
import { personalize } from '../server/personalize.js';
import { buildZip } from '../server/zip.js';

let server, base, db;
const tokens = {};

async function call(method, url, body, who) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}
const login = async (who, email, password, kind = 'web') => {
  const r = await call('POST', '/api/auth/login', { email, password, kind });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tokens[who] = r.data.token;
  return r.data.user;
};

before(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  db = openDb(':memory:');
  ensureAdmin(db, { email: 'root@test', password: 'rootpass123' });
  const app = createApp({ db, publicUrl: 'http://localhost:9', demoSite: true, log: { error() {} } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

test('personalize handles names, usernames and missing values', () => {
  assert.equal(personalize('Hi {name}! How are you?', { name: 'john smith' }), 'Hi John! How are you?');
  assert.equal(personalize('Hi {name}! How are you?', { name: 'john_1985' }), 'Hi! How are you?');
  assert.equal(personalize('Good day, {name}! I am Anna.', {}), 'Good day! I am Anna.');
  assert.equal(personalize('Hello {name} :) {country} is far', { name: 'Mike', country: 'USA' }), 'Hello Mike :) USA is far');
});

test('zip writer produces a valid archive header', () => {
  const z = buildZip([{ name: 'a/b.txt', data: Buffer.from('hello') }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
});

test('full flow: admin → agency → operator → profile → bot', async () => {
  // auth
  assert.equal((await call('POST', '/api/auth/login', { email: 'root@test', password: 'nope' })).status, 401);
  await login('admin', 'root@test', 'rootpass123');
  assert.equal((await call('GET', '/api/profiles', undefined, 'admin')).status, 403, 'admin has no agency panel');

  // admin creates agency with licenses
  const ag = await call('POST', '/api/admin/agencies', {
    name: 'Rose Agency', ownerName: 'Olena', ownerEmail: 'owner@rose', ownerPassword: 'ownerpass1', licenses: 3, days: 30,
  }, 'admin');
  assert.equal(ag.status, 201, JSON.stringify(ag.data));
  assert.equal(ag.data.keys.length, 3);
  assert.match(ag.data.keys[0], /^AGC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  await login('owner', 'owner@rose', 'ownerpass1');
  assert.equal((await call('GET', '/api/admin/agencies', undefined, 'owner')).status, 403);

  // demo site preset created
  const sites = await call('GET', '/api/sites', undefined, 'owner');
  assert.equal(sites.data.sites.length, 1);
  const siteId = sites.data.sites[0].id;
  assert.equal(sites.data.sites[0].config.card, '.man-card');

  // operator
  const op = await call('POST', '/api/operators', { name: 'Ira', email: 'ira@rose', password: 'irapass' }, 'owner');
  assert.equal(op.status, 201);
  assert.equal((await call('POST', '/api/operators', { name: 'Dup', email: 'IRA@rose', password: 'irapass' }, 'owner')).status, 400);

  // licenses
  const lic = await call('GET', '/api/licenses', undefined, 'owner');
  assert.equal(lic.data.summary.free, 3);
  const [l1, l2] = lic.data.licenses;

  // profiles
  const p1 = await call('POST', '/api/profiles', {
    name: 'Anna', age: 32, city: 'Kyiv', country: 'Ukraine', interests: 'yoga, travel, cooking',
    operator_id: op.data.id, site_id: siteId, license_id: l1.id, target_age_min: 35, target_age_max: 60, daily_limit: 3,
  }, 'owner');
  assert.equal(p1.status, 201, JSON.stringify(p1.data));
  const p2 = await call('POST', '/api/profiles', { name: 'Maria', age: 28, site_id: siteId }, 'owner');
  assert.equal(p2.status, 201);
  assert.equal((await call('POST', '/api/profiles', { age: 28 }, 'owner')).status, 400);

  const prof = await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'owner');
  assert.equal(prof.data.profile.license.state, 'active');
  assert.equal(prof.data.profile.license.daysLeft, 30);

  // operator sees only own profile
  await login('op', 'ira@rose', 'irapass', 'bot');
  const opProfiles = await call('GET', '/api/profiles', undefined, 'op');
  assert.deepEqual(opProfiles.data.profiles.map((p) => p.name), ['Anna']);
  assert.equal((await call('GET', `/api/profiles/${p2.data.id}`, undefined, 'op')).status, 404);
  assert.equal((await call('PATCH', `/api/profiles/${p1.data.id}`, { name: 'Hacked' }, 'op')).status, 200);
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'op')).data.profile.name, 'Anna', 'operator cannot rename');
  assert.equal((await call('GET', '/api/operators', undefined, 'op')).status, 403);

  // invites: template generation (no API key)
  const gen = await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'op');
  assert.equal(gen.status, 201, JSON.stringify(gen.data));
  assert.equal(gen.data.invite.source, 'template');
  assert.match(gen.data.invite.text, /\{name\}/);
  assert.match(gen.data.preview, /Michael/);

  // bot: unlicensed profile is refused
  assert.equal((await call('GET', `/api/bot/profiles/${p2.data.id}/config`, undefined, 'owner')).status, 402);

  // bot config
  const cfg = await call('GET', `/api/bot/profiles/${p1.data.id}/config`, undefined, 'op');
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.limits.remaining, 3);
  assert.equal(cfg.data.site.config.messageInput, '#chat-modal textarea');

  // filter: age + dedupe + limit
  const candidates = [
    { id: 'm1', name: 'Mike', age: 45, country: 'USA' },
    { id: 'm2', name: 'young_guy', age: 25 },
    { id: 'm3', name: 'Tom', age: 50 },
    { id: 'm4', name: 'Bob' },
    { id: 'm5', name: 'Sam', age: 40 },
    { id: 'm1', name: 'Mike dup', age: 45 },
  ];
  const f1 = await call('POST', `/api/bot/profiles/${p1.data.id}/filter`, { candidates }, 'op');
  assert.equal(f1.status, 200);
  assert.deepEqual(f1.data.allowed.map((m) => m.id), ['m1', 'm3', 'm4']);
  assert.equal(f1.data.skipped.age, 1);
  assert.equal(f1.data.skipped.limit, 1);
  assert.match(f1.data.allowed[0].text, /Mike/);

  // report sends
  const s1 = await call('POST', `/api/bot/profiles/${p1.data.id}/sent`, { man: f1.data.allowed[0], ok: true, text: f1.data.allowed[0].text, invite_id: f1.data.allowed[0].invite_id }, 'op');
  assert.equal(s1.data.remaining, 2);
  await call('POST', `/api/bot/profiles/${p1.data.id}/sent`, { man: { id: 'm3', name: 'Tom' }, ok: false, error: 'кнопка не знайдена' }, 'op');
  const f2 = await call('POST', `/api/bot/profiles/${p1.data.id}/filter`, { candidates }, 'op');
  assert.deepEqual(f2.data.allowed.map((m) => m.id), ['m3', 'm4'], 'already-sent m1 skipped, failed m3 retried');
  await call('POST', `/api/bot/profiles/${p1.data.id}/sent`, { man: { id: 'm3', name: 'Tom' }, ok: true }, 'op');
  const s3 = await call('POST', `/api/bot/profiles/${p1.data.id}/sent`, { man: { id: 'm4', name: 'Bob' }, ok: true }, 'op');
  assert.equal(s3.data.remaining, 0);
  assert.equal(s3.data.stop, true);
  const f3 = await call('POST', `/api/bot/profiles/${p1.data.id}/filter`, { candidates: [{ id: 'm9', age: 40 }] }, 'op');
  assert.equal(f3.data.allowed.length, 0, 'daily limit reached');

  // replies
  const rep = await call('POST', `/api/bot/profiles/${p1.data.id}/replies`, { men: [{ id: 'm1' }, { id: 'unknown' }] }, 'op');
  assert.equal(rep.data.new, 1);
  const rep2 = await call('POST', `/api/bot/profiles/${p1.data.id}/replies`, { men: [{ id: 'm1' }] }, 'op');
  assert.equal(rep2.data.new, 0, 'reply counted once');

  // heartbeat + pause from panel stops bot
  const hb = await call('POST', `/api/bot/profiles/${p1.data.id}/heartbeat`, { state: 'running', info: 'page 1' }, 'op');
  assert.equal(hb.data.paused, false);
  await call('PATCH', `/api/profiles/${p1.data.id}`, { status: 'paused' }, 'owner');
  assert.equal((await call('POST', `/api/bot/profiles/${p1.data.id}/heartbeat`, { state: 'running' }, 'op')).data.paused, true);
  assert.equal((await call('GET', `/api/bot/profiles/${p1.data.id}/config`, undefined, 'op')).status, 409);
  await call('PATCH', `/api/profiles/${p1.data.id}`, { status: 'active' }, 'owner');

  // stats
  const st = await call('GET', '/api/stats/overview?days=7', undefined, 'owner');
  assert.equal(st.status, 200);
  assert.equal(st.data.today.sent, 3);
  assert.equal(st.data.today.failed, 0, 'failed attempt replaced by later success');
  assert.equal(st.data.today.replies, 1);
  assert.equal(st.data.daily.length, 7);
  assert.equal(st.data.botsOnline, 1);
  assert.equal(st.data.recentReplies[0].man_name, 'Mike');
  assert.match(st.data.recentReplies[0].chat_url, /inbox\.html#man-m1/);
  const opStats = await call('GET', '/api/stats/overview', undefined, 'op');
  assert.equal(opStats.data.profiles.length, 1);
  assert.equal(opStats.data.licenses, null);

  const log = await call('GET', '/api/stats/messages?status=replied', undefined, 'owner');
  assert.equal(log.data.total, 1);

  // license reassignment rules
  assert.equal((await call('POST', `/api/licenses/${l2.id}/assign`, { profile_id: p2.data.id }, 'owner')).status, 200);
  const lic2 = await call('GET', '/api/licenses', undefined, 'owner');
  assert.equal(lic2.data.summary.active, 2);

  // admin revokes → bot refused
  await call('POST', `/api/admin/licenses/${l1.id}/revoke`, {}, 'admin');
  assert.equal((await call('GET', `/api/bot/profiles/${p1.data.id}/config`, undefined, 'op')).status, 402);
  await call('POST', `/api/admin/licenses/${l1.id}/restore`, {}, 'admin');
  await call('POST', `/api/admin/licenses/${l1.id}/extend`, { days: 10 }, 'admin');
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'owner')).data.profile.license.daysLeft, 40);

  // settings: secrets are masked and preserved
  const put = await call('PUT', '/api/settings', { settings: { ai: { apiKey: 'sk-ant-secret-123456', language: 'English' }, defaults: { dailyLimit: 200, minDelay: 30, maxDelay: 60 } } }, 'owner');
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.settings.ai.apiKey, 'sk-a••••3456');
  await call('PUT', '/api/settings', { settings: { ai: { apiKey: put.data.settings.ai.apiKey, model: 'claude-opus-5-5' } } }, 'owner');
  const raw = JSON.parse(db.prepare('SELECT settings FROM agencies WHERE name = ?').get('Rose Agency').settings);
  assert.equal(raw.ai.apiKey, 'sk-ant-secret-123456');
  assert.equal((await call('PUT', '/api/settings', { settings: { defaults: { minDelay: 90, maxDelay: 10 } } }, 'owner')).status, 400);

  // AI path with a fake Claude client
  let seen;
  setAiClientFactory(() => ({
    beta: { messages: { create: async (params) => { seen = params; return { model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '"Hi {name}! I am Anna from Kyiv, I love yoga and slow Sunday mornings. What does your perfect weekend look like?"' }] }; } } },
  }));
  const aiGen = await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner');
  assert.equal(aiGen.status, 201, JSON.stringify(aiGen.data));
  assert.equal(aiGen.data.invite.source, 'ai');
  assert.ok(!aiGen.data.invite.text.startsWith('"'), 'quotes stripped');
  assert.equal(seen.model, 'claude-opus-5-5');
  assert.equal(seen.fallbacks, 'default');
  assert.match(seen.messages[0].content, /Anna/);

  // AI refusal surfaces as a clear error
  setAiClientFactory(() => ({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }));
  assert.equal((await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner')).status, 422);

  // invites listing + activate older
  const invs = await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner');
  assert.equal(invs.data.invites.length, 2);
  const older = invs.data.invites[1];
  await call('POST', `/api/profiles/${p1.data.id}/invites/${older.id}/activate`, {}, 'owner');
  const invs2 = await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner');
  assert.equal(invs2.data.invites.find((i) => i.active).id, older.id);

  // suspended agency locks everyone out
  const agencies = await call('GET', '/api/admin/agencies', undefined, 'admin');
  await call('PATCH', `/api/admin/agencies/${agencies.data.agencies[0].id}`, { active: false }, 'admin');
  assert.equal((await call('GET', '/api/profiles', undefined, 'owner')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@rose', password: 'ownerpass1' })).status, 403);
});

test('extension zip is served with server url baked in', async () => {
  const res = await fetch(`${base}/download/extension.zip`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.includes(Buffer.from('agency-bot/manifest.json')));
  assert.ok(buf.includes(Buffer.from('self.AGENCY_DEFAULT_SERVER = "http://localhost:9"')));
});
