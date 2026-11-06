// Builds the report on the operator's computer: reads what was recorded, recognises roles, checks once more that
// nothing personal is inside, packs a zip and downloads it.
const M = self.__scanMask;
const R = self.__scanRoles;
const DB = self.__scanDb;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

function step(text, state = 'run') {
  const li = document.createElement('li');
  li.className = state;
  li.textContent = text;
  $('steps').append(li);
  return (t, s = 'ok') => { li.textContent = t || text; li.className = s; };
}

// ---------------- privacy: every string through the last filter ----------------
let fixes = 0;
const DEBUG = location.search.includes('debug'); // developer only: shows in the console what the last filter cut (never saved)
function clean(v) {
  if (typeof v === 'string') { const [s, f] = M.scrub(v); if (f && DEBUG) console.log('scrubbed:', v.slice(0, 120)); fixes += f; return s; }
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clean(x); return o; }
  return v;
}
const jsonl = (list) => list.map((x) => JSON.stringify(clean(x))).join('\n');

// ---------------- zip (deflate) ----------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function deflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dtime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const ddate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name);
    let raw = f.make ? await f.make() : f.data;
    const data = typeof raw === 'string' ? enc.encode(raw) : raw;
    raw = null;
    if (f.onDone) f.onDone();
    const comp = await deflate(data);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
    h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true); h.setUint32(18, comp.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, comp);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 8, true);
    c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, comp.length, true);
    c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

// ---------------- analysis ----------------
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const descKey = (d) => (d ? `${d.tg}${d.c?.length ? `.${d.c.slice(0, 2).join('.')}` : ''}${d.r ? `[role=${d.r}]` : ''}${d.ext ? '[ext]' : ''}${d.tx && d.tx.length < 40 ? ` «${d.tx}»` : ''}` : '?');

function botAnalysis(events) {
  const clicks = events.filter((e) => e.ty === 'click');
  const types = events.filter((e) => e.ty === 'type');
  const syn = clicks.filter((e) => !e.tr);
  const real = clicks.filter((e) => e.tr);
  const gaps = (list) => { const g = []; for (let i = 1; i < list.length; i++) g.push(list[i].t - list[i - 1].t); return g; };
  const sg = gaps(syn);
  const mean = sg.length ? sg.reduce((a, b) => a + b, 0) / sg.length : 0;
  const sd = sg.length ? Math.sqrt(sg.reduce((a, b) => a + (b - mean) ** 2, 0) / sg.length) : 0;
  const it = {};
  for (const t of types) for (const k of t.it || []) it[k] = (it[k] || 0) + 1;
  const seq = {};
  for (let i = 1; i < syn.length; i++) { const k = `${descKey(syn[i - 1].d)}  →  ${descKey(syn[i].d)}`; seq[k] = (seq[k] || 0) + 1; }
  return {
    note: 'Кліки з isTrusted=0 — програмні (інше розширення / скрипт). detail=0 — клік через el.click(). mv=0 — без руху миші перед кліком. [ext] — клік по панелі іншого розширення, не по сайту.',
    clicksOnOtherExtension: clicks.filter((e) => e.d?.ext).length,
    clicks: clicks.length, trustedClicks: real.length, syntheticClicks: syn.length,
    clickNoDetail: clicks.filter((e) => e.det === 0).length, clickNoMouseMove: clicks.filter((e) => !e.mv).length, clickNoPointerDown: clicks.filter((e) => !e.pd).length,
    syntheticGapMs: { median: median(sg), mean: Math.round(mean), sd: Math.round(sd) },
    typingBursts: types.length, untrustedTyping: types.filter((t) => !t.tr).length, inputTypes: it,
    enterKeys: events.filter((e) => e.ty === 'key' && /Enter/.test(e.k)).length,
    topSyntheticTargets: topN(syn.map((e) => descKey(e.d)), 20),
    topTrustedTargets: topN(real.map((e) => descKey(e.d)), 20),
    topSyntheticSequences: Object.entries(seq).sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}
const parts = (list, size) => { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out.length ? out : [[]]; };

/** What the pages themselves say about the site: framework hints, size, load times (from the one-time page facts). */
function pageFacts(events) {
  const info = events.filter((e) => e.ty === 'pageinfo');
  const fw = topN(info.flatMap((e) => e.fw || []), 10);
  const byRoute = {};
  for (const e of info) {
    const r = (byRoute[e.r] ||= { n: 0, nodes: 0, maxNodes: 0, iframes: 0, shadow: 0, custom: 0, dom: [], scripts: new Set() });
    r.n++; r.nodes += e.nodes; r.maxNodes = Math.max(r.maxNodes, e.nodes); r.iframes = Math.max(r.iframes, e.iframes); r.shadow = Math.max(r.shadow, e.shadow); r.custom = Math.max(r.custom, e.custom);
    if (e.load?.dom) r.dom.push(e.load.dom);
    for (const x of e.scripts || []) if (r.scripts.size < 30) r.scripts.add(x);
  }
  return {
    frameworks: fw, screen: info[0] ? { dpr: info[0].dpr, vw: info[0].vw, vh: info[0].vh, sw: info[0].sw, sh: info[0].sh, lang: info[0].lang } : null,
    routes: Object.entries(byRoute).map(([r, v]) => ({ route: r, loads: v.n, avgNodes: Math.round(v.nodes / v.n), maxNodes: v.maxNodes, iframes: v.iframes, shadow: v.shadow,
      custom: v.custom, domReadyMs: median(v.dom), scripts: [...v.scripts] })).sort((a, b) => b.loads - a.loads).slice(0, 30),
  };
}

function topN(list, n) { const m = {}; for (const x of list) m[x] = (m[x] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n); }

/** Which requests follow which actions within 3 s (e.g. click «Send» → POST SITE/api/messages). */
function correlate(events, netlog) {
  const reqs = netlog.filter((r) => r.ty === 'xmlhttprequest' || r.ty === 'websocket' || r.ty === 'main_frame' || r.ty === 'other' || r.ty === 'ping').sort((a, b) => a.t - b.t);
  const times = reqs.map((r) => r.t);
  const out = {};
  for (const e of events) {
    if (!['click', 'key', 'submit', 'file'].includes(e.ty) || !e.d) continue;
    let lo = 0; let hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < e.t) lo = mid + 1; else hi = mid; }
    const after = [];
    for (let i = lo; i < reqs.length && reqs[i].t <= e.t + 3000 && after.length < 6; i++) after.push(`${reqs[i].m} ${reqs[i].u} → ${reqs[i].st}`);
    const key = `${e.ty}${e.k ? `:${e.k}` : ''} ${descKey(e.d)}`;
    const o = (out[key] ||= { n: 0, trusted: 0, req: {}, fx: {} });
    o.n++;
    if (e.tr) o.trusted++;
    for (const a of after) o.req[a] = (o.req[a] || 0) + 1;
    for (const [sig, c] of e.fx?.added || []) o.fx[`+${sig}`] = (o.fx[`+${sig}`] || 0) + c;
    for (const t of e.fx?.texts || []) o.fx[`«${t}»`] = (o.fx[`«${t}»`] || 0) + 1;
    if (e.fx?.firstMs !== undefined) (o.ms ||= []).push(e.fx.firstMs);
    for (const c of e.fx?.counters || []) o.fx[`${c.tpl} ${c.delta > 0 ? '+' : ''}${c.delta}`] = (o.fx[`${c.tpl} ${c.delta > 0 ? '+' : ''}${c.delta}`] || 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1].n - a[1].n).slice(0, 80).map(([k, v]) => ({
    action: k, n: v.n, trusted: v.trusted, reactMs: v.ms ? median(v.ms) : undefined,
    requests: Object.entries(v.req).sort((a, b) => b[1] - a[1]).slice(0, 6),
    effects: Object.entries(v.fx).sort((a, b) => b[1] - a[1]).slice(0, 8),
  }));
}

function textStats(states) {
  const ell = {};
  const counters = {};
  for (const s of states) {
    for (const n of s.state.n || []) {
      if (n.el && n.tn) ell[n.tn] = (ell[n.tn] || 0) + 1;
      if (n.tx && /#/.test(n.tx) && R.KW.counter.test(n.tx)) counters[n.tx] = (counters[n.tx] || 0) + 1;
    }
  }
  return {
    note: 'Довжини текстів, обрізаних трикрапкою (прев’ю). Скільки символів показує сайт у прев’ю — дивитись тут.',
    ellipsisLengths: Object.entries(ell).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]),
    counters: Object.entries(counters).sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

const ROLE_COLOR = { messageInput: '#4dabf7', sendButton: '#51cf66', translateButton: '#ffd43b', attach: '#ff922b', fileInput: '#ff922b', letterButton: '#cc5de8',
  chatItem: '#20c997', chatList: '#12b886', chatHeader: '#748ffc', hintItem: '#f06595', counter: '#fab005', herCurrent: '#e599f7', herSwitch: '#e599f7',
  tab: '#91a7ff', messageBubble: '#868e96', danger: '#fa5252', likeButton: '#ff8787', favoriteButton: '#ffa8a8', searchInput: '#66d9e8', modal: '#adb5bd' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A screen as boxes: what is where and what the scanner thinks it is. No pictures, no texts beyond the masked ones. */
function wireframe(s, roles) {
  const st = s.state;
  const W = st.vw || 1280; const H = Math.max(st.vh || 800, 400);
  const mark = new Map();
  for (const [role, list] of Object.entries(roles)) for (const c of list.slice(0, role === 'danger' ? 6 : 1)) if (c.score >= 0.4 && !mark.has(c.i)) mark.set(c.i, role);
  const rects = [];
  (st.n || []).forEach((n, i) => {
    if (!n.v || !n.b || n.f) return;
    const [x, y, w, h] = n.b;
    if (w < 6 || h < 6 || x > W || y > H * 1.5 || x + w < 0 || y + h < 0) return;
    const role = mark.get(i);
    if (!role && rects.length > 700) return;
    rects.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${role ? `${ROLE_COLOR[role] || '#fff'}33` : 'none'}" stroke="${role ? ROLE_COLOR[role] || '#fff' : '#3a3440'}" stroke-width="${role ? 2 : 0.6}"/>`);
    if (role) rects.push(`<text x="${x + 3}" y="${y + 12}" fill="${ROLE_COLOR[role] || '#fff'}" font-size="11" font-family="sans-serif" font-weight="700">${esc(role)}</text>`);
    else if (n.tx && w > 30 && h >= 10 && rects.length < 1400) rects.push(`<text x="${x + 2}" y="${y + Math.min(h - 2, 11)}" fill="#8b8494" font-size="9" font-family="sans-serif">${esc(clean(n.tx).slice(0, Math.max(3, Math.floor(w / 6))))}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#141217"/>`
    + `<text x="8" y="${H - 8}" fill="#6c6474" font-size="12" font-family="sans-serif">${esc(clean(s.route))} · бачили ${s.count}×</text>${rects.join('')}</svg>`;
}

function htmlSummary(sum) {
  const rows = (list, f) => list.map(f).join('');
  const roles = Object.entries(sum.roles).map(([role, list]) => `<tr><td><b>${esc(role)}</b></td><td>${list[0] ? `<code>${esc(list[0].css[0])}</code>` : '—'}</td><td>${list[0] ? Math.round(list[0].confidence * 100) : 0}%</td><td>${list[0] ? list[0].states : 0}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Звіт сканера</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#121014;color:#eee;max-width:1100px;margin:24px auto;padding:0 16px}code{color:#ffd8e6}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2e2934;padding:4px 8px;text-align:left;vertical-align:top}h2{margin-top:28px}.m{color:#9b92a3}</style>
<h1>Звіт сканера</h1>
<p class="m">Записано: ${esc(sum.scan.from)} → ${esc(sum.scan.to)} (${esc(sum.scan.duration)}). Версія ${esc(sum.scan.version)}. Особистих даних у звіті немає: імена, тексти, ID, фото, адреси з ID замінено заглушками.</p>
<p>Екранів (унікальних станів): <b>${sum.counts.states}</b> · дій: <b>${sum.counts.events}</b> · типів запитів: <b>${sum.counts.net}</b> · подій: <b>${sum.counts.incidents}</b> · перевірок: <b>${sum.counts.probes}</b></p>
<h2>Що де на сайті (найкращі кандидати)</h2><table><tr><th>Роль</th><th>Селектор</th><th>Впевненість</th><th>Екранів</th></tr>${roles}</table>
<h2>Сторінки</h2><table>${rows(sum.routes.slice(0, 40), ([r, n]) => `<tr><td><code>${esc(r)}</code></td><td>${n}</td></tr>`)}</table>
<h2>Інший бот / програмні дії</h2><pre>${esc(JSON.stringify(sum.bot, null, 1))}</pre>
<h2>Дія → що сталось</h2><pre>${esc(JSON.stringify(sum.actions.slice(0, 25), null, 1))}</pre>
<h2>Події (сон, розлогін, капча, вкладки)</h2><pre>${esc(JSON.stringify(sum.incidents, null, 1))}</pre>
<h2>Прев’ю й лічильники</h2><pre>${esc(JSON.stringify(sum.texts, null, 1))}</pre>`;
}

// ---------------- build ----------------
async function build() {
  $('go').disabled = true;
  $('steps').replaceChildren();
  $('result').hidden = true;
  fixes = 0;
  const t0 = Date.now();
  try {
    let s = step('Зберігаю останнє…');
    await chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {});
    s('Останнє збережено');

    s = step('Читаю записане…');
    const meta = (await DB.get('meta', 'main').catch(() => null)) || {};
    const read = async (store) => { const out = []; await DB.each(store, (v) => out.push(v)).catch((e) => { out.error = String(e?.message || e); }); return out; };
    const [states, events, netlog, net, probes, incidents] = await Promise.all(['states', 'events', 'netlog', 'net', 'probes', 'incidents'].map(read));
    events.sort((a, b) => a.t - b.t); // actions with an effect are stored a few seconds later
    netlog.sort((a, b) => a.t - b.t);
    // repeat views of known screens are counted separately (small) — add them to the screens
    for (const st of states) { const c = meta.seen?.[st.sig]; if (c) { st.count += c[0]; st.last = Math.max(st.last, c[1]); } }
    s(`Прочитано: екранів ${states.length}, дій ${events.length}, запитів ${netlog.length}`);

    s = step('Розпізнаю, що де на сайті…');
    const classified = [];
    const flags = { captcha: 0, login: 0, modal: 0, foreign: 0 };
    for (const st of states) {
      try {
        if (st.state.light) {
          // stored without elements (the space budget was used up): roles were recognised when it was recorded
          const { flags: f = {}, ...best } = st.state.best || {};
          st.roles = Object.fromEntries(Object.entries(best).map(([k, v]) => [k, [{ ...v, tg: '?', why: [] }]]));
          for (const k of Object.keys(flags)) if (f[k]) flags[k] += 1;
        } else {
          const c = R.classify(st.state);
          st.roles = c.roles;
          for (const k of Object.keys(flags)) if (c.flags[k]) flags[k] += 1;
        }
        classified.push({ roles: st.roles, route: st.route, count: st.count });
      } catch (e) { st.roleError = String(e?.message || e).slice(0, 80); }
    }
    const roles = R.aggregate(classified);
    s('Ролі розпізнано');

    s = step('Аналізую дії й мережу…');
    const routes = {};
    for (const st of states) routes[st.route] = (routes[st.route] || 0) + st.count;
    const transitions = topN(events.filter((e) => e.ty === 'route').map((e) => `${e.from} → ${e.r}`), 40);
    const scan = (await chrome.storage.local.get('scan')).scan || {};
    const first = meta.startedAt || scan.startedAt || (states[0]?.first);
    const last = Math.max(...states.map((x) => x.last || 0), ...events.slice(-1).map((e) => e.t), Date.now() * 0);
    const sum = {
      scan: {
        version: chrome.runtime.getManifest().version, from: first ? new Date(first).toISOString() : '?', to: new Date(last || Date.now()).toISOString(),
        duration: first ? `${Math.round(((last || Date.now()) - first) / 60000)} хв` : '?', browser: meta.browser, lang: meta.lang, tz: meta.tz, starts: meta.starts,
        stillRecording: Boolean(scan.scanning),
      },
      counts: { states: states.length, events: events.length, netlog: netlog.length, net: net.length, probes: probes.length, incidents: incidents.length,
        statesOverCap: meta.overflow || 0, statesLight: meta.lightStates || 0, stateMB: Math.round((meta.stateBytes || 0) / 1e6),
        eventsDropped: meta.dropped || 0, eventsTrimmed: meta.eventsTrimmed || 0, storageFull: Boolean(meta.full), storageMB: meta.usage ? Math.round(meta.usage / 1e6) : null },
      roles, flags, otherExtensions: meta.ext || [],
      routes: Object.entries(routes).sort((a, b) => b[1] - a[1]),
      transitions,
      network: net.sort((a, b) => b.n - a.n).slice(0, 150).map((a) => ({ ...a, avgMs: Math.round(a.dsum / Math.max(1, a.n)) })),
      bot: botAnalysis(events),
      actions: correlate(events, netlog),
      texts: textStats(states),
      incidents: topN(incidents.map((i) => i.kind), 40),
      probes: probes.slice(-80),
      pages: pageFacts(events),
      scrollBoxes: topN(events.filter((e) => e.ty === 'scrollbox').map((e) => `${descKey(e.d)} end=${e.end} kids=${e.kids > 50 ? '50+' : e.kids}`), 30),
      toasts: topN(events.flatMap((e) => e.fx?.texts || []), 60),
      readErrors: Object.fromEntries([['states', states], ['events', events], ['netlog', netlog]].filter(([, l]) => l.error).map(([k, l]) => [k, l.error])),
    };
    s('Аналіз готовий');

    s = step('Малюю схеми екранів…');
    const topStates = states.filter((x) => x.state.n?.length).sort((a, b) => b.count - a.count).slice(0, 30);
    const svgs = topStates.map((st, i) => ({ name: `screens/${String(i + 1).padStart(2, '0')}-${st.route.replace(/[^\w.-]+/g, '_').slice(0, 50)}.svg`, data: wireframe(st, st.roles || {}) }));
    s(`Схем: ${svgs.length}`);

    s = step('Перевіряю, що немає особистих даних…');
    const files = [
      { name: 'ПРОЧИТАЙ.txt', data: README },
      { name: 'summary.json', data: JSON.stringify(clean(sum), null, 1) },
      { name: 'summary.html', data: htmlSummary(clean(sum)) },
      ...parts(states, 60).map((list, i) => ({ name: `states/part-${String(i + 1).padStart(2, '0')}.jsonl`,
        make: () => jsonl(list.map(({ roles: r, ...x }) => ({ ...x, best: Object.fromEntries(Object.entries(r || {}).filter(([, l]) => l[0]).map(([k, l]) => [k, { i: l[0].i, score: l[0].score, css: l[0].css, xp: l[0].xp }])) }))) })),
      ...parts(events, 25000).map((list, i) => ({ name: `events/part-${String(i + 1).padStart(2, '0')}.jsonl`, make: () => jsonl(list) })),
      { name: 'network.json', data: JSON.stringify(clean(net), null, 1) },
      { name: 'network-log.jsonl', make: () => jsonl([...netlog.slice(0, 10000), ...netlog.slice(Math.max(10000, netlog.length - 40000))]) },
      { name: 'incidents.json', data: JSON.stringify(clean(incidents), null, 1) },
      { name: 'probes.json', data: JSON.stringify(clean(probes), null, 1) },
      ...svgs, // texts inside are cleaned one by one (the svg itself has a w3.org namespace URL that must stay)
    ];
    s = step('Пакую архів (і перевіряю кожен файл)…');
    const blob = await zip(files);
    step(fixes ? `Перевірено: додатково приховано ${fixes} підозрілих фрагментів` : 'Перевірено: особистих даних не знайдено', 'ok');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
    const name = `scan-report-${stamp}.zip`;
    const url = URL.createObjectURL(blob);
    const a = $('dl');
    a.href = url;
    a.download = name;
    a.textContent = `⬇ ${name} (${blob.size < 1048576 ? `${Math.max(1, Math.round(blob.size / 1024))} КБ` : `${(blob.size / 1048576).toFixed(1)} МБ`})`;
    $('fname').textContent = name;
    $('result').hidden = false;
    a.click();
    s(`Готово за ${Math.round((Date.now() - t0) / 1000)} с`);
    document.title = 'Звіт готовий';
    window.__reportDone = { name, size: blob.size, fixes, states: states.length, events: events.length };
  } catch (e) {
    step(`Помилка: ${e?.message || e}. Спробуйте ще раз — записане не втрачено.`, 'err');
    window.__reportDone = { error: String(e?.message || e) };
  } finally {
    $('go').disabled = false;
  }
}

const README = `ЗВІТ СКАНЕРА САЙТУ

Що це: запис того, як влаштований сайт (структура екранів, кнопки, переходи, що відбувається після дій).
Особистих даних немає: імена, тексти листування, ID, фото, адреси з ID, паролі, cookies — не записувались
або замінені заглушками ([W] — слово з великої, [w] — слово, # — число, [текст N] — текст довжиною N).

Файли:
  summary.html      — короткий огляд (відкрити в браузері)
  summary.json      — те саме для розробника
  states/*.jsonl    — кожен унікальний екран: елементи, класи, атрибути, розміри, стани, ролі
  events/*.jsonl    — дії (клік / Enter / набір / файл / прокрутка), без текстів; tr=1 — людина, tr=0 — програмно
  network.json      — шаблони запитів сайту (без вмісту), коди, час
  network-log.jsonl — останні запити по часу
  incidents.json    — сон, розлогін, капча, закриття вкладок, інтернет
  probes.json       — щогодинні перевірки «що бот бачить»
  screens/*.svg     — схеми екранів (рамки + ролі)

Надішліть цей архів розробнику.
`;

$('go').addEventListener('click', build);
if (!location.search.includes('wait')) build();
