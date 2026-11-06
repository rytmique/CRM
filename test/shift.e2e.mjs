// The night shift end to end, in a real Chromium with the real bot (the copy downloaded from the panel):
// ▶ from the panel → the bot starts by itself → «Шанс»: letters with her photo to online men only → «Аллчат»: a message
// on the topic only into quiet dialogs (never where he waits for an answer) → mini reports in Telegram → ⏹ from the panel.
// Usage: node test/shift.e2e.mjs   (screenshots in $E2E_OUT or ./e2e-out/shift)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb, platformSet } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setTelegramApi } from '../server/telegram.js';
import { shiftSiteConfig } from '../server/sites.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'e2e-out', 'shift');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const fail = (m) => { throw new Error(m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-e2e-'));

function unzip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    out[buf.slice(i + 30, i + 30 + nameLen).toString()] = buf.slice(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

// ---- a fake Telegram Bot API: what the platform sends ----
const tgSent = [];
const tg = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    if (method === 'sendMessage') tgSent.push(JSON.parse(body || '{}'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : method === 'getMe' ? { username: 'ShiftBot' } : { message_id: 1 } }));
  });
});
await new Promise((r) => tg.listen(0, r));
setTelegramApi(`http://127.0.0.1:${tg.address().port}`);

// ---- the panel, in this process (so the test can look into its database) ----
delete process.env.ANTHROPIC_API_KEY;
const db = openDb(path.join(tmp, 'db.sqlite'));
ensureAdmin(db, { email: 'root@shift', password: 'rootpass123' });
const httpServer = http.createServer();
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const PORT = httpServer.address().port;
const BASE = `http://localhost:${PORT}`;
httpServer.on('request', createApp({ db, publicUrl: BASE, demoSite: true, mediaDir: path.join(tmp, 'media'), log: { error: console.error } }));

async function api(method, url, body, token) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${method} ${url}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const loginApi = async (email, password) => (await api('POST', '/api/auth/login', { email, password })).token;

let context;
const consoleErrors = [];
try {
  // ---------- data: a team, the night-shift site, Kate and her photo for «Шанс» ----------
  const admin = await loginApi('root@shift', 'rootpass123');
  await api('POST', '/api/admin/agencies', { name: 'Shift team', ownerName: 'Lead', ownerEmail: 'lead@shift', ownerPassword: 'leadpass1', licenses: 3, days: 30 }, admin);
  const owner = await loginApi('lead@shift', 'leadpass1');
  await api('PUT', '/api/settings', { settings: { timezone: 'UTC', modes: { chance: { on: true, everyMin: 30, onlineOnly: true }, allchat: { on: true, perNight: 2, who: 'silent', silentHours: 2, gapHours: 3 } } } }, owner);
  const site = await api('POST', '/api/sites', { name: 'Демо: нічна зміна', config: shiftSiteConfig(BASE) }, owner);
  const siteId = site.site?.id ?? site.id;
  await api('PUT', `/api/sites/${siteId}/scenario`, { scenario: {
    steps: [{ wait: 0, actions: [{ do: 'message', text: 'invite' }] }],
    human: { hoursFrom: 0, hoursTo: 24, windows: [[0, 24]], perHour: 300, breakEvery: 0, typing: false, spread: false, gapFrom: 1, gapTo: 2,
      thinkFrom: 0, thinkTo: 1, actionGapFrom: 0, actionGapTo: 1, pageGapFrom: 0, pageGapTo: 1, reactFrom: 0, reactTo: 1, idleChance: 0 },
  } }, owner);
  const op = await api('POST', '/api/operators', { name: 'Ira', email: 'ira@shift', password: 'irapass1' }, owner);
  const kate = (await api('POST', '/api/profiles', { name: 'Kate', age: 29, operator_id: op.id, site_id: siteId, daily_limit: 40, min_delay: 5, max_delay: 6 }, owner));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff0a2db4000000000049454e44ae426082', 'hex');
  const up = await fetch(`${BASE}/api/profiles/${kate.id}/media?steps=300`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'kate-chance.png', authorization: `Bearer ${owner}` }, body: png });
  if (up.status !== 201) fail(`photo upload: ${up.status} ${await up.text()}`);
  // the dialogs of the demo desk have been quiet for hours (as seen by the bot before) — «Аллчат» may write there
  for (const id of ['8000001', '8000002', '8000003', '8000004', '8000005', '8000006']) db.prepare("INSERT INTO dialogs (profile_id, man_id, fp, fp_at) VALUES (?,?,'',?)").run(kate.id, id, Date.now() - 10 * 3600000);
  // Ira linked her Telegram to the platform bot
  platformSet(db, 'tgToken', 'SHIFT:TOKEN');
  db.prepare("UPDATE users SET tg_chat_id = '424242' WHERE id = ?").run(op.id);
  log('data ready');

  // ---------- the bot as people get it (downloaded from the panel) ----------
  const zipRes = await fetch(`${BASE}/api/extension/download`, { headers: { authorization: `Bearer ${owner}` } });
  if (!zipRes.ok) fail(`extension download: ${zipRes.status}`);
  const extDir = path.join(tmp, 'ext');
  for (const [name, data] of Object.entries(unzip(Buffer.from(await zipRes.arrayBuffer())))) {
    fs.mkdirSync(path.dirname(path.join(extDir, name)), { recursive: true });
    fs.writeFileSync(path.join(extDir, name), data);
  }
  const botDir = path.join(extDir, 'agency-bot');
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1360, height: 900 },
    args: [`--disable-extensions-except=${botDir}`, `--load-extension=${botDir}`],
  });
  context.on('weberror', (e) => consoleErrors.push(`pageerror: ${e.error().message}`));
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#login-form');
  await popup.fill('#server', BASE);
  await popup.fill('#email', 'ira@shift');
  await popup.fill('#password', 'irapass1');
  await popup.click('#login-form button[type=submit]');
  await popup.waitForSelector('#profile option[value]', { state: 'attached' });
  await popup.evaluate(() => chrome.storage.local.set({ speed: 5 }));
  log('bot logged in');

  // ---------- ▶ from the panel: the bot starts by itself within a minute ----------
  const started = await api('POST', '/api/bots/start', {}, owner);
  if (started.started.length !== 1) fail(`start: ${JSON.stringify(started)}`);
  const readState = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  let st;
  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    st = await readState();
    if (st?.status && st.status !== 'stopped' && st.profileId === kate.id && st.startedAt >= t0 - 5000) break;
    await sleep(1000);
  }
  if (!st || st.profileId !== kate.id) fail(`the bot did not start from the panel in time: ${JSON.stringify(st)?.slice(0, 300)}`);
  log(`started from the panel in ${Math.round((Date.now() - t0) / 1000)} s`);

  // ---------- both passes run: «Шанс» then «Аллчат» ----------
  const passes = () => db.prepare('SELECT * FROM passes WHERE profile_id = ? ORDER BY id').all(kate.id);
  const t1 = Date.now();
  while (Date.now() - t1 < 360000 && passes().length < 2) {
    st = await readState();
    if (st?.status === 'error') fail(`bot error: ${st.message}\n${st.log.map((l) => l.text).join('\n')}`);
    await sleep(2000);
  }
  st = await readState();
  const botLog = st.log.map((l) => l.text).join('\n');
  const ps = passes();
  if (ps.length < 2) fail(`passes: ${JSON.stringify(ps)}\n${botLog}`);
  const site1 = context.pages().find((p) => p.url().includes('/demo-site/shift.html'));
  if (!site1) fail('the site tab is not open');
  await site1.screenshot({ path: path.join(OUT, 'shift-desk.png') });
  const dialogs = await site1.evaluate(() => JSON.parse(localStorage.getItem('shift_dialogs') || '{}'));

  // «Шанс»: 8 of 12 men are online — each got a letter with the photo and a subject; the 4 offline got nothing
  const chance = ps.find((p) => p.mode === 'chance');
  const online = ['7000001', '7000002', '7000004', '7000005', '7000007', '7000008', '7000010', '7000011'];
  const offline = ['7000003', '7000006', '7000009', '7000012'];
  for (const id of online) {
    const letter = dialogs[id]?.msgs?.find((m) => m.mine && m.letter);
    if (!letter) fail(`no letter to the online man ${id}\n${botLog}`);
    if (!letter.files?.includes('kate-chance.png')) fail(`the letter to ${id} has no photo: ${JSON.stringify(letter)}`);
    if (!letter.subject) fail(`the letter to ${id} has no subject`);
    if (!/Hello [A-Z][a-z]+!/.test(letter.text)) fail(`the letter does not greet him by name: ${letter.text.slice(0, 80)}`);
  }
  for (const id of offline) if (dialogs[id]?.msgs?.some((m) => m.mine)) fail(`wrote to the offline man ${id}`);
  if (chance.sent !== 8) fail(`«Шанс» pass: ${JSON.stringify(chance)}`);
  log('«Шанс»: 8 letters with the photo to online men, none to the 4 offline');

  // «Аллчат»: quiet dialogs where her message is last got one more — on the topic; the unread one and his-last one — nothing
  const allchat = ps.find((p) => p.mode === 'allchat');
  const before = { '8000001': 2, '8000002': 1, '8000003': 2, '8000004': 3, '8000005': 2, '8000006': 3 };
  const wrote = Object.keys(before).filter((id) => dialogs[id]?.msgs?.slice(before[id]).some((m) => m.mine && !m.letter));
  if (wrote.sort().join() !== '8000001,8000002,8000005,8000006') fail(`«Аллчат» wrote to ${wrote.join(', ')}\n${botLog}`);
  if (dialogs['8000003'].msgs.length !== 2 || dialogs['8000004'].msgs.length !== 3) fail('wrote into a dialog where he waits for an answer');
  if (!dialogs['8000003'].unread) fail('the unread dialog was opened (the reply must stay «new» for the operator)');
  const info = JSON.parse(allchat.info || '{}');
  // (men who just answered Kate's letter wait for an answer too)
  if (allchat.sent !== 4 || !(info.waits >= 2)) fail(`«Аллчат» pass: ${JSON.stringify(allchat)}`);
  log('«Аллчат»: 4 quiet dialogs got a message, the 2 waiting for an answer were not touched (the unread one not even opened)');

  // mini reports in Ira's Telegram, one per pass
  for (let i = 0; i < 20 && tgSent.filter((m) => m.chat_id === '424242').length < 2; i++) await sleep(250);
  const reports = tgSent.filter((m) => m.chat_id === '424242').map((m) => m.text);
  if (!reports.some((t) => /Шанс/.test(t) && /Листів з фото: <b>8<\/b>/.test(t))) fail(`no «Шанс» report in Telegram: ${JSON.stringify(reports)}`);
  if (!reports.some((t) => /Аллчат/.test(t) && /<b>4<\/b>/.test(t) && /чекають відповіді людини \d/.test(t))) fail(`no «Аллчат» report: ${JSON.stringify(reports)}`);
  log('Telegram: a mini report after each pass');

  // the server knows what was sent and by which mode
  const byMode = db.prepare("SELECT mode, COUNT(*) AS n FROM messages WHERE profile_id = ? AND status = 'sent' GROUP BY mode").all(kate.id);
  if (byMode.find((x) => x.mode === 'chance')?.n !== 8) fail(`messages by mode: ${JSON.stringify(byMode)}`);
  if (db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE profile_id = ? AND ok = 1').get(kate.id).n !== 4) fail('allchat log');

  // replies come in (the demo answers a few seconds later); the inbox check counts them
  await sleep(8000);
  await popup.bringToFront();
  await popup.click('#inbox').catch(() => {});
  await sleep(5000);
  const stats = await api('GET', '/api/stats/shift?nights=2', null, owner);
  const night = stats.nights.find((x) => x.chance.sent);
  log(`stats: ${JSON.stringify(night)}`);
  if (!night || night.chance.sent !== 8 || night.allchat.sent !== 4) fail(`stats: ${JSON.stringify(stats.nights)}`);
  if (night.chance.replies < 1) fail(`no replies to the letters counted: ${JSON.stringify(night)}`);
  if (night.allchat.replies < 1) fail(`no replies to «Аллчат» counted (dialog list without IDs → by name): ${JSON.stringify(night)}`);
  await popup.screenshot({ path: path.join(OUT, 'shift-popup.png') });

  // ---------- ⏹ from the panel: the bot stops at its next heartbeat ----------
  await api('POST', '/api/bots/stop', {}, owner);
  const t2 = Date.now();
  while (Date.now() - t2 < 60000) { st = await readState(); if (['stopped', 'error'].includes(st?.status)) break; await sleep(1000); }
  if (st.status !== 'stopped') fail(`stop from the panel: ${st.status}`);
  log('stopped from the panel');
  if (consoleErrors.length) fail(`errors on pages: ${consoleErrors.join(' | ')}`);
  console.log(`\nSHIFT E2E OK — screenshots in ${OUT}`);
} finally {
  await context?.close().catch(() => {});
  httpServer.close();
  tg.close();
}
process.exit(0);
