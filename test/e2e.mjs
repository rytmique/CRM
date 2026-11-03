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
  await api('POST', '/api/admin/agencies', { name: 'Rose Agency', ownerName: 'Олена', ownerEmail: 'owner@e2e', ownerPassword: 'owner12345', licenses: 3, days: 30 }, admin);
  const owner = (await api('POST', '/api/auth/login', { email: 'owner@e2e', password: 'owner12345' })).token;
  const op = await api('POST', '/api/operators', { name: 'Ірина', email: 'ira@e2e', password: 'ira123' }, owner);
  const site = (await api('GET', '/api/sites', null, owner)).sites[0];
  const lic = (await api('GET', '/api/licenses', null, owner)).licenses;
  const anna = await api('POST', '/api/profiles', {
    name: 'Anna', age: 32, city: 'Kyiv', country: 'Ukraine', interests: 'yoga, travel, cooking', looking_for: 'a kind and honest man',
    bio: 'Paediatric nurse, loves long walks by the Dnipro and baking on Sundays.', operator_id: op.id, site_id: site.id, license_id: lic[0].id,
    daily_limit: 4, min_delay: 5, max_delay: 6,
  }, owner);
  const maria = await api('POST', '/api/profiles', { name: 'Maria', age: 27, interests: 'dancing, books', city: 'Lviv', country: 'Ukraine', site_id: site.id, operator_id: op.id, license_id: lic[1].id }, owner);
  await api('POST', '/api/profiles', { name: 'Olha', age: 35, city: 'Odesa', country: 'Ukraine', site_id: site.id, status: 'paused' }, owner);
  await api('PUT', '/api/settings', { settings: { inboxCheckEvery: 2 } }, owner);
  const FAST = { hoursFrom: 0, hoursTo: 0, perHour: 0, breakEvery: 0, typing: false, spread: false };
  await api('PUT', `/api/sites/${site.id}/scenario`, { scenario: {
    steps: [{ actions: [{ do: 'click', action: 'like' }, { do: 'message', text: 'invite' }] }, { wait: 24, actions: [{ do: 'message', text: 'followup' }] }],
    human: FAST,
  } }, owner);
  log('data ready');

  // ---------- browser with the extension ----------
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: [`--disable-extensions-except=${path.join(ROOT, 'extension')}`, `--load-extension=${path.join(ROOT, 'extension')}`],
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

  for (const [hash, file] of [['licenses', '05-licenses'], ['operators', '06-operators'], ['sites', '07-sites'], ['settings', '08-settings'], ['extension', '09-extension']]) {
    await page.click(`a[href="#/${hash}"]`);
    await page.waitForSelector('.page-head h1');
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, `${file}.png`), fullPage: true });
  }
  log('panel pages ok');

  // ---------- extension run ----------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#login-form');
  await popup.fill('#server', BASE);
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
  const kate = await api('POST', '/api/profiles', { name: 'Kate', age: 29, interests: 'tennis, jazz', site_id: taught.id, operator_id: op.id, license_id: lic[2].id, daily_limit: 4, min_delay: 5, max_delay: 6 }, owner);
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

  // ---------- dashboard after the run (light, dark, mobile) ----------
  await page.bringToFront();
  await page.click('a[href="#/dashboard"]');
  await page.waitForSelector('.chart-svg');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '01-dashboard.png'), fullPage: true });
  await page.click('a[href="#/journal"]');
  await page.waitForSelector('.page-head h1');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '12-journal.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.click('a[href="#/dashboard"]');
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
  await page.click('a[href="#/setup"]');
  await page.waitForSelector('.setup-steps > li');
  await page.selectOption('.setup select', String(anna.id)); // Anna went through the whole way (Kate never ran a test)
  await page.waitForFunction(() => document.querySelectorAll('.setup-steps > li.done').length === 6, null, { timeout: 10000 }).catch(() => {});
  const setupSteps = await page.$$eval('.setup-steps > li', (els) => els.map((e) => e.classList.contains('done')));
  if (setupSteps.length !== 6 || !setupSteps.every(Boolean)) fail(`setup wizard after a full run: ${JSON.stringify(setupSteps)}`);
  await page.click('.setup-steps > li:nth-child(4) .setup-head');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '25-setup.png'), fullPage: true });
  log('setup wizard ok: all 6 steps ticked by themselves');
  await page.click('a[href="#/sites"]');
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
  await page.waitForSelector('.page-head h1');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '15-admin-agencies.png') });
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
