/* global importScripts */
importScripts('config.js');

const DEFAULT_SERVER = self.AGENCY_DEFAULT_SERVER || 'http://localhost:3000';
const WATCH_EVERY_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_FAILS_IN_ROW = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------- state (mirrored to storage so the popup can render it) ----------------
const EMPTY_STATE = {
  status: 'idle', // idle | running | waiting | sleeping | watching | limit | stopped | error
  profileId: null, profileName: '', siteName: '', tabId: null,
  sent: 0, failed: 0, replies: 0, remaining: null, dailyLimit: null, page: 0,
  message: '', inviteText: '', startedAt: null, log: [], test: false, pending: 0, followups: 0,
};
let state = { ...EMPTY_STATE };
let running = false;
let stopRequested = false;
let lastHeartbeat = 0;
let keepAliveTimer = null;
let unseenReplies = 0;
/** The operator's pauses for the current run (seconds, [from, to]) and typing speed. */
const DEFAULT_PACE = { think: [2, 6], actionGap: [2, 6], pageGap: [3, 8], react: [20, 90], idleChance: 30, cpm: 600 };
let pace = { ...DEFAULT_PACE };
const between = ([a, b]) => rand(a, b) * 1000;

async function setState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set({ state });
  updateBadge();
}

async function log(text, level = 'info') {
  const entry = { t: Date.now(), text, level };
  await setState({ log: [entry, ...state.log].slice(0, 60), message: text });
}

function updateBadge() {
  if (unseenReplies > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#d6336c' });
    chrome.action.setBadgeText({ text: String(Math.min(unseenReplies, 99)) });
  } else if (['running', 'waiting', 'watching', 'sleeping'].includes(state.status)) {
    chrome.action.setBadgeBackgroundColor({ color: '#2f9e44' });
    chrome.action.setBadgeText({ text: 'ON' });
  } else if (state.status === 'error' || state.status === 'blocked') {
    chrome.action.setBadgeBackgroundColor({ color: '#e03131' });
    chrome.action.setBadgeText({ text: '!' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function keepAlive(on) {
  // Any extension API call resets the service worker idle timer, so long pauses between sends don't kill the run.
  clearInterval(keepAliveTimer);
  keepAliveTimer = on ? setInterval(() => chrome.runtime.getPlatformInfo(), 20000) : null;
}

// ---------------- server API ----------------
async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth || null;
}

async function api(path, { method = 'GET', body } = {}, attempt = 0) {
  const auth = await getAuth();
  if (!auth) throw Object.assign(new Error('Спочатку увійдіть у розширення'), { status: 401 });
  let res;
  try {
    res = await fetch(auth.server + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (attempt < 3) { await sleep(2000 * 2 ** attempt); return api(path, { method, body }, attempt + 1); }
    throw new Error('Немає зв’язку з сервером панелі');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500 && attempt < 2) { await sleep(3000 * (attempt + 1)); return api(path, { method, body }, attempt + 1); }
  if (!res.ok) {
    if (res.status === 401) await chrome.storage.local.remove('auth');
    throw Object.assign(new Error(data.error || `Помилка сервера (${res.status})`), { status: res.status });
  }
  return data;
}

async function heartbeat(force = false, botState) {
  if (!state.profileId) return;
  if (!force && Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
  lastHeartbeat = Date.now();
  const info = `надіслано ${state.sent}${state.followups ? ` (повторних ${state.followups})` : ''}, відповідей ${state.replies}${state.status === 'sleeping' ? ', неробочий час' : state.page ? `, стор. ${state.page}` : ''}`;
  try {
    const r = await api(`/api/bot/profiles/${state.profileId}/heartbeat`, { method: 'POST', body: { state: botState || mapBotState(), info } });
    if (r.paused && running && !stopRequested) {
      stopRequested = true;
      await log('Анкету поставлено на паузу в панелі — зупиняюсь', 'warn');
    }
  } catch { /* heartbeat is best-effort */ }
}

const mapBotState = () => ({ running: 'running', waiting: 'running', sleeping: 'running', watching: 'done', limit: 'limit', error: 'error', blocked: 'error', stopped: 'idle', idle: 'idle' }[state.status] || 'running');

// ---------------- tab helpers ----------------
async function waitTabComplete(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Вкладку з сайтом закрито');
    if (tab.status === 'complete') return tab;
    await sleep(300);
  }
  throw new Error('Сторінка сайту не завантажилась');
}

function waitForNavigation(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let started = false;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(noNavTimer);
      clearTimeout(maxTimer);
      setTimeout(resolve, 1200);
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) done();
    };
    const noNavTimer = setTimeout(() => { if (!started) done(); }, 3000); // SPA paging: no page load
    const maxTimer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function inTab(tabId, cmd, payload) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (c, p) => window.__agencyBot[c](p),
    args: [cmd, payload],
  });
  return res?.result;
}

const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
const sameSection = (url, searchUrl) => {
  try {
    const u = new URL(url);
    const s = new URL(searchUrl);
    return u.origin === s.origin && u.pathname.startsWith(s.pathname.replace(/[^/]*$/, ''));
  } catch { return false; }
};

async function prepareTab(tabId, site) {
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  // No tab given (autopilot): an open tab of this site — same origin and the same part of it as the search page
  // (the demo site lives next to the panel, the panel tab must not be taken).
  if (!tab && site.searchUrl) [tab] = (await chrome.tabs.query({})).filter((t) => t.url && sameSection(t.url, site.searchUrl));
  if (!site.searchUrl) {
    if (!tab) throw new Error('Відкрийте сторінку пошуку на сайті та натисніть Старт');
    return tab.id;
  }
  if (tab && tab.url && sameSection(tab.url, site.searchUrl)) {
    await waitTabComplete(tab.id);
    const probe = await inTab(tab.id, 'probe', { site }).catch(() => null);
    if (probe && probe.cards > 0) return tab.id;
    await chrome.tabs.update(tab.id, { url: site.searchUrl });
    await sleep(500);
    await waitTabComplete(tab.id);
    return tab.id;
  }
  const created = await chrome.tabs.create({ url: site.searchUrl, active: true });
  await waitTabComplete(created.id);
  return created.id;
}

// ---------------- acting like a person ----------------
const FOLLOWUP_EVERY_MS = 5 * 60 * 1000;
const hhmm = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

function localHour(tz) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date())); } catch { return new Date().getHours(); }
}
const inHours = (h, from, to) => (from === to ? true : from < to ? h >= from && h < to : h >= from || h < to);

// ---------------- schedule (agency time zone) ----------------
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
/** Hour, minute, weekday (1 = Mon) and date there. */
function tzNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return { h: Number(p.hour), m: Number(p.minute), wd: WEEKDAY[p.weekday] || 1, day: `${p.year}-${p.month}-${p.day}` };
  } catch {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), wd: d.getDay() || 7, day: d.toISOString().slice(0, 10) };
  }
}
/** Working windows of a day: [[9, 13], [15, 23]] (older scenarios: one window hoursFrom–hoursTo). */
const windowsOf = (human) => (human.windows?.length ? human.windows : [[human.hoursFrom, human.hoursTo]]);
/** Working day and working hour right now? */
function inSchedule(human, tz) {
  const t = tzNow(tz);
  const days = human.days?.length ? human.days : ALL_DAYS;
  return days.includes(t.wd) && windowsOf(human).some(([a, b]) => inHours(t.h, a, b));
}
/** Working milliseconds left today: the rest of this window plus the windows still ahead (24-hour day: until midnight). */
function msToWindowEnd(human, tz) {
  const t = tzNow(tz);
  const nowMin = t.h * 60 + t.m;
  let left = 0;
  for (const [a, b] of windowsOf(human)) {
    if (a === b) return (24 * 60 - nowMin) * 60000;
    const from = a * 60;
    const to = (b > a ? b : b + 24) * 60;
    const start = Math.max(from, nowMin);
    if (to > start) left += to - start;
  }
  return Math.max(60000, left * 60000);
}
const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const hh = (x) => `${String(x).padStart(2, '0')}:00`;
function scheduleText(human) {
  const d = (human.days?.length ? human.days : ALL_DAYS).slice().sort();
  const days = d.length === 7 ? 'щодня' : d.map((x) => DAY_NAMES[x - 1]).join(', ');
  const w = windowsOf(human);
  const hours = w.length === 1 && (w[0][0] === w[0][1] || (w[0][0] === 0 && w[0][1] === 24)) ? 'цілодобово' : w.map(([a, b]) => `${hh(a)}–${hh(b)}`).join(', ');
  return `${days}, ${hours}`;
}
/** When the next working window starts (for the "sleeping" message). */
function nextStartText(human, tz) {
  const t = tzNow(tz);
  const starts = windowsOf(human).map(([a]) => a).sort((x, y) => x - y);
  return hh(starts.find((a) => a > t.h) ?? starts[0]);
}

/** Waits until `until` (ms), checking the inbox now and then and stopping on request. */
async function waitUntil(until, ctx, status = 'waiting') {
  await setState({ status });
  let lastInbox = Date.now();
  while (Date.now() < until && !stopRequested) {
    await sleep(Math.min(1000, Math.max(0, until - Date.now())));
    await heartbeat();
    if (ctx && Date.now() - lastInbox > WATCH_EVERY_MS) { lastInbox = Date.now(); await checkInbox(ctx.site, ctx.profileId); }
  }
  if (!stopRequested) await setState({ status: 'running' });
}

/** Outside working hours the bot only watches the inbox. */
async function waitWorkingHours(ctx) {
  if (inSchedule(ctx.human, ctx.timezone)) return;
  const msg = `Неробочий час (${scheduleText(ctx.human)}) — продовжу о ${nextStartText(ctx.human, ctx.timezone)}`;
  await log(`🌙 ${msg}. Поки що лише стежу за відповідями`);
  await setState({ status: 'sleeping', message: msg });
  let lastInbox = Date.now();
  while (!stopRequested && !inSchedule(ctx.human, ctx.timezone)) {
    await sleep(1000);
    await heartbeat();
    if (Date.now() - lastInbox > WATCH_EVERY_MS) { lastInbox = Date.now(); await checkInbox(ctx.site, ctx.profileId); }
  }
  if (!stopRequested) { await setState({ status: 'running' }); await log('☀ Робочий час — продовжую'); }
}

/** After every man: hourly cap → long break → the usual random pause. */
async function afterMan(ctx, r, messages) {
  ctx.sinceBreak += messages;
  if (r && r.hourLeft === 0 && r.hourResetAt) {
    const until = r.hourResetAt + rand(30, 120) * 1000;
    await setState({ message: `Ліміт на годину (${ctx.human.perHour}) — пауза до ${hhmm(until)}` });
    await log(`⏳ Ліміт на годину — пауза до ${hhmm(until)}`);
    await waitUntil(until, ctx);
    return;
  }
  if (ctx.human.breakEvery && ctx.sinceBreak >= ctx.breakAt) {
    ctx.sinceBreak = 0;
    ctx.breakAt = Math.round(ctx.human.breakEvery * rand(0.7, 1.3));
    const ms = (ctx.human.breakMinutesTo ? rand(ctx.human.breakMinutes, Math.max(ctx.human.breakMinutes, ctx.human.breakMinutesTo)) : ctx.human.breakMinutes * rand(0.6, 1.4)) * 60000;
    await setState({ message: `Перерва ${Math.round(ms / 60000)} хв` });
    await log(`☕ Перерва ${Math.round(ms / 60000)} хв, як у живої людини`);
    await waitUntil(Date.now() + ms, ctx);
    return;
  }
  // Sometimes a person just scrolls the list and looks around between men.
  if (!ctx.test && ctx.tabId && Math.random() * 100 < pace.idleChance) {
    await setState({ message: '👀 Гортаю список, як людина' });
    await inTab(ctx.tabId, 'idle', { site: ctx.site, seconds: Math.round(rand(5, 15)) }).catch(() => null);
  }
  // Even pace: what is left of today's limit is spread until the end of the working hours.
  const left = r?.remaining;
  if (ctx.human.spread && !ctx.test && left > 0) {
    const gap = msToWindowEnd(ctx.human, ctx.timezone) / left;
    const usual = ((ctx.limits.minDelay + ctx.limits.maxDelay) / 2) * 1000;
    if (gap > usual * 1.3) {
      const until = Date.now() + gap * rand(0.7, 1.2);
      await setState({ message: `Рівномірний темп: наступне ≈ о ${hhmm(until)} (на сьогодні лишилось ${left})` });
      await waitUntil(until, ctx);
      return;
    }
  }
  await pause(ctx.limits, ctx.slow || 1);
}

/**
 * Captcha / "too many requests" / logged out: the bot stops touching the site, calls a person and waits.
 * When the page is fine again it goes on — slower, so the site does not get suspicious again.
 */
async function guard(ctx, tabId = ctx.tabId) {
  const b = await inTab(tabId, 'blocked', { site: ctx.site }).catch(() => null);
  if (!b) return false;
  await log(`🛑 ${b.text}. Бот на паузі — розв’яжіть це вручну у вкладці сайту, далі бот продовжить сам`, 'error');
  chrome.notifications.create(`blocked-${Date.now()}`, {
    type: 'basic', iconUrl: 'icon128.png', priority: 2, requireInteraction: true,
    title: '🛑 Потрібна людина', message: `${b.text}. Відкрийте вкладку сайту й розв’яжіть — бот чекає.`,
  });
  await setState({ status: 'blocked', message: `🛑 ${b.text} — потрібна людина` });
  await heartbeat(true, 'error');
  api(`/api/bot/profiles/${ctx.profileId}/alert`, { method: 'POST', body: { text: b.text } }).catch(() => {}); // Telegram: a person is needed
  const since = Date.now();
  while (!stopRequested) {
    await sleep(5000);
    await heartbeat();
    if (!(await inTab(tabId, 'blocked', { site: ctx.site }).catch(() => b))) break;
    if (Date.now() - since > 60 * 60000) throw new Error(`${b.text} — за годину ніхто не розв’язав. Зупиняюсь`);
  }
  if (stopRequested) return true;
  ctx.slow = Math.min(3, (ctx.slow || 1) * 1.5);
  await log(`✓ Сторінка знову доступна — продовжую повільніше (паузи ×${ctx.slow.toFixed(1)})`);
  await setState({ status: 'running', message: 'Продовжую' });
  return true;
}

async function pause(limits, slow = 1) {
  const total = rand(limits.minDelay, limits.maxDelay) * 1000 * slow;
  const end = Date.now() + total;
  await setState({ status: 'waiting' });
  while (Date.now() < end && !stopRequested) {
    await sleep(Math.min(1000, end - Date.now()));
    await heartbeat();
  }
  if (!stopRequested) await setState({ status: 'running' });
}

/** Opens the inbox in a background tab and returns { total, men: unread }. */
async function scanInbox(site) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: site.inboxUrl, active: false });
    await waitTabComplete(tab.id);
    await sleep(1500);
    return (await inTab(tab.id, 'inbox', { site })) || { total: 0, men: [] };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function checkInbox(site, profileId = state.profileId) {
  if (!site.inboxUrl || !site.inboxItem) return 0;
  try {
    const res = await scanInbox(site);
    if (!res?.men?.length) return 0;
    const r = await api(`/api/bot/profiles/${profileId}/replies`, { method: 'POST', body: { men: res.men } });
    if (r.new > 0) {
      unseenReplies += r.new;
      await setState({ replies: state.replies + r.new });
      const names = r.men.map((m) => `${m.name || m.id}${m.mood === 'negative' ? ' (не цікаво — більше не пишемо)' : ''}`).join(', ');
      await log(`💌 Нові відповіді (${r.new}): ${names}`, 'reply');
      chrome.notifications.create(`reply-${Date.now()}`, {
        type: 'basic', iconUrl: 'icon128.png', priority: 2,
        title: `💌 Нові відповіді: ${r.new}`,
        message: `${names} — відкрийте вхідні та відповідайте особисто.`,
      });
    }
    return r.new;
  } catch (e) {
    await log(`Не вдалося перевірити вхідні: ${e.message}`, 'warn');
    return 0;
  }
}

const pageKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch { return u; } };

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(500);
  await waitTabComplete(tabId);
  await sleep(rand(900, 1700));
}

// ---------------- attachments ----------------
const fileCache = new Map(); // media id -> { name, type, b64 }

async function loadFile(f) {
  if (fileCache.has(f.id)) return fileCache.get(f.id);
  const auth = await getAuth();
  if (!auth) throw new Error('спочатку увійдіть у розширення');
  const res = await fetch(`${auth.server}/api/bot/media/${f.id}`, { headers: { authorization: `Bearer ${auth.token}` } }).catch(() => null);
  if (!res?.ok) throw new Error(`файл «${f.name}» не завантажився з панелі`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const out = { name: f.name, type: f.type, b64: btoa(bin) };
  if (fileCache.size >= 20) fileCache.clear();
  fileCache.set(f.id, out);
  return out;
}

/**
 * Runs inside the page (MAIN world): puts our files into the site's file field.
 * 1) the chat's <input type=file>; 2) press the paperclip and catch the file dialog it would open; 3) drop on the box.
 * Script clicks never open the system file dialog (no user gesture), so nothing pops up on the operator's screen.
 */
async function mainAttach(files, sel) {
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const bin = (b64) => { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
  const list = files.map((f) => new File([bin(f.b64)], f.name, { type: f.type, lastModified: Date.now() }));
  const all = new DataTransfer();
  list.forEach((f) => all.items.add(f));
  const shown = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const q = (s) => { try { return s ? [...document.querySelectorAll(s)] : []; } catch { return []; } };
  const put = (inp) => {
    if (!inp.multiple && list.length > 1) { const one = new DataTransfer(); one.items.add(list[0]); inp.files = one.files; } else inp.files = all.files;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const box = q(sel.messageInput).find(shown);
  const nearest = (inputs) => {
    if (!box || inputs.length < 2) return inputs[0];
    let best = inputs[0];
    let bestDist = Infinity;
    for (const i of inputs) {
      let a = box;
      let d = 0;
      while (a && !a.contains(i)) { a = a.parentElement; d++; }
      if (a && d < bestDist) { best = i; bestDist = d; }
    }
    return best;
  };
  if (sel.fileInput || !sel.attachButton) {
    const inputs = q(sel.fileInput || 'input[type=file]');
    if (inputs.length) { put(nearest(inputs)); return { ok: true, how: 'input' }; }
  }
  const btn = q(sel.attachButton).find(shown);
  if (btn) {
    const lab = btn.tagName === 'LABEL' ? btn : btn.closest('label');
    const viaLabel = lab && (lab.control || lab.querySelector('input[type=file]'));
    if (viaLabel) { put(viaLabel); return { ok: true, how: 'label' }; }
    const proto = HTMLInputElement.prototype;
    const origClick = proto.click;
    const origPicker = proto.showPicker;
    let caught = null;
    proto.click = function click() { if (this.type === 'file' && !caught) { caught = this; return undefined; } return origClick.call(this); };
    if (origPicker) proto.showPicker = function showPicker() { if (this.type === 'file' && !caught) { caught = this; return undefined; } return origPicker.call(this); };
    try {
      btn.click();
      for (let i = 0; i < 25 && !caught; i++) await sleepMs(100);
    } finally {
      proto.click = origClick;
      if (origPicker) proto.showPicker = origPicker;
    }
    if (caught) { put(caught); return { ok: true, how: 'button' }; }
  }
  const inputs = q('input[type=file]');
  if (inputs.length) { put(nearest(inputs)); return { ok: true, how: 'input' }; }
  if (box) {
    for (const type of ['dragenter', 'dragover', 'drop']) box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: all }));
    return { ok: true, how: 'drop' };
  }
  return { ok: false, error: 'не знайшов, куди прикріпити файл — навчіть «Кнопка Прикріпити файл»' };
}

async function attachFiles(tabId, site, files, dry) {
  if (dry) return (await inTab(tabId, 'attachCheck', { site })) || { ok: false, error: 'сторінка не відповіла' };
  const data = [];
  for (const f of files) data.push(await loadFile(f));
  const before = (await inTab(tabId, 'attachedCount', { site })) || 0;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: mainAttach,
    args: [data, { messageInput: site.messageInput || '', attachButton: site.attachButton || '', fileInput: site.fileInput || '' }],
  });
  const r = res?.result;
  if (!r?.ok) return r || { ok: false, error: 'не вдалося прикріпити' };
  const mb = files.reduce((a, f) => a + (f.size || 0), 0) / 1048576;
  if (site.attachDone) {
    const w = await inTab(tabId, 'waitAttached', { site, before, timeout: 15000 + mb * 4000 });
    if (!w?.ok) return { ok: false, error: 'файл не прикріпився (прев’ю не з’явилось)' };
  } else {
    await sleep(2500 + Math.min(30000, mb * 1500)); // time for the upload
  }
  return { ok: true, how: r.how };
}

/** In the open chat: text → files → Send. */
/** The letter form: its own fields where taught, the chat ones otherwise. */
const letterSite = (site) => ({
  ...site,
  messageInput: site.letterInput || site.messageInput,
  sendButton: site.letterSend || site.sendButton,
  sentConfirm: site.letterConfirm || site.sentConfirm,
  closeChat: '',
});

/** In the open chat: (letter form) → the site's counter → text → files → translate → Send. */
async function writeHere(tabId, site, m, dry, typing) {
  const letter = m.via === 'letter';
  // Safety on chat-list sites: the open chat must be his (header name / ID), else nothing is typed.
  if (site.chatName || site.chatId) {
    const c = await inTab(tabId, 'waitChat', { site, name: m.name, id: m.id }).catch(() => null);
    if (!c?.ok) return { ok: false, wrongChat: true, error: `відкритий чат не його (${c?.name || c?.id || 'не видно'}) — не пишу` };
  }
  if (letter) {
    if (!site.letterOpen && !site.letterInput) return { ok: false, error: 'листи ще не навчені — 🎯 → вкладка «Листи»' };
    if (site.letterOpen) {
      const o = await inTab(tabId, 'clickAction', { site, man: m, sel: site.letterOpen, name: 'Лист', ctx: 'page', dry }).catch((e) => ({ ok: false, error: e.message }));
      if (!o?.ok) return { ok: false, error: o?.error || 'кнопку «Лист» не знайдено' };
      await sleep(rand(800, 1600));
    }
  }
  const s = letter ? letterSite(site) : site;
  // The site counts what is left ("Залишилося 9 повідомлень"): at 0 nothing more may be sent to him.
  const counter = letter ? site.letterLeft : site.chatLeft;
  if (counter) {
    const n = await inTab(tabId, 'leftCount', { sel: counter }).catch(() => null);
    if (n === 0) return { ok: false, exhausted: true, error: letter ? 'сайт: листів цьому чоловіку не лишилось' : 'сайт: повідомлень цьому чоловіку не лишилось' };
  }
  if (letter && site.letterSubject) {
    const subject = (m.text.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60);
    const sj = await inTab(tabId, 'fillSubject', { sel: site.letterSubject, text: subject, dry });
    if (!sj?.ok) return sj || { ok: false, error: 'поле теми листа не знайдено' };
  }
  const f = await inTab(tabId, 'fill', { site: s, man: m, dry, typing, think: pace.think, cpm: pace.cpm });
  if (!f?.ok) return f || { ok: false, error: 'немає відповіді від сторінки' };
  const a = m.files?.length ? await attachFiles(tabId, s, m.files, dry).catch((e) => ({ ok: false, error: e.message })) : { ok: true };
  if (site.translateButton) {
    const tr = await inTab(tabId, 'clickAction', { site, man: m, sel: site.translateButton, name: 'Перекласти', ctx: 'page', dry }).catch(() => null);
    if (tr?.ok) await sleep(rand(1800, 3200)); // the site translates
  }
  const r = await inTab(tabId, 'submit', { site: s, dry });
  if (!r?.ok) return r || { ok: false, error: 'немає відповіді від сторінки' };
  return { ...r, letter, attached: a.ok ? (m.files?.length || 0) : 0, warning: a.ok ? '' : `файл не прикріплено: ${a.error}` };
}

/** Writes from the search list. Works whether "Write" opens a box on the list or goes to his profile/chat page. */
async function sendOne(tabId, site, man, dry = false, typing = false) {
  const before = (await chrome.tabs.get(tabId)).url;
  let opened;
  try { opened = await inTab(tabId, 'open', { site, man, dry }); } catch { opened = { ok: true }; } // page unloaded on click
  if (!opened?.ok) return opened || { ok: false, error: 'немає відповіді від сторінки' };
  await sleep(1200);
  let tab = await chrome.tabs.get(tabId);
  const left = tab.status === 'loading' || pageKey(tab.url) !== pageKey(before);
  if (tab.status === 'loading') tab = await waitTabComplete(tabId);
  if (left) await sleep(800);
  let res;
  try { res = await writeHere(tabId, site, man, dry, typing); } catch (e) { res = { ok: false, error: e.message }; }
  if (left) await navigate(tabId, before); // back to the list of men
  return res || { ok: false, error: 'немає відповіді від сторінки' };
}

/** Writes on his own page (follow-ups): press "Write" if needed, then type and send. */
async function sendOnPage(tabId, site, man, dry = false, typing = false) {
  let o;
  try { o = await inTab(tabId, 'openPage', { site, dry }); } catch { o = { ok: true, clicked: true }; }
  if (o?.clicked) {
    await sleep(1200);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') { await waitTabComplete(tabId); await sleep(800); }
  }
  try { return (await writeHere(tabId, site, man, dry, typing)) || { ok: false, error: 'немає відповіді від сторінки' }; } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Runs one scenario step for one man.
 * where: 'card' — we are on the search list next to his card; 'page' — we are on his profile/chat page.
 * Returns { ok, messages, error, warnings }. A failed message fails the step; a missing like/wink is only a warning.
 */
async function runActions(tabId, site, man, actions, { where = 'card', dry = false, typing = false, home = null } = {}) {
  let left = false;
  const warnings = [];
  let messages = 0;
  let msgError = '';
  let did = 0;
  let attached = 0;
  let letters = 0;
  let exhausted = false; // the site's own counter says nothing more may be sent to him
  const goToHim = async () => {
    if (!man.url) return false;
    await navigate(tabId, man.url);
    where = 'page';
    left = true;
    return true;
  };
  for (const [i, a] of actions.entries()) {
    if (stopRequested || msgError) break;
    if (i > 0 && !dry) await sleep(between(pace.actionGap)); // like → (pause) → message, as a person would
    if (a.do === 'pause') { await sleep(a.seconds * 1000); continue; }
    if (a.do === 'view') {
      if (!dry && Math.random() * 100 >= (a.chance ?? 100)) continue;
      if (where === 'card' && !(await goToHim())) { warnings.push('немає посилання на його профіль — перегляд пропущено'); continue; }
      await inTab(tabId, 'view', { seconds: dry ? 3 : a.seconds }).catch(() => null);
      did++;
      continue;
    }
    if (a.do === 'click') {
      if (!dry && Math.random() * 100 >= (a.chance ?? 100)) continue;
      let res = null;
      if (where === 'card' && a.where !== 'page') res = await inTab(tabId, 'clickAction', { site, man, sel: a.sel, name: a.name, ctx: 'card', dry }).catch((e) => ({ ok: false, error: e.message }));
      if (where === 'card' && (!res || res.missing)) {
        if (await goToHim()) res = await inTab(tabId, 'clickAction', { site, man, sel: a.sel, name: a.name, ctx: 'page', dry }).catch((e) => ({ ok: false, error: e.message }));
      } else if (where === 'page') {
        res = await inTab(tabId, 'clickAction', { site, man, sel: a.sel, name: a.name, ctx: 'page', dry }).catch((e) => ({ ok: false, error: e.message }));
      }
      if (res?.ok) did++; else warnings.push(res?.error || `«${a.name}»: немає куди клікнути`);
      continue;
    }
    if (a.do === 'message') {
      const m = { ...man, text: a.text, files: a.files || [], via: a.via || 'chat' };
      let res;
      try { res = where === 'card' ? await sendOne(tabId, site, m, dry, typing) : await sendOnPage(tabId, site, m, dry, typing); } catch (e) { res = { ok: false, error: e.message }; }
      if (res?.ok) { messages++; did++; attached += res.attached || 0; if (res.letter) letters++; if (res.warning) warnings.push(res.warning); } else {
        msgError = res?.error || 'помилка відправки';
        if (res?.exhausted) exhausted = true;
      }
    }
  }
  if (left && home) await navigate(tabId, home);
  const hasMessage = actions.some((a) => a.do === 'message');
  const ok = hasMessage ? !msgError && messages > 0 : did > 0;
  return { ok, messages, attached, letters, exhausted, error: msgError || (!ok ? warnings.join('; ') : ''), warnings };
}

/** Follow-ups: men who have not replied and whose next step is due. */
async function processDue(ctx, force = false) {
  if (!ctx.cfg.scenario.followups || stopRequested) return 0;
  if (!force && Date.now() - ctx.lastDue < FOLLOWUP_EVERY_MS) return 0;
  ctx.lastDue = Date.now();
  await checkInbox(ctx.site, ctx.profileId); // whoever answered must not get a follow-up
  const due = await api(`/api/bot/profiles/${ctx.profileId}/due?limit=5`);
  await setState({ pending: due.pending });
  if (due.noManUrl && due.pending && !ctx.warnedUrl) {
    ctx.warnedUrl = true;
    await log('⚠ Повторні спроби чекають, але не налаштовано «URL профілю чоловіка» і з картки не взялось посилання', 'warn');
  }
  if (!due.men.length) return 0;
  const home = (await chrome.tabs.get(ctx.tabId)).url;
  await log(`↻ Повторні спроби: ${due.men.length} (у черзі ${due.pending})`);
  for (const man of due.men) {
    if (stopRequested) break;
    await waitWorkingHours(ctx);
    if (stopRequested) break;
    const reminder = man.kind === 'reengage';
    await setState({ message: reminder ? `💬 Нагадування: ${man.name || man.id}` : `↻ Спроба ${man.step}/${man.of}: ${man.name || man.id}` });
    let res;
    try {
      if (man.url) {
        await navigate(ctx.tabId, man.url);
      } else {
        // No page of his own (chat-list sites): type his ID into the site's search and open his chat.
        const fm = await inTab(ctx.tabId, 'findMan', { site: ctx.site, id: man.id, name: man.name });
        if (!fm?.ok) throw new Error(fm?.error || 'не вдалося знайти його чат');
      }
      await guard(ctx);
      res = await runActions(ctx.tabId, ctx.site, man, man.actions, { where: 'page', typing: ctx.human.typing });
    } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
    const text = man.actions.find((a) => a.do === 'message')?.text || '';
    const r = await api(`/api/bot/profiles/${ctx.profileId}/step`, {
      method: 'POST', body: { man: { id: man.id }, step: man.step, kind: man.kind, ok: res.ok, messages: res.messages, text, error: res.error, exhausted: res.exhausted },
    });
    const who = man.name || man.id;
    if (res.exhausted) {
      await log(`⛔ ${who}: ${res.error} — більше не пишемо`);
    } else if (res.ok) {
      await setState({ sent: state.sent + res.messages, followups: (state.followups || 0) + 1, remaining: r.remaining });
      if (reminder) await log(`💬 ${who}: нагадування після відповіді ✓ (лишилось ${r.left ?? '—'})${r.stage === 'done' ? ' — останнє, далі без відповіді він зникне зі списку' : ''}`);
      else await log(`↻ ${who}: спроба ${man.step}/${man.of} ✓${res.attached ? ` 📎${res.attached}` : ''}${r.stage === 'done' ? ' — остання, далі без відповіді він зникне зі списку' : ''}`);
    } else {
      await setState({ failed: state.failed + 1, remaining: r.remaining });
      await log(`${reminder ? '💬' : '↻'} ${who}: ${reminder ? 'нагадування' : `спроба ${man.step}`} не вдалось — ${res.error}`, 'warn');
    }
    for (const w of res.warnings || []) if (res.ok) await log(`  ⚠ ${w}`, 'warn');
    await heartbeat();
    if (r.stop) { ctx.limitReached = true; break; }
    await afterMan(ctx, r, res.messages);
  }
  if (!stopRequested && home) await navigate(ctx.tabId, home);
  return due.men.length;
}

/** Next page or more of the infinite feed. Returns false when the list has ended. */
async function advance(tabId, site) {
  const fresh = await inTab(tabId, 'scan', { site });
  if (fresh?.hasNext) {
    await inTab(tabId, 'next', { site }).catch(() => null);
    await waitForNavigation(tabId);
    return true;
  }
  if (site.nextPage) return false;
  const m = await inTab(tabId, 'more', { site });
  return Boolean(m?.grew);
}

/**
 * The site's own hints ("Please write him message / letter"): the bot takes them first, after a human pause,
 * opens his chat from the hint, reads his ID from the chat header and writes the way the hint asks.
 */
async function processTasks(ctx) {
  const { tabId, site, profileId } = ctx;
  if (!site.taskItem || stopRequested) return 0;
  ctx.triedTasks ||= new Set();
  let done = 0;
  for (let round = 0; round < 50 && !stopRequested && !ctx.limitReached; round++) {
    await waitWorkingHours(ctx);
    if (stopRequested) break;
    await guard(ctx);
    const list = (await inTab(tabId, 'tasks', { site }).catch(() => null)) || [];
    const task = list.find((t) => !ctx.triedTasks.has(t.id || `${t.name}|${t.age}`));
    if (!task) break;
    ctx.triedTasks.add(task.id || `${task.name}|${task.age}`);
    const kind = task.via === 'letter' ? '✉ лист' : '💬 чат';
    const wait = between(pace.react);
    await setState({ message: `💡 Підказка сайту: ${task.name} (${kind}) — відкрию за ${Math.round(wait / 1000)} с` });
    await waitUntil(Date.now() + wait, ctx);
    if (stopRequested) break;
    const o = await inTab(tabId, 'openTask', { site, task }).catch((e) => ({ ok: false, error: e.message }));
    if (!o?.ok) { await log(`💡 ${task.name}: ${o?.error || 'не відкрилось'}`, 'warn'); continue; }
    if (!o.id) { await log(`💡 ${task.name}: не бачу його ID — навчіть «ID у шапці відкритого чату»`, 'warn'); continue; }
    const f = await api(`/api/bot/profiles/${profileId}/filter`, { method: 'POST', body: { candidates: [{ id: o.id, name: o.name, age: task.age, via: task.via }] } });
    await setState({ remaining: f.remaining });
    if (f.remaining <= 0) { ctx.limitReached = true; break; }
    const man = f.allowed[0];
    if (!man) { await log(`💡 ${o.name}: уже писали або не підходить під фільтр — пропускаю`); continue; }
    await setState({ message: `💡 Пишу ${man.name || man.id} (${kind})` });
    let res;
    try { res = await runActions(tabId, site, man, man.actions || [], { where: 'page', typing: ctx.human.typing }); } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
    const r = await api(`/api/bot/profiles/${profileId}/sent`, { method: 'POST', body: { man, ok: res.ok, error: res.error, text: man.text, invite_id: man.invite_id, exhausted: res.exhausted } });
    if (res.ok) {
      done++;
      await setState({ sent: state.sent + res.messages, remaining: r.remaining });
      await log(`💡 ${man.name || man.id}: ${res.letters ? '✉ лист' : '💬 повідомлення'} ✓${res.attached ? ` 📎${res.attached}` : ''}`);
    } else {
      await setState({ failed: state.failed + (res.exhausted ? 0 : 1), remaining: r.remaining });
      await log(`💡 ${man.name || man.id}: ${res.error}`, 'warn');
    }
    await heartbeat();
    if (r.stop) { ctx.limitReached = true; break; }
    await afterMan(ctx, r, res.messages);
    if (r.due > 0) await processDue(ctx, true);
  }
  return done;
}

const SCAN_AHEAD_PAGES = 3;

/**
 * "Розвідка": reads the first pages without writing, so the server can rank everyone seen,
 * then the best of them get their invite first — on their own pages. The usual page walk covers the rest.
 */
async function scanAhead(ctx) {
  const { tabId, site, profileId } = ctx;
  const seen = [];
  for (let i = 0; i < SCAN_AHEAD_PAGES && !stopRequested; i++) {
    await waitTabComplete(tabId);
    await guard(ctx);
    const scan = await inTab(tabId, 'scan', { site });
    seen.push(...(scan?.candidates || []));
    if (i < SCAN_AHEAD_PAGES - 1 && !(await advance(tabId, site))) break;
    await sleep(rand(1500, 3500));
  }
  if (stopRequested || !seen.length) return 0;
  const pool = await api(`/api/bot/profiles/${profileId}/pool`, { method: 'POST', body: { candidates: seen } });
  await navigate(tabId, site.searchUrl || ctx.listUrl);
  const next = await api(`/api/bot/profiles/${profileId}/pool/next?limit=50`);
  await log(`🔭 Розвідка: переглянув чоловіків ${seen.length}, нових ${pool.added}. Найперспективніших: ${next.men.length} — пишу їм першими`);
  let done = 0;
  for (const man of next.men) {
    if (stopRequested || ctx.limitReached) break;
    await waitWorkingHours(ctx);
    if (stopRequested) break;
    const why = man.why?.length ? ` (${man.why.join(', ')})` : '';
    await setState({ message: `⭐ Пишу: ${man.name || man.id}${why}` });
    let res;
    try {
      await navigate(tabId, man.url);
      await guard(ctx);
      res = await runActions(tabId, site, man, man.actions || [{ do: 'message', text: man.text }], { where: 'page', typing: ctx.human.typing });
    } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
    const r = await api(`/api/bot/profiles/${profileId}/sent`, { method: 'POST', body: { man, ok: res.ok, error: res.error, text: man.text, invite_id: man.invite_id, exhausted: res.exhausted } });
    if (res.ok) {
      done++;
      await setState({ sent: state.sent + res.messages, remaining: r.remaining });
      await log(`⭐ ${man.name || man.id}${why} ✓${res.attached ? ` 📎${res.attached}` : ''}`);
    } else {
      await setState({ failed: state.failed + 1, remaining: r.remaining });
      await log(`✗ ${man.name || man.id}: ${res.error}`, 'warn');
    }
    await heartbeat();
    if (r.stop) { ctx.limitReached = true; break; }
    await afterMan(ctx, r, res.messages);
  }
  if (!stopRequested) await navigate(tabId, site.searchUrl || ctx.listUrl);
  return done;
}

async function loadRun(profileId, test) {
  const cfg = await api(`/api/bot/profiles/${profileId}/config`);
  const site = cfg.site.config;
  const menFrom = site.taskItem || (site.card && (site.cardId || site.chatId));
  if (!menFrom || !site.messageInput) throw new Error('Сайт налаштовано не повністю: звідки брати чоловіків (картка з ID або підказки сайту) і поле вводу. Натисніть 🎯 «Навчити бота»');
  const human = cfg.scenario?.human || { hoursFrom: 0, hoursTo: 0, perHour: 0, breakEvery: 0, breakMinutes: 10, typing: false };
  const ap = await getAutopilot();
  if (ap?.profileId === profileId) await setAutopilot({ ...ap, human, timezone: cfg.timezone, profileName: cfg.profile.name });
  const range = (a, b, d) => (Number.isFinite(a) && Number.isFinite(b) ? [a, Math.max(a, b)] : d);
  pace = {
    think: range(human.thinkFrom, human.thinkTo, DEFAULT_PACE.think),
    actionGap: range(human.actionGapFrom, human.actionGapTo, DEFAULT_PACE.actionGap),
    pageGap: range(human.pageGapFrom, human.pageGapTo, DEFAULT_PACE.pageGap),
    react: range(human.reactFrom, human.reactTo, DEFAULT_PACE.react),
    idleChance: Number.isFinite(human.idleChance) ? human.idleChance : DEFAULT_PACE.idleChance,
    cpm: human.typeSpeed || DEFAULT_PACE.cpm,
  };
  return {
    cfg, site, human, profileId, test, limits: cfg.limits, timezone: cfg.timezone,
    sinceBreak: 0, breakAt: Math.round((human.breakEvery || 0) * rand(0.7, 1.3)), lastDue: 0, limitReached: false,
  };
}

async function run(profileId, tabId) {
  const ctx = await loadRun(profileId, false);
  const { cfg, site } = ctx;
  await setState({
    ...EMPTY_STATE, log: state.log, status: 'running', test: false, profileId, profileName: cfg.profile.name, siteName: cfg.site.name,
    remaining: cfg.limits.remaining, dailyLimit: cfg.limits.dailyLimit, page: 1, inviteText: cfg.invite.text, startedAt: Date.now(), pending: cfg.pending,
  });
  const h = ctx.human;
  await log(`Старт: ${cfg.profile.name} на «${cfg.site.name}». Ліміт на сьогодні: ${cfg.limits.remaining}. Спроб на чоловіка: ${cfg.scenario.attempts}`
    + `${h.hoursFrom !== h.hoursTo ? `, працюю ${h.hoursFrom}:00–${h.hoursTo}:00` : ''}${h.perHour ? `, до ${h.perHour}/год` : ''}`);
  await heartbeat(true, 'running');

  ctx.limitReached = cfg.limits.remaining <= 0;
  if (!ctx.limitReached) {
    tabId = await prepareTab(tabId, site);
    ctx.tabId = tabId;
    await setState({ tabId });
    await chrome.storage.session.set({ active: { profileId, tabId } });
    let sinceInbox = 0;
    let failsInRow = 0;
    let emptyPages = 0;
    let noGrowth = 0;
    const tried = new Set(); // men already attempted in this run (a failing one is not retried in a loop)

    // Operator desk without a list of new men: the site's hints + follow-ups, waiting for new hints in between.
    if (!site.card) {
      while (!stopRequested && !ctx.limitReached) {
        await waitWorkingHours(ctx);
        await processDue(ctx);
        if (ctx.limitReached || stopRequested) break;
        const did = await processTasks(ctx);
        if (ctx.limitReached || stopRequested) break;
        if (!did) {
          await setState({ message: '💡 Нових підказок сайту немає — чекаю й стежу за відповідями' });
          await waitUntil(Date.now() + rand(60, 150) * 1000, ctx, 'watching');
        }
      }
    }

    // The best men of the first pages first — once the platform knows who answers and his page can be opened.
    if (site.card && cfg.ranking?.ready && cfg.ranking?.manUrl) {
      await waitWorkingHours(ctx);
      ctx.listUrl = (await chrome.tabs.get(tabId)).url;
      await scanAhead(ctx).catch((e) => log(`Розвідка не вдалась: ${e.message}`, 'warn'));
    }

    outer: while (site.card && !stopRequested) {
      await waitWorkingHours(ctx);
      await processDue(ctx);
      if (ctx.limitReached || stopRequested) break;
      await processTasks(ctx); // the site's own hints go before the list
      if (ctx.limitReached || stopRequested) break;
      await waitTabComplete(tabId);
      await guard(ctx);
      if (stopRequested) break;
      const scan = await inTab(tabId, 'scan', { site });
      if (!scan) throw new Error('Не вдалося прочитати сторінку сайту');
      const listUrl = scan.url;
      let allowed = [];
      if (scan.candidates.length) {
        const f = await api(`/api/bot/profiles/${profileId}/filter`, { method: 'POST', body: { candidates: scan.candidates } });
        allowed = f.allowed.filter((m) => !tried.has(m.id));
        await setState({ remaining: f.remaining });
        if (f.remaining <= 0) { ctx.limitReached = true; break; }
        const skip = [f.skipped.contacted && `вже писали ${f.skipped.contacted}`, f.skipped.age && `не підходить вік ${f.skipped.age}`,
          f.skipped.filter && `не підходять під фільтр ${f.skipped.filter}`].filter(Boolean).join(', ');
        await log(`Стор. ${state.page}: чоловіків ${scan.candidates.length}, нових ${allowed.length}${skip ? ` (${skip})` : ''}`);
      } else {
        await log(`Стор. ${state.page}: карток не знайдено`, 'warn');
      }
      emptyPages = allowed.length ? 0 : emptyPages + 1;
      if (emptyPages >= 30) { await log('30 сторінок поспіль без нових чоловіків — завершую', 'warn'); break; }

      for (const man of allowed) {
        if (stopRequested) break outer;
        await waitWorkingHours(ctx);
        if (stopRequested) break outer;
        await setState({ message: `Пишу: ${man.name || man.id}${man.age ? `, ${man.age}` : ''}` });
        if (await guard(ctx)) { if (stopRequested) break outer; continue outer; } // the list may have changed meanwhile
        tried.add(man.id);
        let res;
        try { res = await runActions(tabId, site, man, man.actions || [{ do: 'message', text: man.text }], { where: 'card', typing: ctx.human.typing, home: listUrl }); } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
        const r = await api(`/api/bot/profiles/${profileId}/sent`, {
          method: 'POST', body: { man, ok: res.ok, error: res.error, text: man.text, invite_id: man.invite_id, exhausted: res.exhausted },
        });
        if (res.exhausted) {
          await log(`⛔ ${man.name || man.id}: ${res.error} — пропускаю`);
        } else if (res.ok) {
          failsInRow = 0;
          await setState({ sent: state.sent + res.messages, remaining: r.remaining });
          await log(`✓ ${man.name || man.id}${res.letters ? ' ✉ лист' : ''}${res.attached ? ` 📎${res.attached}` : ''}`);
          for (const w of res.warnings) await log(`  ⚠ ${w}`, 'warn');
        } else {
          failsInRow++;
          await setState({ failed: state.failed + 1, remaining: r.remaining });
          await log(`✗ ${man.name || man.id}: ${res.error}`, 'warn');
          if (await guard(ctx)) failsInRow = 0; // it was the site blocking, not the settings
          if (failsInRow >= MAX_FAILS_IN_ROW) throw new Error(`${MAX_FAILS_IN_ROW} помилок поспіль — перевірте сторінку сайту або натисніть 🎯 «Навчити бота»`);
        }
        await heartbeat();
        if (r.stop) { ctx.limitReached = true; break outer; }
        if (cfg.inboxCheckEvery && ++sinceInbox >= cfg.inboxCheckEvery) { sinceInbox = 0; await checkInbox(site, profileId); }
        await afterMan(ctx, r, res.messages);
        // Follow-ups that came due go first (warm traffic); then the list is read again from the top.
        if (r.due > 0 || Date.now() - ctx.lastDue >= FOLLOWUP_EVERY_MS) {
          const did = await processDue(ctx, r.due > 0);
          if (ctx.limitReached) break outer;
          if (did) continue outer;
        }
      }
      if (stopRequested) break;
      // Next page, or (no pagination button) more of the infinite feed.
      if (await advance(tabId, site)) {
        noGrowth = 0;
        await setState({ page: state.page + 1 });
        await sleep(between(pace.pageGap));
      } else if (site.nextPage) {
        await log('Сторінки закінчились');
        break;
      } else if (++noGrowth >= 2) {
        await log('Список чоловіків закінчився');
        break;
      }
    }
  }

  if (ctx.limitReached) await log('Денний ліміт вичерпано 👍');
  await checkInbox(site, profileId);
  if (stopRequested) return;

  // Keep watching the inbox so replies reach a live person quickly; keep doing follow-ups as they come due.
  await setState({ status: ctx.limitReached ? 'limit' : 'watching', message: 'Нових чоловіків немає. Стежу за відповідями і роблю повторні спроби…' });
  await heartbeat(true, ctx.limitReached ? 'limit' : 'done');
  while (!stopRequested) {
    const end = Date.now() + WATCH_EVERY_MS;
    while (Date.now() < end && !stopRequested) { await sleep(1000); await heartbeat(); }
    if (stopRequested) break;
    await checkInbox(site, profileId);
    if (!ctx.limitReached && ctx.tabId && inSchedule(ctx.human, ctx.timezone)) {
      const prev = state.status;
      await processDue(ctx).catch((e) => log(`Повторні спроби: ${e.message}`, 'warn'));
      if (!stopRequested) await setState({ status: ctx.limitReached ? 'limit' : prev });
    }
  }
}

const TEST_MEN = 3;

/**
 * Test mode: walks the whole flow on the real site but never presses "Send" or any taught button.
 * Nothing is recorded on the server and the daily limit is untouched.
 */
/** Only the outcome of a test goes to the panel (for the setup wizard) — nothing about men or messages. */
const reportTest = (profileId, problems) => api(`/api/bot/profiles/${profileId}/test`, { method: 'POST', body: { ok: !problems.length, problems } }).catch(() => {});

async function runTest(profileId, tabId) {
  const ctx = await loadRun(profileId, true);
  const { cfg, site } = ctx;
  await setState({
    ...EMPTY_STATE, log: state.log, status: 'running', test: true, profileId, profileName: cfg.profile.name, siteName: cfg.site.name,
    page: 1, inviteText: cfg.invite.text, startedAt: Date.now(),
  });
  await log(`🧪 Тест-режим: ${cfg.profile.name} на «${cfg.site.name}». Нічого не надсилається й не натискається, ліміт не витрачається`);
  const problems = [];
  const warn = async (text) => log(`⚠ ${text}`, 'warn');

  tabId = await prepareTab(tabId, site);
  await setState({ tabId });

  const blockedNow = await inTab(tabId, 'blocked', { site }).catch(() => null);
  if (blockedNow) {
    problems.push(`${blockedNow.text} — розв’яжіть вручну у вкладці й запустіть тест ще раз`);
    await reportTest(profileId, problems);
    throw new Error(problems[0]);
  }

  // 0. The site's own hints "write him" (operator desks): open one, read his ID, walk the first message without sending
  if (site.taskItem) {
    const ts = (await inTab(tabId, 'tasks', { site }).catch(() => null)) || [];
    if (!ts.length) {
      await warn('Підказок сайту «напиши йому» зараз немає — нормально, якщо сайт ще не підкинув. Запустіть тест, коли з’являться');
    } else {
      await log(`✓ Підказки сайту: ${ts.length}. Напр.: ${ts.slice(0, 3).map((t) => `${t.name}${t.age ? ` ${t.age}` : ''} (${t.via === 'letter' ? 'лист' : 'чат'})`).join('; ')}`);
      const t = ts[0];
      const o = await inTab(tabId, 'openTask', { site, task: t, dry: true }).catch((e) => ({ ok: false, error: e.message }));
      if (!o?.ok) problems.push(`Підказка «${t.name}»: ${o?.error || 'не відкрилась'} — перевірте «Підказка» та «Ім’я в шапці відкритого чату»`);
      else if (!o.id) problems.push('Чат з підказки відкрився, але бот не бачить ID — навчіть «ID у шапці відкритого чату»');
      else {
        await log(`✓ Чат з підказки відкрився: ${o.name} [${o.id}]`);
        const f = await api(`/api/bot/profiles/${profileId}/filter`, { method: 'POST', body: { candidates: [{ id: o.id, name: o.name, age: t.age, via: t.via }], test: true } });
        const man = f.allowed[0];
        if (!man) await warn(`${o.name}: йому вже писали — перевірку відправки пропущено`);
        else {
          let res;
          try { res = await runActions(tabId, site, man, man.actions || [], { where: 'page', dry: true }); } catch (e) { res = { ok: false, error: e.message, warnings: [] }; }
          if (res.ok) { await setState({ sent: state.sent + 1 }); await log(`✓ ${man.name || man.id}: ${t.via === 'letter' ? 'лист' : 'повідомлення'} пройдено — НІЧОГО не надіслано`); } else problems.push(`${man.name || man.id}: ${res.error}`);
        }
        if (site.findInput && !site.manUrl) {
          const fm = await inTab(tabId, 'findMan', { site, id: o.id, name: o.name }).catch((e) => ({ ok: false, error: e.message }));
          if (fm?.ok) await log(`✓ Пошук за ID працює — повторні знайдуть його чат`); else problems.push(`Пошук за ID: ${fm?.error} — повторні спроби не спрацюють`);
        }
      }
    }
  }
  // 1. Search page (sites with a list of new men)
  const scan = site.card ? await inTab(tabId, 'scan', { site }) : null;
  const men = scan?.candidates || [];
  if (!site.card) {
    if (!site.manUrl && !site.findInput && cfg.scenario.followups) problems.push('Для повторних спроб бот має знайти його чат: навчіть «Пошук чоловіка за ID» або «URL профілю чоловіка»');
  } else if (!men.length) {
    problems.push('На сторінці пошуку не знайдено жодного чоловіка — перевірте «Картка» та «ID»');
  } else {
    const sample = men.slice(0, 3).map((c) => `${c.name || '?'}${c.age ? ` ${c.age}` : ''} [${c.id}]`).join('; ');
    await log(`✓ Пошук: чоловіків на сторінці ${men.length}. Напр.: ${sample}`);
    if (new Set(men.map((c) => c.id)).size < men.length) problems.push('ID повторюються в різних картках — селектор «ID» бере не те');
    const noName = men.filter((c) => !c.name).length;
    const noAge = men.filter((c) => !c.age).length;
    if (noName) await warn(`Без імені: ${noName} з ${men.length} — перевірте «Ім’я» (без імені інвайт піде без звертання)`);
    if (site.cardAge && noAge) await warn(`Без віку: ${noAge} з ${men.length} — перевірте «Вік»`);
    for (const mk of site.marks || []) {
      const n = men.filter((c) => c.marks.includes(mk.key)).length;
      await log(`${n ? '✓' : '⚠'} Ознака «${mk.name}»: у ${n} з ${men.length}`, n ? 'info' : 'warn');
    }
  }

  // 2. The first scenario step on 3 men (without sending or clicking)
  const listUrl = (await chrome.tabs.get(tabId)).url;
  if (men.length && !stopRequested) {
    const f = await api(`/api/bot/profiles/${profileId}/filter`, { method: 'POST', body: { candidates: men, test: true } });
    const pick = f.allowed.slice(0, TEST_MEN);
    if (!pick.length) await warn('Нікому на цій сторінці писати не треба (уже писали / фільтри) — перевірку відправки пропущено');
    for (const man of pick) {
      if (stopRequested) break;
      await setState({ message: `🧪 Перевіряю: ${man.name || man.id}` });
      let res;
      try { res = await runActions(tabId, site, man, man.actions || [{ do: 'message', text: man.text }], { where: 'card', dry: true, home: listUrl }); } catch (e) { res = { ok: false, error: e.message, warnings: [] }; }
      if (res.ok) {
        await setState({ sent: state.sent + 1 });
        await log(`✓ ${man.name || man.id}: крок 1 пройдено (${(man.actions || []).map((a) => (a.do === 'message' ? `повідомлення${a.files?.length ? ` 📎${a.files.length}` : ''}` : { click: a.name, view: 'перегляд профілю', pause: 'пауза' }[a.do])).join(' → ')}) — НІЧОГО не надіслано`);
        for (const w of res.warnings) {
          if (w.startsWith('файл не прикріплено')) problems.push(`${man.name || man.id}: ${w}`);
          else await warn(w);
        }
      } else {
        await setState({ failed: state.failed + 1 });
        problems.push(`${man.name || man.id}: ${res.error}`);
        await log(`✗ ${man.name || man.id}: ${res.error}`, 'warn');
      }
      await sleep(1500);
    }

    // 3. Follow-ups need his own page: check the message box (and taught page buttons) there
    if (cfg.scenario.followups && !stopRequested) {
      const him = men.find((c) => c.url) || men[0];
      const url = site.manUrl ? site.manUrl.replaceAll('{id}', encodeURIComponent(him.id)) : him.url;
      if (!url) {
        problems.push('Для повторних спроб потрібна сторінка чоловіка: вкажіть «URL профілю чоловіка» (🎯 Навчити → «Ця сторінка — профіль чоловіка»)');
      } else {
        await navigate(tabId, url);
        const o = await inTab(tabId, 'openPage', { site, dry: true }).catch(() => ({ clicked: true }));
        if (o?.clicked) { await sleep(1200); await waitTabComplete(tabId); }
        const p = await inTab(tabId, 'probe', { site }).catch(() => null);
        if (p?.messageInput) await log(`✓ Сторінка чоловіка: поле для повторних повідомлень знайдено (${him.name || him.id})`);
        else problems.push('На сторінці чоловіка не знайдено поле вводу — повторні спроби не спрацюють. Відкрийте його сторінку й навчіть «Поле вводу» ще раз');
        for (const a of (site.actions || []).filter((x) => x.where === 'page')) {
          const r = await inTab(tabId, 'clickAction', { site, man: him, sel: a.sel, name: a.name, ctx: 'page', dry: true }).catch(() => null);
          if (r?.ok) await log(`✓ Кнопка «${a.name}» на його сторінці є`); else await warn(`Кнопку «${a.name}» на його сторінці не знайдено`);
        }
        await navigate(tabId, listUrl);
      }
    }
  }

  // 4. Next page / infinite feed (checked, not followed)
  if (men.length && !stopRequested) {
    const fresh = await inTab(tabId, 'scan', { site });
    if (site.nextPage) {
      if (fresh?.hasNext) await log('✓ Кнопка «Наступна сторінка» є');
      else await warn('Кнопку «Наступна сторінка» не знайдено (або це остання сторінка)');
    } else {
      const m = await inTab(tabId, 'more', { site });
      if (m?.grew) await log(`✓ Список догружається при прокрутці (уже ${m.count})`);
      else await warn('При прокрутці нові чоловіки не з’явились. Якщо на сайті є сторінки — вкажіть «Наступна сторінка»');
    }
  }

  // 5. Inbox
  if (!stopRequested) {
    if (!site.inboxUrl || !site.inboxItem) {
      problems.push('Вхідні не налаштовано — бот не побачить відповідей і писатиме повторно тим, хто вже відповів');
    } else {
      try {
        const r = await scanInbox(site);
        const names = r.men.slice(0, 5).map((m) => `${m.name || '?'} [${m.id}]`).join(', ');
        if (r.total) await log(`✓ Вхідні: діалогів ${r.total}, непрочитаних ${r.men.length}${names ? `: ${names}` : ''}`);
        else await warn('У вхідних не знайдено діалогів. Нормально для нової анкети; інакше перевірте «Діалог у вхідних»');
      } catch (e) {
        problems.push(`Вхідні не відкрились: ${e.message}`);
      }
    }
  }

  if (stopRequested) { await log('🧪 Тест перервано'); return; }
  await reportTest(profileId, problems);
  if (problems.length) {
    for (const p of problems) await log(`✗ ${p}`, 'error');
    throw new Error(`тест знайшов проблем: ${problems.length}. Виправте (🎯 Навчити бота або панель) й запустіть тест ще раз`);
  }
  await setState({ message: 'Тест пройдено. Можна запускати справжню розсилку' });
  await log('🧪 Тест пройдено ✓ Можна запускати справжню розсилку', 'reply');
}

// ---------------- autopilot: the bot turns itself on and off by the schedule ----------------
async function getAutopilot() {
  const { autopilot } = await chrome.storage.local.get('autopilot');
  return autopilot || null;
}
async function setAutopilot(v) {
  await chrome.storage.local.set({ autopilot: v });
}

/** Every minute (chrome.alarms): start in working hours, stop after them, restart on a new day for a fresh limit. */
async function autopilotTick() {
  const ap = await getAutopilot();
  if (!ap?.on || !ap.profileId || !ap.human || !(await getAuth())) return;
  const t = tzNow(ap.timezone);
  const inside = inSchedule(ap.human, ap.timezone);
  if (running) {
    if (state.test || state.profileId !== ap.profileId || stopRequested) return;
    if (!inside) {
      stopRequested = true;
      await log(`⏰ Автопілот: робочий час скінчився — вимикаюсь. Розклад: ${scheduleText(ap.human)}`);
    } else if (ap.runDay && ap.runDay !== t.day && ['limit', 'watching'].includes(state.status)) {
      stopRequested = true;
      await log('⏰ Автопілот: новий день — перезапускаюсь з новим лімітом');
    }
    return;
  }
  if (!inside || ap.heldDay === t.day) return; // stopped by hand today: back tomorrow
  if (ap.errorAt && Date.now() - ap.errorAt < 15 * 60000) return; // don't hammer a broken site
  await setAutopilot({ ...ap, runDay: t.day, errorAt: null });
  await log(`⏰ Автопілот: робочий час (${scheduleText(ap.human)}) — вмикаюсь сам`);
  start(ap.profileId, null, false, { auto: true });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'autopilot') autopilotTick().catch(() => {}); });
chrome.alarms.get('autopilot').then((a) => { if (!a) chrome.alarms.create('autopilot', { periodInMinutes: 1 }); });

async function start(profileId, tabId, test = false, { auto = false } = {}) {
  if (running) return;
  running = true;
  stopRequested = false;
  keepAlive(true);
  try {
    if (test) {
      await runTest(profileId, tabId);
      await setState({ status: 'stopped' });
      return;
    }
    await run(profileId, tabId);
    await setState({ status: 'stopped', message: 'Зупинено' });
    await heartbeat(true, 'idle');
  } catch (e) {
    await setState({ status: 'error' });
    await log(`${test ? '🧪 ' : ''}Помилка: ${e.message}`, 'error');
    if (!test) await heartbeat(true, 'error');
    if (auto) {
      const ap = await getAutopilot();
      if (ap) await setAutopilot({ ...ap, errorAt: Date.now() });
      await log('⏰ Автопілот спробує ще раз через 15 хв', 'warn');
    }
  } finally {
    running = false;
    keepAlive(false);
    await chrome.storage.session.remove('active');
  }
}

// ---------------- messages from the popup ----------------
const handlers = {
  async state() {
    const { auth } = await chrome.storage.local.get('auth');
    const ap = await getAutopilot();
    return {
      state, running, auth: auth ? { server: auth.server, user: auth.user } : null, defaultServer: DEFAULT_SERVER,
      autopilot: ap ? { on: Boolean(ap.on), profileId: ap.profileId, profileName: ap.profileName, schedule: ap.human ? scheduleText(ap.human) : '' } : null,
    };
  },
  /** Turns the schedule on for a profile (its scenario's days and hours) or off. */
  async autopilot({ on, profileId }) {
    if (!on) {
      const ap = await getAutopilot();
      await setAutopilot({ ...(ap || {}), on: false });
      await log('⏰ Автопілот вимкнено');
      return { on: false };
    }
    const cfg = await api(`/api/bot/profiles/${Number(profileId)}/config`);
    const human = cfg.scenario?.human;
    if (!human) throw new Error('Не вдалося прочитати розклад анкети');
    await setAutopilot({ on: true, profileId: Number(profileId), profileName: cfg.profile.name, human, timezone: cfg.timezone, heldDay: null, runDay: null, errorAt: null });
    await log(`⏰ Автопілот увімкнено: ${cfg.profile.name}, ${scheduleText(human)}. Браузер має бути відкритий, а ви — залогінені на сайті`);
    autopilotTick().catch(() => {});
    return { on: true, schedule: scheduleText(human) };
  },
  async login({ server, email, password }) {
    const base = String(server || DEFAULT_SERVER).trim().replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, kind: 'bot' }),
      });
    } catch {
      throw new Error('Сервер недоступний. Перевірте адресу панелі.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не вдалося увійти');
    await chrome.storage.local.set({ auth: { server: base, token: data.token, user: data.user } });
    return { user: data.user };
  },
  async logout() {
    stopRequested = true;
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    await chrome.storage.local.remove('auth');
    await setState({ ...EMPTY_STATE });
    return {};
  },
  async profiles() {
    return api('/api/bot/profiles');
  },
  async start({ profileId, tabId, test }) {
    if (running) throw new Error('Бот уже працює');
    unseenReplies = 0;
    const ap = await getAutopilot();
    if (ap?.heldDay) await setAutopilot({ ...ap, heldDay: null });
    start(Number(profileId), tabId, Boolean(test));
    return {};
  },
  async stop() {
    stopRequested = true;
    await log('Зупиняю…');
    // Stopped by hand during working hours: the autopilot leaves it off until the next working day.
    const ap = await getAutopilot();
    if (ap?.on && ap.human && inSchedule(ap.human, ap.timezone)) {
      await setAutopilot({ ...ap, heldDay: tzNow(ap.timezone).day });
      await log('⏰ Автопілот: сьогодні більше не вмикаюсь сам (до наступного робочого дня)');
    }
    return {};
  },
  async seen() {
    unseenReplies = 0;
    updateBadge();
    return {};
  },
  async checkInbox() {
    if (!state.profileId) throw new Error('Спочатку запустіть бота для анкети');
    const cfg = await api(`/api/bot/profiles/${state.profileId}/config`);
    const n = await checkInbox(cfg.site.config, state.profileId);
    return { new: n };
  },
  /** "🎯 Навчити бота": opens the teaching panel on the current tab (it survives page changes in that tab). */
  async teach({ profileId, tabId }) {
    for (let i = 0; running && stopRequested && i < 40; i++) await sleep(250); // just pressed Stop
    if (running) throw new Error('Спочатку зупиніть бота');
    if (!tabId) throw new Error('Відкрийте сайт знайомств у вкладці');
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('Відкрийте сайт знайомств у цій вкладці й натисніть ще раз');
    const r = await api(`/api/bot/profiles/${profileId}/site`);
    const teach = { tabId, profileId, siteId: r.site.id, siteName: r.site.name, fields: r.fields, config: r.site.config, tab: 'list' };
    await chrome.storage.session.set({ teach });
    await openTeach(teach);
    return {};
  },
  async teachDraft({ config, tab }) {
    const { teach } = await chrome.storage.session.get('teach');
    if (teach) await chrome.storage.session.set({ teach: { ...teach, config, tab } });
    return {};
  },
  async teachEnd() {
    await chrome.storage.session.remove('teach');
    return {};
  },
  async saveSite({ siteId, config }) {
    const r = await api(`/api/bot/sites/${siteId}`, { method: 'PUT', body: { config } });
    const { teach } = await chrome.storage.session.get('teach');
    if (teach) await chrome.storage.session.set({ teach: { ...teach, config: r.config } });
    return { config: r.config };
  },
  async probe({ profileId, tabId }) {
    const cfg = await api(`/api/bot/profiles/${profileId}/config`);
    return inTab(tabId, 'probe', { site: cfg.site.config });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg).then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function openTeach(teach, message) {
  await chrome.scripting.executeScript({ target: { tabId: teach.tabId }, files: ['content.js', 'picker.js'] });
  await chrome.scripting.executeScript({
    target: { tabId: teach.tabId },
    func: (data) => window.__agencyPicker.open(data),
    args: [{ siteId: teach.siteId, siteName: teach.siteName, fields: teach.fields, config: teach.config, tab: teach.tab, message }],
  });
}

// The teaching panel comes back after the operator goes to another page (his profile, inbox…).
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !/^https?:/.test(tab.url || '')) return;
  const { teach } = await chrome.storage.session.get('teach');
  if (!teach || teach.tabId !== tabId) return;
  openTeach(teach, 'Нова сторінка — продовжуємо. Незбережене не втрачено').catch(() => {});
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { teach } = await chrome.storage.session.get('teach');
  if (teach?.tabId === tabId) chrome.storage.session.remove('teach');
});

chrome.notifications.onClicked.addListener(async () => {
  const cfgTab = state.tabId ? await chrome.tabs.get(state.tabId).catch(() => null) : null;
  if (cfgTab) chrome.tabs.update(cfgTab.id, { active: true });
});

// Resume after the service worker was restarted mid-run (not after a browser restart: session storage is cleared then).
(async () => {
  const { state: saved } = await chrome.storage.local.get('state');
  if (saved) state = { ...EMPTY_STATE, ...saved };
  const { active } = await chrome.storage.session.get('active');
  if (active && !running) {
    await log('Відновлюю роботу після перезапуску розширення…', 'warn');
    start(active.profileId, active.tabId);
  } else if (['running', 'waiting', 'sleeping', 'watching', 'limit'].includes(state.status)) {
    await setState({ status: 'stopped', message: 'Зупинено (браузер перезапущено)' });
  }
  updateBadge();
})();
