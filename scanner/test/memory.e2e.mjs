// A whole night in the operator's tab, in short: does the recorder hold on to memory, page elements or listeners?
// The same operator work on the heavy page twice — first without recording, then with it — and the growth per minute
// (after a forced garbage collection) is compared. A leak of 0.25 MB a minute would be 150 MB by the morning.
// Usage: MINUTES=6 node scanner/test/memory.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(HERE, '..');
const MINUTES = Number(process.env.MINUTES || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

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

/** Least-squares slope of y over x. */
const slope = (pts) => {
  const n = pts.length; const mx = pts.reduce((a, p) => a + p[0], 0) / n; const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0); const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? num / den : 0;
};

let ctx;
let failed = false;
try {
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-mem-')), {
    channel: 'chromium', headless: true, viewport: { width: 1360, height: 860 },
    args: [`--disable-extensions-except=${SCANNER}`, `--load-extension=${SCANNER}`, '--js-flags=--expose-gc'],
  });
  let sw = ctx.serviceWorkers()[0];
  for (let i = 0; !sw && i < 50; i++) { await sleep(200); sw = ctx.serviceWorkers()[0]; }
  const extId = new URL(sw.url()).host;
  const inExt = async (fn, arg) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/popup.html`); try { return await p.evaluate(fn, arg); } finally { await p.close(); } };

  const page = await ctx.newPage();
  await page.goto(`${BASE}/fx/heavy.html`);
  await page.waitForSelector('.ChatList_row__k2L3m');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const measure = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(300);
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { heap: m.JSHeapUsedSize / 1e6, nodes: m.Nodes, listeners: m.JSEventListeners };
  };

  let acts = 0;
  const work = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const k = acts++ % 6;
      try {
        if (k === 0) await page.click(`.ChatList_row__k2L3m >> nth=${(acts * 7) % 30}`);
        else if (k === 1) await page.click(`.Hints_item__j3K4l >> nth=${acts % 10}`);
        else if (k === 2) { await page.click('.Composer_input__e5R6t'); await page.keyboard.type('Hello dear friend, how are you', { delay: 3 }); await page.keyboard.press('Enter'); }
        else if (k === 3) { await page.mouse.move(150, 400); await page.mouse.wheel(0, 900); }
        else if (k === 4) await page.click(`.Tabs_tab__c7D8e >> nth=${acts % 5}`);
        else await page.click('.Translate_btn__z5X6c');
      } catch { /* the heavy page re-renders under the cursor now and then */ }
      await sleep(1500 + Math.random() * 1000);
    }
  };
  const phase = async (name) => {
    await work(45000); // warm-up: caches, first screens
    const pts = [];
    const t0 = Date.now();
    for (let i = 0; i <= MINUTES; i++) {
      const m = await measure();
      pts.push({ min: (Date.now() - t0) / 60000, ...m });
      if (i < MINUTES) await work(60000);
    }
    const r = { heap: slope(pts.map((p) => [p.min, p.heap])), nodes: slope(pts.map((p) => [p.min, p.nodes])), listeners: slope(pts.map((p) => [p.min, p.listeners])) };
    log(`${name}: heap ${pts[0].heap.toFixed(1)} → ${pts.at(-1).heap.toFixed(1)} MB (${r.heap.toFixed(3)} MB/min), elements ${pts[0].nodes} → ${pts.at(-1).nodes} (${r.nodes.toFixed(1)}/min), listeners ${pts[0].listeners} → ${pts.at(-1).listeners} (${r.listeners.toFixed(1)}/min)`);
    return r;
  };

  const base = await phase('without recording');
  const tabId = await inExt(() => chrome.tabs.query({}).then((t) => t.find((x) => x.url.includes('heavy.html')).id));
  const r = await inExt((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
  if (!r.ok) throw new Error(`start: ${r.error}`);
  await page.bringToFront();
  const rec = await phase('with recording');
  const st = await inExt(() => chrome.runtime.sendMessage({ type: 'status' }));
  log(`recorded: screens ${st.states}, actions ${st.events}`);
  if (!(st.events > MINUTES * 5)) { failed = true; log(`✗ too few actions recorded (${st.events}) — the recorder did not run`); }

  const extra = { heap: rec.heap - base.heap, nodes: rec.nodes - base.nodes, listeners: rec.listeners - base.listeners };
  const night = (x) => (x * 600).toFixed(0);
  log(`extra growth because of the recorder: ${extra.heap.toFixed(3)} MB/min (≈${night(extra.heap)} MB per 10 h), ${extra.nodes.toFixed(1)} elements/min, ${extra.listeners.toFixed(1)} listeners/min`);
  if (extra.heap > 0.25) { failed = true; log('✗ memory grows because of the recorder'); }
  if (extra.nodes > 60) { failed = true; log('✗ the recorder keeps removed page elements alive'); }
  if (extra.listeners > 3) { failed = true; log('✗ event listeners pile up'); }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await ctx?.close().catch(() => {});
  server.close();
}
console.log(failed ? '\nMEMORY FAILED' : '\nMEMORY OK');
process.exitCode = failed ? 1 : 0;
