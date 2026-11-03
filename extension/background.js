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
  } else if (state.status === 'error') {
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

const mapBotState = () => ({ running: 'running', waiting: 'running', sleeping: 'running', watching: 'done', limit: 'limit', error: 'error', stopped: 'idle', idle: 'idle' }[state.status] || 'running');

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

async function prepareTab(tabId, site) {
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!site.searchUrl) {
    if (!tab) throw new Error('Відкрийте сторінку пошуку на сайті та натисніть Старт');
    return tab.id;
  }
  if (tab && tab.url && sameOrigin(tab.url, site.searchUrl)) {
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
  const { hoursFrom, hoursTo } = ctx.human;
  if (inHours(localHour(ctx.timezone), hoursFrom, hoursTo)) return;
  const msg = `Неробочий час — продовжу о ${String(hoursFrom).padStart(2, '0')}:00`;
  await log(`🌙 ${msg}. Поки що лише стежу за відповідями`);
  await setState({ status: 'sleeping', message: msg });
  let lastInbox = Date.now();
  while (!stopRequested && !inHours(localHour(ctx.timezone), hoursFrom, hoursTo)) {
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
    const ms = ctx.human.breakMinutes * rand(0.6, 1.4) * 60000;
    await setState({ message: `Перерва ${Math.round(ms / 60000)} хв` });
    await log(`☕ Перерва ${Math.round(ms / 60000)} хв, як у живої людини`);
    await waitUntil(Date.now() + ms, ctx);
    return;
  }
  await pause(ctx.limits);
}

async function pause(limits) {
  const total = rand(limits.minDelay, limits.maxDelay) * 1000;
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
      const names = r.men.map((m) => m.name || m.id).join(', ');
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
  try { res = await inTab(tabId, 'compose', { site, man, dry, typing }); } catch (e) { res = { ok: false, error: e.message }; }
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
  try { return (await inTab(tabId, 'compose', { site, man, dry, typing })) || { ok: false, error: 'немає відповіді від сторінки' }; } catch (e) { return { ok: false, error: e.message }; }
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
  const goToHim = async () => {
    if (!man.url) return false;
    await navigate(tabId, man.url);
    where = 'page';
    left = true;
    return true;
  };
  for (const a of actions) {
    if (stopRequested || msgError) break;
    if (a.do === 'pause') { await sleep(a.seconds * 1000); continue; }
    if (a.do === 'view') {
      if (!dry && Math.random() * 100 >= (a.chance ?? 100)) continue;
      if (where === 'card' && !(await goToHim())) { warnings.push('немає посилання на його профіль — перегляд пропущено'); continue; }
      await inTab(tabId, 'view', { seconds: dry ? 3 : a.seconds }).catch(() => null);
      did++;
      continue;
    }
    if (a.do === 'click') {
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
      const m = { ...man, text: a.text };
      let res;
      try { res = where === 'card' ? await sendOne(tabId, site, m, dry, typing) : await sendOnPage(tabId, site, m, dry, typing); } catch (e) { res = { ok: false, error: e.message }; }
      if (res?.ok) { messages++; did++; } else msgError = res?.error || 'помилка відправки';
    }
  }
  if (left && home) await navigate(tabId, home);
  const hasMessage = actions.some((a) => a.do === 'message');
  const ok = hasMessage ? !msgError && messages > 0 : did > 0;
  return { ok, messages, error: msgError || (!ok ? warnings.join('; ') : ''), warnings };
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
    await setState({ message: `↻ Спроба ${man.step}/${man.of}: ${man.name || man.id}` });
    let res;
    try {
      await navigate(ctx.tabId, man.url);
      res = await runActions(ctx.tabId, ctx.site, man, man.actions, { where: 'page', typing: ctx.human.typing });
    } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
    const text = man.actions.find((a) => a.do === 'message')?.text || '';
    const r = await api(`/api/bot/profiles/${ctx.profileId}/step`, {
      method: 'POST', body: { man: { id: man.id }, step: man.step, ok: res.ok, messages: res.messages, text, error: res.error },
    });
    if (res.ok) {
      await setState({ sent: state.sent + res.messages, followups: (state.followups || 0) + 1, remaining: r.remaining });
      await log(`↻ ${man.name || man.id}: спроба ${man.step}/${man.of} ✓${r.stage === 'done' ? ' — остання, далі без відповіді він зникне зі списку' : ''}`);
    } else {
      await setState({ failed: state.failed + 1, remaining: r.remaining });
      await log(`↻ ${man.name || man.id}: спроба ${man.step} не вдалась — ${res.error}`, 'warn');
    }
    for (const w of res.warnings || []) if (res.ok) await log(`  ⚠ ${w}`, 'warn');
    await heartbeat();
    if (r.stop) { ctx.limitReached = true; break; }
    await afterMan(ctx, r, res.messages);
  }
  if (!stopRequested && home) await navigate(ctx.tabId, home);
  return due.men.length;
}

async function loadRun(profileId, test) {
  const cfg = await api(`/api/bot/profiles/${profileId}/config`);
  const site = cfg.site.config;
  if (!site.card || !site.cardId || !site.messageInput) throw new Error('Сайт налаштовано не повністю (картка, ID, поле вводу). Натисніть 🎯 «Навчити бота» або заповніть у панелі');
  const human = cfg.scenario?.human || { hoursFrom: 0, hoursTo: 0, perHour: 0, breakEvery: 0, breakMinutes: 10, typing: false };
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

    outer: while (!stopRequested) {
      await waitWorkingHours(ctx);
      await processDue(ctx);
      if (ctx.limitReached || stopRequested) break;
      await waitTabComplete(tabId);
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
        tried.add(man.id);
        let res;
        try { res = await runActions(tabId, site, man, man.actions || [{ do: 'message', text: man.text }], { where: 'card', typing: ctx.human.typing, home: listUrl }); } catch (e) { res = { ok: false, messages: 0, error: e.message, warnings: [] }; }
        const r = await api(`/api/bot/profiles/${profileId}/sent`, {
          method: 'POST', body: { man, ok: res.ok, error: res.error, text: man.text, invite_id: man.invite_id },
        });
        if (res.ok) {
          failsInRow = 0;
          await setState({ sent: state.sent + res.messages, remaining: r.remaining });
          await log(`✓ ${man.name || man.id}`);
          for (const w of res.warnings) await log(`  ⚠ ${w}`, 'warn');
        } else {
          failsInRow++;
          await setState({ failed: state.failed + 1, remaining: r.remaining });
          await log(`✗ ${man.name || man.id}: ${res.error}`, 'warn');
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
      const fresh = await inTab(tabId, 'scan', { site });
      if (fresh?.hasNext) {
        await inTab(tabId, 'next', { site }).catch(() => null);
        await waitForNavigation(tabId);
        await setState({ page: state.page + 1 });
      } else if (site.nextPage) {
        await log('Сторінки закінчились');
        break;
      } else {
        // No pagination button configured → the site is an infinite feed: scroll for more men.
        const m = await inTab(tabId, 'more', { site });
        if (m?.grew) {
          noGrowth = 0;
          await setState({ page: state.page + 1 });
        } else if (++noGrowth >= 2) {
          await log('Список чоловіків закінчився');
          break;
        }
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
    if (!ctx.limitReached && ctx.tabId && inHours(localHour(ctx.timezone), ctx.human.hoursFrom, ctx.human.hoursTo)) {
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

  // 1. Search page
  const scan = await inTab(tabId, 'scan', { site });
  const men = scan?.candidates || [];
  if (!men.length) {
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
        await log(`✓ ${man.name || man.id}: крок 1 пройдено (${(man.actions || []).map((a) => ({ message: 'повідомлення', click: a.name, view: 'перегляд профілю', pause: 'пауза' }[a.do])).join(' → ')}) — НІЧОГО не надіслано`);
        for (const w of res.warnings) await warn(w);
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
  if (problems.length) {
    for (const p of problems) await log(`✗ ${p}`, 'error');
    throw new Error(`тест знайшов проблем: ${problems.length}. Виправте (🎯 Навчити бота або панель) й запустіть тест ще раз`);
  }
  await setState({ message: 'Тест пройдено. Можна запускати справжню розсилку' });
  await log('🧪 Тест пройдено ✓ Можна запускати справжню розсилку', 'reply');
}

async function start(profileId, tabId, test = false) {
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
    return { state, running, auth: auth ? { server: auth.server, user: auth.user } : null, defaultServer: DEFAULT_SERVER };
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
    start(Number(profileId), tabId, Boolean(test));
    return {};
  },
  async stop() {
    stopRequested = true;
    await log('Зупиняю…');
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
