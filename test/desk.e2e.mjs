// The real site's desk (a mock built from the operator's scanner report: demo-site/desk2) with the ready site profile, end to end:
// the admin puts the profile on the team (address only) → the bot finds the women in the rows of «All chats» → the test walks
// both and sends nothing (the invisible reCAPTCHA badge is not a captcha) → ▶ → «Шанс»: a letter with photos from her gallery
// to online men only; «Аллчат»: only quiet dialogs, never where he waits; the right box of the translator is sent → ⏹ from the panel.
// Usage: node test/desk.e2e.mjs   (screenshots in $E2E_OUT or ./e2e-out/desk)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb, platformSet } from '../server/db.js';
import { createApp, ensureAdmin } from '../server/app.js';
import { setTelegramApi } from '../server/telegram.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'e2e-out', 'desk');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const fail = (m) => { throw new Error(m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-'));

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

const tgSent = [];
const tg = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    if (method === 'sendMessage') tgSent.push(JSON.parse(body || '{}'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : method === 'getMe' ? { username: 'DeskBot' } : { message_id: 1 } }));
  });
});
await new Promise((r) => tg.listen(0, r));
setTelegramApi(`http://127.0.0.1:${tg.address().port}`);

delete process.env.ANTHROPIC_API_KEY;
const db = openDb(path.join(tmp, 'db.sqlite'));
ensureAdmin(db, { email: 'root@desk', password: 'rootpass123' });
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
  // ---------- the team, the ready site profile (the admin gives only the address), Ira ----------
  const admin = await loginApi('root@desk', 'rootpass123');
  const ag = await api('POST', '/api/admin/agencies', { name: 'Desk team', ownerName: 'Lead', ownerEmail: 'lead@desk', ownerPassword: 'leadpass1', licenses: 3, days: 30 }, admin);
  const agencyId = ag.agency?.id ?? ag.id;
  const put = await api('PUT', `/api/admin/agencies/${agencyId}/site`, { url: `${BASE}/demo-site/desk2/chat`, preset: 'desk' }, admin);
  const siteId = put.site.id;
  const owner = await loginApi('lead@desk', 'leadpass1');
  await api('PUT', '/api/settings', { settings: { timezone: 'UTC', modes: { chance: { on: true, everyMin: 30, onlineOnly: true }, allchat: { on: true, perNight: 2, who: 'silent', silentHours: 2, gapHours: 3 } } } }, owner);
  await api('PUT', `/api/sites/${siteId}/scenario`, { scenario: {
    steps: [{ wait: 0, actions: [{ do: 'message', text: 'invite' }] }],
    human: { hoursFrom: 0, hoursTo: 24, windows: [[0, 24]], perHour: 300, breakEvery: 0, typing: false, spread: false, gapFrom: 1, gapTo: 2,
      thinkFrom: 0, thinkTo: 1, actionGapFrom: 0, actionGapTo: 1, pageGapFrom: 0, pageGapTo: 1, reactFrom: 0, reactTo: 1, idleChance: 0 },
  } }, owner);
  const op = await api('POST', '/api/operators', { name: 'Ira', email: 'ira@desk', password: 'irapass1' }, owner);
  platformSet(db, 'tgToken', 'DESK:TOKEN');
  db.prepare("UPDATE users SET tg_chat_id = '535353' WHERE id = ?").run(op.id);
  log(`ready profile on the team: ${put.site.base_url}`);

  // ---------- the bot, the desk opened by the operator ----------
  const zipRes = await fetch(`${BASE}/api/extension/download`, { headers: { authorization: `Bearer ${owner}` } });
  if (!zipRes.ok) fail(`extension download: ${zipRes.status}`);
  const extDir = path.join(tmp, 'ext');
  for (const [name, data] of Object.entries(unzip(Buffer.from(await zipRes.arrayBuffer())))) {
    fs.mkdirSync(path.dirname(path.join(extDir, name)), { recursive: true });
    fs.writeFileSync(path.join(extDir, name), data);
  }
  const botDir = path.join(extDir, 'agency-bot');
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${botDir}`, `--load-extension=${botDir}`],
  });
  context.on('weberror', (e) => consoleErrors.push(`pageerror: ${e.error().message}`));
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const desk = await context.newPage();
  await desk.goto(`${BASE}/demo-site/desk2/chance`);
  await desk.waitForSelector('[data-testid="chat-list"]');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#login-form');
  await popup.fill('#server', BASE);
  await popup.fill('#email', 'ira@desk');
  await popup.fill('#password', 'irapass1');
  await popup.click('#login-form button[type=submit]');
  await popup.waitForSelector('#main-view:not([hidden])');
  await popup.evaluate(() => chrome.storage.local.set({ speed: 5 }));
  const readState = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  const deskTab = async () => popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('/demo-site/desk2'))?.id);
  const press = async (test) => popup.evaluate(async ({ test, tab }) => new Promise((res) => chrome.runtime.sendMessage({ type: 'start', tabId: tab, test }, res)), { test, tab: await deskTab() });
  const chats = () => desk.evaluate(() => JSON.parse(localStorage.getItem('desk2_chats') || '{}'));
  const mineCount = (c) => Object.values(c).reduce((n, x) => n + x.msgs.filter((m) => m.mine).length, 0);

  // ---------- 🧪 the test: both women, nothing sent, no false «captcha» ----------
  const before = mineCount(await chats());
  await popup.check('#test-mode');
  await press(true);
  let st;
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < 300000) { st = await readState(); if (st?.test && ['stopped', 'error'].includes(st.status)) break; await sleep(1000); }
  const testLog = (st?.log || []).map((l) => l.text).reverse().join('\n');
  if (st?.status !== 'stopped') fail(`the test did not pass: ${st?.status}\n${testLog}`);
  if (/капч/i.test(testLog)) fail(`a false captcha (the invisible badge):\n${testLog}`);
  const profs = db.prepare('SELECT * FROM profiles WHERE operator_id = ? ORDER BY id').all(op.id);
  if (profs.map((p) => `${p.name}:${p.site_profile_id}:${p.age}`).sort().join() !== 'Kate:5000000001:29,Olivia:5000000002:31') fail(`women from the rows: ${JSON.stringify(profs.map((p) => [p.name, p.site_profile_id, p.age]))}\n${testLog}`);
  for (const n of ['Kate', 'Olivia']) if (!new RegExp(`🧪 ${n}: тест пройдено`).test(testLog)) fail(`the test of ${n} did not pass:\n${testLog}`);
  if (!/з її галереї/.test(testLog)) fail(`the test did not walk the photos of her gallery:\n${testLog}`);
  if (mineCount(await chats()) !== before) fail('the test sent something');
  if (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get().n) fail('the test recorded messages');
  await popup.screenshot({ path: path.join(OUT, 'popup-test.png') });
  log('🧪 test: Kate and Olivia found in the rows, both walked (letter + photos of her gallery), nothing sent, no false captcha');

  const [kate, olivia] = profs.sort((a, b) => a.site_profile_id.localeCompare(b.site_profile_id));
  for (const [p, k] of [[kate, 0], [olivia, 1]]) {
    for (let i = 1; i <= 6; i++) db.prepare("INSERT OR REPLACE INTO dialogs (profile_id, man_id, fp, fp_at) VALUES (?,?,'',?)").run(p.id, String(8000000 + k * 100 + i), Date.now() - 10 * 3600000);
  }

  // ---------- ▶ on ----------
  await popup.uncheck('#test-mode');
  await press(false);
  const passes = (pid) => db.prepare('SELECT * FROM passes WHERE profile_id = ? ORDER BY id').all(pid);
  const t1 = Date.now();
  while (Date.now() - t1 < 720000 && (passes(kate.id).length < 2 || passes(olivia.id).length < 2)) {
    st = await readState();
    if (st?.status === 'error') fail(`bot error: ${st.message}\n${st.log.map((l) => l.text).reverse().join('\n')}`);
    await sleep(2000);
  }
  st = await readState();
  const botLog = st.log.map((l) => l.text).reverse().join('\n');
  if (passes(kate.id).length < 2 || passes(olivia.id).length < 2) fail(`passes: ${JSON.stringify([passes(kate.id), passes(olivia.id)])}\n${botLog}`);
  if (/капч/i.test(botLog)) fail(`a false captcha:\n${botLog}`);
  await desk.bringToFront();
  await desk.screenshot({ path: path.join(OUT, 'desk.png') });
  const all = await chats();
  for (const [p, k] of [[kate, 0], [olivia, 1]]) {
    const chatOf = (id) => all[`c${p.site_profile_id.slice(-2)}${id}`];
    const starts = new Set();
    for (let i = 0; i < 12; i++) {
      const c = chatOf(String(7000001 + k * 100 + i));
      const letters = c.msgs.filter((m) => m.mine && m.letter);
      if (c.man.online) {
        if (letters.length !== 1) fail(`${p.name}: ${letters.length} letters to the online man ${c.man.name}\n${botLog}`);
        if (letters[0].files?.length !== 2) fail(`${p.name}: the letter to ${c.man.name} has photos ${JSON.stringify(letters[0].files)}`);
        if (/^(Hello|Hi|Hey|Dear)\b|^\s/.test(letters[0].text)) fail(`the letter does not start with a hook: ${letters[0].text.slice(0, 80)}`);
        starts.add(letters[0].text.slice(0, 5).toLowerCase());
        if (/^\[EN\]/.test(letters[0].text)) fail('the letter went through the translator: the left box was written');
      } else if (c.msgs.some((m) => m.mine)) fail(`${p.name}: wrote to the offline man ${c.man.name}`);
    }
    if (starts.size < 8) fail(`${p.name}: the hooks repeat: ${[...starts].join(' | ')}`);
    const seedLen = { 1: 2, 2: 1, 3: 2, 4: 3, 5: 2, 6: 3 };
    const wrote = Object.keys(seedLen).filter((n) => chatOf(String(8000000 + k * 100 + Number(n))).msgs.slice(seedLen[n]).some((m) => m.mine && !m.letter));
    if (wrote.sort().join() !== '1,2,5,6') fail(`${p.name}: «Аллчат» wrote to ${wrote.join(', ')}\n${botLog}`);
    for (const n of [3, 4]) if (chatOf(String(8000000 + k * 100 + n)).msgs.length !== seedLen[n]) fail(`${p.name}: wrote where he waits for an answer (${n})`);
    if (passes(p.id).find((x) => x.mode === 'chance').sent !== 8) fail(`${p.name}: «Шанс» ${JSON.stringify(passes(p.id))}`);
    if (db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE profile_id = ? AND ok = 1').get(p.id).n !== 4) fail(`${p.name}: allchat log`);
  }
  log('both women: 8 «Шанс» letters each with 2 photos of her gallery, online men only, the English box sent; «Аллчат» 4 quiet dialogs each; waiting ones untouched');

  for (let i = 0; i < 20 && tgSent.filter((m) => m.chat_id === '535353').length < 4; i++) await sleep(250);
  if (tgSent.filter((m) => m.chat_id === '535353').length < 4) fail(`Telegram reports: ${JSON.stringify(tgSent.map((m) => m.text))}`);
  log('Telegram: a report after each pass');
  await popup.bringToFront();
  await popup.screenshot({ path: path.join(OUT, 'popup-running.png') });

  // ---------- ⏹ from the panel ----------
  await api('POST', '/api/bots/stop', {}, owner);
  const t2 = Date.now();
  while (Date.now() - t2 < 90000) { st = await readState(); if (['stopped', 'error'].includes(st?.status)) break; await sleep(1000); }
  if (st.status !== 'stopped') fail(`stop from the panel: ${st.status}`);
  log('stopped from the panel');
  if (consoleErrors.length) fail(`errors on pages: ${consoleErrors.join(' | ')}`);
  console.log(`\nDESK E2E OK — screenshots in ${OUT}`);
} finally {
  await context?.close().catch(() => {});
  httpServer.close();
  tg.close();
}
process.exit(0);
