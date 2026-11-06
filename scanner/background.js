/* global importScripts */
// Scanner background: turns the recorder on for the operator's site, stores what it sends, watches the network
// (address templates only), tabs, sleep and restarts. Never opens tabs, never clicks, never touches the page.
importScripts('dict.js', 'roles.js', 'db.js');

const M = self.__scanMask;
const DB = self.__scanDb;
const VERSION = chrome.runtime.getManifest().version;

const CAP = { states: 900, perRoute: 60, stateBytes: 90e6, events: 150000, netlog: 120000, bytes: 1.5e9 };
const R = self.__scanRoles;
const NET_SKIP_LOG = new Set(['image', 'font', 'media', 'stylesheet', 'imageset']);

// ---------------- config (chrome.storage.local "scan") ----------------
let scanCache = null;
let scanLoaded = false; // settings read once per wake-up; later changes come through setScan / storage.onChanged
async function getScan() {
  if (scanLoaded) return scanCache;
  const { scan } = await chrome.storage.local.get('scan');
  if (!scanLoaded) { scanCache = scan || null; scanLoaded = true; }
  return scanCache;
}
async function setScan(v) {
  scanCache = v;
  scanLoaded = true;
  await chrome.storage.local.set({ scan: v });
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.scan) { scanCache = ch.scan.newValue || null; scanLoaded = true; } });

/** Wraps listeners: an unexpected error becomes an incident in the report, never an «Errors» badge for the operator. */
const safe = (name, fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { try { await DB.add('incidents', [{ t: Date.now(), kind: 'internal-error', where: name, note: String(e?.message || e).slice(0, 120) }]); } catch { /* ignore */ } return undefined; }
};
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); });

const ours = (host, scan) => Boolean(host && scan?.siteDomains?.some((d) => host === d || host.endsWith(`.${d}`)));
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

// ---------------- meta (counters, tab numbers, routes) ----------------
let meta = null;
async function getMeta() {
  if (meta) return meta;
  meta = (await DB.get('meta', 'main').catch(() => null)) || { k: 'main', tabs: {}, routes: {}, states: 0, overflow: 0, events: 0, netlog: 0, dropped: 0, ticks: 0, full: false, ext: [] };
  return meta;
}
let metaDirty = false;
function touchMeta() { metaDirty = true; }
async function saveMeta() {
  if (!metaDirty || !meta) return;
  metaDirty = false;
  await DB.put('meta', meta).catch(() => { metaDirty = true; });
}
setInterval(saveMeta, 5000);

// repeat views of known screens (up to 5000 counters): a record of their own, written at most every 30 s — not inside meta,
// which is written every 5 s
let seenRec = null;
let seenDirty = false;
let seenSavedAt = 0;
async function getSeen() {
  if (seenRec) return seenRec;
  const rec = (await DB.get('meta', 'seen').catch(() => null)) || { k: 'seen', map: {}, n: 0 };
  const m = await getMeta();
  if (m.seen) { // recorded by 1.2.0 inside meta: move it out
    for (const [k, v] of Object.entries(m.seen)) if (!rec.map[k] && rec.n < 5000) { rec.map[k] = v; rec.n++; }
    delete m.seen; delete m.seenN;
    touchMeta();
    seenDirty = true;
  }
  seenRec ||= rec;
  return seenRec;
}
async function saveSeen() {
  if (!seenDirty || !seenRec) return;
  seenDirty = false;
  seenSavedAt = Date.now();
  await DB.put('meta', seenRec).catch(() => { seenDirty = true; });
}

async function tabNo(tabId) {
  const m = await getMeta();
  if (tabId == null || tabId < 0) return 0;
  if (!m.tabs[tabId]) { m.tabs[tabId] = Object.keys(m.tabs).length + 1; touchMeta(); }
  return m.tabs[tabId];
}

async function incident(kind, extra = {}) {
  await DB.add('incidents', [{ t: Date.now(), kind, ...extra }]).catch(() => {});
}

// ---------------- the recorder in pages ----------------
const FILES = ['dict.js', 'roles.js', 'content.js'];
/** Address patterns of the site: the domain with all its subdomains; an IP address exactly (it has no subdomains). */
const sitePatterns = (scan) => scan.siteDomains.map((d) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(':') ? `*://${d}/*` : `*://*.${d}/*`));
// one registration at a time: the start, a wake-up and a «frames» message can come together → «Duplicate script ID»
let regChain = Promise.resolve();
function registerRecorder(scan) {
  const run = regChain.then(() => registerRecorderNow(scan));
  regChain = run.catch(() => {});
  return run;
}
async function registerRecorderNow(scan) {
  const want = [{ id: 'rec', matches: sitePatterns(scan) }];
  if (scan.frameOrigins?.length) want.push({ id: 'rec-frames', matches: [...new Set(scan.frameOrigins.map((o) => { const u = new URL(o); return `${u.protocol}//${u.hostname}/*`; }))] });
  const have = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  for (const w of want) {
    const cur = have.find((h) => h.id === w.id);
    if (cur && JSON.stringify(cur.matches) === JSON.stringify(w.matches)) continue;
    if (cur) await chrome.scripting.unregisterContentScripts({ ids: [w.id] }).catch(() => {});
    const def = { id: w.id, matches: w.matches, js: FILES, allFrames: true, runAt: 'document_idle', persistAcrossSessions: true };
    // also blank / srcdoc frames the site makes for its widgets (needs a newer Chrome — without it, the rest still works)
    try { await chrome.scripting.registerContentScripts([{ ...def, matchOriginAsFallback: true }]); } catch { await chrome.scripting.registerContentScripts([def]); }
  }
}
async function unregisterRecorder() {
  const have = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((h) => h.id) }).catch(() => {});
}
/** Tabs of the site that were already open when recording started (or after an update of the scanner). */
async function injectOpenTabs(scan) {
  const tabs = await chrome.tabs.query({ url: sitePatterns(scan) }).catch(() => []);
  for (const t of tabs) {
    await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: FILES }).catch(() => {});
  }
  return tabs.length;
}

async function ensureRunning(reason) {
  const scan = await getScan();
  if (!scan?.scanning) { chrome.action.setBadgeText({ text: scan?.siteDomains ? '■' : '' }); return; }
  await registerRecorder(scan).catch((e) => incident('register-error', { note: String(e?.message || e).slice(0, 120) }));
  const { injected } = await chrome.storage.session.get('injected').catch(() => ({}));
  if (reason !== 'boot' || !injected) {
    await injectOpenTabs(scan);
    await chrome.storage.session.set({ injected: Date.now() }).catch(() => {});
  }
  chrome.action.setBadgeBackgroundColor({ color: '#d6336c' });
  chrome.action.setBadgeText({ text: 'REC' });
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some((a) => a.name === 'tick')) chrome.alarms.create('tick', { periodInMinutes: 1 });
  if (!alarms.some((a) => a.name === 'probe' && a.periodInMinutes === 20)) chrome.alarms.create('probe', { delayInMinutes: 3, periodInMinutes: 20 });
  if (!alarms.some((a) => a.name === 'space')) chrome.alarms.create('space', { periodInMinutes: 30 });
}

// ---------------- storing what pages send ----------------
async function storeState(st, tab, frameId) {
  const m = await getMeta();
  const existing = await DB.get('states', st.sig).catch(() => null);
  if (existing) {
    existing.count++;
    existing.last = st.t;
    existing.tabs = [...new Set([...(existing.tabs || []), tab])].slice(0, 20);
    await DB.put('states', existing);
    return;
  }
  const perRoute = m.routes[st.route] || 0;
  if (m.full || m.states >= CAP.states || perRoute >= CAP.perRoute) {
    m.overflow++; // only a counter: new addresses (every new profile) must not grow the settings once the limit is reached
    touchMeta();
    return;
  }
  m.states++;
  m.routes[st.route] = perRoute + 1;
  for (const id of st.foreign?.ext || []) if (!m.ext.includes(id)) m.ext.push(id);
  const size = JSON.stringify(st).length;
  m.stateBytes = (m.stateBytes || 0) + size;
  touchMeta();
  let keep = st;
  if (m.stateBytes > CAP.stateBytes) {
    // the budget for full screens is used up: keep what the scanner recognised on this screen, without the elements
    let best = {};
    try { const c = R.classify(st); best = Object.fromEntries(Object.entries(c.roles).filter(([, l]) => l[0]).map(([k, l]) => [k, { score: l[0].score, css: l[0].css, xp: l[0].xp }])); best.flags = c.flags; } catch { /* ignore */ }
    keep = { ...st, n: [], light: 1, best };
    m.lightStates = (m.lightStates || 0) + 1;
  }
  await DB.put('states', { sig: st.sig, route: st.route, top: st.top, frame: frameId || 0, first: st.t, last: st.t, count: 1, tabs: [tab], size, state: keep });
}

/** Repeat views of known screens: only counters (kept in meta, merged into the screens in the report). */
async function seen(msg) {
  const s = await getSeen();
  for (const [sig, n, last] of msg.list || []) {
    let c = s.map[sig];
    if (!c) { if (s.n >= 5000) continue; s.n++; c = s.map[sig] = [0, 0]; } // a page of endless shapes cannot bloat it
    c[0] += n;
    c[1] = Math.max(c[1], last);
  }
  seenDirty = true;
  if (Date.now() - seenSavedAt > 30000) await saveSeen();
}

async function storeEvents(list, tab, top, dropped) {
  const m = await getMeta();
  if (dropped) { m.dropped += dropped; touchMeta(); }
  if (!list.length) return;
  await DB.add('events', list.map((e) => ({ ...e, tab, top: top ? 1 : 0 })));
  m.events += list.length;
  touchMeta();
  if (m.events > CAP.events + 5000) { await DB.trim('events', 5000, 20000); m.events -= 5000; m.eventsTrimmed = (m.eventsTrimmed || 0) + 5000; }
}

// ---------------- network: templates of addresses, status and time — never bodies, headers or cookies ----------------
const pending = new Map(); // requestId → start
let netBuf = [];
const netAgg = new Map();
const early = [];
function netStart(d) {
  if (d.tabId < 0 && !d.initiator) return;
  if (!scanLoaded) {
    // the background just woke up and has not read its settings yet: keep the first requests for a moment
    if (early.length < 300) early.push(d);
    if (early.length === 1) getScan().then(() => { for (const x of early.splice(0)) netStart(x); }).catch(() => { early.length = 0; });
    return;
  }
  const scan = scanCache;
  if (!scan?.scanning) return;
  const fromSite = ours(hostOf(d.initiator || d.documentUrl || ''), scan) || ((d.type === 'main_frame' || d.type === 'sub_frame') && ours(hostOf(d.url), scan));
  if (!fromSite) return;
  pending.set(d.requestId, { t: d.timeStamp, m: d.method, url: d.url, ty: d.type, tab: d.tabId, fr: d.frameId });
  if (pending.size > 5000) pending.delete(pending.keys().next().value);
  // a websocket stays open for hours and may never "complete": note it the moment it opens (status 101 = switched to websocket)
  if (d.type === 'websocket') netEnd({ requestId: d.requestId, statusCode: 101, timeStamp: d.timeStamp }, false);
}
function netEnd(d, err) {
  const p = pending.get(d.requestId);
  if (!p) return;
  pending.delete(d.requestId);
  const tpl = M.maskUrl(p.url, scanCache?.siteDomains || []);
  const e = { t: Math.round(p.t), m: p.m, u: tpl, ty: p.ty, st: err ? 0 : d.statusCode, d: Math.round(d.timeStamp - p.t), tabId: p.tab, fr: p.fr ? 1 : 0 };
  if (err) e.err = String(d.error || '').replace(/[^A-Z_:.]/gi, '').slice(0, 40);
  if (d.fromCache) e.c = 1;
  const key = `${p.m} ${tpl}`;
  const a = netAgg.get(key) || { key, m: p.m, u: tpl, ty: p.ty, n: 0, st: {}, dsum: 0, dmax: 0, first: e.t, last: e.t, err: 0 };
  a.n++;
  a.st[e.st] = (a.st[e.st] || 0) + 1;
  a.dsum += e.d;
  a.dmax = Math.max(a.dmax, e.d);
  a.last = e.t;
  if (err) a.err++;
  netAgg.set(key, a);
  if (!NET_SKIP_LOG.has(p.ty)) netBuf.push(e);
  if (netBuf.length >= 200) flushNet();
}
let netFlushing = false;
async function flushNet() {
  if (netFlushing || (!netBuf.length && !netAgg.size)) return;
  netFlushing = true;
  const buf = netBuf; netBuf = [];
  const agg = new Map(netAgg); netAgg.clear();
  try {
    const m = await getMeta();
    for (const e of buf) { e.tab = await tabNo(e.tabId); delete e.tabId; }
    await DB.add('netlog', buf);
    m.netlog += buf.length;
    if (m.netlog > CAP.netlog + 5000) { await DB.trim('netlog', 5000, 20000); m.netlog -= 5000; }
    await DB.update('net', [...agg.keys()], (k, old) => {
      const a = agg.get(k);
      if (!old) return a;
      old.n += a.n; old.dsum += a.dsum; old.dmax = Math.max(old.dmax, a.dmax); old.last = a.last; old.err += a.err;
      for (const [s, c] of Object.entries(a.st)) old.st[s] = (old.st[s] || 0) + c;
      return old;
    });
    touchMeta();
  } catch (e) {
    incident('net-store-error', { note: String(e?.message || e).slice(0, 120) });
  } finally {
    netFlushing = false;
  }
}
setInterval(flushNet, 5000);
chrome.webRequest.onBeforeRequest.addListener(netStart, { urls: ['<all_urls>'] });
chrome.webRequest.onCompleted.addListener((d) => netEnd(d, false), { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((d) => netEnd(d, true), { urls: ['<all_urls>'] });

// ---------------- tabs, windows, sleep, restarts ----------------
const siteTabs = new Set();
async function isSiteTab(tabId) {
  if (siteTabs.has(tabId)) return true;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const scan = await getScan();
  const yes = Boolean(t && ours(hostOf(t.url || t.pendingUrl || ''), scan));
  if (yes) siteTabs.add(tabId);
  return yes;
}
async function timeline(e) {
  const scan = await getScan();
  if (!scan?.scanning) return;
  await DB.add('events', [{ t: Date.now(), ...e }]).catch(() => {});
  const m = await getMeta(); m.events++; touchMeta();
}
chrome.tabs.onActivated.addListener(safe('tab-focus', async ({ tabId }) => { const site = await isSiteTab(tabId); await timeline({ ty: 'tab-focus', site: site ? 1 : 0, tab: site ? await tabNo(tabId) : 0 }); }));
chrome.windows.onFocusChanged.addListener(safe('window-focus', async (wid) => { await timeline({ ty: 'window-focus', none: wid === chrome.windows.WINDOW_ID_NONE ? 1 : 0 }); }));
chrome.tabs.onRemoved.addListener(safe('tab-closed', async (tabId) => {
  if (siteTabs.has(tabId) || (await getMeta()).tabs[tabId]) {
    siteTabs.delete(tabId);
    const scan = await getScan();
    if (scan?.scanning) await incident('tab-closed', { tab: await tabNo(tabId) });
  }
}));
chrome.tabs.onCreated.addListener(safe('tab-opened', async (t) => { if (t.openerTabId != null && siteTabs.has(t.openerTabId)) await timeline({ ty: 'tab-opened-from-site', tab: await tabNo(t.openerTabId) }); }));
chrome.tabs.onUpdated.addListener(safe('tab-updated', async (tabId, info, tab) => {
  if (info.discarded && siteTabs.has(tabId)) { const scan = await getScan(); if (scan?.scanning) await incident('tab-discarded', { tab: await tabNo(tabId) }); } // Chrome's memory saver
  if (!info.url) return;
  const scan = await getScan();
  const site = ours(hostOf(info.url), scan);
  if (site) siteTabs.add(tabId);
  else if (siteTabs.has(tabId)) { siteTabs.delete(tabId); if (scan?.scanning) await timeline({ ty: 'left-site', tab: await tabNo(tabId) }); }
  void tab;
}));
chrome.idle.setDetectionInterval(120);
chrome.idle.onStateChanged.addListener(safe('idle', async (s) => { const scan = await getScan(); if (scan?.scanning) await incident(`pc-${s}`); }));
chrome.runtime.onStartup.addListener(safe('startup', async () => { const scan = await getScan(); if (scan?.scanning) await incident('browser-started'); await ensureRunning('startup'); }));
chrome.runtime.onInstalled.addListener(safe('installed', async (d) => { const scan = await getScan(); if (scan?.scanning) await incident('scanner-updated', { reason: d.reason }); await ensureRunning('installed'); }));

chrome.alarms.onAlarm.addListener(safe('alarm', async (a) => {
  const scan = await getScan();
  if (!scan?.scanning) return;
  const m = await getMeta();
  if (a.name === 'tick') {
    const now = Date.now();
    if (m.lastTick && now - m.lastTick > 3 * 60000) await incident('gap', { minutes: Math.round((now - m.lastTick) / 60000) }); // the computer slept or the browser was closed
    m.lastTick = now;
    m.ticks++;
    touchMeta();
    await saveMeta();
    await saveSeen();
    await flushNet();
  } else if (a.name === 'probe') {
    const tabs = await chrome.tabs.query({ url: sitePatterns(scan) }).catch(() => []);
    for (const t of tabs) {
      const r = await chrome.tabs.sendMessage(t.id, { type: 'probe' }, { frameId: 0 }).catch((e) => ({ error: String(e?.message || e).slice(0, 80) }));
      await DB.add('probes', [{ t: Date.now(), tab: await tabNo(t.id), active: t.active ? 1 : 0, ...(r || { error: 'no answer' }) }]).catch(() => {});
    }
    if (!tabs.length) await DB.add('probes', [{ t: Date.now(), none: 1 }]).catch(() => {});
  } else if (a.name === 'space') {
    const est = await navigator.storage.estimate().catch(() => null);
    if (est) {
      m.usage = est.usage;
      if (est.usage > CAP.bytes && !m.full) { m.full = true; await incident('storage-full', { mb: Math.round(est.usage / 1e6) }); }
      touchMeta();
    }
  }
}));

// ---------------- messages ----------------
async function handle(msg, sender) {
  // the site's pages vs. our own pages (popup, report — those can be tabs too)
  const fromPage = Boolean(sender?.tab) && !String(sender?.url || '').startsWith(chrome.runtime.getURL(''));
  const scan = await getScan();
  if (fromPage) {
    if (!scan?.scanning) return { ok: false, stopped: true };
    const tab = await tabNo(sender.tab.id);
    siteTabs.add(sender.tab.id);
    const top = sender.frameId === 0;
    switch (msg.type) {
      case 'state': await storeState(msg.state, tab, sender.frameId); break;
      case 'seen': await seen(msg); break;
      case 'events': await storeEvents(msg.events || [], tab, top, msg.dropped || 0); break;
      case 'incident': await incident(msg.kind, { tab, top: top ? 1 : 0, note: msg.note }); break;
      case 'frames': {
        const extra = (msg.origins || []).filter((o) => { const h = hostOf(o); return h && !ours(h, scan) && /^https?:\/\//.test(o); });
        const merged = [...new Set([...(scan.frameOrigins || []), ...extra])].slice(0, 20);
        if (merged.length !== (scan.frameOrigins || []).length) { await setScan({ ...scan, frameOrigins: merged }); await registerRecorder({ ...scan, frameOrigins: merged }); }
        break;
      }
      default: break;
    }
    return { ok: true };
  }
  // from the popup / report page
  switch (msg.type) {
    case 'status': return status();
    case 'start': return start(msg.tabId);
    case 'resume': return resume();
    case 'stop': return stop();
    case 'reset': return reset();
    case 'flush': await flushNet(); await saveMeta(); await saveSeen(); return { ok: true };
    default: return { ok: false, error: 'unknown' };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function start(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url || '';
  if (!/^https?:\/\//.test(url)) throw new Error('Відкрийте ваш сайт у цій вкладці й натисніть ще раз');
  const host = hostOf(url);
  const domain = M.regDomain(host);
  const prev = await getScan();
  const known = prev?.siteDomains?.includes(domain);
  // pressed on another site of the same work (e.g. login on another domain): add it, never wipe what is recorded
  const scan = {
    scanning: true, scanId: Math.random().toString(36).slice(2), siteDomains: known ? prev.siteDomains : [...(prev?.siteDomains || []), domain].slice(-4),
    frameOrigins: prev?.frameOrigins || [], startedAt: prev?.startedAt || Date.now(), resumedAt: Date.now(),
  };
  const same = Boolean(prev?.siteDomains);
  await setScan(scan);
  const m = await getMeta();
  m.version = VERSION;
  m.browser = navigator.userAgent.replace(/\([^)]*\)/g, '()').slice(0, 160);
  m.lang = navigator.language;
  m.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  m.starts = (m.starts || 0) + 1;
  m.startedAt = scan.startedAt;
  m.lastTick = Date.now();
  touchMeta();
  await saveMeta();
  await incident(same ? 'resume' : 'start');
  await ensureRunning('start');
  siteTabs.add(tabId);
  return { ok: true, tabs: (await chrome.tabs.query({ url: sitePatterns(scan) })).length };
}

async function resume() {
  const prev = await getScan();
  if (!prev?.siteDomains?.length) throw new Error('Нічого продовжувати — натисніть «Вивчити сайт» на вкладці з сайтом');
  await setScan({ ...prev, scanning: true, scanId: Math.random().toString(36).slice(2), resumedAt: Date.now(), stoppedAt: undefined });
  const m = await getMeta();
  m.lastTick = Date.now();
  m.starts = (m.starts || 0) + 1;
  touchMeta();
  await saveMeta();
  await incident('resume');
  await ensureRunning('start');
  return { ok: true };
}

async function stop() {
  const scan = await getScan();
  if (!scan) return { ok: true };
  await flushNet();
  await setScan({ ...scan, scanning: false, stoppedAt: Date.now() });
  await unregisterRecorder();
  await incident('stop');
  const m = await getMeta(); m.stoppedAt = Date.now(); touchMeta(); await saveMeta(); await saveSeen();
  chrome.action.setBadgeText({ text: '■' });
  return { ok: true };
}

async function reset() {
  await stop();
  await DB.clearAll();
  meta = null;
  seenRec = null;
  seenDirty = false;
  await chrome.storage.local.remove('scan');
  scanCache = null;
  chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

async function status() {
  const scan = await getScan();
  const m = await getMeta();
  const [states, events, incidents, probes, net] = await Promise.all(['states', 'events', 'incidents', 'probes', 'net'].map((s) => DB.count(s).catch(() => 0)));
  // the popup asks every 3 s: only the newest incidents, never the whole night's list
  const last = await DB.last('incidents', 8).catch(() => []);
  return {
    ok: true, scanning: Boolean(scan?.scanning), has: Boolean(scan?.siteDomains), startedAt: m.startedAt || scan?.startedAt, stoppedAt: scan?.stoppedAt,
    states, events, incidents, probes, net, overflow: m.overflow, dropped: m.dropped, full: m.full, usage: m.usage, ext: m.ext.length,
    recent: last, version: VERSION, sites: scan?.siteDomains || [],
  };
}

safe('boot', () => ensureRunning('boot'))();
