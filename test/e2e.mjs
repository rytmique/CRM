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
  await api('POST', '/api/profiles', { name: 'Maria', age: 27, city: 'Lviv', country: 'Ukraine', site_id: site.id, operator_id: op.id, license_id: lic[1].id }, owner);
  await api('POST', '/api/profiles', { name: 'Olha', age: 35, city: 'Odesa', country: 'Ukraine', site_id: site.id, status: 'paused' }, owner);
  await api('PUT', '/api/settings', { settings: { inboxCheckEvery: 2 } }, owner);
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
  await page.click('text=✨ Згенерувати ШІ');
  await page.waitForFunction(() => document.querySelectorAll('.overlay').length === 1 && document.querySelector('.modal textarea[name=text]')?.value.length > 30);
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
  // Start from the popup page (its "active tab" is the extension page, so the bot opens the site search in a new tab).
  await popup.click('#start');
  log('bot started');

  const readState = () => popup.evaluate(async () => (await chrome.storage.local.get('state')).state);
  let st;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    st = await readState();
    if (['limit', 'watching', 'error', 'stopped'].includes(st?.status)) break;
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

  // admin panel
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.click('.nav-foot button:has-text("Вийти")');
  await page.fill('#l-email', 'admin@e2e');
  await page.fill('#l-pass', 'admin12345');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-head h1');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '15-admin-agencies.png') });

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
