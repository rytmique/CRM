// The night shift end to end, in a real Chromium with the real bot (the copy downloaded from the panel):
// the bot window has only login, «🧪 Тестовий режим» and ▶ / ⏹. The bot reads the women on the site by itself (Kate, Olivia →
// her profiles in the panel), the test walks the way for both and sends nothing; ▶ → for both women: «Шанс» letters (with the photo
// set in the panel) to online men only, «Аллчат» only into quiet dialogs (never where he waits for an answer), the site switched
// to each in turn → mini reports in Telegram → ⏹ from the panel.
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
  // ---------- data: a team, the night-shift site (two women on it), Ira. No profiles: the bot finds them ----------
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
  const ira = await loginApi('ira@shift', 'irapass1');
  // Ira: «Шанс» every 20 minutes (her own setting)
  await api('PUT', '/api/me/prefs', { chanceEveryMin: 20, allchatPerNight: 2 }, ira);
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
  // the operator opened the site (as Kate)
  const desk = await context.newPage();
  await desk.goto(`${BASE}/demo-site/shift.html`);
  await desk.waitForSelector('.her-now');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#login-form');
  await popup.screenshot({ path: path.join(OUT, 'popup-login.png') });
  await popup.fill('#server', BASE);
  await popup.fill('#email', 'ira@shift');
  await popup.fill('#password', 'irapass1');
  await popup.click('#login-form button[type=submit]');
  await popup.waitForSelector('#main-view:not([hidden])');
  await popup.evaluate(() => chrome.storage.local.set({ speed: 5 }));
  // nothing but on / off and the test mode
  for (const gone of ['#profile', '#rotate', '#autopilot', '#teach', '#probe', '#report', '#speed', '#inbox']) if (await popup.$(gone)) fail(`the bot window still has ${gone}`);
  await popup.screenshot({ path: path.join(OUT, 'popup-main.png') });
  log('bot logged in: only ▶ / 🧪');
  const readState = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  const tabOfDesk = async () => popup.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.includes(u))?.id, '/demo-site/shift.html');
  // the bot is started with the site tab active (as when the person clicks the bot icon over the site)
  const press = async (test) => {
    await popup.evaluate(async ({ test, tab }) => new Promise((res) => chrome.runtime.sendMessage({ type: 'start', tabId: tab, test }, res)), { test, tab: await tabOfDesk() });
  };
  const deskState = () => desk.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('shift_')).map((k) => [k, localStorage.getItem(k)])));

  // ---------- 🧪 the test: both women, nothing sent ----------
  const beforeTest = await deskState();
  await popup.check('#test-mode');
  if ((await popup.textContent('#start')).trim() !== '🧪 Запустити тест') fail('the button does not say «test»');
  await press(true);
  let st;
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < 240000) { st = await readState(); if (st?.test && ['stopped', 'error'].includes(st.status)) break; await sleep(1000); }
  const testLog = (st?.log || []).map((l) => l.text).reverse().join('\n');
  if (st?.status !== 'stopped') fail(`the test did not pass: ${st?.status}\n${testLog}`);
  await popup.screenshot({ path: path.join(OUT, 'popup-test.png') });
  const profs = db.prepare('SELECT * FROM profiles WHERE operator_id = ? ORDER BY id').all(op.id);
  if (profs.map((p) => `${p.name}:${p.site_profile_id}`).join() !== 'Kate:5000000001,Olivia:5000000002') fail(`profiles from the site: ${JSON.stringify(profs.map((p) => [p.name, p.site_profile_id, p.age]))}\n${testLog}`);
  if (profs.some((p) => !p.age)) fail('the age of the women was not read');
  if (!/🧪 Kate: тест пройдено/.test(testLog) || !/🧪 Olivia: тест пройдено/.test(testLog)) fail(`the test did not walk both women:\n${testLog}`);
  if (!/НІЧОГО не надіслано/.test(testLog)) fail(`the test did not walk a letter:\n${testLog}`);
  if (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get().n || db.prepare('SELECT COUNT(*) AS n FROM allchat_log').get().n) fail('the test recorded messages');
  const afterTest = await deskState();
  for (const [k, v] of Object.entries(afterTest)) {
    if (!k.startsWith('shift_dialogs')) continue;
    const mine = (x) => Object.values(JSON.parse(x || '{}')).reduce((n, d) => n + d.msgs.filter((m) => m.mine).length, 0);
    if (mine(v) !== mine(beforeTest[k] || afterTest[k])) fail(`the test sent something on the site (${k})`);
  }
  const [kate, olivia] = profs;
  log('🧪 test: Kate and Olivia found on the site and made profiles, both walked, nothing sent');

  // the team lead sets Kate's photo for «Шанс» in the panel; the dialogs of both have been quiet for hours
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff0a2db4000000000049454e44ae426082', 'hex');
  const up = await fetch(`${BASE}/api/profiles/${kate.id}/media?steps=300`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'kate-chance.png', authorization: `Bearer ${ira}` }, body: png });
  if (up.status !== 201) fail(`photo upload: ${up.status} ${await up.text()}`);
  for (const [p, shift] of [[kate, 0], [olivia, 100]]) {
    for (let i = 1; i <= 6; i++) db.prepare("INSERT OR REPLACE INTO dialogs (profile_id, man_id, fp, fp_at) VALUES (?,?,'',?)").run(p.id, String(8000000 + shift + i), Date.now() - 10 * 3600000);
  }

  // ---------- ▶ on: both women, in turns ----------
  await popup.uncheck('#test-mode');
  await press(false);
  const passes = (pid) => db.prepare('SELECT * FROM passes WHERE profile_id = ? ORDER BY id').all(pid);
  const t1 = Date.now();
  while (Date.now() - t1 < 480000 && (passes(kate.id).length < 2 || passes(olivia.id).length < 2)) {
    st = await readState();
    if (st?.status === 'error') fail(`bot error: ${st.message}\n${st.log.map((l) => l.text).reverse().join('\n')}`);
    await sleep(2000);
  }
  st = await readState();
  const botLog = st.log.map((l) => l.text).reverse().join('\n');
  if (passes(kate.id).length < 2 || passes(olivia.id).length < 2) fail(`passes: ${JSON.stringify([passes(kate.id), passes(olivia.id)])}\n${botLog}`);
  await popup.screenshot({ path: path.join(OUT, 'popup-running.png') });
  await desk.bringToFront();
  await desk.screenshot({ path: path.join(OUT, 'shift-desk.png') });
  const store = await deskState();
  const dialogsOf = (her) => JSON.parse(store[`shift_dialogs@${her}`] || '{}');

  for (const [p, shift, photo] of [[kate, 0, 'kate-chance.png'], [olivia, 100, null]]) {
    const dialogs = dialogsOf(p.site_profile_id);
    const online = [1, 2, 4, 5, 7, 8, 10, 11].map((i) => String(7000000 + shift + i));
    const offline = [3, 6, 9, 12].map((i) => String(7000000 + shift + i));
    for (const id of online) {
      const letter = dialogs[id]?.msgs?.find((m) => m.mine && m.letter);
      if (!letter) fail(`${p.name}: no letter to the online man ${id}\n${botLog}`);
      if (photo && !letter.files?.includes(photo)) fail(`${p.name}: the letter to ${id} has no photo: ${JSON.stringify(letter)}`);
      if (!photo && letter.files?.length) fail(`${p.name}: a photo that is not hers: ${JSON.stringify(letter)}`);
      if (!letter.subject) fail(`the letter to ${id} has no subject`);
      if (!/Hello [A-Z][a-z]+!/.test(letter.text)) fail(`the letter does not greet him by name: ${letter.text.slice(0, 80)}`);
    }
    for (const id of offline) if (dialogs[id]?.msgs?.some((m) => m.mine)) fail(`${p.name}: wrote to the offline man ${id}`);
    const before = { 1: 2, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 };
    const wrote = Object.keys(before).filter((i) => dialogs[String(8000000 + shift + Number(i))]?.msgs?.slice(before[i]).some((m) => m.mine && !m.letter));
    if (wrote.sort().join() !== '1,2,5,6') fail(`${p.name}: «Аллчат» wrote to ${wrote.join(', ')}\n${botLog}`);
    const waiting = dialogs[String(8000003 + shift)];
    if (waiting.msgs.length !== 2 || !waiting.unread) fail(`${p.name}: touched a dialog where he waits for an answer`);
    if (dialogs[String(8000004 + shift)].msgs.length !== 3) fail(`${p.name}: wrote where he waits for an answer`);
    const ch = passes(p.id).find((x) => x.mode === 'chance');
    if (ch.sent !== 8) fail(`${p.name}: «Шанс» pass ${JSON.stringify(ch)}`);
    if (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND status = 'sent' AND mode = 'chance'").get(p.id).n !== 8) fail(`${p.name}: messages`);
    if (db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE profile_id = ? AND ok = 1').get(p.id).n !== 4) fail(`${p.name}: allchat log`);
  }
  if (!/На сайті анкета Olivia/.test(botLog)) fail(`the site was not switched to Olivia:\n${botLog}`);
  log('both women: 8 «Шанс» letters each (Kate\'s with her photo) to online men only; «Аллчат» into 4 quiet dialogs each; waiting ones untouched');

  // her «Шанс» interval (20 min) holds across the turns: the next pass of each is ~20 min after her first
  const next = /Далі: (Kate|Olivia) о (\d\d:\d\d)/.exec(st.message || '');
  log(`now: ${st.message}`);
  if (!next) fail(`no «next» in the state: ${st.message}`);

  // mini reports in Ira's Telegram, one per pass and woman
  for (let i = 0; i < 20 && tgSent.filter((m) => m.chat_id === '424242').length < 4; i++) await sleep(250);
  const reports = tgSent.filter((m) => m.chat_id === '424242').map((m) => m.text);
  for (const name of ['Kate', 'Olivia']) {
    if (!reports.some((t) => t.includes(name) && /Шанс/.test(t) && /Листів з фото: <b>8<\/b>/.test(t))) fail(`no «Шанс» report for ${name}: ${JSON.stringify(reports)}`);
    if (!reports.some((t) => t.includes(name) && /Аллчат/.test(t) && /<b>4<\/b>/.test(t))) fail(`no «Аллчат» report for ${name}: ${JSON.stringify(reports)}`);
  }
  log('Telegram: a mini report after each pass of each woman');

  // the panel: both women working (one writes, the other waits for her turn)
  const bots = (await api('GET', '/api/bots', null, ira)).bots;
  if (bots.length !== 2 || bots.some((b) => b.state === 'off')) fail(`bots in the panel: ${JSON.stringify(bots)}`);
  await sleep(6000); // replies come in a few seconds later
  const stats = await api('GET', '/api/stats/shift?nights=2', null, owner);
  const night = stats.nights.find((x) => x.chance.sent);
  log(`stats: ${JSON.stringify(night)}`);
  if (!night || night.chance.sent !== 16 || night.allchat.sent !== 8) fail(`stats: ${JSON.stringify(stats.nights)}`);
  const ira2 = stats.people.find((x) => x.name === 'Ira');
  if (ira2?.sent !== 24) fail(`the team by person: ${JSON.stringify(stats.people)}`);

  // ---------- ⏹ from the panel: the bot stops at its next heartbeat ----------
  await api('POST', '/api/bots/stop', {}, owner);
  const t2 = Date.now();
  while (Date.now() - t2 < 90000) { st = await readState(); if (['stopped', 'error'].includes(st?.status)) break; await sleep(1000); }
  if (st.status !== 'stopped') fail(`stop from the panel: ${st.status}`);
  log('stopped from the panel');
  await popup.bringToFront();
  await popup.screenshot({ path: path.join(OUT, 'popup-stopped.png') });
  if (consoleErrors.length) fail(`errors on pages: ${consoleErrors.join(' | ')}`);
  console.log(`\nSHIFT E2E OK — screenshots in ${OUT}`);
} finally {
  await context?.close().catch(() => {});
  httpServer.close();
  tg.close();
}
process.exit(0);
