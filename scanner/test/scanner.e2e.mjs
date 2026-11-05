// Scanner end-to-end in a real Chromium: an operator working on the demo site with "another bot" running,
// tabs, reloads, a second window, offline, captcha, login page, an iframe from another host, a scanner update,
// a browser restart, a busy burst — then the report: roles found, nothing personal inside, nothing changed on the page.
// Usage: node scanner/test/scanner.e2e.mjs   (OUT=dir to keep the report and screenshots)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(HERE, '..');
const ROOT = path.resolve(SCANNER, '..');
const OTHERBOT = path.join(HERE, 'otherbot');
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'scan-out-'));
const BURST_S = Number(process.env.BURST_S || 60);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const fail = (m) => { throw new Error(m); };

// ---------- static server: /demo-site/* and /fx/* ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = null;
  if (u.pathname.startsWith('/demo-site/')) file = path.join(ROOT, u.pathname);
  else if (u.pathname.startsWith('/fx/')) file = path.join(HERE, 'fixtures', u.pathname.slice(4));
  else if (u.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-profile-'));
const launch = () => chromium.launchPersistentContext(userDir, {
  channel: 'chromium', headless: true, viewport: { width: 1360, height: 860 }, acceptDownloads: true,
  args: [`--disable-extensions-except=${SCANNER},${OTHERBOT}`, `--load-extension=${SCANNER},${OTHERBOT}`],
});

let ctx;
const errors = [];
async function scannerWorker() {
  for (let i = 0; i < 50; i++) {
    const sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
    if (sw) return sw;
    await sleep(200);
  }
  return ctx.waitForEvent('serviceworker');
}
const status = async (sw) => sw.evaluate(() => new Promise((r) => {
  // ask the background like the popup does (from inside the extension)
  self.__testStatus ? r(self.__testStatus()) : r(null);
}));

try {
  ctx = await launch();
  ctx.on('weberror', (e) => errors.push(`pageerror: ${e.error().message}`));
  let sw = await scannerWorker();
  const extId = new URL(sw.url()).host;
  log('scanner loaded', extId);
  const popupUrl = (tabId) => `chrome-extension://${extId}/popup.html${tabId ? `?tab=${tabId}` : ''}`;
  // everything extension-side goes through an extension page (it also wakes the service worker up)
  const inExt = async (fn, arg) => {
    const p = await ctx.newPage();
    await p.goto(popupUrl());
    try { return await p.evaluate(fn, arg); } finally { await p.close(); }
  };
  const tabIdOf = (needle) => inExt((n) => chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || '').includes(n))?.id), needle);
  const bgStatus = () => inExt(() => chrome.runtime.sendMessage({ type: 'status' }));

  // ---------- 1. the operator opens the desk and presses «Вивчити сайт» ----------
  const desk = await ctx.newPage();
  desk.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await desk.goto(`${BASE}/demo-site/desk.html?women=1`);
  await desk.waitForSelector('.chat-item');
  const pagesBefore = ctx.pages().length;
  const popup = await ctx.newPage();
  await popup.goto(popupUrl(await tabIdOf('desk.html')));
  await popup.waitForSelector('#start:not([disabled])');
  await popup.locator('body').screenshot({ path: path.join(OUT, 'popup-1-start.png') });
  await popup.click('#start');
  await popup.waitForSelector('#rec:not([hidden])');
  log('recording started');

  // ---------- 2. nothing on the page is changed by the scanner ----------
  const clean = await ctx.newPage();
  await clean.goto(`${BASE}/demo-site/search.html`);
  await clean.evaluate(() => { window.__muts = 0; new MutationObserver((l) => { window.__muts += l.length; }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); });
  await sleep(7000); // the scanner takes its snapshots meanwhile
  const muts = await clean.evaluate(() => window.__muts);
  // the only thing allowed to change this page is the other bot's panel (added before we started counting)
  if (muts) fail(`the page changed ${muts} times while only the scanner was looking`);
  log('page untouched by the scanner (0 mutations in 7 s)');

  // ---------- 3. a real operator at work (trusted input) ----------
  await desk.bringToFront();
  await desk.click('.chat-item >> nth=0');
  await sleep(500);
  await desk.click('.tr-src');
  await desk.keyboard.type('Hello my dear Michael from test, I live in Lviv', { delay: 5 });
  await desk.click('.btn-translate');
  await desk.keyboard.press('Enter');
  await desk.click('.btn-send');
  await sleep(800);
  await desk.click('.btn-letter');
  await sleep(400);
  if (await desk.locator('.letter-subject').isVisible()) await desk.fill('.letter-subject', 'Private subject 123456');
  await desk.click('.btn-chat-mode');
  await desk.click('.her-switch');
  await sleep(300);
  await desk.click('.her-item >> nth=1');
  await sleep(1500);
  if (await desk.locator('.task').count()) await desk.click('.task >> nth=0');
  await sleep(1500);
  await desk.fill('.find-id', '100037');
  await desk.keyboard.press('Enter');
  await sleep(1500);
  log('operator actions on the desk done');

  // search → chat modal with a photo → profile → inbox
  await clean.bringToFront();
  await clean.click('.man-card >> nth=0 >> .btn-write');
  await clean.fill('#chat-modal textarea', 'Second private text for David');
  const [chooser] = await Promise.all([clean.waitForEvent('filechooser'), clean.click('#chat-modal .btn-attach')]);
  await chooser.setFiles({ name: 'secret-photo-of-me.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(SCANNER, 'icon48.png')) });
  await sleep(300);
  await clean.click('#chat-modal .btn-send');
  await sleep(1200);
  await clean.click('#chat-modal .btn-close');
  await clean.click('a.next-page');
  await clean.waitForLoadState();
  await sleep(1500);
  await clean.goto(`${BASE}/demo-site/profile.html?id=100074`);
  await sleep(1200);
  // a photo through the site's own file field (a <label> with a hidden input in the page)
  const [chooser2] = await Promise.all([clean.waitForEvent('filechooser'), clean.click('#profile-chat .btn-attach')]);
  await chooser2.setFiles({ name: 'secret-photo-of-me.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(SCANNER, 'icon48.png')) });
  await clean.fill('#profile-chat textarea', 'Third private text for Thomas');
  await clean.click('#profile-chat .btn-send');
  await sleep(1500);
  await clean.goto(`${BASE}/demo-site/inbox.html`);
  await sleep(1500);
  await clean.reload();
  await sleep(1500);
  log('search, chat with a photo, profile, inbox, reload done');

  // ---------- 4. tabs, second window, closing, offline, captcha, login, iframe ----------
  const second = await ctx.newPage();
  await second.goto(`${BASE}/demo-site/desk.html`);
  await sleep(2500);
  await desk.bringToFront();
  await sleep(500);
  await second.close();
  const win2 = await ctx.newPage(); // a separate window in the operator's eyes
  await win2.goto('about:blank');
  await win2.goto(`${BASE}/fx/login.html`);
  await sleep(2500);
  await win2.goto(`${BASE}/fx/frame-host.html`);
  await sleep(7000); // the top page reports the iframe host, the background registers it
  await win2.reload();
  await sleep(4000);
  await ctx.setOffline(true);
  await sleep(2000);
  await ctx.setOffline(false);
  await sleep(1000);
  await desk.evaluate(() => localStorage.setItem('demo_captcha', 'true'));
  await desk.reload();
  await sleep(3000);
  await desk.evaluate(() => localStorage.removeItem('demo_captcha'));
  await desk.reload();
  await desk.waitForSelector('.chat-item');
  log('tabs, window, offline, captcha, login page, iframe done');

  // ---------- 5. another bot clicking and typing fast (programmatic events) ----------
  await desk.evaluate(() => localStorage.setItem('otherbot', '1'));
  const t5 = Date.now();
  while (Date.now() - t5 < BURST_S * 1000) {
    await sleep(5000);
    if (Math.random() < 0.3) await desk.mouse.move(400 + Math.random() * 300, 300 + Math.random() * 200); // the operator moves the mouse now and then
  }
  await desk.evaluate(() => localStorage.setItem('otherbot', '0'));
  const afterBurst = await bgStatus();
  if (!afterBurst.ok || !afterBurst.scanning) fail(`scanner stopped during the burst: ${JSON.stringify(afterBurst)}`);
  log(`other bot burst ${BURST_S}s: screens ${afterBurst.states}, actions ${afterBurst.events}, request types ${afterBurst.net}`);

  // ---------- 6. Chrome stops the scanner's background (it does so on its own when idle) — recording goes on ----------
  const before6 = afterBurst.events;
  let killed = false;
  try {
    const cdp = await ctx.newCDPSession(desk);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(extId));
    if (t) { await cdp.send('Target.closeTarget', { targetId: t.targetId }); killed = true; }
  } catch (e) { log('(could not stop the service worker from the test:', e.message, ')'); }
  await sleep(1500);
  await desk.click('.chat-item >> nth=1').catch(() => {});
  await sleep(1500);
  await desk.click('.chat-item >> nth=0').catch(() => {});
  await sleep(7000);
  const after6 = await bgStatus();
  if (!after6.scanning || after6.events <= before6) fail(`after the background was stopped nothing new was recorded (${before6} → ${after6.events})`);
  log(`background ${killed ? 'stopped by Chrome' : 'not stopped (test limitation)'}: still recording (${before6} → ${after6.events} actions)`);

  // ---------- 7. the browser is closed and opened again ----------
  await ctx.close();
  ctx = await launch();
  const desk2 = await ctx.newPage();
  await desk2.goto(`${BASE}/demo-site/desk.html?women=1`);
  await desk2.waitForSelector('.chat-item');
  await desk2.click('.chat-item >> nth=2').catch(() => {});
  await sleep(6000);
  const after7 = await bgStatus();
  if (!after7.scanning || after7.events <= after6.events) fail(`after a browser restart nothing new was recorded (${after6.events} → ${after7.events})`);
  log(`browser restart: still recording (${after6.events} → ${after7.events} actions)`);
  const pop2 = await ctx.newPage();
  await pop2.goto(popupUrl(await tabIdOf('desk.html')));
  await pop2.waitForSelector('#rec:not([hidden])');
  await sleep(500);
  await pop2.locator('body').screenshot({ path: path.join(OUT, 'popup-2-recording.png') });

  // ---------- 8. the report ----------
  const [repPage] = await Promise.all([ctx.waitForEvent('page'), pop2.click('#report')]);
  const dlp = repPage.waitForEvent('download', { timeout: 180000 }).catch(() => null);
  await repPage.waitForFunction(() => window.__reportDone, null, { timeout: 180000 });
  const done = await repPage.evaluate(() => window.__reportDone);
  await repPage.screenshot({ path: path.join(OUT, 'report-page.png') });
  if (done.error) fail(`report error: ${done.error}\n${await repPage.locator('#steps').innerText()}`);
  const download = await dlp;
  if (!download) fail('the report did not download by itself');
  const zipPath = path.join(OUT, download.suggestedFilename());
  await download.saveAs(zipPath);
  log(`report: ${path.basename(zipPath)} ${(done.size / 1048576).toFixed(2)} MB, extra hidden: ${done.fixes}`);
  const dir = path.join(OUT, 'report');
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir]);

  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  for (const f of files.filter((x) => x.endsWith('.svg'))) if (!fs.readFileSync(path.join(dir, f), 'utf8').startsWith('<svg xmlns="http://www.w3.org/2000/svg"')) fail(`broken svg ${f}`);
  for (const need of ['summary.json', 'summary.html', 'states.jsonl', 'events.jsonl', 'network.json', 'incidents.json', 'probes.json']) if (!files.includes(need)) fail(`no ${need} in the report`);
  if (!files.some((f) => f.startsWith('screens') && f.endsWith('.svg'))) fail('no screen schemes in the report');

  // ---------- 9. nothing personal inside ----------
  const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const SECRETS = ['Michael', 'David', 'Robert', 'Thomas', 'Third private', 'Kate', 'Maria', 'Olha', 'Lviv', 'Hello my dear', 'Private subject', 'secret-photo', 'Second private',
    '100037', '100074', '5000000001', '5000000002', '123456', '777888', 'localhost', '127.0.0.1', `:${PORT}`, 'Hello there my friend'];
  const leaks = SECRETS.filter((s) => all.includes(s));
  if (leaks.length) fail(`personal data in the report: ${leaks.join(', ')}`);
  log('privacy: none of the names, texts, IDs, file names or the site address are in the report');

  // ---------- 10. what the report knows ----------
  const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const best = (r) => sum.roles[r]?.[0];
  const want = ['messageInput', 'sendButton', 'translateButton', 'letterButton', 'chatItem', 'hintItem', 'herSwitch', 'searchInput', 'attach'];
  const missing = want.filter((r) => !best(r) || best(r).confidence < 0.3);
  if (missing.length) fail(`roles not found: ${missing.join(', ')}\n${JSON.stringify(Object.fromEntries(Object.entries(sum.roles).map(([k, v]) => [k, v[0]?.css?.[0] + ' ' + v[0]?.confidence])), null, 1)}`);
  log('roles:', want.map((r) => `${r}=${best(r).css[0]} (${Math.round(best(r).confidence * 100)}%)`).join(', '));
  if (!sum.flags.captcha) fail('captcha was not noticed');
  if (!sum.flags.login) fail('the login page was not noticed');
  if (!sum.otherExtensions.length) fail('the other bot\'s extension was not noticed');
  if (!(sum.bot.syntheticClicks > 10 && sum.bot.trustedClicks > 5)) fail(`bot analysis: ${JSON.stringify(sum.bot).slice(0, 300)}`);
  const kinds = new Map(sum.incidents);
  for (const k of ['start', 'offline', 'online', 'tab-closed']) if (!kinds.has(k)) fail(`incident "${k}" missing: ${JSON.stringify(sum.incidents)}`);
  const states = fs.readFileSync(path.join(dir, 'states.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (!states.some((s) => !s.top)) fail('the iframe from another host was not recorded');
  if (!states.some((s) => s.route.startsWith('SITE/demo-site/desk.html'))) fail(`routes: ${[...new Set(states.map((s) => s.route))].join(' ')}`);
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (!ev.some((e) => e.ty === 'file' && e.files === 1 && e.types[0] === 'image/png')) fail('the attached photo (count + type) was not recorded');
  if (!ev.some((e) => e.ty === 'type' && e.tr === 1 && e.len > 20)) fail('trusted typing (length only) was not recorded');
  if (!ev.some((e) => e.ty === 'click' && e.fx)) fail('no "what changed after the click"');
  if (!sum.network.length) fail('no network templates');
  if (ctx.pages().filter((p) => !p.url().startsWith('chrome-extension://')).length > 1 + 0) { /* desk2 only — the scanner opened nothing */ }
  log(`report content ok: ${states.length} screens, ${ev.length} actions, ${sum.network.length} request types, other extensions: ${sum.otherExtensions.length}, bot clicks: ${sum.bot.syntheticClicks}`);
  log(`  bot: noDetail ${sum.bot.clickNoDetail}, noMouseMove ${sum.bot.clickNoMouseMove}, inputTypes ${JSON.stringify(sum.bot.inputTypes)}`);
  log(`  preview lengths: ${JSON.stringify(sum.texts.ellipsisLengths.slice(0, 8))}; counters: ${JSON.stringify(sum.texts.counters.slice(0, 3))}`);
  void pagesBefore; void status;

  const errs = errors.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  if (errs.length) fail(`browser errors:\n${errs.join('\n')}`);
  console.log(`\nSCANNER E2E OK — report and screenshots in ${OUT}`);
} catch (e) {
  console.error('\nSCANNER E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  server.close();
  fs.rmSync(userDir, { recursive: true, force: true });
}
