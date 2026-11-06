// A heavy page like a real operator desk (≈15 000 elements, hashed class names, a clock, "typing…", online dots,
// a virtual list, toasts) + another bot extension, for MINUTES minutes of operator work.
// Checks: the page does not slow down because of the scanner, screens keep being recorded although the page never
// stops changing, nothing personal in the report, the site's own web component is not taken for another extension.
// Usage: MINUTES=10 OUT=dir node scanner/test/heavy.e2e.mjs
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
const OTHERBOT = path.join(HERE, 'otherbot');
const MINUTES = Number(process.env.MINUTES || 6);
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'scan-heavy-'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const fail = (m) => { throw new Error(m); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  const f = path.join(HERE, 'fixtures', u.pathname.replace(/^\/fx\//, ''));
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-heavy-profile-'));
let ctx;
const LAG = () => {
  window.__lag = { max: 0, over100: 0, samples: 0 };
  let last = performance.now();
  setInterval(() => { const now = performance.now(); const d = now - last - 50; last = now; window.__lag.samples++; if (d > window.__lag.max) window.__lag.max = d; if (d > 100) window.__lag.over100++; }, 50);
};

try {
  ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium', headless: true, viewport: { width: 1360, height: 860 }, acceptDownloads: true,
    args: [`--disable-extensions-except=${SCANNER},${OTHERBOT}`, `--load-extension=${SCANNER},${OTHERBOT}`],
  });
  let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  for (let i = 0; !sw && i < 50; i++) { await sleep(200); sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js')); }
  const extId = new URL(sw.url()).host;
  const inExt = async (fn, arg) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/popup.html`); try { return await p.evaluate(fn, arg); } finally { await p.close(); } };

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/fx/heavy.html`);
  await page.waitForSelector('.ChatList_row__k2L3m');
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  log(`heavy page: ${nodes} elements`);

  // ---- the page alone (baseline) ----
  await page.evaluate(LAG);
  await sleep(20000);
  const base = await page.evaluate(() => ({ ...window.__lag }));
  log(`without the scanner: max lag ${Math.round(base.max)} ms, >100 ms ${base.over100}/${base.samples}`);

  // ---- start recording ----
  const tabId = await inExt(() => chrome.tabs.query({}).then((t) => t.find((x) => x.url.includes('heavy.html')).id));
  const r = await inExt((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
  if (!r.ok) fail(`start: ${r.error}`);
  await page.bringToFront();
  await page.evaluate(() => { window.__lag = { max: 0, over100: 0, samples: 0 }; });

  // ---- operator work ----
  const end = Date.now() + MINUTES * 60000;
  let acts = 0;
  while (Date.now() < end) {
    const k = acts++ % 7;
    try {
      if (k === 0) await page.click(`.ChatList_row__k2L3m >> nth=${(acts * 7) % 30}`);
      else if (k === 1) await page.click(`.Hints_item__j3K4l >> nth=${acts % 10}`);
      else if (k === 2) { await page.click('.Composer_input__e5R6t'); await page.keyboard.type(`Hello dear ${['Michael', 'Kevin'][acts % 2]}, I miss you so much`, { delay: 4 }); await page.keyboard.press('Enter'); }
      else if (k === 3) { await page.mouse.move(150, 400); await page.mouse.wheel(0, 900); }
      else if (k === 4) await page.click(`.Tabs_tab__c7D8e >> nth=${acts % 5}`);
      else if (k === 5) await page.click('[aria-label="Like"]');
      else await page.click('.Translate_btn__z5X6c');
    } catch (e) { errors.push(`action ${k}: ${e.message.split('\n')[0]}`); }
    await sleep(2500 + Math.random() * 2000);
  }
  const withScan = await page.evaluate(() => ({ ...window.__lag }));
  log(`with the scanner (${MINUTES} min, ${acts} actions): max lag ${Math.round(withScan.max)} ms, >100 ms ${withScan.over100}/${withScan.samples}`);
  const st = await inExt(() => chrome.runtime.sendMessage({ type: 'status' }));
  log(`status: screens ${st.states}, actions ${st.events}, request types ${st.net}, storage ${st.usage ? Math.round(st.usage / 1e6) : '?'} MB`);

  // ---- report ----
  const rep = await ctx.newPage();
  const dlp = rep.waitForEvent('download', { timeout: 240000 });
  await rep.goto(`chrome-extension://${extId}/report.html`);
  await rep.waitForFunction(() => window.__reportDone, null, { timeout: 240000 });
  const done = await rep.evaluate(() => window.__reportDone);
  if (done.error) fail(`report: ${done.error}`);
  const dl = await dlp;
  const zipPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  const dir = path.join(OUT, 'report');
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir]);
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const SECRETS = ['Michael', 'Kevin', 'Brown', 'Wilson', 'michael_brown', 'Michael_Brown', 'david_wilson', 'Central Park', 'Emily', 'Denver', 'Portland', '1408', 'Anna', '500001234', '700000000', '700007919', 'miss you', 'localhost'];
  const leaks = SECRETS.filter((x) => (/^\d+$/.test(x) ? new RegExp(`(?<!\\d)${x}(?!\\d)`).test(all) : all.includes(x))); // numbers: not inside timestamps
  if (leaks.length) fail(`personal data in the report: ${leaks.join(', ')}`);
  const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const errKinds = (sum.incidents || []).filter(([k]) => /error/.test(k));
  if (errKinds.length) fail(`inner errors of the scanner: ${JSON.stringify(errKinds)}`);
  const states = files.filter((f) => f.startsWith('states/')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const seenTotal = states.reduce((a, s) => a + s.count, 0);
  const snapMs = states.map((s) => s.state.ms || 0);
  log(`report: ${(done.size / 1e6).toFixed(2)} MB, screens ${states.length}, screen views ${seenTotal}, snapshot ms max ${Math.max(...snapMs)} avg ${Math.round(snapMs.reduce((a, b) => a + b, 0) / snapMs.length)}`);
  if (seenTotal < MINUTES * 4) fail(`too few screen views (${seenTotal}) — snapshots starve while the page keeps changing`);
  const ep = states.flatMap((s) => s.state.n || []).filter((n) => n.tg === 'emoji-picker');
  if (!ep.length || ep.some((n) => n.f)) fail('the site\'s own web component was taken for another extension (or not recorded)');
  const best = (k) => sum.roles[k]?.[0];
  for (const [role, re] of [['messageInput', /Composer_input|textbox|Write a message/], ['sendButton', /Send/], ['chatItem', /ChatList_row/], ['hintItem', /Hints_item/], ['translateButton', /Translate/], ['counter', /.*/]]) {
    if (!best(role) || !re.test(best(role).css.join(' '))) fail(`role ${role}: ${JSON.stringify(best(role)?.css)}`);
  }
  log('roles:', ['messageInput', 'sendButton', 'chatItem', 'hintItem', 'translateButton', 'counter', 'letterButton', 'likeButton', 'attach'].map((k) => `${k}=${best(k)?.css?.[0]} ${Math.round((best(k)?.confidence || 0) * 100)}%`).join(', '));
  if (!sum.toasts.some(([t]) => /Message sent/.test(t))) fail(`toasts after Send not caught: ${JSON.stringify(sum.toasts.slice(0, 5))}`);
  log('toasts after actions:', JSON.stringify(sum.toasts.slice(0, 4)), '· page facts:', JSON.stringify(sum.pages.frameworks), sum.pages.routes[0]?.maxNodes, 'nodes');
  const extra = withScan.max - base.max;
  if (extra > 150) fail(`the scanner slows the page: +${Math.round(extra)} ms max lag`);
  const errs = errors.filter((e) => !/Failed to fetch|net::/.test(e));
  if (errs.length) fail(`errors: ${errs.join(' | ')}`);
  console.log(`\nHEAVY OK — ${OUT}`);
} catch (e) {
  console.error('\nHEAVY FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  server.close();
  fs.rmSync(userDir, { recursive: true, force: true });
}
