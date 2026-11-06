// End-to-end check in a real Chromium: panel pages + the extension doing a real run on the demo site.
// Usage: npm run e2e   (needs Playwright + Chromium installed; screenshots go to $E2E_OUT or ./e2e-out)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'e2e-out');
const PORT = 3300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-e2e-'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { throw new Error(msg); };
const log = (...a) => console.log('•', ...a);

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) fail(`${method} ${url} → ${res.status} ${data.error}`);
  return data;
}

/** Reads a STORE-only zip (what the server makes) into { name: Buffer }. */
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
const goHash = (pg, key) => pg.evaluate((k) => { location.hash = `#/${k}`; }, key);

// same hash as demo-site/demo.js, to know which demo men will "reply"
function hash(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: BASE, DATA_DIR: tmp, ADMIN_EMAIL: 'admin@e2e', ADMIN_PASSWORD: 'admin12345', ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

let context;
const consoleErrors = [];
try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(100); } }

  // ---------- data setup through the API ----------
  const admin = (await api('POST', '/api/auth/login', { email: 'admin@e2e', password: 'admin12345' })).token;
  await api('POST', '/api/admin/agencies', { name: 'Rose Agency', ownerName: 'Олена', ownerEmail: 'owner@e2e', ownerPassword: 'owner12345', planProfiles: 3, planDays: 30 }, admin);
  const owner = (await api('POST', '/api/auth/login', { email: 'owner@e2e', password: 'owner12345' })).token;
  const op = await api('POST', '/api/operators', { name: 'Ірина', email: 'ira@e2e', password: 'ira123' }, owner);
  const site = (await api('GET', '/api/sites', null, owner)).sites[0];
  const anna = await api('POST', '/api/profiles', {
    name: 'Anna', age: 32, city: 'Kyiv', country: 'Ukraine', interests: 'yoga, travel, cooking', looking_for: 'a kind and honest man',
    bio: 'Paediatric nurse, loves long walks by the Dnipro and baking on Sundays.', operator_id: op.id, site_id: site.id,
    daily_limit: 4, min_delay: 5, max_delay: 6,
  }, owner);
  const maria = await api('POST', '/api/profiles', { name: 'Maria', age: 27, interests: 'dancing, books', city: 'Lviv', country: 'Ukraine', site_id: site.id, operator_id: op.id }, owner);
  await api('POST', '/api/profiles', { name: 'Olha', age: 35, city: 'Odesa', country: 'Ukraine', site_id: site.id, status: 'paused' }, owner);
  await api('PUT', '/api/settings', { settings: { inboxCheckEvery: 2 } }, owner);
  const FAST = { hoursFrom: 0, hoursTo: 0, perHour: 0, breakEvery: 0, typing: false, spread: false, thinkFrom: 0, thinkTo: 1, actionGapFrom: 0, actionGapTo: 1, pageGapFrom: 0, pageGapTo: 1 };
  await api('PUT', `/api/sites/${site.id}/scenario`, { scenario: {
    steps: [{ actions: [{ do: 'click', action: 'like' }, { do: 'message', text: 'invite' }] }, { wait: 24, actions: [{ do: 'message', text: 'followup' }] }],
    human: FAST,
  } }, owner);
  log('data ready');

  // ---------- browser with the extension: the copy people really get (downloaded from the panel, marked, no comments) ----------
  const zipRes = await fetch(`${BASE}/api/extension/download`, { headers: { authorization: `Bearer ${owner}` } });
  if (!zipRes.ok) fail(`extension download: ${zipRes.status}`);
  const extDir = path.join(tmp, 'ext');
  for (const [name, data] of Object.entries(unzip(Buffer.from(await zipRes.arrayBuffer())))) {
    fs.mkdirSync(path.dirname(path.join(extDir, name)), { recursive: true });
    fs.writeFileSync(path.join(extDir, name), data);
  }
  const botDir = path.join(extDir, 'agency-bot');
  if (/\/\*\*/.test(fs.readFileSync(path.join(botDir, 'background.js'), 'utf8'))) fail('the downloaded bot still has comments');
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: [`--disable-extensions-except=${botDir}`, `--load-extension=${botDir}`],
  });
  context.on('weberror', (e) => consoleErrors.push(`pageerror: ${e.error().message}`));
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  log('extension loaded', extId);

  // ---------- panel ----------
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
  await page.goto(BASE);
  await page.fill('#l-email', 'owner@e2e');
  await page.fill('#l-pass', 'owner12345');
  await page.click('button[type=submit]');
  await page.waitForSelector('.tiles');

  // generate an invite via UI
  await page.click('a[href="#/profiles"]');
  await page.waitForSelector('table.table.hover');
  await page.click('text=Anna');
  await page.waitForSelector('.modal .detail');
  await page.click('text=✨ Ще варіант (ШІ)');
  await page.waitForFunction(() => document.querySelectorAll('.overlay').length === 1 && document.querySelector('.modal .variant textarea')?.value.length > 30);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '03-profile-detail.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(OUT, '02-profiles.png') });

  // profile form
  await page.click('text=+ Додати анкету');
  await page.waitForSelector('.modal form');
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, '04-profile-form.png') });
  await page.keyboard.press('Escape');

  for (const [hash, file] of [['team', '06-operators'], ['sites', '07-sites'], ['settings', '08-settings'], ['extension', '09-extension'], ['prompts', '09b-prompts']]) {
    await goHash(page, hash);
    await page.waitForSelector('.page-head h1');
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, `${file}.png`), fullPage: true });
  }
  log('panel pages ok');

  // ---------- extension run ----------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#login-form');
  await popup.fill('#server', `${BASE}/demo-site/desk.html`); // as people type it: a page of the panel, not the panel — must still log in
  await popup.fill('#email', 'ira@e2e');
  await popup.fill('#password', 'ira123');
  await popup.click('#login-form button[type=submit]');
  await popup.waitForSelector('#profile option[value]', { state: 'attached' });
  await popup.selectOption('#profile', String(anna.id));
  await popup.screenshot({ path: path.join(OUT, '10-popup-ready.png') });
  // ---------- test mode first: the whole flow on the site, but nothing is sent ----------
  await popup.check('#test-mode');
  await popup.click('#start');
  let ts;
  const tt = Date.now();
  do { await sleep(1000); ts = await popup.evaluate(async () => (await chrome.storage.local.get('state')).state); }
  while (!(ts?.test && ['stopped', 'error'].includes(ts.status)) && Date.now() - tt < 90000);
  await popup.bringToFront();
  await popup.screenshot({ path: path.join(OUT, '10b-popup-test-mode.png') });
  if (ts.status !== 'stopped' || !ts.log.some((l) => l.text.includes('Тест пройдено'))) fail(`test mode: ${ts.status}\n${ts.log.map((l) => l.text).join('\n')}`);
  if (ts.sent !== 3) fail(`test mode checked ${ts.sent} men, expected 3`);
  const testTab = context.pages().find((p) => p.url().includes('/demo-site/'));
  const sentInTest = await testTab.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('demo_sent') || '{}')).length);
  if (sentInTest) fail(`test mode actually sent ${sentInTest} messages`);
  const likedInTest = await testTab.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('demo_likes') || '{}')).length);
  if (likedInTest) fail(`test mode actually pressed Like ${likedInTest} times`);
  if (!ts.log.some((l) => l.text.includes('Сторінка чоловіка: поле'))) fail(`test mode did not check his page:\n${ts.log.map((l) => l.text).join('\n')}`);
  if ((await api('GET', '/api/stats/overview?days=1', null, owner)).today.sent) fail('test mode recorded sends on the server');
  await testTab.close();
  await popup.uncheck('#test-mode');
  log('test mode ok: 3 men checked end to end, nothing sent, nothing recorded');

  // Start from the popup page (its "active tab" is the extension page, so the bot opens the site search in a new tab).
  await popup.click('#start');
  log('bot started');

  const readState = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  let st;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    st = await readState();
    if (st && !st.test && st.startedAt >= t0 - 5000 && ['limit', 'watching', 'error', 'stopped'].includes(st.status)) break;
    await sleep(1000);
  }
  if (st.status === 'error') fail(`bot error: ${st.message}\n${st.log.map((l) => l.text).join('\n')}`);
  if (st.status !== 'limit') fail(`expected limit, got ${st.status}`);
  if (st.sent !== 4) fail(`expected 4 sent, got ${st.sent}`);
  log(`bot finished: sent ${st.sent}, status ${st.status}`);

  // The demo site makes ~40% of men reply 4–12 s after the invite; wait, then check the inbox from the popup.
  await sleep(13000);
  await popup.bringToFront();
  await popup.click('#inbox');
  await sleep(4000);
  st = await readState();
  await popup.screenshot({ path: path.join(OUT, '11-popup-after-run.png') });

  const men = Array.from({ length: 4 }, (_, i) => String(100000 + i * 37));
  const expectedReplies = men.filter((id) => hash('reply' + id) % 10 < 4).length;
  const stats = await api('GET', '/api/stats/overview?days=7', null, owner);
  if (stats.today.sent !== 4) fail(`panel shows ${stats.today.sent} sent`);
  if (stats.today.replies !== expectedReplies) fail(`panel shows ${stats.today.replies} replies, expected ${expectedReplies}`);
  log(`panel stats ok: sent ${stats.today.sent}, replies ${stats.today.replies} (expected ${expectedReplies})`);

  // dedupe: a second run must not write to the same men again
  const filter = await api('POST', `/api/bot/profiles/${anna.id}/filter`, { candidates: men.map((id) => ({ id })) }, owner);
  if (filter.allowed.length) fail('dedupe failed');

  // message text actually typed on the demo site
  const sitePage = context.pages().find((p) => p.url().includes('/demo-site/'));
  const sent = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_sent') || '{}'));
  if (Object.keys(sent).length !== 4) fail(`demo site received ${Object.keys(sent).length} messages`);
  if (Object.values(sent).some((m) => m.text.includes('{name}'))) fail('placeholder leaked into a sent message');
  log('demo site received 4 personalised messages, e.g.:', Object.values(sent)[0].text);
  const likes = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_likes') || '{}'));
  if (Object.keys(likes).length !== 4) fail(`scenario step 1 should like 4 men, liked ${Object.keys(likes).length}`);
  const anaMsgs = await api('GET', `/api/stats/messages?profile_id=${anna.id}&status=waiting`, null, owner);
  if (anaMsgs.total !== 4 - expectedReplies) fail(`expected ${4 - expectedReplies} men waiting for a follow-up, got ${anaMsgs.total}`);
  log('scenario step 1: liked + wrote 4 men; follow-ups scheduled for those who did not reply');

  // ---------- second run: a site where you write from the man's profile page ----------
  await popup.bringToFront();
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  const profileSite = await api('POST', '/api/sites', { name: 'Демо: писати з профілю', config: {
    searchUrl: `${BASE}/demo-site/search.html`, card: '.man-card', cardId: 'a.man-name@href', cardName: '.man-name', cardAge: '.man-age',
    openChat: 'a.man-name', messageInput: '#profile-chat textarea', sendButton: '#profile-chat .btn-send', sentConfirm: '#profile-chat .sent-ok',
  } }, owner);
  await api('PUT', `/api/sites/${profileSite.id}/scenario`, { scenario: { steps: [{ actions: [{ do: 'message', text: 'invite' }] }], human: FAST } }, owner);
  await api('PATCH', `/api/profiles/${maria.id}`, { site_id: profileSite.id, daily_limit: 2, min_delay: 5, max_delay: 6 }, owner);
  await popup.selectOption('#profile', String(maria.id));
  await popup.click('#start');
  const t1 = Date.now();
  const mariaDone = () => st?.profileId === maria.id && ['limit', 'watching', 'error', 'stopped'].includes(st.status);
  do { await sleep(1000); st = await readState(); } while (!mariaDone() && Date.now() - t1 < 90000);
  if (st.status === 'error') fail(`profile-page run error: ${st.message}\n${st.log.map((l) => l.text).join('\n')}`);
  if (st.sent !== 2) fail(`profile-page run sent ${st.sent}: ${st.log.map((l) => l.text).join(' | ')}`);
  const sentAfter = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_sent') || '{}'));
  if (!['100000', '100037'].every((id) => sentAfter[id]?.text.includes('Maria'))) fail('profile-page run did not write from Maria');
  const back = context.pages().find((p) => p !== sitePage && p.url().includes('/demo-site/search.html'));
  if (!back) fail('bot did not return to the search list after writing from a profile page');
  log('profile-page flow ok: 2 sent, bot returned to the list');

  // ---------- 🎯 teach a new site by clicking, then a run with follow-ups ----------
  await popup.bringToFront();
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  const taught = await api('POST', '/api/sites', { name: 'Навчений кліками' }, owner);
  const kate = await api('POST', '/api/profiles', { name: 'Kate', age: 29, interests: 'tennis, jazz', site_id: taught.id, operator_id: op.id, daily_limit: 4, min_delay: 5, max_delay: 6 }, owner);
  const tpage = await context.newPage();
  await tpage.goto(`${BASE}/demo-site/search.html?teach=1`);
  const teachTab = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes('teach=1')).id);
  const teachRes = await popup.evaluate(({ pid, tid }) => new Promise((r) => chrome.runtime.sendMessage({ type: 'teach', profileId: pid, tabId: tid }, r)), { pid: kate.id, tid: teachTab });
  if (!teachRes?.ok) fail(`teach failed: ${teachRes?.error}`);
  await tpage.bringToFront();
  const panel = tpage.locator('#__agency_teach');
  await panel.locator('.panel').waitFor();
  const row = (label) => panel.locator('.row').filter({ hasText: label });
  const pickBtn = (label) => row(label).getByRole('button', { name: '🎯 Вибрати' });
  await row('URL сторінки пошуку').getByRole('button', { name: '📍 Ця сторінка' }).click();
  await pickBtn('Картка чоловіка').click();
  await tpage.click('.man-card:nth-of-type(3) .avatar');
  await row('ID чоловіка').locator('.val').waitFor();
  await pickBtn('Наступна сторінка').click();
  await tpage.click('a.next-page'); // intercepted while picking: the page stays
  if (!tpage.url().includes('teach=1')) fail('picking "Next" navigated away');
  await panel.locator('button[title="Згорнути"]').click();
  await tpage.click('.man-card:nth-of-type(1) .btn-write'); // operator opens the chat as usual
  await panel.locator('button[title="Згорнути"]').click();
  await panel.getByRole('button', { name: /^Відправка/ }).click();
  await pickBtn('Поле вводу').click();
  await tpage.click('#chat-modal textarea');
  await pickBtn('Кнопка «Надіслати»').click();
  await tpage.click('#chat-modal .btn-send');
  await pickBtn('Прикріпити файл').click();
  await tpage.click('#chat-modal .btn-attach'); // intercepted: no file dialog
  await pickBtn('Закрити вікно').click();
  await tpage.click('#chat-modal .btn-close');
  if (!(await tpage.locator('#chat-modal').isVisible())) fail('picking "Close" must not close the chat');
  if (await tpage.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('demo_sent') || '{}')).length) !== Object.keys(sentAfter).length) fail('picking "Send" sent a message');
  await tpage.click('#chat-modal .btn-close');
  await panel.getByRole('button', { name: /^Кнопки/ }).click();
  await panel.locator('input.n').nth(0).fill('Лайк');
  await panel.getByRole('button', { name: '+ 🎯 Додати' }).nth(0).click();
  await tpage.click('.man-card:nth-of-type(2) .btn-like');
  await panel.locator('input.n').nth(1).fill('Онлайн');
  await panel.getByRole('button', { name: '+ 🎯 Додати' }).nth(1).click();
  await tpage.locator('.man-card .online').first().click();
  await panel.getByRole('button', { name: /^Список/ }).click();
  await sleep(300);
  await tpage.screenshot({ path: path.join(OUT, '16-teach-panel.png') });
  await panel.getByRole('button', { name: '💾 Зберегти' }).click();
  await panel.locator('.msg', { hasText: 'Збережено' }).waitFor();
  // the panel follows the operator to his profile page
  await tpage.goto(`${BASE}/demo-site/profile.html?id=100037`);
  await panel.locator('.panel').waitFor({ timeout: 10000 });
  await panel.getByRole('button', { name: /^Його сторінка/ }).click();
  await row('URL профілю чоловіка').getByRole('button', { name: '📍 Ця сторінка' }).click();
  await panel.getByRole('button', { name: '💾 Зберегти' }).click();
  await panel.locator('.msg', { hasText: 'Збережено' }).waitFor();
  await tpage.screenshot({ path: path.join(OUT, '17-teach-man-page.png') });
  await panel.locator('button[title="Закрити"]').click();
  const tcfg = (await api('GET', '/api/sites', null, owner)).sites.find((x) => x.id === taught.id).config;
  const want = { card: '.man-card', cardId: '@data-man-id', cardName: '.man-name', nextPage: '.next-page', openChat: '.btn-write', sendButton: '.btn-send', closeChat: '.btn-close' };
  for (const [k, v] of Object.entries(want)) if (tcfg[k] !== v) fail(`taught ${k} = ${tcfg[k]}, expected ${v}\n${JSON.stringify(tcfg, null, 1)}`);
  if (!tcfg.manUrl.endsWith('profile.html?id={id}')) fail(`taught manUrl ${tcfg.manUrl}`);
  if (tcfg.actions[0]?.sel !== '.btn-like' || tcfg.actions[0].where !== 'card' || tcfg.marks[0]?.sel !== '.online') fail(`taught lists ${JSON.stringify([tcfg.actions, tcfg.marks])}`);
  for (const k of ['messageInput', 'attachButton']) if (!tcfg[k] || !(await tpage.locator(tcfg[k]).count())) fail(`taught ${k} ${tcfg[k]} does not match his page`);
  await tpage.close();
  log('teach by clicking ok:', Object.keys(tcfg).filter((k) => tcfg[k] && (!Array.isArray(tcfg[k]) || tcfg[k].length)).join(', '));

  // Kate's photos: one for the invite, one for the follow-up
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db40000000049454e44ae426082', 'hex');
  for (const [name, steps] of [['kate-hello.png', '1'], ['kate-beach.png', '2']]) {
    const up = await fetch(`${BASE}/api/profiles/${kate.id}/media?steps=${steps}`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': name, authorization: `Bearer ${owner}` }, body: png });
    if (up.status !== 201) fail(`upload ${name}: ${up.status}`);
  }

  // Kate: only "online" men; like + invite with a photo, then a follow-up with another photo right away (wait 0)
  // on his own page, typed letter by letter
  await api('PUT', `/api/sites/${taught.id}/scenario`, { scenario: {
    steps: [
      { actions: [{ do: 'click', action: tcfg.actions[0].key }, { do: 'message', text: 'invite', files: 'all' }] },
      { wait: 0, actions: [{ do: 'message', text: 'followup', files: 'all' }] },
    ],
    filters: { needMarks: [tcfg.marks[0].key] },
    human: { ...FAST, typing: true },
  } }, owner);
  const before = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_sent') || '{}'));
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${kate.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(kate.id));
  await popup.click('#start');
  const t2 = Date.now();
  const kateDone = () => st?.profileId === kate.id && st.startedAt >= t2 - 5000 && ['limit', 'watching', 'error', 'stopped'].includes(st.status);
  do { await sleep(1000); st = await readState(); } while (!kateDone() && Date.now() - t2 < 300000);
  if (st.status !== 'limit') fail(`follow-up run: ${st.status} ${st.message}\n${st.log.map((l) => l.text).join('\n')}`);
  if (st.sent !== 4 || st.followups !== 2) fail(`follow-up run sent ${st.sent}, follow-ups ${st.followups}\n${st.log.map((l) => l.text).join('\n')}`);
  const afterKate = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_sent') || '{}'));
  const touched = Object.keys(afterKate).filter((id) => (afterKate[id].count || 1) - (before[id]?.count || (before[id] ? 1 : 0)) > 0);
  if (touched.length !== 2) fail(`Kate wrote to ${touched.length} men: ${touched}`);
  for (const id of touched) {
    if (hash('online' + id) % 3 !== 0) fail(`Kate wrote to ${id}, who is not online`);
    const got = afterKate[id].count - (before[id]?.count || (before[id] ? 1 : 0));
    if (got !== 2) fail(`man ${id} got ${got} messages from Kate, expected invite + follow-up`);
    if (afterKate[id].history.at(-1).includes('{name}')) fail('placeholder leaked into a follow-up');
    const files = afterKate[id].files.slice(-2);
    if (files.join() !== 'kate-hello.png,kate-beach.png') fail(`man ${id} got files ${JSON.stringify(afterKate[id].files)}, expected the invite photo then the follow-up photo`);
  }
  const kateRows = await api('GET', `/api/stats/messages?profile_id=${kate.id}`, null, owner);
  if (kateRows.messages.some((m) => m.step !== 2 || m.stage !== 'done')) fail(`Kate rows: ${JSON.stringify(kateRows.messages.map((m) => [m.man_id, m.step, m.stage]))}`);
  await popup.screenshot({ path: path.join(OUT, '18-popup-followups.png') });
  await popup.click('#stop');
  log('follow-ups ok: online men only, like + invite 📎, then a typed follow-up 📎 on his page; both men dropped after the last attempt');

  // ---------- adapter on an infinite feed + IDs taken from links ----------
  const feed = await context.newPage();
  await feed.goto(`${BASE}/demo-site/search.html?feed=1`);
  await feed.addScriptTag({ path: path.join(ROOT, 'extension', 'content.js') });
  const feedSite = { card: '.man-card', cardId: 'a.man-name@href', cardName: '.man-name', cardAge: '.man-age' };
  const first = await feed.evaluate((site) => window.__agencyBot.scan({ site }), feedSite);
  if (first.candidates.length !== 8 || first.hasNext) fail(`feed scan: ${first.candidates.length} cards, hasNext ${first.hasNext}`);
  if (first.candidates[0].id !== '100000') fail(`id from link not normalised: ${first.candidates[0].id}`);
  const grown = await feed.evaluate((site) => window.__agencyBot.more({ site }), feedSite);
  if (!grown.grew || grown.count !== 16) fail(`feed did not load more: ${JSON.stringify(grown)}`);
  await feed.close();
  log('infinite feed + link IDs ok');

  // ---------- autopilot + scanning ahead: the most promising men first ----------
  // The platform "learned" that men from the USA answer more (seeded straight into the shared stats table).
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(path.join(tmp, 'agency.db'));
  const seed = sdb.prepare('INSERT INTO man_stats (feature, sent, replied, updated_at) VALUES (?,?,?,0) ON CONFLICT(feature) DO UPDATE SET sent = excluded.sent, replied = excluded.replied');
  seed.run('*', 1000, 100);
  seed.run('c:usa', 400, 120);
  sdb.close();
  await api('PATCH', `/api/profiles/${anna.id}`, { daily_limit: 8 }, owner); // 4 more today
  const t3 = Date.now();
  const apRes = await popup.evaluate((pid) => new Promise((r) => chrome.runtime.sendMessage({ type: 'autopilot', on: true, profileId: pid }, r)), anna.id);
  if (!apRes?.ok) fail(`autopilot failed: ${apRes?.error}`);
  const annaDone = () => st?.profileId === anna.id && st.startedAt >= t3 - 5000 && ['limit', 'watching', 'error', 'stopped'].includes(st.status);
  do { await sleep(1000); st = await readState(); } while (!annaDone() && Date.now() - t3 < 240000);
  const apLog = st.log.map((l) => l.text).join('\n');
  if (st.status !== 'limit') fail(`autopilot run: ${st.status} ${st.message}\n${apLog}`);
  if (!/⏰ Автопілот: робочий час/.test(apLog)) fail(`autopilot did not start the bot itself:\n${apLog}`);
  if (!/🔭 Розвідка/.test(apLog) || !/⭐ /.test(apLog)) fail(`no scan-ahead:\n${apLog}`);
  const annaRows = (await api('GET', `/api/stats/messages?profile_id=${anna.id}&limit=50`, null, owner)).messages.filter((m) => m.sent_at >= t3).sort((a, b) => a.sent_at - b.sent_at);
  if (annaRows.length !== 4) fail(`autopilot run wrote ${annaRows.length} men`);
  if (annaRows[0].man_country !== 'USA') fail(`the first man was not the most promising: ${annaRows.map((m) => m.man_country)}`);
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  const ap = await popup.evaluate(async () => (await chrome.storage.local.get('autopilot')).autopilot);
  if (!ap.on || !ap.heldDay) fail(`manual stop should hold the autopilot until tomorrow: ${JSON.stringify(ap)}`);
  await popup.reload();
  await popup.waitForSelector('#autopilot');
  if (!(await popup.isChecked('#autopilot'))) fail('autopilot checkbox not shown as on');
  await popup.screenshot({ path: path.join(OUT, '22-popup-autopilot.png') });
  await popup.click('#autopilot'); // off
  await popup.waitForFunction(async () => (await chrome.storage.local.get('autopilot')).autopilot.on === false, null, { timeout: 10000 });
  log(`autopilot + scan-ahead ok: started by itself, best first (${annaRows.map((m) => m.man_country).join(', ')}), manual stop holds it`);

  // ---------- captcha: the bot stops, calls a person, waits, then goes on ----------
  await api('PATCH', `/api/profiles/${maria.id}`, { daily_limit: 4 }, owner); // 2 more today
  await sitePage.evaluate(() => localStorage.setItem('demo_captcha', 'true'));
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${maria.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(maria.id));
  if (await popup.isChecked('#test-mode')) await popup.click('#test-mode');
  await popup.click('#start');
  const t4 = Date.now();
  do { await sleep(1000); st = await readState(); } while (st.status !== 'blocked' && Date.now() - t4 < 60000);
  if (st.status !== 'blocked') fail(`captcha not noticed: ${st.status}\n${st.log.map((l) => l.text).join('\n')}`);
  const sentBlocked = st.sent;
  await sleep(6000);
  if ((await readState()).sent !== sentBlocked) fail('the bot kept writing while the captcha was up');
  await popup.screenshot({ path: path.join(OUT, '24-popup-captcha.png') });
  for (const pg of context.pages()) if (await pg.$('.btn-not-robot')) await pg.click('.btn-not-robot'); // a person solves it
  do { await sleep(1000); st = await readState(); } while (!['limit', 'error', 'stopped'].includes(st.status) && Date.now() - t4 < 180000);
  const capLog = st.log.map((l) => l.text).join('\n');
  if (st.status !== 'limit') fail(`after the captcha: ${st.status}\n${capLog}`);
  if (!/🛑 /.test(capLog) || !/повільніше/.test(capLog)) fail(`captcha log:\n${capLog}`);
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  log('captcha ok: the bot paused, waited for a person, then went on slower');

  // ---------- letters: the site's mail form, its "N left" counter, translate ----------
  const letterSite = await api('POST', '/api/sites', { name: 'Демо: листи', config: {
    searchUrl: `${BASE}/demo-site/search.html`, card: '.man-card', cardId: 'a.man-name@href', cardName: '.man-name', cardAge: '.man-age', nextPage: 'a.next-page',
    openChat: 'a.man-name', messageInput: '#profile-chat textarea', sendButton: '#profile-chat .btn-send', sentConfirm: '#profile-chat .sent-ok',
    sendError: '#profile-chat .send-error', manUrl: `${BASE}/demo-site/profile.html?id={id}`, translateButton: '#profile-chat .btn-translate',
    chatLeft: '#profile-chat .left-msgs', letterOpen: '#profile-chat .btn-letter', letterSubject: '#profile-chat .letter-subject', letterLeft: '#profile-chat .left-letters',
  } }, owner);
  await api('PUT', `/api/sites/${letterSite.id}/scenario`, { scenario: { steps: [{ actions: [{ do: 'message', text: 'letter', via: 'letter' }] }], human: FAST } }, owner);
  await api('PATCH', `/api/profiles/${maria.id}`, { site_id: letterSite.id, daily_limit: 6 }, owner); // 2 more today
  const mariaSent = new Set((await api('GET', `/api/stats/messages?profile_id=${maria.id}&limit=100`, null, owner)).messages.filter((m) => m.status === 'sent').map((m) => m.man_id));
  const full = Array.from({ length: 32 }, (_, i) => String(100000 + i * 37)).find((id) => !mariaSent.has(id));
  // site order for this run: forget what the platform "learned" above, so no scan-ahead reorders the men
  const sdb2 = new DatabaseSync(path.join(tmp, 'agency.db'));
  sdb2.exec("DELETE FROM man_stats");
  sdb2.close();
  // the next man in the list already got all his letters: the site's counter shows 0 → the bot must skip him
  await sitePage.evaluate((id) => { const l = JSON.parse(localStorage.getItem('demo_letters') || '{}'); l[id] = { count: 3, history: [] }; localStorage.setItem('demo_letters', JSON.stringify(l)); }, full);
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${maria.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(maria.id));
  await popup.click('#start');
  const t5 = Date.now();
  do { await sleep(1000); st = await readState(); } while (!(st.startedAt >= t5 - 5000 && ['limit', 'error', 'stopped', 'watching'].includes(st.status)) && Date.now() - t5 < 240000);
  const letterLog = st.log.map((l) => l.text).join('\n');
  if (st.status !== 'limit') fail(`letters run: ${st.status}\n${letterLog}`);
  const letters = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_letters') || '{}'));
  if (letters[full].history.length) fail(`wrote a letter to ${full}, who had none left`);
  const got = Object.entries(letters).filter(([id, l]) => id !== full && l.history.length);
  if (got.length !== 2) fail(`expected 2 letters, got ${got.length}:\n${letterLog}`);
  for (const [, l] of got) {
    const x = l.history.at(-1);
    if (!x.subject || !x.text.includes('Maria') || x.text.length < 300 || !x.translated) fail(`letter: ${JSON.stringify(x)}`);
  }
  if (!/⛔ .*листів/.test(letterLog)) fail(`no skip of the man without letters:\n${letterLog}`);
  const fullRow = (await api('GET', `/api/stats/messages?profile_id=${maria.id}&limit=100`, null, owner)).messages.find((m) => m.man_id === full);
  if (fullRow?.status !== 'failed') fail(`the man without letters: ${JSON.stringify(fullRow)}`);
  const mariaDetail = await api('GET', `/api/profiles/${maria.id}`, null, owner);
  if (!mariaDetail.usesLetters || !mariaDetail.letter?.text) fail('letter text not shown in the profile');
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  log(`letters ok: 2 letters with a subject, translated; the man with 0 letters left was skipped`);

  // ---------- operator desk: the site's "write him" hints, ID only in the chat header, follow-ups found by ID ----------
  const deskSite = await api('POST', '/api/sites', { name: 'Демо: робочий стіл', config: {
    searchUrl: `${BASE}/demo-site/desk.html`,
    taskItem: '.task', taskName: '.t-name', taskText: '.t-text', taskOpen: '@self',
    messageInput: '.tr-dst', sendButton: '.btn-send', sentConfirm: '.chat .sent-ok', sendError: '.chat .send-error',
    chatName: '.ch-name', chatId: '.ch-id', chatLeft: '.left-msgs',
    letterOpen: '.btn-letter', letterSubject: '.letter-subject', letterLeft: '.left-letters',
    findInput: '.find-id', inboxUrl: `${BASE}/demo-site/desk.html`, inboxItem: '.chat-item', inboxUnread: '.ci-unread', inboxName: '.ci-name',
  } }, owner);
  await api('PUT', `/api/sites/${deskSite.id}/scenario`, { scenario: {
    steps: [{ actions: [{ do: 'message', text: 'invite' }] }, { wait: 0, actions: [{ do: 'message', text: 'followup' }] }],
    human: { ...FAST, reactFrom: 0, reactTo: 1, idleChance: 0 },
  } }, owner);
  await api('PATCH', `/api/profiles/${kate.id}`, { site_id: deskSite.id, daily_limit: 8 }, owner); // Kate has 4 today → 4 more
  await sitePage.goto(`${BASE}/demo-site/desk.html`);
  const tasks0 = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_tasks') || '[]'));
  if (tasks0.length !== 5) fail(`desk tasks: ${JSON.stringify(tasks0)}`);
  const [d1, dGlitch, d3] = tasks0;
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${kate.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(kate.id));
  await popup.click('#start');
  const t6 = Date.now();
  do { await sleep(1000); st = await readState(); } while (!(st.startedAt >= t6 - 5000 && ['limit', 'error', 'stopped'].includes(st.status)) && Date.now() - t6 < 300000);
  const deskLog = st.log.map((l) => l.text).join('\n');
  if (st.status !== 'limit') fail(`desk run: ${st.status} ${st.message}\n${deskLog}`);
  const dSent = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_sent') || '{}'));
  const dLetters = await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_letters') || '{}'));
  if (dSent[d1.id]?.count !== 2 || !dSent[d1.id].history[0].includes('Kate')) fail(`hint 1: invite + follow-up expected, got ${JSON.stringify(dSent[d1.id])}\n${deskLog}`);
  if (dLetters[d3.id]?.count !== 1 || !dLetters[d3.id].history[0].subject) fail(`hint 3 asked for a letter: ${JSON.stringify(dLetters[d3.id])}\n${deskLog}`);
  if (dSent[d3.id]?.count !== 1) fail(`hint 3 follow-up (found by ID) expected: ${JSON.stringify(dSent[d3.id])}\n${deskLog}`);
  if (dSent[dGlitch.id] || dSent[dGlitch.opens] || dLetters[dGlitch.opens]) fail(`wrote into a wrong chat: ${JSON.stringify([dSent[dGlitch.id], dSent[dGlitch.opens]])}`);
  if (!/чат іншого чоловіка/.test(deskLog)) fail(`no wrong-chat safety stop:\n${deskLog}`);
  const kateDesk = (await api('GET', `/api/stats/messages?profile_id=${kate.id}&limit=50`, null, owner)).messages;
  if (!kateDesk.some((m) => m.man_id === d1.id && m.step === 2)) fail(`server: hint man ID from the chat header: ${JSON.stringify(kateDesk.map((m) => [m.man_id, m.step]))}`);
  await popup.screenshot({ path: path.join(OUT, '26-popup-desk.png') });
  await sitePage.bringToFront();
  await sitePage.reload();
  await sleep(500);
  await sitePage.screenshot({ path: path.join(OUT, '27-desk.png') });
  await popup.bringToFront();
  await popup.click('#stop');
  await popup.waitForFunction(async () => (await chrome.storage.local.get('state')).state.status === 'stopped', null, { timeout: 30000 });
  log('operator desk ok: hints → chat / letter as asked, ID from the chat header, wrong chat refused, follow-ups found by ID');

  // ---------- 🧪 full test run: everything as for real, nothing sent ----------
  const beforeFull = await sitePage.evaluate(() => [localStorage.getItem('demo_sent'), localStorage.getItem('demo_letters')]);
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${kate.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(kate.id));
  if (!(await popup.isChecked('#test-mode'))) await popup.click('#test-mode');
  await popup.waitForSelector('#test-full', { state: 'visible' });
  if (!(await popup.isChecked('#test-full'))) await popup.click('#test-full');
  await popup.click('#start');
  const t7 = Date.now();
  do { await sleep(1000); st = await readState(); } while (!(st.startedAt >= t7 - 5000 && ['stopped', 'error'].includes(st.status)) && Date.now() - t7 < 240000);
  const fullLog = st.log.map((l) => l.text).join('\n');
  if (!/Повний прогін готово: пройшов [1-9]/.test(fullLog)) fail(`full test run:\n${fullLog}`);
  if (!/✉ лист написав би/.test(fullLog) || !/НЕ надіслано/.test(fullLog)) fail(`full test run should walk a letter hint:\n${fullLog}`);
  const afterFull = await sitePage.evaluate(() => [localStorage.getItem('demo_sent'), localStorage.getItem('demo_letters')]);
  if (JSON.stringify(afterFull) !== JSON.stringify(beforeFull)) fail('the full test run sent something');
  await popup.screenshot({ path: path.join(OUT, '28-popup-full-test.png') });
  await popup.click('#test-mode'); // back to normal
  log('full test run ok: hints walked as for real, nothing sent');

  // ---------- 🎯 teach an operator desk by clicking (what an admin does by hand), then the quick test ----------
  const deskTaught = await api('POST', '/api/sites', { name: 'Робочий стіл (мишкою)', config: { searchUrl: `${BASE}/demo-site/desk.html` } }, owner);
  await api('PUT', `/api/sites/${deskTaught.id}/scenario`, { scenario: { human: { ...FAST, reactFrom: 0, reactTo: 1, idleChance: 0 } } }, owner);
  await api('PATCH', `/api/profiles/${kate.id}`, { site_id: deskTaught.id }, owner);
  await sitePage.goto(`${BASE}/demo-site/desk.html`);
  const deskTabId = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes('desk.html')).id);
  const tRes = await popup.evaluate(({ pid, tid }) => new Promise((r) => chrome.runtime.sendMessage({ type: 'teach', profileId: pid, tabId: tid }, r)), { pid: kate.id, tid: deskTabId });
  if (!tRes?.ok) fail(`desk teach: ${tRes?.error}`);
  await sitePage.bringToFront();
  const dp = sitePage.locator('#__agency_teach');
  await dp.locator('.panel').waitFor();
  const dTab = (name) => dp.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  const dRow = (label) => dp.locator('.row').filter({ hasText: label });
  const dPick = async (label, sel, opts) => { await dRow(label).getByRole('button', { name: '🎯 Вибрати' }).click(); await sitePage.click(sel, opts); await sleep(250); };
  const dFold = () => dp.locator('button[title="Згорнути"]').click();
  await dTab('Підказки');
  await dPick('Підказка «напиши йому»', '.task >> nth=1', { position: { x: 6, y: 6 } });
  await dFold(); await sitePage.click('.task >> nth=1'); await sleep(400); await dFold(); // the operator opens a chat as usual
  await dTab('Відправка');
  await dPick('Поле вводу повідомлення', '.tr-dst');
  await dPick('Кнопка «Надіслати»', '.btn-send');
  await dPick('Ім’я в шапці відкритого чату', '.ch-name');
  await dPick('ID у шапці відкритого чату', '.ch-id');
  await dPick('Лічильник «Залишилося N повідомлень»', '.left-msgs');
  await dFold(); await sitePage.click('.btn-letter'); await sleep(300); await dFold(); // the operator presses the envelope
  await dTab('Листи');
  await dPick('Кнопка «Лист»', '.btn-letter');
  await dPick('Поле теми листа', '.letter-subject');
  await dPick('Лічильник «Залишилося N листів»', '.left-letters');
  await dFold(); await sitePage.click('.btn-chat-mode'); await sleep(300); await dFold();
  await dTab('Його сторінка');
  await dPick('Пошук чоловіка за ID', '.find-id');
  await dTab('Вхідні');
  await dRow('URL сторінки вхідних').getByRole('button', { name: '📍 Ця сторінка' }).click();
  await dPick('Діалог у вхідних', '.chat-item >> nth=2', { position: { x: 4, y: 4 } });
  await dTab('Підказки');
  await sleep(300);
  await sitePage.screenshot({ path: path.join(OUT, '29-teach-desk.png') });
  await dp.getByRole('button', { name: '💾 Зберегти' }).click();
  await dp.locator('.msg', { hasText: 'Збережено' }).waitFor();
  await dp.locator('button[title="Закрити"]').click();
  const dcfg = (await api('GET', '/api/sites', null, owner)).sites.find((x) => x.id === deskTaught.id).config;
  const dWant = { taskItem: '.task', taskName: '.t-name', taskText: '.t-text', taskOpen: '@self', sendButton: '.btn-send', chatName: '.ch-name', chatId: '.ch-id', chatLeft: '.left-msgs', inboxItem: '.chat-item' };
  for (const [k, v] of Object.entries(dWant)) if (dcfg[k] !== v) fail(`desk taught ${k} = ${dcfg[k]}, expected ${v}\n${JSON.stringify(dcfg, null, 1)}`);
  for (const k of ['messageInput', 'letterOpen', 'letterSubject', 'letterLeft', 'findInput', 'inboxUrl']) if (!dcfg[k]) fail(`desk not taught: ${k}`);
  await popup.bringToFront(); await popup.reload();
  await popup.waitForSelector(`#profile option[value="${kate.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(kate.id));
  if (!(await popup.isChecked('#test-mode'))) await popup.click('#test-mode');
  if (await popup.isChecked('#test-full')) await popup.click('#test-full');
  await popup.click('#start');
  const t8 = Date.now();
  do { await sleep(1000); st = await readState(); } while (!(st.startedAt >= t8 - 5000 && ['stopped', 'error'].includes(st.status)) && Date.now() - t8 < 180000);
  const dLog = st.log.map((l) => l.text).join('\n');
  if (!/Тест пройдено/.test(dLog) || !/Чат з підказки відкрився/.test(dLog)) fail(`desk taught by clicks — test:\n${dLog}`);
  await popup.click('#test-mode');
  log('desk taught by clicking ok: hints, chat header, envelope, search by ID, inbox — the quick test passes');

  // ---------- 📋 report for the developer: no names, no IDs ----------
  const rep = await popup.evaluate(({ pid }) => new Promise((r) => chrome.tabs.query({}, (tabs) => {
    const t = tabs.find((x) => x.url.includes('/demo-site/desk.html'));
    chrome.runtime.sendMessage({ type: 'report', profileId: pid, tabId: t?.id }, r);
  })), { pid: kate.id });
  if (!rep?.ok) fail(`report: ${rep?.error}`);
  const repText = rep.data.text;
  if (!/Навчено: .*taskItem✓/.test(repText) || !/На сторінці зараз: .*підказок \d/.test(repText)) fail(`report content:\n${repText}`);
  if (/\d{5,}/.test(repText) || /localhost|127\.0\.0\.1/.test(repText) || /(William|Richard|Edward|Michael|Paul)\b/.test(repText)) fail(`report leaks data:\n${repText}`);
  log('report ok: taught fields + what the bot sees, no names / IDs / addresses');

  // ---------- 🔁 changing profiles: one desk, several women; no work for her → the next one (the site switches too) ----------
  const womenUrl = `${BASE}/demo-site/desk.html?women=1`;
  const womenSite = await api('POST', '/api/sites', { name: 'Демо: кілька анкет', config: {
    searchUrl: womenUrl,
    taskItem: '.task', taskName: '.t-name', taskText: '.t-text', taskOpen: '@self',
    messageInput: '.tr-dst', sendButton: '.btn-send', sentConfirm: '.chat .sent-ok', sendError: '.chat .send-error',
    chatName: '.ch-name', chatId: '.ch-id', chatLeft: '.left-msgs',
    findInput: '.find-id', inboxUrl: womenUrl, inboxItem: '.chat-item', inboxUnread: '.ci-unread', inboxName: '.ci-name',
  } }, owner);
  await api('PUT', `/api/sites/${womenSite.id}/scenario`, { scenario: {
    steps: [{ actions: [{ do: 'message', text: 'invite' }] }],
    human: { ...FAST, reactFrom: 0, reactTo: 1, idleChance: 0 },
  } }, owner);
  await api('PATCH', `/api/profiles/${kate.id}`, { site_id: womenSite.id, site_profile_id: '5000000001', daily_limit: 30, min_delay: 5, max_delay: 6 }, owner);
  await api('PATCH', `/api/profiles/${maria.id}`, { site_id: womenSite.id, site_profile_id: '5000000002', daily_limit: 30, min_delay: 5, max_delay: 6 }, owner);
  await sitePage.goto(womenUrl);
  await sitePage.evaluate(() => localStorage.setItem('demo_her', JSON.stringify('5000000002'))); // the site shows Maria, the bot starts as Kate
  await sitePage.reload();
  // the admin teaches the "Анкети" tab by clicking
  const wTabId = await popup.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes('women=1')).id);
  const wRes = await popup.evaluate(({ pid, tid }) => new Promise((r) => chrome.runtime.sendMessage({ type: 'teach', profileId: pid, tabId: tid }, r)), { pid: kate.id, tid: wTabId });
  if (!wRes?.ok) fail(`women teach: ${wRes?.error}`);
  await sitePage.bringToFront();
  const wp = sitePage.locator('#__agency_teach');
  await wp.locator('.panel').waitFor();
  const wRow = (label) => wp.locator('.row').filter({ hasText: label });
  const wPick = async (label, sel, opts) => { await wRow(label).getByRole('button', { name: '🎯 Вибрати' }).click(); await sitePage.click(sel, opts); await sleep(250); };
  const wFold = () => wp.locator('button[title="Згорнути"]').click();
  await wp.getByRole('button', { name: /^Анкети/ }).click();
  await wPick('Яка анкета зараз', '.her-now');
  await wPick('Перемикач анкет', '.her-switch');
  await wFold(); await sitePage.click('.her-switch'); await sleep(300); await wFold(); // the admin opens the list of women
  await wPick('Жінка в списку', '.her-item >> nth=1', { position: { x: 4, y: 4 } });
  await wFold(); await sitePage.click('.her-switch'); await sitePage.click('.task >> nth=0'); await sleep(400); await wFold(); // closes it, opens a chat
  await wPick('у шапці чату', '.ch-her');
  await sitePage.screenshot({ path: path.join(OUT, '32-teach-women.png') });
  await wp.getByRole('button', { name: '💾 Зберегти' }).click();
  await wp.locator('.msg', { hasText: 'Збережено' }).waitFor();
  await wp.locator('button[title="Закрити"]').click();
  const wcfg = (await api('GET', '/api/sites', null, owner)).sites.find((x) => x.id === womenSite.id).config;
  const wHit = await sitePage.evaluate((c) => ({
    herCurrent: document.querySelector(c.herCurrent)?.className, herSwitch: document.querySelector(c.herSwitch)?.className,
    herItem: document.querySelectorAll(c.herItem).length, herItemId: document.querySelector(c.herItem)?.querySelector(c.herItemId)?.className,
    herItemName: c.herItemName ? document.querySelector(c.herItem)?.querySelector(c.herItemName)?.className : '', chatHer: document.querySelector(c.chatHer)?.className,
  }), wcfg);
  if (wHit.herCurrent !== 'her-now' || wHit.herSwitch !== 'her-switch' || wHit.herItem !== 3 || wHit.herItemId !== 'her-id' || wHit.chatHer !== 'ch-her') {
    fail(`women taught by clicks: ${JSON.stringify(wHit)}\n${JSON.stringify(wcfg, null, 1)}`);
  }
  await sitePage.evaluate(() => localStorage.setItem('demo_her', JSON.stringify('5000000002')));
  await sitePage.reload();
  log(`women taught by clicking: current ${wcfg.herCurrent}, switch ${wcfg.herSwitch}, row ${wcfg.herItem} (ID ${wcfg.herItemId}, name ${wcfg.herItemName || '—'}), chat ${wcfg.chatHer}`);
  await popup.bringToFront();
  await popup.reload();
  await popup.waitForSelector(`#profile option[value="${kate.id}"]`, { state: 'attached' });
  await popup.selectOption('#profile', String(kate.id));
  if (!(await popup.isChecked('#rotate'))) await popup.click('#rotate');
  await popup.click('#start');
  const tRot = Date.now();
  const rotDone = () => st.startedAt >= tRot - 5000 && ((st.status === 'watching' && /ні в кого/.test(st.message || '')) || ['error', 'stopped', 'limit'].includes(st.status));
  do { await sleep(1000); st = await readState(); } while (!rotDone() && Date.now() - tRot < 300000);
  const rotLog = st.log.map((l) => l.text).join('\n');
  const wSent = await sitePage.evaluate(() => Object.fromEntries(['5000000001', '5000000002', '5000000003']
    .map((w) => [w, JSON.parse(localStorage.getItem(`demo_sent@${w}`) || '{}')])));
  const kateW = Object.values(wSent['5000000001']);
  const mariaW = Object.values(wSent['5000000002']);
  if (kateW.length !== 2 || !kateW.every((x) => x.count === 1 && x.history[0].includes('Kate'))) fail(`Kate's hints: ${JSON.stringify(wSent['5000000001'])}\n${rotLog}`);
  if (mariaW.length !== 2 || !mariaW.every((x) => x.count === 1 && x.history[0].includes('Maria'))) fail(`Maria's hints: ${JSON.stringify(wSent['5000000002'])}\n${rotLog}`);
  if (Object.keys(wSent['5000000003']).length) fail(`wrote as Olha, who is not in the panel: ${JSON.stringify(wSent['5000000003'])}`);
  if (!/переходжу на Maria/.test(rotLog)) fail(`no switch to Maria in the log:\n${rotLog}`);
  if (!/👩 На сайті анкета Kate/.test(rotLog)) fail(`Kate was not checked on the site first:\n${rotLog}`);
  if ((await sitePage.evaluate(() => JSON.parse(localStorage.getItem('demo_her')))) !== '5000000002') fail('the site was not switched to Maria');
  const mariaServer = (await api('GET', `/api/stats/messages?profile_id=${maria.id}&limit=200`, null, owner)).messages;
  for (const id of Object.keys(wSent['5000000002'])) if (!mariaServer.some((m) => m.man_id === id && m.status === 'sent')) fail(`server: ${id} not under Maria`);
  await popup.screenshot({ path: path.join(OUT, '30-popup-rotate.png') });
  // ⏹ from the control panel: the running bot stops by itself within ~30 s (its next heartbeat)
  const roseId = (await api('GET', '/api/auth/me', null, owner)).user.agencyId;
  const tStop = Date.now();
  await api('POST', `/api/admin/agencies/${roseId}/stop-bots`, {}, admin);
  do { await sleep(1000); st = await readState(); } while (st.status !== 'stopped' && Date.now() - tStop < 75000);
  if (st.status !== 'stopped' || !/Бота зупинили з панелі/.test(st.log.map((l) => l.text).join('\n'))) fail(`remote stop did not stop the bot: ${st.status} ${st.message}`);
  log(`remote stop ok: the bot stopped ${Math.round((Date.now() - tStop) / 1000)} s after ⏹ in the control panel`);
  await sitePage.bringToFront();
  await sitePage.click('.her-switch');
  await sleep(300);
  await sitePage.screenshot({ path: path.join(OUT, '31-desk-women.png') });
  await sitePage.click('.her-switch');
  await popup.bringToFront();
  // the safety: a chat of another woman is never written in
  await sitePage.click('.chat-item >> nth=0');
  const wrongHer = await popup.evaluate(async ({ tid }) => {
    await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['content.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => window.__agencyBot.chatHerIs({ site: { chatHer: '.ch-her' }, id: '5000000001', name: 'Kate' }) });
    return r.result;
  }, { tid: wTabId });
  if (wrongHer?.ok !== false || !/Maria/.test(wrongHer.now)) fail(`a chat of Maria passed as Kate's: ${JSON.stringify(wrongHer)}`);
  await popup.click('#rotate'); // back to one profile
  log('profile rotation ok: started as Kate (site switched from Maria), her hints done → switched the site to Maria → hers; never wrote as another woman');

  // ---------- dashboard after the run (light, dark, mobile) ----------
  await page.bringToFront();
  await goHash(page, 'dashboard'); // «Статистика по днях» opens from «Статистика»
  await page.waitForSelector('.chart-svg');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '01-dashboard.png'), fullPage: true });
  await goHash(page, 'journal');
  await page.waitForSelector('.page-head h1');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '12-journal.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await goHash(page, 'dashboard'); // «Статистика по днях» opens from «Статистика»
  await page.waitForSelector('.chart-svg');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '13-dashboard-dark.png'), fullPage: true });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '14-dashboard-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) fail('horizontal scroll on mobile dashboard');

  await page.setViewportSize({ width: 1360, height: 900 });
  await goHash(page, 'setup');
  await page.waitForSelector('.setup-steps > li');
  await page.selectOption('.setup select', String(anna.id)); // Anna went through the whole way (Kate never ran a test)
  await page.waitForFunction(() => document.querySelectorAll('.setup-steps > li.done').length === 6, null, { timeout: 10000 }).catch(() => {});
  const setupSteps = await page.$$eval('.setup-steps > li', (els) => els.map((e) => e.classList.contains('done')));
  if (setupSteps.length !== 6 || !setupSteps.every(Boolean)) fail(`setup wizard after a full run: ${JSON.stringify(setupSteps)}`);
  await page.click('.setup-steps > li:nth-child(4) .setup-head');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '25-setup.png'), fullPage: true });
  log('setup wizard ok: all 6 steps ticked by themselves');
  await goHash(page, 'sites');
  await page.waitForSelector('.site-card');
  await page.screenshot({ path: path.join(OUT, '19-sites.png'), fullPage: true });
  await page.locator('.site-card', { hasText: 'Навчений кліками' }).getByText('⚙ Сценарій').click();
  await page.waitForSelector('.modal .step-card');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '20-scenario.png') });
  await page.keyboard.press('Escape');
  await page.click('a[href="#/profiles"]');
  await page.waitForSelector('table.table.hover');
  await page.click('text=Kate');
  await page.waitForSelector('.modal .followup-box');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '21-profile-followups.png') });
  await page.keyboard.press('Escape');

  // admin panel
  await page.click('.nav-foot button:has-text("Вийти")');
  await page.fill('#l-email', 'admin@e2e');
  await page.fill('#l-pass', 'admin12345');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head h1:has-text("Пульт")');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '15-admin-overview.png'), fullPage: true });
  await page.click('a[href="#/agencies"]');
  await page.waitForSelector('td:has-text("Rose Agency")');
  await page.screenshot({ path: path.join(OUT, '15b-admin-agencies.png') });
  await page.click('td:has-text("Rose Agency")');
  await page.waitForSelector('.people-table');
  await page.screenshot({ path: path.join(OUT, '15c-admin-team.png'), fullPage: true });
  // the bot copy taken for this run is listed with its mark
  await page.click('a[href="#/devices"]');
  await page.waitForSelector('text=Копії бота');
  if (!(await page.locator('td code').count())) fail('downloaded copy of the bot not listed');
  await page.screenshot({ path: path.join(OUT, '15d-admin-devices.png'), fullPage: true });
  log('control panel ok: overview, teams, team card, devices and copies');

  // ---------- registration by link: admin → team lead → operator, each approved ----------
  await page.click('a[href="#/registrations"]');
  await page.click('button:has-text("+ Запросити тімліда")');
  await page.fill('.modal input[name=note]', 'Новий тімлід');
  await page.click('.modal button:has-text("Створити посилання")');
  await page.waitForSelector('.modal textarea.access-text');
  const leadUrl = /(http\S+#\/join\/\S+)/.exec(await page.inputValue('.modal textarea.access-text'))[1];
  await page.keyboard.press('Escape');
  const jp = await context.newPage();
  const join = async (url, name, email, team) => {
    await jp.goto(url);
    await jp.waitForSelector('#j-name');
    await jp.fill('#j-name', name);
    if (team) await jp.fill('#j-agencyName', team);
    await jp.fill('#j-email', email);
    await jp.fill('#j-password', 'joinpass1');
    await jp.fill('#j-password2', 'joinpass1');
    await jp.click('button[type=submit]');
    await jp.waitForSelector('text=Заявку надіслано');
  };
  await join(leadUrl, 'Тарас', 'taras@e2e', 'Команда Тараса');
  await jp.screenshot({ path: path.join(OUT, '33-join-done.png') });
  await page.reload();
  await page.waitForSelector('.pending-row:has-text("Тарас")');
  await page.click('.pending-row:has-text("Тарас") button:has-text("Підтвердити")');
  await page.waitForSelector('.pending-row:has-text("Тарас")', { state: 'detached' });
  await page.click('.nav-foot button:has-text("Вийти")');
  await page.fill('#l-email', 'taras@e2e');
  await page.fill('#l-pass', 'joinpass1');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head h1');
  await goHash(page, 'team');
  await page.waitForSelector('.link-box input');
  await join(await page.inputValue('.link-box input'), 'Ліна', 'lina@e2e');
  await page.reload();
  await page.waitForSelector('.pending-row:has-text("Ліна")');
  await page.screenshot({ path: path.join(OUT, '34-team-pending.png') });
  await page.click('.pending-row:has-text("Ліна") button:has-text("Підтвердити")');
  await page.waitForSelector('td:has-text("Ліна")');
  await jp.close();
  log('registration by link ok: admin invited a team lead, approved; the lead invited an operator, approved');
  await page.click('.nav-foot button:has-text("Вийти")');
  await page.fill('#l-email', 'admin@e2e');
  await page.fill('#l-pass', 'admin12345');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head h1:has-text("Пульт")');
  await page.click('a[href="#/memory"]');
  await page.waitForSelector('.memory-list, .page-head h1:has-text("Пам’ять ШІ")');
  await page.fill('input[name=lesson]', 'Mention one concrete hobby and ask about his weekend.');
  await page.click('text=Додати урок');
  await page.waitForSelector('.memory-list li');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '23-admin-memory.png'), fullPage: true });
  log('admin memory page ok');

  if (consoleErrors.length) fail(`browser errors:\n${consoleErrors.join('\n')}`);
  console.log(`\nE2E OK — screenshots in ${OUT}`);
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  if (consoleErrors.length) console.error(consoleErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
