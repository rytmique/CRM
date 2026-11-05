// Page recorder. Only LOOKS: never clicks, types, focuses, scrolls, adds or changes anything on the page.
// Records the structure of every new state of the page (masked), what the person / another bot does (no texts),
// and what changes after each action. Sends everything to the background, which stores it on this computer.
(() => {
  // one recorder per page; an old one from before a scanner update is dead (its extension context is gone)
  try { if (window.__siteScanAlive?.()) return; } catch { /* old context */ }
  window.__siteScanAlive = () => alive && Boolean(chrome.runtime?.id);

  const M = self.__scanMask;
  const R = self.__scanRoles;
  const TOP = window === window.top;
  const MAX_NODES = 1600;
  const MAX_DEPTH = 60;
  const SNAP_DEBOUNCE = 1200;
  const SNAP_MIN_GAP = 2500;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'BASE', 'TITLE']);
  const ATTRS = ['role', 'type', 'name', 'title', 'alt', 'placeholder', 'aria-label', 'aria-haspopup', 'aria-controls', 'aria-modal', 'aria-live',
    'tabindex', 'accept', 'maxlength', 'multiple', 'autocomplete', 'for', 'data-testid', 'data-test', 'data-qa', 'data-id', 'data-type', 'data-state', 'data-status', 'onclick'];

  let cfg = null;
  var alive = true; // eslint-disable-line no-var -- read by __siteScanAlive above
  const cleanups = [];
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

  // ---------------- talking to the background ----------------
  const outbox = [];
  let sending = false;
  function send(msg) {
    if (!alive) return;
    outbox.push(msg);
    if (outbox.length > 120) outbox.splice(0, outbox.length - 120); // background was unreachable for a long time: keep the newest
    flush();
  }
  async function flush() {
    if (sending || !alive) return;
    sending = true;
    try {
      while (outbox.length && alive) {
        if (!chrome.runtime?.id) { teardown(); return; } // the extension was removed or updated
        const msg = outbox[0];
        try {
          const r = await chrome.runtime.sendMessage(msg);
          outbox.shift();
          if (r?.stopped) { teardown(); return; }
        } catch (e) {
          if (/context invalidated/i.test(String(e?.message))) { teardown(); return; }
          await new Promise((r) => setTimeout(r, 3000)); // the service worker is waking up — try again
          if (!alive) return;
        }
      }
    } finally {
      sending = false;
    }
  }

  // ---------------- page structure ----------------
  const route = () => M.maskUrl(location.href, cfg.siteDomains);
  const cls = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '';
    return c.split(/\s+/).filter(Boolean).slice(0, 8).map(M.maskName);
  };
  const sig = (el) => `${el.tagName}.${cls(el).join('.')}`;
  const extIds = new Set();
  const EXT_RE = /chrome-extension:\/\/([a-p]{32})/;

  function isForeign(el) {
    const parent = el.parentElement;
    let ext = false;
    for (const a of ['src', 'href', 'style']) {
      const v = el.getAttribute?.(a);
      const m = v && EXT_RE.exec(v);
      if (m) { extIds.add(m[1]); ext = true; }
    }
    const inner = el.shadowRoot?.querySelector('[src^="chrome-extension://"],[href^="chrome-extension://"]') || (el.children.length < 200 ? el.querySelector?.('[src^="chrome-extension://"],[href^="chrome-extension://"]') : null);
    if (inner) { const m = EXT_RE.exec(inner.getAttribute('src') || inner.getAttribute('href') || ''); if (m) { extIds.add(m[1]); ext = true; } }
    if (ext) return true;
    if (parent === document.documentElement && el.tagName !== 'BODY' && el.tagName !== 'HEAD') return true;
    if (parent === document.body && el.tagName.includes('-')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && Number(cs.zIndex) >= 2147480000) return true;
    }
    return false;
  }

  function ownText(el) {
    let s = '';
    for (const c of el.childNodes) if (c.nodeType === 3) s += c.data;
    return s;
  }

  /** The whole page → a compact masked list of elements. Repeated rows (chat list, messages) keep 3 examples + the count. */
  function snapshot(reason) {
    const nodes = [];
    const vw = innerWidth;
    const vh = innerHeight;
    let total = 0;
    let styled = 0;
    let foreign = 0;
    const active = document.activeElement;
    const stack = [[document.documentElement, -1, 0, 1, 0]];
    while (stack.length) {
      const [el, p, d, k, rep] = stack.pop();
      total++;
      if (nodes.length >= MAX_NODES || d > MAX_DEPTH) continue;
      const tg = el.tagName.toLowerCase();
      const n = { p, d, tg };
      if (k > 1) n.k = k;
      if (rep) n.rep = rep;
      const i = nodes.push(n) - 1;
      if (isForeign(el)) { n.f = 1; foreign++; continue; }
      const c = cls(el);
      if (c.length) n.c = c;
      if (el.id) n.id = M.maskName(el.id);
      const a = {};
      for (const name of ATTRS) {
        if (!el.hasAttribute?.(name)) continue;
        const v = el.getAttribute(name);
        a[name] = name === 'onclick' ? '1' : M.maskValue(v);
      }
      for (const at of el.attributes || []) {
        if (at.name.startsWith('aria-') && !(at.name in a) && Object.keys(a).length < 14) a[at.name] = M.maskValue(at.value);
        else if (at.name.startsWith('data-') && !(at.name in a) && Object.keys(a).length < 14) a[at.name] = M.maskValue(at.value);
      }
      if (tg === 'a' && el.getAttribute('href')) a.href = M.maskUrl(el.href, cfg.siteDomains);
      if (Object.keys(a).length) n.a = a;
      if (a.role) n.r = a.role;
      const r = el.getBoundingClientRect();
      if (r.width || r.height) n.b = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      const vis = (r.width > 0 && r.height > 0) && (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
      if (vis) n.v = 1;
      let s = '';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += 'd';
      if (el.checked || el.getAttribute('aria-checked') === 'true') s += 'k';
      if (el.selected || el.getAttribute('aria-selected') === 'true') s += 's';
      if (el.getAttribute('aria-expanded') === 'true') s += 'e';
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') s += 'h';
      if (el.readOnly) s += 'r';
      if (el.hasAttribute('open')) s += 'o';
      if (el === active) s += 'f';
      const editable = el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable);
      if (editable) s += 'ce';
      if (s) n.s = s;
      // typed text is never read — only how long it is
      if (tg === 'input' || tg === 'textarea' || tg === 'select') {
        if (tg !== 'select' && el.type !== 'password' && el.type !== 'file') n.vl = String(el.value || '').length;
        if (el.type === 'file') n.fl = el.files?.length || 0;
      } else if (editable) {
        n.vl = (el.textContent || '').length;
      } else if (tg !== 'svg') {
        const m = M.maskText(ownText(el));
        if (m) { n.tx = m.t; n.tn = m.n; if (m.ell) n.el = 1; }
      }
      if (tg === 'iframe' || tg === 'frame') n.ifr = M.maskUrl(el.src || 'about:blank', cfg.siteDomains);
      if ((tg === 'img' || tg === 'video' || tg === 'audio') && el.getAttribute('src')) n.src = 1;
      // a little computed style where it says something: clickable, fixed windows, overflowing texts
      if (styled < 450 && vis && (n.tx || tg === 'div' || tg === 'span' || tg === 'li' || tg === 'i' || tg === 'svg' || d < 6)) {
        styled++;
        const cs = getComputedStyle(el);
        const st = {};
        if (cs.position === 'fixed' || cs.position === 'sticky') st.pos = cs.position;
        if (cs.cursor === 'pointer') st.cur = 1;
        if (cs.zIndex !== 'auto' && Number(cs.zIndex) > 0) st.z = Number(cs.zIndex);
        if (n.tx && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) n.el = 1;
        if (Object.keys(st).length) n.cs = st;
      }
      if (editable || tg === 'svg') continue; // content of the typing box is private; icons are noise
      const kids = [...el.children];
      if (el.shadowRoot) { n.sh = 1; kids.push(...el.shadowRoot.children); }
      // same-tag sibling index (for XPath) and repeated groups
      const byTag = new Map();
      const groups = new Map();
      for (const ch of kids) groups.set(sig(ch), (groups.get(sig(ch)) || 0) + 1);
      const kept = new Map();
      const push = [];
      for (const ch of kids) {
        if (SKIP.has(ch.tagName)) continue;
        const kk = (byTag.get(ch.tagName) || 0) + 1;
        byTag.set(ch.tagName, kk);
        const g = sig(ch);
        const size = groups.get(g);
        const seen = (kept.get(g) || 0) + 1;
        kept.set(g, seen);
        if (size > 3 && seen > 3) continue;
        push.push([ch, i, d + 1, kk, size >= 3 ? size : 0]);
      }
      for (let j = push.length - 1; j >= 0; j--) stack.push(push[j]);
    }
    return { nodes, total, foreign, vw, vh };
  }

  function buildState(reason) {
    const t0 = performance.now();
    const res = snapshot(reason);
    const ms = Math.round(performance.now() - t0);
    const s = {
      v: 1, t: Date.now(), reason, route: route(), top: TOP, vw: res.vw, vh: res.vh,
      title: M.maskText(document.title)?.t || '', lang: document.documentElement.lang || '', dir: document.documentElement.dir || '',
      sx: Math.round(scrollX), sy: Math.round(scrollY), vis: document.visibilityState,
      n: res.nodes, total: res.total, ms, foreign: { count: res.foreign, ext: [...extIds] },
    };
    s.sig = 's' + M.fnv(`${s.route}|${res.nodes.map((n) => `${n.d}${n.tg}${n.c ? `.${n.c.join('.')}` : ''}${n.rep ? '*' : ''}${n.v ? '' : '-'}${n.s?.includes('h') ? 'h' : ''}`).join(',')}`);
    return s;
  }

  // ---------------- when to take a snapshot ----------------
  const sentSigs = new Set();
  const seenCounts = new Map();
  function flushSeen() {
    if (!seenCounts.size) return;
    send({ type: 'seen', list: [...seenCounts.entries()].map(([sig, c]) => [sig, c.n, c.last]) });
    seenCounts.clear();
  }
  let lastSnap = 0;
  let snapTimer = null;
  let mutations = 0;
  let mutationsSinceSnap = 0;

  function scheduleSnap(reason, delay = SNAP_DEBOUNCE) {
    if (!alive) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      const wait = lastSnap + SNAP_MIN_GAP - Date.now();
      if (wait > 0) { scheduleSnap(reason, wait); return; }
      const run = () => takeSnap(reason);
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 }); else run();
    }, delay);
  }

  function takeSnap(reason) {
    if (!alive || !cfg) return null;
    lastSnap = Date.now();
    mutationsSinceSnap = 0;
    let s;
    try { s = buildState(reason); } catch (e) { send({ type: 'incident', kind: 'snapshot-error', note: String(e?.message || e).slice(0, 120) }); return null; }
    if (sentSigs.has(s.sig)) {
      // a screen we already sent: only count it (sent in one small message a minute)
      const c = seenCounts.get(s.sig) || { n: 0, last: 0 };
      c.n++; c.last = s.t;
      seenCounts.set(s.sig, c);
    } else {
      sentSigs.add(s.sig);
      if (sentSigs.size > 3000) sentSigs.clear();
      send({ type: 'state', state: s });
    }
    return s;
  }

  // ---------------- actions and what follows them ----------------
  const events = [];
  let evThisMinute = 0;
  let evMinute = 0;
  let dropped = 0;
  const moves = [];
  let lastDown = { t: 0, el: null };

  function pushEvent(e) {
    const m = Math.floor(Date.now() / 60000);
    if (m !== evMinute) { evMinute = m; evThisMinute = 0; }
    if (++evThisMinute > 900) { dropped++; return; }
    e.t = Date.now();
    e.r = route();
    events.push(e);
    if (events.length >= 60) flushEvents();
  }
  function flushEvents() {
    if (!events.length && !dropped) return;
    send({ type: 'events', top: TOP, events: events.splice(0), dropped });
    dropped = 0;
  }

  /** The element a person meant: the nearest button / link / row, described without any text that could be personal. */
  function describe(target) {
    const start = target?.nodeType === 1 ? target : target?.parentElement;
    if (!start) return null;
    // a button / link / field, or the whole clickable row (the outermost element still showing the hand cursor)
    const meaningful = (x) => ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'SUMMARY', 'LI', 'OPTION'].includes(x.tagName) || x.getAttribute('role') || x.hasAttribute('onclick') || x.isContentEditable;
    let el = start;
    let pick = null;
    for (let j = 0; j < 7 && el && el !== document.body && el !== document.documentElement; j++, el = el.parentElement) {
      if (meaningful(el)) { pick = el; break; }
      let pointer = false;
      try { pointer = getComputedStyle(el).cursor === 'pointer'; } catch { /* ignore */ }
      if (pointer) pick = el;
      else if (pick) break;
    }
    el = pick || start;
    const r = el.getBoundingClientRect();
    const d = { tg: el.tagName.toLowerCase(), c: cls(el).slice(0, 5), b: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    if (el.id) d.id = M.maskName(el.id);
    const role = el.getAttribute('role');
    if (role) d.r = role;
    for (const a of ['type', 'name', 'title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) (d.a ||= {})[a] = M.maskValue(v); }
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) {
      const m = M.maskText((el.innerText || el.textContent || '').slice(0, 300));
      if (m) d.tx = m.t;
    }
    if (el.isContentEditable) d.ce = 1;
    // where it sits: a few ancestors, and whether it is one of many alike rows
    const path = [];
    let x = el.parentElement;
    for (let j = 0; j < 5 && x && x !== document.documentElement; j++, x = x.parentElement) path.push(sig(x).toLowerCase());
    d.path = path;
    const par = el.parentElement;
    if (par) {
      const same = [...par.children].filter((c) => sig(c) === sig(el));
      if (same.length >= 3) d.row = same.indexOf(el) + 1;
    }
    if (start !== el) d.inner = start.tagName.toLowerCase();
    return d;
  }

  // effects: what appears / disappears in the 2.5 s after an action
  let effect = null;
  function openEffect(ev) {
    if (effect) closeEffect();
    effect = { ev, t0: Date.now(), added: new Map(), removed: 0, attrs: new Map(), text: 0, counters: countersNow(), routeBefore: route() };
    setTimeout(() => { if (effect && effect.ev === ev) closeEffect(); }, 2500);
  }
  function closeEffect() {
    const e = effect;
    effect = null;
    if (!e) return;
    const after = countersNow();
    const counters = [];
    for (const [tpl, v] of Object.entries(after)) if (e.counters[tpl] !== undefined && e.counters[tpl] !== v) counters.push({ tpl, delta: v - e.counters[tpl] });
    e.ev.fx = {
      added: [...e.added.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      removed: e.removed, attrs: [...e.attrs.entries()].slice(0, 10), text: e.text, counters,
      route: route() !== e.routeBefore ? route() : undefined,
    };
    scheduleSnap('after-action', 600);
  }
  /** Counters like "Left 12 messages": template → number (the number itself is a site counter, not personal). */
  function countersNow() {
    const out = {};
    try {
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let t = w.nextNode(); t && n < 4000; t = w.nextNode(), n++) {
        const s = t.data;
        if (s.length > 60 || !/\d/.test(s) || !R.KW.counter.test(s)) continue;
        const num = Number((s.match(/\d+/) || [])[0]);
        const tpl = M.maskText(s)?.t;
        if (tpl && Number.isFinite(num)) out[tpl] = num;
      }
    } catch { /* ignore */ }
    return out;
  }

  // ---------------- listeners (all passive: nothing is prevented or stopped) ----------------
  const typing = new Map();
  function onMove() {
    const now = Date.now();
    moves.push(now);
    while (moves.length && now - moves[0] > 1500) moves.shift();
    if (moves.length > 200) moves.splice(0, moves.length - 200);
  }
  function onDown(e) { lastDown = { t: Date.now(), el: e.target, tr: e.isTrusted }; }
  function onClick(e) {
    const d = describe(e.target);
    const ev = { ty: 'click', tr: e.isTrusted ? 1 : 0, det: e.detail, btn: e.button, mv: moves.length,
      pd: lastDown.el && Date.now() - lastDown.t < 800 && (lastDown.el === e.target || lastDown.el?.contains?.(e.target)) ? 1 : 0, d };
    pushEvent(ev);
    openEffect(ev);
  }
  function onKey(e) {
    if (['Enter', 'Escape', 'Tab', 'NumpadEnter'].includes(e.key)) {
      const ev = { ty: 'key', k: e.key, tr: e.isTrusted ? 1 : 0, ctrl: e.ctrlKey ? 1 : 0, shift: e.shiftKey ? 1 : 0, meta: e.metaKey ? 1 : 0, d: describe(e.target) };
      pushEvent(ev);
      if (e.key !== 'Tab') openEffect(ev);
    }
  }
  function onInput(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    let rec = typing.get(el);
    if (!rec) {
      rec = { ty: 'type', n: 0, it: new Set(), tr: 1, d: describe(el) };
      typing.set(el, rec);
      setTimeout(() => {
        typing.delete(el);
        rec.it = [...rec.it];
        rec.len = el.isContentEditable ? (el.textContent || '').length : String(el.value || '').length;
        if (el.type === 'password') rec.len = undefined;
        pushEvent(rec);
      }, 2500);
    }
    rec.n++;
    if (e.inputType) rec.it.add(e.inputType); else rec.it.add('(no inputType)');
    if (!e.isTrusted) rec.tr = 0;
  }
  function onChange(e) {
    const el = e.target;
    if (el?.type === 'file') pushEvent({ ty: 'file', tr: e.isTrusted ? 1 : 0, files: el.files?.length || 0, types: [...(el.files || [])].map((f) => f.type || '?').slice(0, 10), d: describe(el) });
    else if (el?.tagName === 'SELECT') pushEvent({ ty: 'select', tr: e.isTrusted ? 1 : 0, d: describe(el) });
  }
  function onSubmit(e) { const ev = { ty: 'submit', tr: e.isTrusted ? 1 : 0, d: describe(e.target) }; pushEvent(ev); openEffect(ev); }
  function onPaste(e) { pushEvent({ ty: 'paste', tr: e.isTrusted ? 1 : 0, d: describe(e.target) }); }
  let scrolls = 0;
  function onScroll() { scrolls++; }

  function onMutations(list) {
    mutations += list.length;
    mutationsSinceSnap += list.length;
    if (effect) {
      for (const m of list) {
        if (m.type === 'childList') {
          for (const nd of m.addedNodes) if (nd.nodeType === 1 && effect.added.size < 60) { const k = sig(nd).toLowerCase(); effect.added.set(k, (effect.added.get(k) || 0) + 1); }
          effect.removed += m.removedNodes.length;
        } else if (m.type === 'attributes') {
          effect.attrs.set(m.attributeName, (effect.attrs.get(m.attributeName) || 0) + 1);
        } else if (m.type === 'characterData') effect.text++;
      }
    }
    scheduleSnap('change');
  }

  // ---------------- start / stop ----------------
  let mo = null;
  let lastHref = location.href;
  function start() {
    mo = new MutationObserver(onMutations);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'disabled', 'open', 'data-state', 'data-status'] });
    cleanups.push(() => mo.disconnect());
    const cap = { capture: true, passive: true };
    listen(window, 'pointermove', onMove, cap);
    listen(window, 'pointerdown', onDown, cap);
    listen(window, 'click', onClick, cap);
    listen(window, 'keydown', onKey, cap);
    listen(window, 'input', onInput, cap);
    listen(window, 'change', onChange, cap);
    listen(window, 'submit', onSubmit, cap);
    listen(window, 'paste', onPaste, cap);
    listen(window, 'scroll', onScroll, cap);
    listen(document, 'visibilitychange', () => { pushEvent({ ty: 'vis', s: document.visibilityState }); if (document.visibilityState === 'visible') scheduleSnap('visible', 400); });
    listen(window, 'online', () => send({ type: 'incident', kind: 'online', top: TOP }));
    listen(window, 'offline', () => send({ type: 'incident', kind: 'offline', top: TOP }));
    let jsErr = 0;
    listen(window, 'error', () => { if (jsErr++ < 20) pushEvent({ ty: 'jserr' }); });
    listen(window, 'pagehide', () => { flushEvents(); flushSeen(); });
    const timers = [
      setInterval(() => { // SPA navigation without a page load
        if (location.href !== lastHref) {
          const from = M.maskUrl(lastHref, cfg.siteDomains);
          lastHref = location.href;
          pushEvent({ ty: 'route', from });
          scheduleSnap('route', 700);
        }
      }, 1000),
      setInterval(() => { // slow changes + scroll counts + events out
        if (scrolls) { pushEvent({ ty: 'scroll', n: scrolls }); scrolls = 0; }
        flushEvents();
      }, 5000),
      setInterval(() => { if (mutationsSinceSnap > 0) scheduleSnap('periodic', 100); flushSeen(); }, 45000),
      setInterval(() => { // resources other extensions load into the page
        try {
          for (const e of performance.getEntriesByType('resource')) { const m = EXT_RE.exec(e.name); if (m) extIds.add(m[1]); }
        } catch { /* ignore */ }
      }, 60000),
    ];
    cleanups.push(() => timers.forEach(clearInterval));
    scheduleSnap('load', 1500);
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    for (const f of cleanups.splice(0)) { try { f(); } catch { /* ignore */ } }
    clearTimeout(snapTimer);
  }

  // hourly probe from the background: a fresh look + what the scanner recognises right now
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!alive || !cfg || msg?.type !== 'probe' || !TOP) return false;
    try {
      const s = buildState('probe');
      const { roles, flags } = R.classify(s);
      const best = {};
      for (const [role, list] of Object.entries(roles)) if (list[0]) best[role] = { score: list[0].score, css: list[0].css[0], n: list.length };
      reply({ route: s.route, vis: document.visibilityState, best, flags, nodes: s.total });
    } catch (e) {
      reply({ error: String(e?.message || e).slice(0, 120) });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.scan) return;
    const v = ch.scan.newValue;
    if (!v?.scanning || (cfg && v.scanId !== cfg.scanId)) teardown();
  });

  chrome.storage.local.get('scan').then(({ scan }) => {
    if (!scan?.scanning) { teardown(); return; }
    const host = location.hostname.toLowerCase();
    const ours = (h) => scan.siteDomains.some((d) => h === d || h.endsWith(`.${d}`));
    // an iframe from another site is recorded only when it sits inside the operator's site
    const anc = [...(location.ancestorOrigins || [])].map((o) => { try { return new URL(o).hostname; } catch { return ''; } });
    if (!ours(host) && !(anc.length && anc.some(ours))) { teardown(); return; }
    if (location.protocol !== 'http:' && location.protocol !== 'https:') { teardown(); return; }
    cfg = scan;
    if (TOP) {
      // iframes from other hosts inside the site: tell the background so it can record them too
      const frames = () => [...document.querySelectorAll('iframe[src]')].map((f) => { try { return new URL(f.src).origin; } catch { return null; } }).filter(Boolean);
      const report = () => { const o = [...new Set(frames())]; if (o.length) send({ type: 'frames', origins: o }); };
      setTimeout(report, 4000);
      const ft = setInterval(report, 120000);
      cleanups.push(() => clearInterval(ft));
    }
    start();
  }).catch(() => teardown());
})();
