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
  assert.match(cfg.data.site.config.messageInput, /#chat-modal textarea/);
  assert.equal(cfg.data.scenario.attempts, 3);

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
  assert.match(seen.system, /opening message a woman sends/, 'built-in prompt by default');

  // Master prompt: placeholders filled, man's {name} left for the bot
  const st0 = await call('GET', '/api/settings', undefined, 'owner');
  assert.ok(st0.data.defaultPrompt.length > 200);
  assert.ok(st0.data.promptVars.some(([k]) => k === '{her_name}'));
  const master = 'You are {her_name}, {her_age}, from {her_city}. Write in {language}. Greet him as {name}. Profile:\n{profile}';
  const putMp = await call('PUT', '/api/settings', { settings: { ai: { masterPrompt: master } } }, 'owner');
  assert.equal(putMp.status, 200, JSON.stringify(putMp.data));
  assert.equal(putMp.data.settings.ai.masterPrompt, master);
  await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner');
  assert.match(seen.system, /^You are Anna, 32, from Kyiv\. Write in English\. Greet him as \{name\}\./);
  assert.match(seen.system, /Interests: yoga, travel, cooking/);

  // Saving the built-in text means "use default"
  const putDef = await call('PUT', '/api/settings', { settings: { ai: { masterPrompt: st0.data.defaultPrompt } } }, 'owner');
  assert.equal(putDef.data.settings.ai.masterPrompt, '');
  await call('PUT', '/api/settings', { settings: { ai: { masterPrompt: master } } }, 'owner');

  // Profile's own prompt beats the master prompt; operators cannot set it
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: 'Own prompt for {her_name} only.' }, 'owner');
  await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner');
  assert.equal(seen.system, 'Own prompt for Anna only.');
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: 'hacked' }, 'op');
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'owner')).data.profile.prompt, 'Own prompt for {her_name} only.');

  // Preview: tries a prompt (with unsaved fields), saves nothing, owner only
  const before = (await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner')).data.invites.length;
  const pv = await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, { prompt: 'Test prompt for {her_name}, {her_city}.', fields: { city: 'Lviv' } }, 'owner');
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(seen.system, 'Test prompt for Anna, Lviv.');
  assert.equal(pv.data.promptSource, 'override');
  assert.match(pv.data.preview, /Michael/);
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner')).data.invites.length, before, 'preview saves nothing');
  const pvAgency = await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, {}, 'owner');
  assert.equal(pvAgency.data.promptSource, 'agency', 'empty preview prompt → agency master prompt, not the profile one');
  assert.equal((await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, { prompt: 'x' }, 'op')).status, 403);
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: '' }, 'owner');
  await call('PUT', '/api/settings', { settings: { ai: { masterPrompt: '' } } }, 'owner');

  // AI refusal surfaces as a clear error
  setAiClientFactory(() => ({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } }));
  assert.equal((await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner')).status, 422);

  // invites listing + activate older
  const invs = await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner');
  assert.ok(invs.data.invites.length >= 2);
  const older = invs.data.invites[1];
  await call('POST', `/api/profiles/${p1.data.id}/invites/${older.id}/activate`, {}, 'owner');
  const invs2 = await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner');
  assert.equal(invs2.data.invites.find((i) => i.active).id, older.id);

  // first-steps checklist: demo site doesn't count, licensed profile and bot run do
  const onb = await call('GET', '/api/stats/onboarding', undefined, 'owner');
  const stepOf = (k) => onb.data.steps.find((x) => x.key === k);
  assert.equal(stepOf('site').done, false, 'demo site is not "your site"');
  assert.equal(stepOf('profile').done, true);
  assert.equal(stepOf('bot').done, true);
  assert.equal(stepOf('operator').done, true);
  assert.deepEqual((await call('GET', '/api/stats/onboarding', undefined, 'op')).data.steps, []);

  // backup: admin downloads a real SQLite file; others can't
  const bk = await fetch(`${base}/api/admin/backup`, { headers: { authorization: `Bearer ${tokens.admin}` } });
  assert.equal(bk.status, 200);
  assert.match(bk.headers.get('content-disposition') || '', /agency-backup-\d{4}-\d{2}-\d{2}\.db/);
  const bkBuf = Buffer.from(await bk.arrayBuffer());
  assert.equal(bkBuf.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await call('GET', '/api/admin/backup', undefined, 'owner')).status, 403);
  assert.equal((await call('GET', '/api/health')).data.persistentStorage, true);

  // admin resets the owner's password → old one stops working, new one works
  const agList = await call('GET', '/api/admin/agencies', undefined, 'admin');
  const reset = await call('POST', `/api/admin/agencies/${agList.data.agencies[0].id}/reset-owner`, {}, 'admin');
  assert.equal(reset.status, 200);
  assert.equal(reset.data.email, 'owner@rose');
  assert.ok(reset.data.password.length >= 10);
  assert.equal((await call('GET', '/api/profiles', undefined, 'owner')).status, 401, 'old session closed');
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@rose', password: 'ownerpass1' })).status, 401);
  await login('owner', 'owner@rose', reset.data.password);
  assert.equal((await call('POST', `/api/admin/agencies/${agList.data.agencies[0].id}/reset-owner`, {}, 'owner')).status, 403);

  // suspended agency locks everyone out
  const agencies = await call('GET', '/api/admin/agencies', undefined, 'admin');
  await call('PATCH', `/api/admin/agencies/${agencies.data.agencies[0].id}`, { active: false }, 'admin');
  assert.equal((await call('GET', '/api/profiles', undefined, 'owner')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@rose', password: reset.data.password })).status, 403);
});

test('scenario: follow-ups until reply, three attempts, then dropped', async () => {
  await login('admin2', 'root@test', 'rootpass123');
  const ag = await call('POST', '/api/admin/agencies', { name: 'Lily', ownerName: 'L', ownerEmail: 'owner@lily', ownerPassword: 'ownerpass1', licenses: 2, days: 30 }, 'admin2');
  assert.equal(ag.status, 201);
  await login('lily', 'owner@lily', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'lily')).data.sites[0];
  assert.equal(site.scenario.steps.length, 3, 'default scenario has 3 attempts');
  assert.equal(site.config.actions[0].key, 'like');

  // custom scenario: like + invite, then 2 follow-ups; only online men from the USA/Canada
  const sc = await call('PUT', `/api/sites/${site.id}/scenario`, { scenario: {
    steps: [
      { actions: [{ do: 'click', action: 'like' }, { do: 'message', text: 'invite' }] },
      { wait: 24, actions: [{ do: 'message', text: 'followup' }] },
      { wait: 48, actions: [{ do: 'view', chance: 50 }, { do: 'message', text: 'custom', custom: 'Hey {name}, me again!\n---\nHi {name}, still here :)' }] },
      { wait: 1, actions: [{ do: 'bogus' }] },
    ],
    filters: { countries: 'USA, Canada', needMarks: ['online'] },
    human: { perHour: 2, hoursFrom: 8, hoursTo: 22 },
  } }, 'lily');
  assert.equal(sc.status, 200, JSON.stringify(sc.data));
  assert.equal(sc.data.scenario.steps.length, 3, 'empty step dropped');

  const lic = (await call('GET', '/api/licenses', undefined, 'lily')).data.licenses;
  const p = (await call('POST', '/api/profiles', { name: 'Kate', age: 30, site_id: site.id, license_id: lic[0].id, daily_limit: 10 }, 'lily')).data;
  const cfg = await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'lily');
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.scenario.attempts, 3);
  assert.equal(cfg.data.scenario.human.perHour, 2);
  const detail = (await call('GET', `/api/profiles/${p.id}`, undefined, 'lily')).data;
  assert.deepEqual(detail.followupSteps, [2]);
  assert.equal(detail.followups.length, 1, 'follow-up text written once at start');

  const f = await call('POST', `/api/bot/profiles/${p.id}/filter`, { candidates: [
    { id: '700001', name: 'Mike', country: 'USA', marks: ['online'] },
    { id: '700002', name: 'Tom', country: 'UK', marks: ['online'] },
    { id: '700003', name: 'Bob', country: 'Canada', marks: [] },
    { id: '700004', name: 'Sam', country: 'Canada', marks: ['online'] },
  ] }, 'lily');
  assert.deepEqual(f.data.allowed.map((m) => m.id), ['700001', '700004']);
  assert.equal(f.data.skipped.filter, 2);
  const mike = f.data.allowed[0];
  assert.deepEqual(mike.actions.map((a) => a.do), ['click', 'message']);
  assert.equal(mike.actions[0].sel, '.btn-like');
  assert.match(mike.url, /profile\.html\?id=700001$/);
  assert.match(mike.text, /Mike/);

  for (const m of f.data.allowed) {
    const r = await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: m, ok: true, text: m.text, invite_id: m.invite_id }, 'lily');
    assert.equal(r.status, 200);
  }
  assert.equal((await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data.men.length, 0, 'nothing due yet');

  // fast-forward: step 2 is due for both
  db.prepare('UPDATE messages SET next_at = 1 WHERE profile_id = ?').run(p.id);
  let due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data;
  assert.equal(due.men.length, 2);
  assert.equal(due.hourLeft, 0, 'per-hour cap reached after 2 messages');
  assert.equal(due.men[0].step, 2);
  assert.equal(due.men[0].actions[0].do, 'message');
  assert.doesNotMatch(due.men[0].actions[0].text, /\{name\}/);

  // Sam replies → his scenario stops
  await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '700004' }] }, 'lily');
  due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data;
  assert.deepEqual(due.men.map((m) => m.id), ['700001']);

  // Mike: step 2 ok, step 3 ok → done
  let st = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '700001' }, step: 2, ok: true, messages: 1, text: 'x' }, 'lily');
  assert.equal(st.data.stage, 'active');
  const dup = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '700001' }, step: 2, ok: true, messages: 1 }, 'lily');
  assert.equal(dup.status, 200, 'repeat report is ignored');
  db.prepare("UPDATE messages SET next_at = 1 WHERE profile_id = ? AND man_id = '700001'").run(p.id);
  due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data;
  assert.equal(due.men[0].step, 3);
  assert.deepEqual(due.men[0].actions.map((a) => a.do), ['view', 'message']);
  assert.match(due.men[0].actions[1].text, /^(Hey Mike, me again!|Hi Mike, still here :\))$/);
  st = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '700001' }, step: 3, ok: true, messages: 1 }, 'lily');
  assert.equal(st.data.stage, 'done', 'three attempts used → dropped');
  db.prepare('UPDATE messages SET next_at = 1 WHERE profile_id = ?').run(p.id);
  assert.equal((await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data.men.length, 0);

  // daily counter includes follow-ups: 2 first + 2 follow-ups
  assert.equal(st.data.remaining, 10 - 4);
  const j = await call('GET', '/api/stats/messages?status=done', undefined, 'lily');
  assert.deepEqual(j.data.messages.map((m) => m.man_id), ['700001']);

  // operator teaching: may save only sites of own profiles
  const op = await call('POST', '/api/operators', { name: 'Op', email: 'op@lily', password: 'oppass1' }, 'lily');
  await login('lilyop', 'op@lily', 'oppass1', 'bot');
  assert.equal((await call('PUT', `/api/bot/sites/${site.id}`, { config: { card: '.x' } }, 'lilyop')).status, 403);
  await call('PATCH', `/api/profiles/${p.id}`, { operator_id: op.data.id }, 'lily');
  const teach = await call('GET', `/api/bot/profiles/${p.id}/site`, undefined, 'lilyop');
  assert.equal(teach.status, 200);
  const newCfg = { ...teach.data.site.config, card: '.card-x', marks: [{ key: 'vip', name: 'VIP', sel: '.vip' }] };
  assert.equal((await call('PUT', `/api/bot/sites/${site.id}`, { config: newCfg }, 'lilyop')).status, 200);
  const after = (await call('GET', '/api/sites', undefined, 'lily')).data.sites[0];
  assert.equal(after.config.card, '.card-x');
  assert.deepEqual(after.config.marks.map((m) => m.key), ['vip']);
  // panel form save keeps taught lists
  await call('PUT', `/api/sites/${site.id}`, { name: after.name, config: { card: '.card-y', cardId: '@id', openChat: '.w', messageInput: 'textarea' } }, 'lily');
  const kept = (await call('GET', '/api/sites', undefined, 'lily')).data.sites[0];
  assert.equal(kept.config.actions[0].key, 'like');
  assert.equal(kept.config.marks[0].key, 'vip');
});

test('extension zip is served with server url baked in', async () => {
  const res = await fetch(`${base}/download/extension.zip`);
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.includes(Buffer.from('agency-bot/manifest.json')));
  assert.ok(buf.includes(Buffer.from('self.AGENCY_DEFAULT_SERVER = "http://localhost:9"')));
});
