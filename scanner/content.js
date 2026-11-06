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
  const MAX_NODES = 2500;
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
  // a window built inside the page without an address of its own (about:blank / srcdoc / blob — chat widgets do this):
  // its address is the page around it + [frame]
  const BUILT_IN = !TOP && /^(about|blob):$/.test(location.protocol);
  const hostPage = () => { try { return parent.location.href; } catch { return document.referrer || ''; } };
  const route = () => (BUILT_IN ? `${M.maskUrl(hostPage(), cfg.siteDomains)} [frame]` : M.maskUrl(location.href, cfg.siteDomains));
  const cls = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '';
    // style variants (hover:…, md:…, z-[1], !mt-0) say nothing about what an element is — and were a fifth of the report
    return c.split(/\s+/).filter((x) => x && !/[:[\]!]/.test(x) && x.length <= 60).slice(0, 8).map(M.maskName);
  };
  const sig = (el) => `${el.tagName}.${cls(el).join('.')}`;
  /**
   * Key for "these siblings are the same kind of row": tag + base class (modifiers like "is-online" toggle all the time)
   * + what tells buttons apart (label, title, role, type, an interface word) — so 📷 🎬 🎤 ➤ or tabs never merge into one group,
   * while 400 chat rows with different names do.
   */
  function groupKey(el) {
    const c = cls(el)[0] || '';
    let k = `${el.tagName}.${c}`;
    // masked values, with hashes flattened: "Chat with [W]" or "~_k" — rows about different people still group together
    for (const a of ['role', 'aria-label', 'title', 'type', 'name', 'data-testid']) { const v = el.getAttribute(a); if (v) k += `|${a}=${M.maskValue(v.slice(0, 40)).replace(/~[0-9a-f]{4}/g, '~')}`; }
    if (['BUTTON', 'A', 'LI', 'LABEL'].includes(el.tagName) || el.getAttribute('role') === 'tab') {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 30) { const m = M.maskText(t); if (m?.ui) k += `|t=${m.t}`; }
    }
    return k;
  }
  const extIds = new Set();
  let lastForeign = new Set(); // other extensions' elements from the last snapshot
  const EXT_RE = /chrome-extension:\/\/([a-p]{32})/;

  /**
   * Elements put on the page by other extensions (another bot's panel): computed once per snapshot.
   * Direct children of <html> (sites never put things there), elements loading chrome-extension:// files and their small
   * injected containers, shadow hosts at the top that carry such files, fixed custom elements on top of everything.
   */
  const EXT_SEL = '[src^="chrome-extension://"],[href^="chrome-extension://"],[style*="chrome-extension://"]';
  function foreignSet() {
    const set = new Set();
    const de = document.documentElement;
    for (const ch of de.children) if (ch.tagName !== 'HEAD' && ch.tagName !== 'BODY') set.add(ch);
    const note = (el) => { const m = EXT_RE.exec(el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('style') || ''); if (m) extIds.add(m[1]); };
    let found = 0;
    for (const el of document.querySelectorAll(EXT_SEL)) {
      if (++found > 200) break;
      note(el);
      // climb to the injected container while it stays small (never the site's own app)
      let top = el;
      for (let j = 0; j < 8 && top.parentElement && top.parentElement !== document.body && top.parentElement !== de; j++) {
        const up = top.parentElement;
        if (up.getElementsByTagName('*').length > 150) break;
        top = up;
      }
      set.add(top);
    }
    const tops = [...de.children, ...(document.body ? document.body.children : [])].slice(0, 400);
    for (const host of tops) {
      if (host.shadowRoot) { const inner = host.shadowRoot.querySelector(EXT_SEL); if (inner) { note(inner); set.add(host); } }
      if (host.parentElement === document.body && host.tagName.includes('-') && !set.has(host)) {
        const cs = getComputedStyle(host);
        if (cs.position === 'fixed' && Number(cs.zIndex) >= 2147480000) set.add(host);
      }
    }
    return set;
  }

  /** Up to `max` characters of visible text inside an element, without reading typing boxes; cheap on huge blocks. */
  function textSample(el, max = 200) {
    let s = '';
    try {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement?.isContentEditable ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      let n = 0;
      for (let t = w.nextNode(); t && s.length < max && n < 300; t = w.nextNode(), n++) s += ` ${t.data}`;
    } catch { /* ignore */ }
    return s.slice(0, max);
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
    const foreignEls = foreignSet();
    lastForeign = foreignEls;
    // breadth first: every panel gets its top levels before any panel goes deep (a long list cannot eat the budget)
    const queue = [[document.documentElement, -1, 0, 1, 0]];
    for (let qi = 0; qi < queue.length; qi++) {
      const [el, p, d, k, rep] = queue[qi];
      queue[qi] = null;
      total++;
      if (nodes.length >= MAX_NODES || d > MAX_DEPTH) continue;
      const tg = el.tagName.toLowerCase();
      const n = { p, d, tg };
      if (k > 1) n.k = k;
      if (rep) n.rep = rep;
      const i = nodes.push(n) - 1;
      if (foreignEls.has(el)) {
        // another extension's element: what it is and where, never what is inside
        n.f = 1; foreign++;
        const fc = cls(el).slice(0, 3); if (fc.length) n.c = fc;
        if (el.id) n.id = M.maskId(el.id);
        const fr = el.getBoundingClientRect(); if (fr.width || fr.height) n.b = [Math.round(fr.x), Math.round(fr.y), Math.round(fr.width), Math.round(fr.height)];
        continue;
      }
      const c = cls(el);
      if (c.length) n.c = c;
      if (el.id) n.id = M.maskId(el.id);
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
      const keys = kids.map(groupKey);
      for (const g of keys) groups.set(g, (groups.get(g) || 0) + 1);
      const kept = new Map();
      const push = [];
      kids.forEach((ch, j) => {
        if (SKIP.has(ch.tagName)) return;
        const kk = (byTag.get(ch.tagName) || 0) + 1;
        byTag.set(ch.tagName, kk);
        const g = keys[j];
        const size = groups.get(g);
        const seen = (kept.get(g) || 0) + 1;
        kept.set(g, seen);
        if (size > 6 && seen > 3) return; // long lists: 3 examples + how many there are
        push.push([ch, i, d + 1, kk, size >= 3 ? size : 0]);
      });
      for (const x of push) queue.push(x);
      if (queue.length > 60000) break; // a pathological page: stop collecting
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
    // usernames in the address (~hash) do not make a new screen: 900 profiles of one layout = one screen seen 900 times
    s.sig = 's' + M.fnv(`${s.route.replace(/[^/?#&]*~[0-9a-f]{4}[^/?#&]*/g, '~')}|${res.nodes.map((n) => `${n.d}${n.tg}${n.c ? `.${n.c[0]}` : ''}${n.rep ? '*' : ''}${n.v ? '' : '-'}`).join(',')}`);
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

  let pendingSince = 0;
  function scheduleSnap(reason, delay = SNAP_DEBOUNCE) {
    if (!alive) return;
    if (snapTimer && pendingSince && Date.now() - pendingSince > 2500) return; // the page never stops changing: let it fire
    clearTimeout(snapTimer);
    if (!pendingSince) pendingSince = Date.now();
    snapTimer = setTimeout(() => {
      snapTimer = null;
      const wait = lastSnap + SNAP_MIN_GAP - Date.now();
      if (wait > 0) { scheduleSnap(reason, wait); return; }
      const run = () => takeSnap(reason);
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 }); else run();
    }, delay);
  }

  /** Right after an action: a look ~0.8 s later, whatever else happens (a menu or a window may close again in a few seconds). */
  let urgentTimer = null;
  function snapSoon(reason, ms = 800) {
    if (!alive || urgentTimer) return;
    urgentTimer = setTimeout(() => {
      urgentTimer = null;
      if (Date.now() - lastSnap < 700) return;
      if ('requestIdleCallback' in window) requestIdleCallback(() => takeSnap(reason), { timeout: 600 }); else takeSnap(reason);
    }, ms);
  }

  function takeSnap(reason) {
    if (!alive || !cfg) return null;
    pendingSince = 0;
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
    e.t ||= Date.now();
    e.r ||= route();
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
    if (el.id) d.id = M.maskId(el.id);
    const role = el.getAttribute('role');
    if (role) d.r = role;
    for (const a of ['type', 'name', 'title', 'aria-label', 'placeholder', 'data-testid', 'data-test', 'data-qa']) { const v = el.getAttribute(a); if (v) (d.a ||= {})[a] = M.maskValue(v); }
    if (el.tagName === 'A' && el.getAttribute('href')) d.href = M.maskUrl(el.href, cfg.siteDomains);
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) {
      const m = M.maskText(textSample(el, 300));
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
    ev.t = Date.now();
    ev.r = route();
    if (effect) closeEffect();
    effect = { ev, t0: Date.now(), first: 0, added: new Map(), texts: [], removed: 0, attrs: new Map(), text: 0, counters: countersNow(), routeBefore: route() };
    setTimeout(() => { if (effect && effect.ev === ev) closeEffect(); }, 4000);
  }
  function closeEffect() {
    const e = effect;
    effect = null;
    if (!e) return;
    const after = countersNow();
    const counters = [];
    for (const [tpl, v] of Object.entries(after)) if (e.counters[tpl] !== undefined && e.counters[tpl] !== v) counters.push({ tpl, delta: v - e.counters[tpl] });
    e.ev.fx = {
      firstMs: e.first ? e.first - e.t0 : undefined,
      texts: e.texts.length ? e.texts : undefined,
      added: [...e.added.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      removed: e.removed, attrs: [...e.attrs.entries()].slice(0, 10), text: e.text, counters,
      route: route() !== e.routeBefore ? route() : undefined,
    };
    pushEvent(e.ev);
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
  /** The action happened on another extension's panel (another bot), not on the site. */
  const onForeign = (e) => { try { const de = document.documentElement; return (e.composedPath?.() || []).some((x) => x.nodeType === 1 && (lastForeign.has(x) || (x.parentElement === de && x.tagName !== 'BODY' && x.tagName !== 'HEAD'))); } catch { return false; } };
  const realTarget = (e) => { try { const p = e.composedPath?.(); return (p && p[0]?.nodeType === 1 ? p[0] : null) || e.target; } catch { return e.target; } };
  function onClick(e) {
    const d = describe(realTarget(e));
    const ev = { ty: 'click', tr: e.isTrusted ? 1 : 0, det: e.detail, btn: e.button, mv: moves.length,
      pd: lastDown.el && Date.now() - lastDown.t < 800 && (lastDown.el === e.target || lastDown.el?.contains?.(e.target)) ? 1 : 0, d };
    if (d && onForeign(e)) d.ext = 1;
    openEffect(ev);
    snapSoon('click');
  }
  function onKey(e) {
    if (['Enter', 'Escape', 'Tab', 'NumpadEnter'].includes(e.key)) {
      const ev = { ty: 'key', k: e.key, tr: e.isTrusted ? 1 : 0, ctrl: e.ctrlKey ? 1 : 0, shift: e.shiftKey ? 1 : 0, meta: e.metaKey ? 1 : 0, d: describe(realTarget(e)) };
      if (ev.d && onForeign(e)) ev.d.ext = 1;
      if (e.key === 'Tab') pushEvent(ev);
      else { openEffect(ev); snapSoon('key'); }
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
  function onSubmit(e) { openEffect({ ty: 'submit', tr: e.isTrusted ? 1 : 0, d: describe(e.target) }); }
  function onPaste(e) { pushEvent({ ty: 'paste', tr: e.isTrusted ? 1 : 0, d: describe(e.target) }); }
  let scrolls = 0;
  const boxes = new Map();
  function onScroll(e) {
    scrolls++;
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const k = sig(el);
    const now = Date.now();
    if (now - (boxes.get(k) || 0) < 60000) return;
    if (boxes.size > 500) boxes.clear();
    boxes.set(k, now);
    const r = el.getBoundingClientRect();
    pushEvent({ ty: 'scrollbox', tr: e.isTrusted ? 1 : 0, d: { tg: el.tagName.toLowerCase(), c: cls(el).slice(0, 5), b: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] },
      sh: el.scrollHeight, ch: el.clientHeight, st: Math.round(el.scrollTop), end: el.scrollTop + el.clientHeight >= el.scrollHeight - 30 ? 1 : 0, kids: el.childElementCount });
  }

  function onMutations(list) {
    mutations += list.length;
    mutationsSinceSnap += list.length;
    if (effect) {
      if (!effect.first) effect.first = Date.now();
      for (const m of list) {
        if (m.type === 'childList') {
          for (const nd of m.addedNodes) {
            if (nd.nodeType !== 1 || effect.added.size >= 60) continue;
            const k = sig(nd).toLowerCase();
            effect.added.set(k, (effect.added.get(k) || 0) + 1);
            if (effect.texts.length < 8 && !nd.isContentEditable) {
              const mt = M.maskText(textSample(nd, 120));
              if (mt && mt.n <= 60 && !mt.t.startsWith('[текст') && !effect.texts.includes(mt.t)) effect.texts.push(mt.t); // short notices only
            }
          }
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
    listen(window, 'pagehide', () => { closeEffect(); flushEvents(); flushSeen(); });
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
    setTimeout(pageInfo, 3000);
  }

  /** Facts about the page itself: framework hints, load timing, screen — nothing about people. */
  function pageInfo() {
    if (!alive) return;
    try {
      const q = (sel) => { try { return Boolean(document.querySelector(sel)); } catch { return false; } };
      const fw = [];
      if (q('[ng-version]')) fw.push('angular');
      if (q('[data-reactroot]') || q('#__next') || q('#root')) fw.push('react?');
      if (q('#__nuxt')) fw.push('nuxt');
      if ([...document.querySelectorAll('body *')].slice(0, 400).some((el) => [...el.attributes].some((a) => a.name.startsWith('data-v-')))) fw.push('vue');
      if (q('[class*="svelte-"]')) fw.push('svelte');
      if (q('[class*="css-"]') || q('[class*="sc-"]')) fw.push('css-in-js');
      if ([...document.querySelectorAll('[class]')].slice(0, 400).some((el) => /__[\w-]{4,}$/.test(String(el.className)))) fw.push('css-modules');
      const nav = performance.getEntriesByType('navigation')[0];
      const all = document.getElementsByTagName('*');
      pushEvent({
        ty: 'pageinfo', fw, top: TOP,
        scripts: [...document.scripts].map((x) => (x.src ? M.maskUrl(x.src, cfg.siteDomains) : 'inline')).slice(0, 40),
        nodes: all.length, iframes: document.getElementsByTagName('iframe').length, forms: document.forms.length,
        custom: new Set([...all].slice(0, 20000).map((x) => x.tagName).filter((t) => t.includes('-'))).size,
        shadow: [...all].slice(0, 20000).filter((x) => x.shadowRoot).length,
        load: nav ? { dom: Math.round(nav.domContentLoadedEventEnd), full: Math.round(nav.loadEventEnd), type: nav.type } : undefined,
        dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, sw: screen.width, sh: screen.height, lang: document.documentElement.lang || '',
        charset: document.characterSet, mode: document.compatMode,
      });
    } catch (e) { send({ type: 'incident', kind: 'pageinfo-error', note: String(e?.message || e).slice(0, 80) }); }
  }

  function teardown() {
    if (!alive) return;
    try { closeEffect(); flushEvents(); } catch { /* ignore */ }
    alive = false;
    for (const f of cleanups.splice(0)) { try { f(); } catch { /* ignore */ } }
    clearTimeout(snapTimer);
    clearTimeout(urgentTimer);
  }

  // hourly probe from the background: a fresh look + what the scanner recognises right now
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!alive || !cfg || msg?.type !== 'probe' || !TOP) return false;
    try {
      const s = buildState('probe');
      const { roles, flags } = R.classify(s);
      const best = {};
      for (const [role, list] of Object.entries(roles)) {
        if (!list[0]) continue;
        // how many elements each of the first three addresses finds right now: over a night this shows which ones stay valid
        const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return null; } };
        const alts = list[0].css.slice(0, 3);
        best[role] = { score: list[0].score, css: alts[0], live: count(alts[0]), altCss: alts.slice(1).map((c) => [c, count(c)]) };
      }
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
    if (location.protocol !== 'http:' && location.protocol !== 'https:' && !(BUILT_IN && anc.length && ours(anc[0]))) { teardown(); return; }
    if (!TOP && (innerWidth < 200 || innerHeight < 120)) { teardown(); return; } // tiny / hidden frames: counters, pixels, ads
    cfg = scan;
    if (TOP) {
      // iframes from other hosts inside the site: tell the background so it can record them too
      const frames = () => [...document.querySelectorAll('iframe[src]')].filter((f) => { const r = f.getBoundingClientRect(); return r.width >= 200 && r.height >= 120; })
        .map((f) => { try { const u = new URL(f.src); return /^h-/.test(M.maskHost(u.hostname, scan.siteDomains)) || M.maskHost(u.hostname, scan.siteDomains).endsWith('SITE') ? u.origin : null; } catch { return null; } }).filter(Boolean);
      const report = () => { const o = [...new Set(frames())]; if (o.length) send({ type: 'frames', origins: o }); };
      setTimeout(report, 4000);
      const ft = setInterval(report, 120000);
      cleanups.push(() => clearInterval(ft));
    }
    start();
  }).catch(() => teardown());
})();
