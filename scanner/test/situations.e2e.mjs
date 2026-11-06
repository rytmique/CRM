// Night situations, one by one, in a real Chromium with the scanner:
// non-site tab, other sites not recorded, password never recorded, stop → resume, report while recording,
// a second domain without losing data, the per-page screen limit, sleep gap, full-screen budget, probes, reset + empty report.
// Usage: node scanner/test/situations.e2e.mjs
import http from 'node:http';
import crypto from 'node:crypto';
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
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'scan-sit-'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, info = '') => { results.push([cond ? '✓' : '✗', name, info]); console.log(`${cond ? '✓' : '✗'} ${name}${info ? ` — ${info}` : ''}`); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = null;
  if (u.pathname.startsWith('/demo-site/')) f = path.join(ROOT, u.pathname);
  else if (u.pathname.startsWith('/fx/profile/')) f = path.join(HERE, 'fixtures', 'profile.html'); // /fx/profile/<username>
  else if (u.pathname.startsWith('/fx/')) f = path.join(HERE, 'fixtures', u.pathname.slice(4));
  if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : 'text/css' });
  fs.createReadStream(f).pipe(res);
});
// a websocket like a chat's live channel: the handshake only, then it stays open
const sockets = new Set();
server.on('upgrade', (req, socket) => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const SITE = `http://localhost:${PORT}`;
const OTHER = `http://127.0.0.1:${PORT}`;

let ctx;
try {
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-sit-p-')), {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 820 }, acceptDownloads: true,
    args: [`--disable-extensions-except=${SCANNER}`, `--load-extension=${SCANNER}`],
  });
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; !sw && i < 50; i++) { await sleep(200); sw = ctx.serviceWorkers()[0]; }
  const id = new URL(sw.url()).host;
  const ext = await ctx.newPage(); // an extension page with the scanner's DB helpers (does not build anything with ?wait)
  await ext.goto(`chrome-extension://${id}/report.html?wait`);
  const msg = (m) => ext.evaluate((x) => chrome.runtime.sendMessage(x), m);
  const tabOf = (needle) => ext.evaluate((n) => chrome.tabs.query({}).then((t) => t.find((x) => (x.url || '').includes(n))?.id), needle);
  const popupFor = async (tabId) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/popup.html${tabId ? `?tab=${tabId}` : ''}`); await sleep(600); return p; };
  const badge = () => ext.evaluate(() => chrome.action.getBadgeText({}));
  const readAll = (store) => ext.evaluate(async (s) => { const out = []; await self.__scanDb.each(s, (v) => out.push(v)); return out; }, store);
  const killSW = async (page) => {
    const cdp = await ctx.newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(id));
    if (t) await cdp.send('Target.closeTarget', { targetId: t.targetId });
    return Boolean(t);
  };
  const report = async () => {
    const p = await ctx.newPage();
    const dlp = p.waitForEvent('download', { timeout: 120000 }).catch(() => null);
    await p.goto(`chrome-extension://${id}/report.html`);
    await p.waitForFunction(() => window.__reportDone, null, { timeout: 120000 });
    const done = await p.evaluate(() => window.__reportDone);
    const dl = await dlp;
    let dir = null;
    if (dl) { const z = path.join(OUT, `${Date.now()}-${dl.suggestedFilename()}`); await dl.saveAs(z); dir = `${z}.d`; execFileSync('unzip', ['-q', '-o', z, '-d', dir]); }
    await p.close();
    return { done, dir };
  };

  // 1. a page that is not a website: the button is off
  const blank = await ctx.newPage();
  await blank.goto('about:blank');
  const p1 = await popupFor(await tabOf('about:blank'));
  ok('на вкладці без сайту кнопка «Вивчити сайт» вимкнена', await p1.locator('#start').isDisabled(), await p1.locator('#idle-note').innerText());
  await p1.close();

  // 2. start on the site; the popup names the site
  const site = await ctx.newPage();
  await site.goto(`${SITE}/demo-site/desk.html?women=1`);
  await site.waitForSelector('.chat-item');
  const p2 = await popupFor(await tabOf('desk.html'));
  const hostShown = await p2.locator('#site').innerText();
  ok('вікно показує, який сайт буде записано', hostShown.includes('localhost'), hostShown);
  await p2.click('#start');
  await p2.waitForSelector('#rec:not([hidden])');
  await p2.close();
  ok('на значку REC', (await badge()) === 'REC');

  // 3. password and typed text: never recorded
  const login = await ctx.newPage();
  await login.goto(`${SITE}/fx/morph.html`);
  await sleep(1500);
  await login.click('.pwd');
  await login.keyboard.type('SuperSecret123', { delay: 5 });
  await login.click('.login');
  await login.keyboard.type('operator.login', { delay: 5 });
  await sleep(4000);

  // 4. another website in the same browser: nothing of it is recorded
  const other = await ctx.newPage();
  await other.goto(`${OTHER}/demo-site/search.html`);
  await other.click('.man-card >> nth=0 >> .btn-write');
  await sleep(4000);
  await msg({ type: 'flush' });
  const states1 = await readAll('states');
  const net1 = await readAll('netlog');
  const ev1 = await readAll('events');
  ok('чужий сайт не записаний (екрани)', !states1.some((s) => s.route.includes('search.html')), `${states1.length} екранів`);
  ok('чужий сайт не записаний (запити)', !net1.some((r) => r.u.includes('search.html')), `${net1.length} запитів`);
  const pwdType = ev1.filter((e) => e.ty === 'type' && e.d?.a?.type === 'password');
  ok('пароль: лише факт набору, без довжини й тексту', pwdType.length > 0 && pwdType.every((e) => e.len === undefined), JSON.stringify(pwdType[0] || {}).slice(0, 120));
  ok('ніде немає набраного тексту', !JSON.stringify([states1, ev1]).includes('SuperSecret') && !JSON.stringify([states1, ev1]).includes('operator.login'));

  // 5. a page that keeps changing shape: the per-page limit holds
  await login.bringToFront();
  const t5 = Date.now();
  let states2 = [];
  let meta2 = {};
  let morph = 0;
  while (Date.now() - t5 < 300000) { // a new shape every ~3 s → the limit of 60 is reached in ~3–4 min
    await sleep(10000);
    await msg({ type: 'flush' });
    states2 = await readAll('states');
    meta2 = await ext.evaluate(() => self.__scanDb.get('meta', 'main'));
    morph = states2.filter((s) => s.route.includes('fx')).length;
    if (meta2.overflow > 3) break;
  }
  ok('ліміт екранів на одну сторінку тримається', morph <= 60 && meta2.overflow > 0, `екранів цієї сторінки ${morph}, понад ліміт ${meta2.overflow}`);

  // 5b. men's profiles with a username in the address: one layout = one screen (they must not eat the screen limit), no name leaks
  const prof = await ctx.newPage();
  const NAMES = ['anna_k', 'olga.m', 'iryna', 'svetlana', 'natalia_v', 'oksana-p', 'viktoriia'];
  for (const nm of NAMES) { await prof.goto(`${SITE}/fx/profile/${nm}`); await sleep(2600); }
  await sleep(2000);
  await msg({ type: 'flush' });
  const profStates = (await readAll('states')).filter((s) => s.route.includes('/profile/'));
  const profSeen = profStates.reduce((a, s) => a + s.count, 0);
  ok('профілі з іменем в адресі: один екран, а не по екрану на кожного', profStates.length <= 2 && profSeen >= NAMES.length, `екранів ${profStates.length}, переглядів ${profSeen}`);
  const profJson = JSON.stringify([profStates, await readAll('events')]).toLowerCase();
  ok('імена з адрес профілів ніде не записані', NAMES.every((nm) => !profJson.includes(nm.split(/[._-]/)[0])));
  await prof.close();

  // 5c. the site's live channel (websocket): noted the moment it opens, although it never "completes"
  const wsOpen = await site.evaluate((u) => new Promise((r) => { const w = new WebSocket(u); window.__ws = w; w.onopen = () => r(true); w.onerror = () => r(false); setTimeout(() => r(false), 5000); }), `${SITE.replace('http', 'ws')}/socket/chat?sid=777`);
  await sleep(1500);
  await msg({ type: 'flush' });
  const wsLog = (await readAll('netlog')).filter((r) => r.ty === 'websocket');
  ok('живий канал сайту (websocket) записано', wsOpen && wsLog.some((r) => r.st === 101 && r.u.startsWith('ws://SITE/socket/chat?')), JSON.stringify(wsLog[0] || {}).slice(0, 120));

  // 6. report while recording: recording goes on
  const evBefore = (await msg({ type: 'status' })).events;
  const r1 = await report();
  await site.bringToFront();
  await site.click('.chat-item >> nth=1');
  await sleep(6000);
  const evAfter = (await msg({ type: 'status' })).events;
  ok('звіт посеред запису зібрався', !r1.done.error && Boolean(r1.dir), `${(r1.done.size / 1024).toFixed(0)} КБ`);
  ok('після звіту запис іде далі', evAfter > evBefore, `${evBefore} → ${evAfter}`);
  if (r1.dir) {
    const leak = execFileSync(process.execPath, [path.join(HERE, 'leaks.mjs'), r1.dir], { encoding: 'utf8' }).trim().split('\n')[0];
    ok('детектор витоків: звіт чистий', leak.startsWith('no leaks'), leak);
  }

  // 7. sleep of the computer: a gap is noticed; the full-screen budget switches to "roles only"
  await killSW(site);
  await ext.evaluate(async () => { const m = await self.__scanDb.get('meta', 'main'); m.lastTick = Date.now() - 10 * 60000; m.stateBytes = 2e9; await self.__scanDb.put('meta', m); });
  await killSW(site); // in case a page woke it up in between: next start reads the changed counters
  await site.reload();
  await site.waitForSelector('.chat-item');
  await site.click('.her-switch');
  await site.click('.her-item >> nth=2');
  const t7 = Date.now();
  let gap = false;
  while (!gap && Date.now() - t7 < 80000) { await sleep(5000); gap = (await readAll('incidents')).some((i) => i.kind === 'gap'); }
  ok('перерву (сон / вимкнений браузер) помічено', gap);
  await sleep(3000);
  const light = (await readAll('states')).filter((s) => s.state.light);
  ok('коли місце для повних екранів скінчилось — пишуться ролі без елементів', light.length > 0 && light.every((s) => !s.state.n.length && s.state.best), `${light.length} легких`);

  // 8. stop → nothing is recorded; resume → recording again (on any tab)
  await msg({ type: 'stop' });
  ok('після «Зупинити» значок ■', (await badge()) === '■');
  const evStop = (await msg({ type: 'status' })).events;
  await site.click('.chat-item >> nth=0');
  await sleep(5000);
  ok('зупинений сканер нічого не пише', (await msg({ type: 'status' })).events === evStop);
  const r8 = await msg({ type: 'resume' });
  await sleep(1500);
  await site.click('.chat-item >> nth=0');
  await sleep(6000);
  ok('«Продовжити» з будь-якої вкладки', r8.ok && (await msg({ type: 'status' })).events > evStop && (await badge()) === 'REC', JSON.stringify(r8));
  const sites8 = (await msg({ type: 'status' })).sites;
  ok('«Продовжити» не додає чужий сайт', sites8.length === 1, sites8.join(', '));

  // 9. «Вивчити сайт» on another domain of the work: added, nothing wiped
  const statesBefore9 = (await msg({ type: 'status' })).states;
  const r9 = await msg({ type: 'start', tabId: await tabOf('127.0.0.1') });
  const st9 = await msg({ type: 'status' });
  ok('другий сайт додано, записане не стерто', r9.ok && st9.sites.length === 2 && st9.states >= statesBefore9, `${st9.sites.length} сайти, екранів ${statesBefore9} → ${st9.states}`);
  // the second site sits on an IP address (127.0.0.1): it is recorded too, as a whole address
  await other.bringToFront();
  await other.reload();
  await other.waitForSelector('.man-card');
  await other.click('.man-card >> nth=1 >> .btn-write');
  await sleep(6000);
  await msg({ type: 'flush' });
  const ipStates = (await readAll('states')).filter((s) => s.route.includes('search.html'));
  ok('сайт на IP-адресі записується', st9.sites.includes('127.0.0.1') && ipStates.length > 0, `${st9.sites.join(', ')}; екранів ${ipStates.length}`);

  // 10. probes (every 20 min, first after 3 min): what the bot sees right now
  const t10 = Date.now();
  let probes = [];
  while (!probes.length && Date.now() - t10 < 200000) { await sleep(10000); probes = await readAll('probes'); }
  ok('перевірка «що бот бачить» спрацювала', probes.some((p) => p.best && Object.keys(p.best).length), probes[0] ? Object.keys(probes[0].best || {}).slice(0, 6).join(', ') : 'немає');

  // the whole night above: no inner errors of the scanner itself
  const bad = (await readAll('incidents')).filter((i) => /error/.test(i.kind));
  ok('за весь тест жодної внутрішньої помилки сканера', !bad.length, bad.map((i) => `${i.kind}:${i.where || ''}:${i.note || ''}`).join(' | ').slice(0, 300));

  // 11. reset → empty; a report of nothing still builds
  await msg({ type: 'reset' });
  const st11 = await msg({ type: 'status' });
  ok('«Почати заново» все стирає', !st11.has && st11.states === 0 && st11.events === 0 && (await badge()) === '');
  const r11 = await report();
  ok('звіт з порожньої бази не ламається', !r11.done.error, r11.done.error || `${r11.done.size} Б`);
} catch (e) {
  ok('тест дійшов до кінця', false, e.message.split('\n')[0]);
} finally {
  await ctx?.close().catch(() => {});
  for (const so of sockets) so.destroy();
  server.close();
  const bad = results.filter((r) => r[0] === '✗');
  console.log(`\n${bad.length ? `SITUATIONS FAILED: ${bad.length}` : 'SITUATIONS OK'} (${results.length} checks)`);
  process.exitCode = bad.length ? 1 : 0;
}
