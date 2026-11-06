// The morning after a full night: the scanner's storage filled up to every limit — does the report still build?
// Usage: node scanner/test/report-big.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SCANNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'scan-big-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-big-p-')), {
    channel: 'chromium', headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${SCANNER}`, `--load-extension=${SCANNER}`],
  });
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; !sw && i < 50; i++) { await sleep(200); sw = ctx.serviceWorkers()[0]; }
  const id = new URL(sw.url()).host;
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGE ERR', e.message));
  await p.goto(`chrome-extension://${id}/report.html?wait`);
  const t0 = Date.now();
  const seeded = await p.evaluate(async () => {
    const DB = self.__scanDb;
    const node = (k) => ({ p: k ? Math.floor((k - 1) / 3) : -1, d: Math.min(40, Math.floor(Math.log2(k + 1))), tg: ['div', 'span', 'a', 'button', 'li'][k % 5],
      c: [`Cls_item__x1y2${k % 50}`, 'Cls_mod__a1'], a: { 'aria-label': 'Send', 'data-state': 'open', title: '[W] [W]' }, b: [k % 1200, k % 800, 100, 20], v: 1,
      tx: k % 3 ? '[W], # · [тел]' : 'Please write him message', tn: 14, k: 1 + (k % 3), cs: { cur: 1 } });
    const full = (i) => ({ v: 1, t: Date.now() - i * 1000, reason: 'change', route: `SITE/desk/~ab${i % 40}`, top: true, vw: 1360, vh: 860, title: '[W]', lang: 'uk',
      n: Array.from({ length: 1600 }, (_, k) => node(k)), total: 9000, ms: 25, foreign: { count: 1, ext: [] }, sig: `s${i}` });
    let bytes = 0;
    for (let b = 0; b < 300; b += 20) {
      const db = await DB.open();
      const tx = db.transaction('states', 'readwrite');
      for (let i = b; i < b + 20; i++) { const st = full(i); bytes += JSON.stringify(st).length; tx.objectStore('states').put({ sig: st.sig, route: st.route, top: true, frame: 0, first: st.t, last: st.t, count: 3, tabs: [1], state: st }); }
      await new Promise((r) => { tx.oncomplete = r; });
    }
    const light = Array.from({ length: 600 }, (_, i) => ({ sig: `l${i}`, route: `SITE/desk/~cd${i % 60}`, top: true, frame: 0, first: 1, last: 2, count: 5, tabs: [1],
      state: { v: 1, t: Date.now(), route: `SITE/desk/~cd${i % 60}`, n: [], light: 1, best: { sendButton: { score: 1, css: ['button[aria-label="Send"]'], xp: '/html/body' }, flags: { captcha: false } } } }));
    for (let b = 0; b < light.length; b += 100) await DB.add('states', []).then(() => Promise.all(light.slice(b, b + 100).map((x) => DB.put('states', x))));
    const ev = (i) => ({ t: Date.now() - (150000 - i) * 200, ty: ['click', 'type', 'key', 'scroll'][i % 4], tr: i % 3 ? 0 : 1, det: 0, mv: 0, pd: 0, k: 'Enter', n: 12, len: 40, it: ['insertText'],
      d: { tg: 'div', c: ['ChatList_row__k2L3m'], b: [1, 2, 300, 44], tx: '[W], #', path: ['aside.chatlist_list__q9w8e', 'div.app_app__x1y2z', 'div.', 'body.'], row: 3 },
      r: 'SITE/desk/~ab12', tab: 1, top: 1, fx: { firstMs: 12, texts: ['Message sent'], added: [['div.toast_toast__r8t7y', 1]], removed: 1, attrs: [['class', 3]], text: 2, counters: [{ tpl: 'Залишилося # повідомлень', delta: -1 }] } });
    for (let b = 0; b < 150000; b += 5000) await DB.add('events', Array.from({ length: 5000 }, (_, k) => ev(b + k)));
    const nl = (i) => ({ t: Date.now() - (120000 - i) * 250, m: i % 5 ? 'GET' : 'POST', u: `api.SITE/v#/chat/${['send', 'list', 'read', 'typing'][i % 4]}`, ty: 'xmlhttprequest', st: 200, d: 80 + (i % 50), tab: 1, fr: 0 });
    for (let b = 0; b < 120000; b += 6000) await DB.add('netlog', Array.from({ length: 6000 }, (_, k) => nl(b + k)));
    for (let k = 0; k < 400; k++) await DB.put('net', { key: `GET api.SITE/v#/x${k}`, m: 'GET', u: `api.SITE/v#/x${k}`, ty: 'xmlhttprequest', n: 300, st: { 200: 300 }, dsum: 30000, dmax: 900, first: 1, last: 2, err: 0 });
    await DB.add('probes', Array.from({ length: 40 }, (_, k) => ({ t: k, tab: 1, best: { sendButton: { score: 1, css: 'x', live: 1 } }, flags: {} })));
    await DB.add('incidents', Array.from({ length: 300 }, (_, k) => ({ t: k, kind: ['gap', 'offline', 'online', 'pc-idle'][k % 4], minutes: 3 })));
    await DB.put('meta', { k: 'main', tabs: {}, routes: {}, states: 900, overflow: 1200, events: 150000, netlog: 120000, dropped: 30, ticks: 600, full: false, ext: ['abcdefghijklmnopabcdefghijklmnop'],
      startedAt: Date.now() - 10 * 3600e3, seen: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, [40, Date.now()]])), stateBytes: bytes, lightStates: 600 });
    return { mb: Math.round(bytes / 1e6), est: (await navigator.storage.estimate()).usage };
  });
  console.log(`• seeded a full night: full screens ${seeded.mb} MB as JSON, storage ${Math.round(seeded.est / 1e6)} MB, in ${Math.round((Date.now() - t0) / 1000)} s`);
  const t1 = Date.now();
  const dlp = p.waitForEvent('download', { timeout: 600000 });
  await p.evaluate(() => document.getElementById('go').click());
  await p.waitForFunction(() => window.__reportDone, null, { timeout: 600000, polling: 1000 });
  const done = await p.evaluate(() => window.__reportDone);
  const heap = await p.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
  if (done.error) throw new Error(done.error);
  const dl = await dlp;
  const zipPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(zipPath);
  console.log(`• report built in ${Math.round((Date.now() - t1) / 1000)} s: ${(done.size / 1e6).toFixed(1)} MB zip, heap after ${heap} MB, screens ${done.states}, actions ${done.events}`);
  const list = execFileSync('unzip', ['-l', zipPath]).toString().trim().split('\n');
  console.log(`• zip entries: ${list.length - 5}; last: ${list.slice(-1)[0].trim()}`);
  execFileSync('unzip', ['-tq', zipPath]);
  console.log('• zip integrity ok');
  console.log(`\nBIG REPORT OK — ${zipPath}`);
} catch (e) {
  console.error('\nBIG REPORT FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
}
