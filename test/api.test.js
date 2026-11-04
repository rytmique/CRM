import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setAiClientFactory } from '../server/ai.js';
import { personalize } from '../server/personalize.js';
import { buildZip } from '../server/zip.js';
import { optimizeProfile, pickInvite, inviteStats, refreshMemory, memoryLines } from '../server/learning.js';
import { getSettings } from '../server/services.js';
import vm from 'node:vm';
import { stripJs } from '../server/strip.js';

/** Reads a STORE-only zip (what the server makes) into { name: Buffer }. */
function unzip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    out[name] = buf.slice(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

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
  // operator edits own profile fully, but can't hand it to someone else
  assert.equal((await call('PATCH', `/api/profiles/${p1.data.id}`, { name: 'Anya', operator_id: 1 }, 'op')).status, 200);
  const renamed = (await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'op')).data.profile;
  assert.equal(renamed.name, 'Anya');
  assert.equal(renamed.operator_id, op.data.id, 'operator cannot reassign');
  await call('PATCH', `/api/profiles/${p1.data.id}`, { name: 'Anna' }, 'op');
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

  // Profile's own prompt beats the master prompt; the operator of the profile may set it too
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: 'Own prompt for {her_name} only.' }, 'owner');
  await call('POST', `/api/profiles/${p1.data.id}/invites/generate`, {}, 'owner');
  assert.equal(seen.system, 'Own prompt for Anna only.');
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: 'Operator prompt' }, 'op');
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}`, undefined, 'owner')).data.profile.prompt, 'Operator prompt');
  await call('PATCH', `/api/profiles/${p1.data.id}`, { prompt: 'Own prompt for {her_name} only.' }, 'owner');

  // Preview: tries a prompt (with unsaved fields), saves nothing
  const before = (await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner')).data.invites.length;
  const pv = await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, { prompt: 'Test prompt for {her_name}, {her_city}.', fields: { city: 'Lviv' } }, 'owner');
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(seen.system, 'Test prompt for Anna, Lviv.');
  assert.equal(pv.data.promptSource, 'override');
  assert.match(pv.data.preview, /Michael/);
  assert.equal((await call('GET', `/api/profiles/${p1.data.id}/invites`, undefined, 'owner')).data.invites.length, before, 'preview saves nothing');
  const pvAgency = await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, {}, 'owner');
  assert.equal(pvAgency.data.promptSource, 'agency', 'empty preview prompt → agency master prompt, not the profile one');
  assert.equal((await call('POST', `/api/profiles/${p1.data.id}/invites/preview`, { prompt: 'x' }, 'op')).status, 200);
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
  // daily counter includes follow-ups: 2 first + 2 follow-ups
  assert.equal(st.data.remaining, 10 - 4);

  // Sam replied: +10 reminders, but only after he goes quiet (48 h by default)
  const samRow = () => db.prepare("SELECT * FROM messages WHERE profile_id = ? AND man_id = '700004'").get(p.id);
  assert.equal(samRow().bonus_left, 10);
  assert.ok(samRow().next_at > Date.now() + 47 * 3600000);
  assert.equal((await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data.men.length, 0, 'mike is done, sam is talking');
  // the same unread dialog seen again: no new reply, reminders postponed
  db.prepare("UPDATE messages SET next_at = 5 WHERE profile_id = ? AND man_id = '700004'").run(p.id);
  const again = await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '700004' }] }, 'lily');
  assert.equal(again.data.new, 0);
  assert.ok(samRow().next_at > Date.now() + 47 * 3600000, 'talk is alive → reminder postponed');
  assert.equal(samRow().bonus_left, 10, 'no double bonus for the same reply');
  // he goes quiet → the bot reminds him on his page
  db.prepare("UPDATE messages SET next_at = 1 WHERE profile_id = ? AND man_id = '700004'").run(p.id);
  due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data;
  assert.equal(due.men.length, 1);
  assert.equal(due.men[0].kind, 'reengage');
  assert.equal(due.men[0].left, 10);
  assert.match(due.men[0].url, /id=700004$/);
  assert.doesNotMatch(due.men[0].actions[0].text, /\{name\}|---/);
  st = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '700004' }, kind: 'reengage', ok: true, messages: 1, text: 'hi' }, 'lily');
  assert.equal(st.data.left, 9);
  assert.equal(st.data.stage, 'replied');
  assert.equal(st.data.remaining, 10 - 5, 'reminders count into the daily limit');
  // he answers the reminder → a new positive reply → +10 more
  const back = await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '700004', text: 'Hey! sorry, busy week :)' }] }, 'lily');
  assert.equal(back.data.new, 1);
  assert.equal(samRow().bonus_left, 19);
  assert.equal(samRow().replies, 2);
  // "not interested" ends it for good
  db.prepare("UPDATE messages SET last_at = ? WHERE profile_id = ? AND man_id = '700004'").run(Date.now() + 1000, p.id);
  const no = await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '700004', text: 'Sorry, I am not interested. Please do not write me.' }] }, 'lily');
  assert.equal(no.data.negative, 1);
  assert.equal(samRow().bonus_left, 0);
  assert.equal(samRow().next_at, null);
  // the last reminder without an answer → dropped
  db.prepare("UPDATE messages SET bonus_left = 1, next_at = 1, reply_mood = 'positive' WHERE profile_id = ? AND man_id = '700004'").run(p.id);
  st = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '700004' }, kind: 'reengage', ok: true, messages: 1 }, 'lily');
  assert.equal(st.data.stage, 'done');
  assert.equal((await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'lily')).data.men.length, 0);
  const funnel = (await call('GET', `/api/profiles/${p.id}`, undefined, 'lily')).data.funnel;
  assert.equal(funnel.replied, 1, 'he still counts as replied');
  const j = await call('GET', '/api/stats/messages?status=done', undefined, 'lily');
  assert.deepEqual(j.data.messages.map((m) => m.man_id).sort(), ['700001', '700004']);

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

test('templates per profile and files attached to messages', async () => {
  await login('admin3', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Iris', ownerName: 'I', ownerEmail: 'owner@iris', ownerPassword: 'ownerpass1', licenses: 2, days: 30 }, 'admin3');
  await login('iris', 'owner@iris', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'iris')).data.sites[0];
  const lib = await call('GET', '/api/scenarios', undefined, 'iris');
  assert.ok(lib.data.presets.length >= 3, 'built-in presets');
  assert.deepEqual(lib.data.templates, []);

  // save a template: like + invite with one random file, then a follow-up with all files of step 2
  const tpl = await call('POST', '/api/scenarios', { name: 'Фото-атака', scenario: {
    steps: [
      { actions: [{ do: 'click', action: 'like', chance: 50 }, { do: 'message', text: 'invite', files: 'one' }] },
      { wait: 12, actions: [{ do: 'message', text: 'custom', custom: 'Hi {name}! Look :)', files: 'all' }] },
    ],
    human: { hoursFrom: 0, hoursTo: 0 },
  } }, 'iris');
  assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
  assert.equal(tpl.data.template.scenario.steps[0].actions[0].chance, 50);
  assert.equal((await call('PUT', `/api/scenarios/${tpl.data.template.id}`, { name: 'Фото' }, 'iris')).data.template.name, 'Фото');

  const lic = (await call('GET', '/api/licenses', undefined, 'iris')).data.licenses;
  const p = (await call('POST', '/api/profiles', { name: 'Lena', site_id: site.id, license_id: lic[0].id, scenario_id: tpl.data.template.id }, 'iris')).data;
  assert.equal((await call('POST', '/api/profiles', { name: 'X', scenario_id: 999999 }, 'iris')).status, 400);

  // files: upload raw bodies, mark steps
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db40000000049454e44ae426082', 'hex');
  const up = async (name, steps) => {
    const res = await fetch(`${base}/api/profiles/${p.id}/media?steps=${steps}`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name), authorization: `Bearer ${tokens.iris}` }, body: png });
    return { status: res.status, data: await res.json() };
  };
  const a = await up('фото 1.png', '1');
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await up('photo2.png', '1,2');
  assert.deepEqual(b.data.media.steps, [1, 2]);
  const bad = await fetch(`${base}/api/profiles/${p.id}/media`, { method: 'POST', headers: { 'content-type': 'application/x-msdownload', authorization: `Bearer ${tokens.iris}` }, body: Buffer.from('MZ') });
  assert.equal(bad.status, 400, 'executables are refused');
  const detail = (await call('GET', `/api/profiles/${p.id}`, undefined, 'iris')).data;
  assert.equal(detail.media.length, 2);
  assert.equal(detail.media[0].name, 'фото 1.png');
  assert.equal(detail.scenarioName, 'Фото');
  assert.equal(detail.steps, 2);

  // the bot runs the profile's template, not the site scenario
  const cfg = await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'iris');
  assert.equal(cfg.data.scenario.steps, 2);
  const f = await call('POST', `/api/bot/profiles/${p.id}/filter`, { candidates: [{ id: '880001', name: 'Tom' }] }, 'iris');
  const msg = f.data.allowed[0].actions.find((x) => x.do === 'message');
  assert.equal(msg.files.length, 1, 'one random file of step 1');
  assert.ok(['фото 1.png', 'photo2.png'].includes(msg.files[0].name));
  const file = await fetch(`${base}/api/bot/media/${msg.files[0].id}`, { headers: { authorization: `Bearer ${tokens.iris}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/bot/media/${msg.files[0].id}`, { headers: { authorization: `Bearer ${tokens.lily}` } })).status, 404, 'other agency cannot read it');

  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: f.data.allowed[0], ok: true, text: msg.text }, 'iris');
  db.prepare('UPDATE messages SET next_at = 1 WHERE profile_id = ?').run(p.id);
  const due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'iris')).data;
  assert.deepEqual(due.men[0].actions[0].files.map((x) => x.name), ['photo2.png'], 'step 2 gets the files marked for step 2');
  assert.equal(due.men[0].actions[0].text, 'Hi Tom! Look :)');

  // un-mark step 2 → follow-up goes without files; delete a file
  await call('PATCH', `/api/profiles/${p.id}/media/${b.data.media.id}`, { steps: [1] }, 'iris');
  assert.deepEqual((await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'iris')).data.men[0].actions[0].files, []);
  assert.equal((await call('DELETE', `/api/profiles/${p.id}/media/${a.data.media.id}`, undefined, 'iris')).status, 200);
  assert.equal((await call('GET', `/api/profiles/${p.id}/media`, undefined, 'iris')).data.media.length, 1);

  // deleting a template sends its profiles back to the site scenario
  await call('DELETE', `/api/scenarios/${tpl.data.template.id}`, undefined, 'iris');
  assert.equal((await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'iris')).data.scenario.steps, 3);
});

test('the bot is downloaded only after logging in: a marked copy, no comments, can be switched off', async () => {
  assert.equal((await fetch(`${base}/download/extension.zip`)).status, 403, 'no open download any more');
  assert.equal((await fetch(`${base}/api/extension/download`)).status, 401);
  await login('admin2', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Lily', ownerName: 'L', ownerEmail: 'owner@lily', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin2');
  await login('lily', 'owner@lily', 'ownerpass1');
  const res = await fetch(`${base}/api/extension/download`, { headers: { authorization: `Bearer ${tokens.lily}` } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  const files = unzip(buf);
  assert.ok(files['agency-bot/manifest.json']);
  const conf = files['agency-bot/config.js'].toString();
  assert.match(conf, /self\.AGENCY_DEFAULT_SERVER = "http:\/\/localhost:9"/);
  const build = /AGENCY_BUILD = "([^"]+)"/.exec(conf)[1];
  // the code: no comments, still valid JavaScript (each file is parsed)
  for (const [name, data] of Object.entries(files).filter(([n]) => n.endsWith('.js'))) {
    const code = data.toString();
    assert.doesNotMatch(code, /^\s*\/\/ |\/\*\*/m, `${name} still has comments`);
    assert.doesNotThrow(() => new vm.Script(code, { filename: name }), `${name} is broken`);
  }
  // the bot logs in with its mark; the admin sees the copy and the device, and can switch the copy off
  const bot = await call('POST', '/api/auth/login', { email: 'owner@lily', password: 'ownerpass1', kind: 'bot', build });
  assert.equal(bot.status, 200);
  const dev = (await call('GET', '/api/admin/devices', undefined, 'admin2')).data;
  assert.ok(dev.devices.some((d) => d.build === build && d.kind === 'bot' && d.email === 'owner@lily'));
  const copy = (await call('GET', '/api/admin/builds', undefined, 'admin2')).data.builds.find((b) => b.build === build);
  assert.equal(copy.sessions, 1);
  await call('POST', `/api/admin/builds/${copy.id}/revoke`, {}, 'admin2');
  const after = await fetch(`${base}/api/bot/profiles`, { headers: { authorization: `Bearer ${bot.data.token}` } });
  assert.equal(after.status, 401, 'the switched-off copy is signed out at once');
  const again = await call('POST', '/api/auth/login', { email: 'owner@lily', password: 'ownerpass1', kind: 'bot', build });
  assert.equal(again.status, 403);
  // "only copies from the panel": an old copy without a mark cannot log in
  await call('PUT', '/api/admin/security', { requireBuild: true }, 'admin2');
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@lily', password: 'ownerpass1', kind: 'bot' })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@lily', password: 'ownerpass1' })).status, 200, 'the panel itself is not affected');
  await call('PUT', '/api/admin/security', { requireBuild: false }, 'admin2');
});

test('roles: operator creates own profiles, sites and templates; owner controls', async () => {
  await login('admin4', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Tulip', ownerName: 'T', ownerEmail: 'owner@tulip', ownerPassword: 'ownerpass1', licenses: 2, days: 30 }, 'admin4');
  await login('tulip', 'owner@tulip', 'ownerpass1');
  const demo = (await call('GET', '/api/sites', undefined, 'tulip')).data.sites[0];
  const o1 = (await call('POST', '/api/operators', { name: 'Op1', email: 'op1@tulip', password: 'op1pass' }, 'tulip')).data;
  await call('POST', '/api/operators', { name: 'Op2', email: 'op2@tulip', password: 'op2pass' }, 'tulip');
  await login('op1', 'op1@tulip', 'op1pass');
  await login('op2', 'op2@tulip', 'op2pass');

  // sites: an operator adds and teaches their own; someone else's only once their profile uses it
  const opSite = await call('POST', '/api/sites', { name: 'Мій сайт', base_url: 'https://dating.example/' }, 'op1');
  assert.equal(opSite.status, 201, JSON.stringify(opSite.data));
  const listed = (await call('GET', '/api/sites', undefined, 'op1')).data.sites;
  assert.equal(listed.find((s) => s.id === opSite.data.id).can_edit, true);
  assert.equal(listed.find((s) => s.id === demo.id).can_edit, false);
  assert.equal((await call('PUT', `/api/sites/${demo.id}/scenario`, { reset: true }, 'op1')).status, 403);
  assert.equal((await call('PUT', `/api/sites/${opSite.data.id}`, { name: 'Мій сайт 2' }, 'op2')).status, 403);
  assert.equal((await call('DELETE', `/api/sites/${opSite.data.id}`, undefined, 'op1')).status, 403, 'only the owner deletes sites');

  // profiles: an operator creates their own and gets a free license automatically
  const a = await call('POST', '/api/profiles', { name: 'Kate', site_id: demo.id, operator_id: 999 }, 'op1');
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.licensed, true);
  const kate = (await call('GET', `/api/profiles/${a.data.id}`, undefined, 'op1')).data.profile;
  assert.equal(kate.operator_id, o1.id);
  assert.equal(kate.license.state, 'active');
  assert.equal((await call('PUT', `/api/sites/${demo.id}/scenario`, { reset: true }, 'op1')).status, 200, 'her site is now editable');
  assert.equal((await call('POST', '/api/profiles', { name: 'Lisa', site_id: opSite.data.id }, 'op1')).data.licensed, true);
  const c = await call('POST', '/api/profiles', { name: 'Nina' }, 'op2');
  assert.equal(c.data.licensed, false, 'pool is empty');
  assert.equal((await call('POST', `/api/profiles/${c.data.id}/license/auto`, {}, 'op2')).status, 400);
  assert.equal((await call('GET', `/api/profiles/${c.data.id}`, undefined, 'op1')).status, 404, 'operators see only their own');
  assert.equal((await call('DELETE', `/api/profiles/${a.data.id}`, undefined, 'op1')).status, 403, 'only the owner deletes profiles');
  assert.equal((await call('GET', '/api/profiles', undefined, 'tulip')).data.profiles.length, 3, 'owner sees everything');
  assert.equal((await call('POST', `/api/profiles/${a.data.id}/invites/preview`, { prompt: 'Write about {her_name}' }, 'op1')).status, 200);

  // templates: own ones editable; the owner can edit all
  const t = await call('POST', '/api/scenarios', { name: 'Op1 plan', scenario: {} }, 'op1');
  assert.equal(t.status, 201);
  assert.equal(t.data.template.can_edit, true);
  assert.equal((await call('PUT', `/api/scenarios/${t.data.template.id}`, { name: 'x' }, 'op2')).status, 403);
  assert.equal((await call('PUT', `/api/scenarios/${t.data.template.id}`, { name: 'Owner edit' }, 'tulip')).status, 200);

  // settings stay with the owner; the prompt editor info is open to operators
  assert.equal((await call('GET', '/api/settings', undefined, 'op1')).status, 403);
  assert.ok((await call('GET', '/api/settings/prompt-info', undefined, 'op1')).data.defaultPrompt);
});

test('men are ranked by what their profile shows: platform-wide reply stats', async () => {
  await login('admin5', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Peony', ownerName: 'P', ownerEmail: 'owner@peony', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin5');
  await login('peony', 'owner@peony', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'peony')).data.sites[0];
  const p = (await call('POST', '/api/profiles', { name: 'Olga', site_id: site.id, license_id: 'auto', daily_limit: 50 }, 'peony')).data;
  assert.equal(p.licensed, true);
  db.exec('DELETE FROM man_stats'); // earlier tests taught the shared table: start clean
  const cfg0 = (await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'peony')).data;
  assert.equal(cfg0.ranking.ready, false, 'no data yet');
  assert.equal(cfg0.ranking.manUrl, true);

  // no data: the site's own order is kept
  const men = [
    { id: '810001', name: 'Ian', age: 33, country: 'UK', info: 'Teacher from London, likes football' },
    { id: '810002', name: 'Bill', age: 52, country: 'USA', info: 'Retired engineer, loves fishing and travel', marks: ['online'] },
    { id: '810003', name: 'Ken', age: 48, country: 'USA', info: 'Business owner' },
  ];
  let f = (await call('POST', `/api/bot/profiles/${p.id}/filter`, { candidates: men }, 'peony')).data;
  assert.deepEqual(f.allowed.map((m) => m.id), ['810001', '810002', '810003']);

  // the platform learned: Americans 50+ who are online answer more, the UK less
  const seed = db.prepare('INSERT INTO man_stats (feature, sent, replied, updated_at) VALUES (?,?,?,0) ON CONFLICT(feature) DO UPDATE SET sent = excluded.sent, replied = excluded.replied');
  seed.run('*', 1000, 100);
  seed.run('c:usa', 300, 60);
  seed.run('c:uk', 300, 6);
  seed.run('a:50', 200, 40);
  seed.run('m:localhost:online', 200, 50);
  f = (await call('POST', `/api/bot/profiles/${p.id}/filter`, { candidates: men }, 'peony')).data;
  assert.deepEqual(f.allowed.map((m) => m.id), ['810002', '810003', '810001'], 'best first');
  assert.ok(f.allowed[0].why.includes('Онлайн'), JSON.stringify(f.allowed[0].why));
  assert.equal(f.allowed[0].features, undefined, 'features stay on the server');

  // sending teaches the platform; a positive reply too
  const before = db.prepare("SELECT sent, replied FROM man_stats WHERE feature = 'c:usa'").get();
  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: f.allowed[0], ok: true, text: 'hi' }, 'peony');
  assert.equal(db.prepare("SELECT sent FROM man_stats WHERE feature = 'c:usa'").get().sent, before.sent + 1);
  assert.ok(db.prepare("SELECT 1 FROM man_stats WHERE feature = 'w:fishing'").get(), 'card words are learned');
  assert.equal(db.prepare("SELECT 1 FROM man_stats WHERE feature = 'w:bill'").get(), undefined, 'his name is not');
  await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '810002', text: 'Hello Olga!' }] }, 'peony');
  assert.equal(db.prepare("SELECT replied FROM man_stats WHERE feature = 'c:usa'").get().replied, before.replied + 1);

  // scanning ahead: several pages go to the pool, the best are handed out first, on their own pages
  const many = Array.from({ length: 20 }, (_, i) => ({ id: String(820000 + i), name: `M${i}`, age: 40 + i, country: i % 4 === 0 ? 'USA' : 'UK', marks: i % 4 === 0 ? ['online'] : [] }));
  const pool = (await call('POST', `/api/bot/profiles/${p.id}/pool`, { candidates: many }, 'peony')).data;
  assert.equal(pool.added, 20);
  assert.equal(pool.ranking.ready, true);
  const next = (await call('GET', `/api/bot/profiles/${p.id}/pool/next?limit=10`, undefined, 'peony')).data;
  assert.ok(next.men.length >= 1 && next.men.length <= 6, `top part only: ${next.men.length}`);
  assert.ok(next.men.every((m) => m.country === 'USA'), 'only the promising ones');
  assert.match(next.men[0].url, /profile\.html\?id=82/);
  assert.equal(next.men[0].step, 1);
  const again = (await call('GET', `/api/bot/profiles/${p.id}/pool/next?limit=10`, undefined, 'peony')).data;
  assert.equal(again.men.length, 0, 'handed out once');
});

test('invites learn: variants by reply rate, weak ones replaced, shared lessons in the prompt', async () => {
  setAiClientFactory(null);
  await login('admin6', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Daisy', ownerName: 'D', ownerEmail: 'owner@daisy', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin6');
  await login('daisy', 'owner@daisy', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'daisy')).data.sites[0];
  const p = (await call('POST', '/api/profiles', { name: 'Vika', interests: 'art, dogs', site_id: site.id, license_id: 'auto' }, 'daisy')).data;

  // the bot start fills the rotation up to 3 variants (templates without a key)
  const cfg = (await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'daisy')).data;
  assert.equal(cfg.variants, 3);
  const live = inviteStats(db, p.id);
  assert.equal(live.length, 3);
  const [a, b, c] = live;

  // A: 15 of 60 answered, B: 1 of 60, C: new
  const agency = db.prepare('SELECT agency_id FROM profiles WHERE id = ?').get(p.id).agency_id;
  const ins = db.prepare("INSERT INTO messages (agency_id, profile_id, man_id, invite_id, status, day, sent_at, replied_at, reply_mood) VALUES (?,?,?,?, 'sent', '2026-11-01', 1, ?, ?)");
  for (let i = 0; i < 60; i++) ins.run(agency, p.id, `a${i}`, a.id, i < 15 ? 2 : null, i < 15 ? 'positive' : '');
  for (let i = 0; i < 60; i++) ins.run(agency, p.id, `b${i}`, b.id, i < 1 ? 2 : null, i < 1 ? 'positive' : '');
  const stats = inviteStats(db, p.id);
  assert.equal(stats.find((v) => v.id === a.id).replies, 15);

  // Thompson sampling: the strong one is picked most of the time, the new one still gets a chance
  const picks = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 2000; i++) { const v = pickInvite(stats); picks[v.id === a.id ? 'a' : v.id === b.id ? 'b' : 'c']++; }
  assert.ok(picks.a > picks.b * 10, JSON.stringify(picks));
  assert.ok(picks.c > 20, `new variant explored: ${JSON.stringify(picks)}`);

  // the optimizer retires B (clearly worse) and writes a new one
  const out = await optimizeProfile(db, db.prepare('SELECT * FROM profiles WHERE id = ?').get(p.id), getSettings(db, agency));
  assert.deepEqual(out.retired, [b.id]);
  assert.equal(out.added.length, 1);
  assert.equal(inviteStats(db, p.id).length, 3);
  assert.ok(db.prepare('SELECT retired_at FROM invites WHERE id = ?').get(b.id).retired_at);

  // panel: variants with numbers, the best marked; retire / add by hand
  const detail = (await call('GET', `/api/profiles/${p.id}`, undefined, 'daisy')).data;
  assert.equal(detail.bestInvite, a.id);
  assert.equal(detail.invites.find((i) => i.id === a.id).sent, 60);
  const manual = await call('POST', `/api/profiles/${p.id}/invites`, { text: 'Hi {name}! A variant I wrote myself :)', variant: true }, 'daisy');
  assert.equal(manual.status, 201);
  assert.equal(inviteStats(db, p.id).length, 4, 'added to the rotation');
  assert.equal((await call('POST', `/api/profiles/${p.id}/invites/${manual.data.invite.id}/retire`, {}, 'daisy')).status, 200);
  assert.equal(inviteStats(db, p.id).length, 3);

  // shared memory: admin lessons + numbers-based ones go into the prompt
  const mem = await call('POST', '/api/admin/memory', { text: 'Mention one concrete hobby and ask about his weekend.' }, 'admin6');
  assert.equal(mem.status, 201);
  assert.equal((await call('GET', '/api/admin/memory', undefined, 'daisy')).status, 403);
  await refreshMemory(db, { force: true });
  assert.ok(memoryLines(db, getSettings(db, agency)).includes('Mention one concrete hobby and ask about his weekend.'));
  let seen = null;
  setAiClientFactory(() => ({ beta: { messages: { create: async (req) => { seen = req; return { stop_reason: 'end_turn', model: req.model, content: [{ type: 'text', text: 'Hello {name}! I paint and walk my dog every morning. What do you love doing on a weekend?' }] }; } } } }));
  await call('PUT', '/api/settings', { settings: { ai: { apiKey: 'sk-test-123456' } } }, 'daisy');
  const gen = await call('POST', `/api/profiles/${p.id}/invites/generate`, { variant: true }, 'daisy');
  assert.equal(gen.status, 201, JSON.stringify(gen.data));
  assert.match(seen.messages[0].content, /What works on this platform[\s\S]*concrete hobby/);
  assert.match(seen.messages[0].content, /gets the most replies so far/, 'the best variant is the model for new ones');
  assert.equal(inviteStats(db, p.id).length, 4);
  // the team cannot switch it off itself; the platform admin can, for one team
  const daisyId = (await call('GET', '/api/auth/me', undefined, 'daisy')).data.user.agencyId;
  await call('PUT', '/api/settings', { settings: { ai: { sharedMemory: false } } }, 'daisy');
  assert.equal(getSettings(db, daisyId).ai.sharedMemory, true);
  assert.equal((await call('PUT', `/api/admin/agencies/${daisyId}/control`, { ai: { sharedMemory: false } }, 'admin6')).status, 200);
  await call('POST', `/api/profiles/${p.id}/invites/generate`, { variant: true }, 'daisy');
  assert.doesNotMatch(seen.messages[0].content, /What works on this platform/);
  setAiClientFactory(null);
});

test('setup wizard follows a new operator from nothing to a running bot', async () => {
  await login('admin7', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Lotus', ownerName: 'L', ownerEmail: 'owner@lotus', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin7');
  await login('lotus', 'owner@lotus', 'ownerpass1');
  const newOp = (await call('POST', '/api/operators', { name: 'New', email: 'new@lotus', password: 'newpass1' }, 'lotus')).data;
  await login('newop', 'new@lotus', 'newpass1');
  const steps = async () => Object.fromEntries((await call('GET', '/api/stats/setup', undefined, 'newop')).data.steps.map((s) => [s.key, s.done]));
  assert.deepEqual(await steps(), { site: false, profile: false, extension: false, teach: false, test: false, start: false });
  // a profile on the ready demo site (like the test stand) does not tick the wizard: it is about the real site
  const demoSite = (await call('GET', '/api/sites', undefined, 'newop')).data.sites.find((x) => x.base_url.includes('/demo-site/'));
  await call('POST', '/api/profiles', { name: 'Demo girl', site_id: demoSite.id, operator_id: newOp.id }, 'lotus'); // no license taken
  assert.deepEqual(await steps(), { site: false, profile: false, extension: false, teach: false, test: false, start: false });
  assert.equal((await call('GET', '/api/stats/setup', undefined, 'newop')).data.demoOnly, true);

  const site = (await call('POST', '/api/sites', { name: 'Real site', base_url: 'https://dating.example/', config: { searchUrl: 'https://dating.example/search' } }, 'newop')).data;
  const p = (await call('POST', '/api/profiles', { name: 'Ola', site_id: site.id }, 'newop')).data;
  assert.deepEqual(await steps(), { site: true, profile: true, extension: false, teach: false, test: false, start: false });
  const setup = (await call('GET', '/api/stats/setup', undefined, 'newop')).data;
  assert.equal(setup.site.searchUrl, 'https://dating.example/search');
  assert.ok(setup.steps.find((s) => s.key === 'teach').missing.length >= 2);

  await login('newopbot', 'new@lotus', 'newpass1', 'bot'); // logged in from the extension
  assert.equal((await steps()).extension, true);
  await call('PUT', `/api/bot/sites/${site.id}`, { config: { searchUrl: 'https://dating.example/search', card: '.c', cardId: '@data-id', openChat: '.w', messageInput: 'textarea' } }, 'newopbot');
  assert.equal((await steps()).teach, true);
  await call('POST', `/api/bot/profiles/${p.id}/test`, { ok: false, problems: ['no cards'] }, 'newopbot');
  assert.equal((await call('GET', '/api/stats/setup', undefined, 'newop')).data.steps.find((s) => s.key === 'test').failed, 'no cards');
  await call('POST', `/api/bot/profiles/${p.id}/test`, { ok: true }, 'newopbot');
  assert.equal((await steps()).test, true);
  await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'newopbot');
  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: { id: '900001', name: 'Tom' }, ok: true, text: 'hi' }, 'newopbot');
  const last = (await call('GET', '/api/stats/setup', undefined, 'newop')).data;
  assert.equal(last.done, true);
});

test('letters, the site counters, more pauses and several work windows', async () => {
  await login('admin8', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Aster', ownerName: 'A', ownerEmail: 'owner@aster', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin8');
  await login('aster', 'owner@aster', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'aster')).data.sites[0];
  assert.ok(site.config.letterOpen && site.config.letterLeft && site.config.chatLeft, 'demo site knows its letter form and counters');

  // step 1: an invite in the chat; step 2: a letter. Pauses and two work windows.
  const sc = await call('PUT', `/api/sites/${site.id}/scenario`, { scenario: {
    steps: [
      { actions: [{ do: 'message', text: 'invite' }] },
      { wait: 24, actions: [{ do: 'message', text: 'letter', via: 'letter' }] },
    ],
    human: { windows: '9-13, 15-23', gapFrom: 90, gapTo: 30, thinkFrom: 3, thinkTo: 7, actionGapFrom: 1, actionGapTo: 2, pageGapFrom: 5, pageGapTo: 9, breakMinutes: 5, breakMinutesTo: 15, typeSpeed: 400 },
  } }, 'aster');
  assert.equal(sc.status, 200, JSON.stringify(sc.data));
  const hm = sc.data.scenario.human;
  assert.deepEqual(hm.windows, [[9, 13], [15, 23]]);
  assert.equal(hm.hoursFrom, 9);
  assert.equal(hm.hoursTo, 23);
  assert.deepEqual([hm.gapFrom, hm.gapTo], [30, 90], 'from/to swapped into order');
  assert.deepEqual([hm.thinkFrom, hm.thinkTo, hm.breakMinutes, hm.breakMinutesTo, hm.typeSpeed], [3, 7, 5, 15, 400]);
  assert.equal(sc.data.scenario.steps[1].actions[0].via, 'letter');

  const p = (await call('POST', '/api/profiles', { name: 'Iryna', interests: 'books, sea', site_id: site.id, license_id: 'auto' }, 'aster')).data;
  const cfg = (await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'aster')).data;
  assert.deepEqual([cfg.limits.minDelay, cfg.limits.maxDelay], [30, 90], 'scenario pause between men when the profile has none');
  assert.deepEqual(cfg.scenario.human.windows, [[9, 13], [15, 23]]);
  const detail = (await call('GET', `/api/profiles/${p.id}`, undefined, 'aster')).data;
  assert.equal(detail.usesLetters, true);
  assert.ok(detail.letter.text.length > 300 && detail.letter.text.includes('{name}'), 'the letter is written once, at start');

  // step 2 resolves to the letter, sent via the letter form
  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: { id: '930001', name: 'Mark' }, ok: true, text: 'hi' }, 'aster');
  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: { id: '930002', name: 'Paul' }, ok: true, text: 'hi' }, 'aster');
  db.prepare('UPDATE messages SET next_at = 1 WHERE profile_id = ?').run(p.id);
  const due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'aster')).data;
  const letterAction = due.men[0].actions[0];
  assert.equal(letterAction.via, 'letter');
  assert.match(letterAction.text, /^Hello (Mark|Paul)!/);
  // the site says no letters are left for Paul → he is done, no more attempts
  const st = await call('POST', `/api/bot/profiles/${p.id}/step`, { man: { id: '930002' }, step: 2, ok: false, exhausted: true, error: 'сайт: листів цьому чоловіку не лишилось' }, 'aster');
  assert.equal(st.data.stage, 'done');

  // a captcha: Telegram alert (no token here → not sent), at most once per 10 minutes
  const a1 = await call('POST', `/api/bot/profiles/${p.id}/alert`, { text: 'Сайт показав капчу' }, 'aster');
  assert.equal(a1.status, 200);
  assert.equal(a1.data.sent, false);
});

test('operator desk: the site hint decides chat or letter; replies matched by name when the list has no IDs', async () => {
  await login('admin9', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Iris2', ownerName: 'I', ownerEmail: 'owner@iris2', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin9');
  await login('iris2', 'owner@iris2', 'ownerpass1');
  const site = (await call('POST', '/api/sites', { name: 'Desk', config: {
    searchUrl: 'https://desk.example/desk', taskItem: '.task', taskName: '.t-name', taskText: '.t-text', taskOpen: '@self',
    messageInput: '.tr-dst', chatName: '.ch-name', chatId: '.ch-id', findInput: '.find-id', inboxItem: '.chat-item', inboxName: '.ci-name',
  } }, 'iris2')).data;
  const listed = (await call('GET', '/api/sites', undefined, 'iris2')).data.sites.find((s) => s.id === site.id);
  assert.equal(listed.ready, true, 'hints + a chat box are enough, no cards needed');
  const p = (await call('POST', '/api/profiles', { name: 'Zoya', site_id: site.id, license_id: 'auto' }, 'iris2')).data;
  const cfg = (await call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'iris2')).data;
  assert.equal(cfg.site.config.taskOpen, '@self');
  assert.ok((await call('GET', `/api/profiles/${p.id}`, undefined, 'iris2')).data.letter, 'letter text ready: hints may ask for letters');

  // "Please write him letter" → the first message goes as a letter, with the letter text
  const f = (await call('POST', `/api/bot/profiles/${p.id}/filter`, { candidates: [
    { id: '1787395165', name: 'Pablo', age: 58, via: 'letter' },
    { id: '1901360240', name: 'Bob', age: 65, via: 'chat' },
  ] }, 'iris2')).data;
  const [pablo, bob] = f.allowed;
  assert.equal(pablo.actions[0].via, 'letter');
  assert.match(pablo.actions[0].text, /^Hello Pablo!/);
  assert.ok(pablo.actions[0].text.length > 300);
  assert.equal(bob.actions[0].via, 'chat');
  assert.doesNotMatch(bob.actions[0].text, /^Hello Bob!\n/);

  // follow-ups need no page of his own: he is found by ID in the chat list
  await call('POST', `/api/bot/profiles/${p.id}/sent`, { man: pablo, ok: true, text: 'x' }, 'iris2');
  await call('PUT', `/api/sites/${site.id}/scenario`, { scenario: { steps: [{ actions: [{ do: 'message', text: 'invite' }] }, { wait: 0, actions: [{ do: 'message', text: 'followup' }] }] } }, 'iris2');
  db.prepare('UPDATE messages SET next_at = 1 WHERE profile_id = ?').run(p.id);
  const due = (await call('GET', `/api/bot/profiles/${p.id}/due`, undefined, 'iris2')).data;
  assert.equal(due.men.length, 1);
  assert.equal(due.men[0].url, '', 'no URL: the bot will search his ID');
  assert.equal(due.noManUrl, false);

  // the chat list shows "Pablo, 58" and no ID: the reply is matched by name
  const r = (await call('POST', `/api/bot/profiles/${p.id}/replies`, { men: [{ id: '', name: 'Pablo, 58', text: 'Hi Zoya!' }] }, 'iris2')).data;
  assert.equal(r.new, 1);
  assert.equal(r.men[0].id, '1787395165');
});

test('payment for the bot: % of the operator earnings, a bigger sum → a bigger %, only the time the bot really worked', async () => {
  await login('admin10', 'root@test', 'rootpass123');
  const ag = (await call('POST', '/api/admin/agencies', { name: 'Orchid', ownerName: 'O', ownerEmail: 'owner@orchid', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin10')).data;
  await login('orchid', 'owner@orchid', 'ownerpass1');
  const op = (await call('POST', '/api/operators', { name: 'Vera', email: 'vera@orchid', password: 'verapass' }, 'orchid')).data;
  await login('vera', 'vera@orchid', 'verapass', 'bot');
  const site = (await call('GET', '/api/sites', undefined, 'orchid')).data.sites[0];
  // a day of 10 working hours, every day
  await call('PUT', `/api/sites/${site.id}/scenario`, { scenario: { human: { windows: '9-19' } } }, 'orchid');
  const p = (await call('POST', '/api/profiles', { name: 'Ola', site_id: site.id }, 'vera')).data;

  // heartbeats: working beats count, idle ones do not
  const t0 = Date.now();
  const beat = (active, state = 'running') => call('POST', `/api/bot/profiles/${p.id}/heartbeat`, { state, active }, 'vera');
  await beat(true);
  db.prepare('UPDATE profiles SET bot_beat_at = ? WHERE id = ?').run(t0 - 60000, p.id); // a minute ago
  await beat(true); // +60 s
  db.prepare('UPDATE profiles SET bot_beat_at = ? WHERE id = ?').run(Date.now() - 60000, p.id);
  await beat(false); // waiting for hints: not counted
  db.prepare('UPDATE profiles SET bot_beat_at = ? WHERE id = ?').run(Date.now() - 60000, p.id);
  await beat(true); // the previous beat was idle: still not counted
  const secs = db.prepare('SELECT SUM(seconds) AS s FROM bot_activity WHERE profile_id = ?').get(p.id).s;
  assert.ok(secs >= 59 && secs <= 62, `only real work counted: ${secs}`);

  // the admin sets the deal: 5 %, from 1000 — 7 %, from 3000 — 10 %
  assert.equal((await call('PATCH', `/api/admin/agencies/${ag.id}`, { billing: { tiers: [{ from: 3000, pct: 10 }, { from: 1000, pct: 7 }, { from: 0, pct: 5 }] } }, 'admin10')).status, 200);
  await call('PUT', '/api/settings', { settings: { billing: { perReply: 20, currency: '€', tiers: [{ from: 0, pct: 0 }] } } }, 'orchid'); // tiers are not the agency's to change

  // 3 positive replies this month → estimate 3 × 20 = 60 → 5 %; the bot worked 1 min of the month's working hours
  const month = new Date().toISOString().slice(0, 7);
  const today = `${month}-${String(new Date().getDate()).padStart(2, '0')}`;
  const ins = db.prepare("INSERT INTO messages (agency_id, profile_id, operator_id, man_id, status, day, sent_at, replied_at, reply_day, reply_mood) VALUES (?,?,?,?, 'sent', ?, 1, 2, ?, ?)");
  for (let i = 0; i < 4; i++) ins.run(ag.id, p.id, op.id, `pay${i}`, today, today, i < 3 ? 'positive' : 'negative');
  let rep = (await call('GET', `/api/billing?month=${month}`, undefined, 'orchid')).data;
  let vera = rep.rows.find((x) => x.user_id === op.id);
  assert.equal(rep.billing.currency, '€');
  assert.deepEqual(rep.billing.tiers.map((x) => x.pct), [5, 7, 10]);
  assert.equal(vera.replies, 3);
  assert.equal(vera.estimated, true);
  assert.equal(vera.earnings, 60);
  assert.equal(vera.pct, 5);
  assert.ok(vera.share > 0 && vera.share < 0.01, `1 minute of many working hours: ${vera.share}`);
  assert.ok(vera.fee < 0.1);

  // end of the month: the operator enters the real sum; a bigger sum → a bigger %
  rep = (await call('PUT', '/api/billing/earnings', { month, amount: 3500 }, 'vera')).data;
  vera = rep.rows[0];
  assert.equal(rep.rows.length, 1, 'an operator sees only themself');
  assert.equal(vera.estimated, false);
  assert.equal(vera.pct, 10);
  // not counting idle off: the whole sum
  await call('PATCH', `/api/admin/agencies/${ag.id}`, { billing: { prorate: false } }, 'admin10');
  vera = (await call('GET', `/api/billing?month=${month}`, undefined, 'vera')).data.rows[0];
  assert.equal(vera.share, 1);
  assert.equal(vera.fee, 350);
  assert.equal((await call('PUT', '/api/billing/earnings', { month, amount: 10, operator_id: 1 }, 'vera')).status, 403, 'not for others');
  // the admin sees what each agency owes
  const all = (await call('GET', `/api/admin/billing?month=${month}`, undefined, 'admin10')).data;
  assert.equal(all.agencies.find((a) => a.id === ag.id).fee, 350);
});

test('invite variants: two bot starts at once still give 3, not 5', async () => {
  await login('admin11', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Poppy', ownerName: 'P', ownerEmail: 'owner@poppy', ownerPassword: 'ownerpass1', licenses: 1, days: 30 }, 'admin11');
  await login('poppy', 'owner@poppy', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'poppy')).data.sites[0];
  const p = (await call('POST', '/api/profiles', { name: 'Lida', site_id: site.id, license_id: 'auto' }, 'poppy')).data;
  await Promise.all([1, 2, 3].map(() => call('GET', `/api/bot/profiles/${p.id}/config`, undefined, 'poppy')));
  assert.equal(inviteStats(db, p.id).length, 3);
});

test('registration by link: admin → team lead (approved by admin), team lead → operators (approve / reject)', async () => {
  await login('adminR', 'root@test', 'rootpass123');
  // the admin makes a one-time link with 3 licenses
  const link = (await call('POST', '/api/admin/links', { note: 'Ігор, 10 людей', licenses: 3, days: 30 }, 'adminR')).data.link;
  const info = await call('GET', `/api/auth/join/${link.token}`);
  assert.equal(info.data.kind, 'owner');
  assert.equal((await call('POST', `/api/auth/join/${link.token}`, { name: 'Ігор', email: 'bad-email', password: 'longpass1' })).status, 400);
  const reg = await call('POST', `/api/auth/join/${link.token}`, { name: 'Ігор', email: 'igor@team.ua', password: 'longpass1', agencyName: 'Ігорева команда' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal((await call('GET', `/api/auth/join/${link.token}`)).status, 404, 'one-time: used up');
  const waiting = await call('POST', '/api/auth/login', { email: 'igor@team.ua', password: 'longpass1' });
  assert.equal(waiting.status, 403);
  assert.match(waiting.data.error, /не підтверджено/);
  const pend = (await call('GET', '/api/admin/registrations', undefined, 'adminR')).data.pending.find((u) => u.email === 'igor@team.ua');
  assert.equal(pend.role, 'owner');
  assert.equal((await call('POST', `/api/admin/users/${pend.id}/approve`, {}, 'adminR')).status, 200);
  await login('igor', 'igor@team.ua', 'longpass1');
  assert.equal((await call('GET', '/api/licenses', undefined, 'igor')).data.licenses.length, 3, 'the licenses of the link are issued on approval');

  // the team lead's link for operators
  const tl = (await call('GET', '/api/operators/link', undefined, 'igor')).data.link;
  const opInfo = (await call('GET', `/api/auth/join/${tl.token}`)).data;
  assert.equal(opInfo.kind, 'operator');
  assert.equal(opInfo.agencyName, 'Ігорева команда');
  for (const [n, e] of [['Оля', 'olya@team.ua'], ['Чужий', 'stranger@x.com']]) {
    assert.equal((await call('POST', `/api/auth/join/${tl.token}`, { name: n, email: e, password: 'longpass1' })).status, 201);
  }
  assert.equal((await call('POST', `/api/auth/join/${tl.token}`, { name: 'Ще', email: 'olya@team.ua', password: 'longpass1' })).status, 400, 'email taken');
  const ops = (await call('GET', '/api/operators', undefined, 'igor')).data.operators;
  const olya = ops.find((o) => o.email === 'olya@team.ua');
  const stranger = ops.find((o) => o.email === 'stranger@x.com');
  assert.ok(olya.pending && stranger.pending);
  await call('POST', `/api/operators/${stranger.id}/reject`, {}, 'igor');
  await call('POST', `/api/operators/${olya.id}/approve`, {}, 'igor');
  assert.equal((await call('POST', '/api/auth/login', { email: 'stranger@x.com', password: 'longpass1' })).status, 401, 'rejected = removed');
  await login('olya', 'olya@team.ua', 'longpass1');
  // a pending person cannot get profiles
  await call('POST', `/api/auth/join/${tl.token}`, { name: 'Петро', email: 'petro@team.ua', password: 'longpass1' });
  const petro = (await call('GET', '/api/operators', undefined, 'igor')).data.operators.find((o) => o.email === 'petro@team.ua');
  assert.equal((await call('POST', '/api/profiles', { name: 'X', operator_id: petro.id }, 'igor')).status, 400);
  // the link leaked → a new one; the old stops working at once
  const tl2 = (await call('POST', '/api/operators/link/reset', {}, 'igor')).data.link;
  assert.notEqual(tl2.token, tl.token);
  assert.equal((await call('GET', `/api/auth/join/${tl.token}`)).status, 404);
  assert.equal((await call('GET', `/api/auth/join/${tl2.token}`)).status, 200);
  // the admin sees and controls everything: Petro waits in the admin's list too
  assert.ok((await call('GET', '/api/admin/registrations', undefined, 'adminR')).data.pending.some((u) => u.email === 'petro@team.ua'));
  await call('POST', `/api/admin/users/${petro.id}/reject`, {}, 'adminR');
  assert.ok(!(await call('GET', '/api/operators', undefined, 'igor')).data.operators.some((o) => o.email === 'petro@team.ua'));
});

test('control panel: caps of the admin win, remote stop, blocking, overview and the team card', async () => {
  await login('adminC', 'root@test', 'rootpass123');
  const a = (await call('POST', '/api/admin/agencies', { name: 'Violet', ownerName: 'I', ownerEmail: 'owner@violet', ownerPassword: 'ownerpass1', licenses: 3, days: 30 }, 'adminC')).data;
  await login('violet', 'owner@violet', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'violet')).data.sites[0];
  await call('POST', '/api/operators', { name: 'Op A', email: 'opa@violet', password: 'opapass1' }, 'violet');
  // caps
  assert.equal((await call('PUT', `/api/admin/agencies/${a.id}/control`, { caps: { dailyMax: 50, minDelayFloor: 60, maxOperators: 1, maxProfiles: 2 }, ai: { model: 'claude-haiku-5-5', variants: 2 } }, 'adminC')).status, 200);
  assert.equal((await call('POST', '/api/operators', { name: 'Op B', email: 'opb@violet', password: 'opbpass1' }, 'violet')).status, 400, 'max operators');
  const p1 = (await call('POST', '/api/profiles', { name: 'P1', site_id: site.id, license_id: 'auto', daily_limit: 300, min_delay: 10, max_delay: 20 }, 'violet')).data;
  await call('POST', '/api/profiles', { name: 'P2', site_id: site.id }, 'violet');
  assert.equal((await call('POST', '/api/profiles', { name: 'P3', site_id: site.id }, 'violet')).status, 400, 'max profiles');
  await login('violetBot', 'owner@violet', 'ownerpass1', 'bot');
  const cfg = (await call('GET', `/api/bot/profiles/${p1.id}/config`, undefined, 'violetBot')).data;
  assert.equal(cfg.limits.dailyLimit, 50);
  assert.ok(cfg.limits.minDelay >= 60 && cfg.limits.maxDelay >= 60);
  // the team cannot lift the caps or switch the model
  await call('PUT', '/api/settings', { settings: { caps: { dailyMax: 0 }, ai: { model: 'claude-opus-5-5' } } }, 'violet');
  assert.equal(getSettings(db, a.id).caps.dailyMax, 50);
  assert.equal(getSettings(db, a.id).ai.model, 'claude-haiku-5-5');
  // remote stop: a bot started before the stop stops; a new start works again
  const startedAt = Date.now() - 60000;
  assert.equal((await call('POST', `/api/bot/profiles/${p1.id}/heartbeat`, { state: 'running', startedAt, now: Date.now() }, 'violetBot')).data.stop, false);
  await call('POST', `/api/admin/agencies/${a.id}/stop-bots`, {}, 'adminC');
  assert.equal((await call('POST', `/api/bot/profiles/${p1.id}/heartbeat`, { state: 'running', startedAt, now: Date.now() }, 'violetBot')).data.stop, true);
  assert.equal((await call('POST', `/api/bot/profiles/${p1.id}/heartbeat`, { state: 'running', startedAt: Date.now() + 1000, now: Date.now() }, 'violetBot')).data.stop, false);
  // the card and the overview
  const card = (await call('GET', `/api/admin/agencies/${a.id}/card`, undefined, 'adminC')).data;
  assert.equal(card.caps.maxProfiles, 2);
  assert.equal(card.ai.model, 'claude-haiku-5-5');
  assert.ok(card.people.some((u) => u.email === 'owner@violet' && u.devices >= 2));
  const ov = (await call('GET', '/api/admin/overview', undefined, 'adminC')).data;
  assert.ok(ov.totals.agencies >= 1 && ov.teams.some((t) => t.id === a.id));
  // blocking a person signs them out everywhere at once
  const owner = card.people.find((u) => u.role === 'owner');
  await call('POST', `/api/admin/users/${owner.id}/block`, {}, 'adminC');
  assert.equal((await call('GET', '/api/bot/profiles', undefined, 'violetBot')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@violet', password: 'ownerpass1' })).status, 403);
  await call('POST', `/api/admin/users/${owner.id}/unblock`, {}, 'adminC');
  const pw = (await call('POST', `/api/admin/users/${owner.id}/password`, {}, 'adminC')).data;
  await login('violet', 'owner@violet', pw.password);
  assert.equal((await call('GET', '/api/admin/overview', undefined, 'violet')).status, 403, 'a team lead never sees the admin panel');
});

test('prompts: each operator their own prompt and tricks, used for their profiles; AI use counted per person', async () => {
  await login('adminP', 'root@test', 'rootpass123');
  await call('POST', '/api/admin/agencies', { name: 'Peony', ownerName: 'P', ownerEmail: 'owner@peony', ownerPassword: 'ownerpass1', licenses: 2, days: 30 }, 'adminP');
  await login('peony', 'owner@peony', 'ownerpass1');
  const site = (await call('GET', '/api/sites', undefined, 'peony')).data.sites[0];
  const op = (await call('POST', '/api/operators', { name: 'Maryna', email: 'maryna@peony', password: 'marynapass' }, 'peony')).data;
  await login('maryna', 'maryna@peony', 'marynapass');
  const p = (await call('POST', '/api/profiles', { name: 'Sofia', interests: 'books', site_id: site.id }, 'maryna')).data;
  await call('PUT', '/api/settings', { settings: { ai: { apiKey: 'sk-ant-team-key-123456' } } }, 'peony');
  await call('PUT', '/api/prompts/team', { prompt: 'TEAM PROMPT for {her_name}: write an opener.' }, 'peony');
  assert.equal((await call('PUT', '/api/prompts/team', { prompt: 'x' }, 'maryna')).status, 403, 'only the team lead changes the team prompt');
  await call('PUT', '/api/prompts/mine', { prompt: 'MARYNA PROMPT for {her_name}: short and playful.', examples: [{ text: 'Hi {name}! Guess which book I am reading now? Hint: it has a dragon.' }, 'too short'] }, 'maryna');
  let seen = null;
  setAiClientFactory((key) => ({ beta: { messages: { create: async (req) => { seen = { ...req, key }; return { stop_reason: 'end_turn', model: req.model, usage: { input_tokens: 120, output_tokens: 40 }, content: [{ type: 'text', text: 'Hello {name}! I just finished a novel with a dragon in it. What are you reading lately?' }] }; } } } }));
  const gen = await call('POST', `/api/profiles/${p.id}/invites/generate`, {}, 'maryna');
  assert.equal(gen.status, 201, JSON.stringify(gen.data));
  assert.equal(seen.key, 'sk-ant-team-key-123456', 'the team key');
  assert.match(seen.system, /^MARYNA PROMPT for Sofia/, 'her operator’s own prompt');
  assert.match(seen.messages[0].content, /got replies[\s\S]*Guess which book/, 'her tricks as examples');
  assert.doesNotMatch(seen.messages[0].content, /too short/);
  // the team lead's own profile still uses the team prompt
  const own = (await call('POST', '/api/profiles', { name: 'Lera', site_id: site.id }, 'peony')).data;
  await call('POST', `/api/profiles/${own.id}/invites/generate`, {}, 'peony');
  assert.match(seen.system, /^TEAM PROMPT for Lera/);
  setAiClientFactory(null);
  // who used the key how much
  const usage = (await call('GET', '/api/settings', undefined, 'peony')).data.usage;
  assert.equal(usage.find((u) => u.user_id === op.id)?.calls, 1);
  // "what works": everyone of the team, mine marked
  const pr = (await call('GET', '/api/prompts', undefined, 'maryna')).data;
  assert.equal(pr.mine.examples.length, 1);
  assert.ok(pr.people.some((x) => x.me && x.promptSource === 'own'));
  assert.ok(pr.people.some((x) => x.role === 'owner' && x.promptSource === 'team'));
});

test('code stripping keeps strings, templates and regexes intact', () => {
  const src = [
    '/** doc */',
    'const a = "// not a comment"; // a comment',
    "const b = 'it''s'.length; /* inline */ const c = `x ${a + `y // ${1}`} /* kept */`;",
    'const re = /\\/\\*[^/]*\\//g; const d = 4 / 2 / 1;',
    'function f() { return /ab+c/i.test("abbc"); }',
    '',
    '',
    '    const e = [1, 2].map((x) => x / 2);',
  ].join('\n');
  const out = stripJs(src);
  assert.doesNotMatch(out, /\/\*\* doc|; \/\/ a comment|inline/);
  assert.match(out, /"\/\/ not a comment"/);
  assert.match(out, /`x \$\{a \+ `y \/\/ \$\{1\}`\} \/\* kept \*\/`/);
  assert.match(out, /\/\\\/\\\*\[\^\/\]\*\\\/\/g/);
  assert.doesNotMatch(out, /\n\n/);
  assert.doesNotThrow(() => new vm.Script(out.replace("'it''s'", "'its'")));
});
