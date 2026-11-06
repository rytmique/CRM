// Guesses what each element of a recorded page state is (message box, Send, chat list, hints…), with a score 0–1.
// Works only on the masked snapshot, so it runs the same in the page (hourly probe) and in the report.
(() => {
  if (self.__scanRoles) return;

  const KW = {
    msg: /messag|write|type a|typing|chat|msg|reply|compose|english|text|повідом|напиш|напис|сообщ|українськ|english|translat/i,
    notMsg: /search|find|пошук|поиск|знайти|найти|login|email|password|пароль|subject|тема|\bid\b/i,
    send: /\bsend\b|надіслати|надішліть|відправити|отправить|отправь|➤|➢|✈/i, // not "submit": every login / search form has one
    translate: /translat|перекла|перевод|перевест/i,
    attach: /attach|clip|upload|\bphoto|\bimage|picture|\bvideo|\baudio|voice|camera|media|gallery|\bfile|фото|відео|видео|аудіо|аудио|скрепк|вклад|📎/i,
    letter: /letter|mail|envelope|лист|письм|✉/i,
    like: /\blike|heart|♡|♥|❤|лайк|вподоб/i,
    fav: /favou?rite|\bstar\b|★|☆|обран|улюблен|избран/i,
    wink: /wink|підморг|подмиг/i,
    gift: /gift|present|подарун|подарок/i,
    pay: /\bpay|buy|purchase|credit|balance|top.?up|оплат|купи|кредит|баланс|premium|преміум|премиум/i,
    destroy: /block|delete|remove|report|\bban\b|заблок|видал|удал|скарг|жалоб/i,
    item: /chat|dialog|conversation|contact|user|person|room|thread|item|man|member|correspond/i,
    unread: /unread|badge|count|counter|new\b|непрочит|нов/i,
    tabs: /\ball\b|unread|favou?rite|dialog|letter|chat|online|inbox|усі|всі|без відп|улюбл|обран|діалог|лист|все|избран|письм|входящ/i,
    head: /head|title|top|header|info|profile|name|caption|user|person/i,
    bubble: /\bmsg|message|bubble|chat-?line|row|history/i,
    hint: /task|hint|suggest|recommend|notif|offer|invite|todo|advice|tip|write ?him|please|напиш|порад|підказ|подсказ/i,
    hintText: /write|message|letter|please|him|напиш|повідом|лист|напиши|письм|сообщ/i,
    counter: /left|remaining|залишил|лишил|осталось|осталос|available/i,
    her: /profile|woman|\bher\b|account|switch|select|anket|current|girl|lady|model|persona|анкет|жінк|женщ/i,
    switchKw: /switch|change|select|choose|змін|перемк|вибр|выбр|смен/i,
    search: /search|find|\bid\b|пошук|поиск|знайти|найти/i,
    online: /online|онлайн/i,
    captcha: /captcha|recaptcha|hcaptcha|turnstile|robot|робот/i,
    modal: /modal|popup|pop-up|dialog|overlay|drawer|sheet|lightbox/i,
  };

  const lower = (x) => String(x || '').toLowerCase();

  /** Text of a node for matching: classes, id, role, attribute values, own masked text. */
  function features(n) {
    const attrs = n.a ? Object.entries(n.a).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    // the same without type=…: every one-line field says type=text, which is not a hint of a message box
    const named = n.a ? Object.entries(n.a).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${v}`).join(' ') : '';
    return { cls: lower(`${(n.c || []).join(' ')} ${n.id || ''}`), attrs: lower(attrs), named: lower(named), text: lower(n.tx || ''), all: lower(`${(n.c || []).join(' ')} ${n.id || ''} ${n.r || ''} ${attrs} ${n.tx || ''}`) };
  }

  const isClickable = (n) => ['button', 'a', 'summary', 'label'].includes(n.tg) || n.r === 'button' || n.r === 'tab' || n.r === 'menuitem' || n.r === 'link' || (n.a && ('onclick' in n.a || n.a.tabindex === '0'));

  function prepare(snap) {
    const nodes = snap.n || [];
    const kids = nodes.map(() => []);
    nodes.forEach((n, i) => { if (n.p >= 0 && kids[n.p]) kids[n.p].push(i); });
    // bottom-up: descendants with an image, digits, a capitalised masked word, a long text
    const hasImg = new Array(nodes.length).fill(false);
    const hasNum = new Array(nodes.length).fill(false);
    const hasName = new Array(nodes.length).fill(false);
    const hasLong = new Array(nodes.length).fill(false);
    const hasMsgBox = new Array(nodes.length).fill(false); // a textarea / typing box somewhere inside
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (['img', 'picture', 'svg', 'canvas', 'video'].includes(n.tg) || /avatar|photo|pic|image|img/i.test((n.c || []).join(' '))) hasImg[i] = true;
      if (/#/.test(n.tx || '')) hasNum[i] = true;
      if (/\[W\]/.test(n.tx || '')) hasName[i] = true;
      if (/\[текст/.test(n.tx || '')) hasLong[i] = true;
      if (n.tg === 'textarea' || (n.s || '').includes('ce')) hasMsgBox[i] = true;
      const p = n.p;
      if (p >= 0) { hasImg[p] ||= hasImg[i]; hasNum[p] ||= hasNum[i]; hasName[p] ||= hasName[i]; hasLong[p] ||= hasLong[i]; hasMsgBox[p] ||= hasMsgBox[i]; }
    }
    return { nodes, kids, hasImg, hasNum, hasName, hasLong, hasMsgBox, vw: snap.vw || 1280, vh: snap.vh || 800, f: nodes.map(features), tw: utilityPage(nodes) };
  }

  // ids a framework makes anew on every load (React useId «_r_5e_» / «:r1:», MUI, Ember, Headless UI…) or masked ones: useless to the bot
  const stableId = (id) => Boolean(id) && !/[#~[\]\s]/.test(id) && !/\d/.test(id) && !/(^|[-_:])_?r_[0-9a-z]*_?$|:r[0-9a-z]*:|«r/i.test(id);
  // utility CSS (Tailwind-like): variants (hover:…, md:…, z-[1], !mt-0, group/btn) everywhere; plain utilities (flex, w-full, gap-2)
  // only on pages that are mostly built from them — elsewhere "left-msgs" or "top-bar" are the site's own names
  const UTIL_EXACT = new Set('flex grid block inline inline-block inline-flex inline-grid hidden contents relative absolute fixed sticky static group peer truncate italic uppercase lowercase capitalize visible invisible container isolate grow shrink underline antialiased transform transition border rounded shadow outline-none select-none pointer-events-none cursor-pointer overflow-hidden overflow-auto whitespace-nowrap break-words sr-only not-sr-only border-t border-b border-l border-r border-x border-y box-border box-content'.split(' '));
  const UTIL_RE = /^-?(m|p)[trblxyse]?-[\w.]+$|^-?(w|h|min-w|min-h|max-w|max-h|size|gap|gap-x|gap-y|space-x|space-y|text|bg|border|border-[trblxy]|rounded|rounded-[trbl]{1,2}|shadow|items|justify|content|self|place-items|place-content|z|top|left|right|bottom|inset|inset-x|inset-y|overflow|overflow-x|overflow-y|font|leading|tracking|opacity|cursor|select|transition|duration|ease|delay|animate|flex|basis|order|col|row|col-span|row-span|grid-cols|grid-rows|divide|ring|outline|whitespace|break|line-clamp|aspect|object|pointer-events|translate-x|translate-y|rotate|scale|origin|fill|stroke|from|to|via|decoration|list|appearance|resize|scroll|snap|touch|will-change|backdrop|blur|drop-shadow|shrink|grow|float|clear|align|indent|columns|box|accent|caret|overscroll|start|end)-([\d./]+|px|full|auto|screen|min|max|fit|none|xs|sm|base|md|lg|xl|\dxl|center|start|end|between|around|evenly|stretch|baseline|col|row|wrap|nowrap|reverse|col-reverse|row-reverse|hidden|visible|scroll|clip|inherit|current|transparent|white|black|normal|medium|semibold|bold|light|thin|tight|snug|relaxed|loose|wide|wider|widest|left|right|justify|top|bottom|middle|sans|serif|mono|ellipsis|y|x|both|contain|cover|primary|secondary|muted|accent|danger|success|warning|[a-z]+-\d{2,3}(\/\d+)?)$/;
  const variant = (c) => /[:[\]!/@]/.test(c);
  const utilityPage = (nodes) => {
    let withCls = 0; let util = 0;
    for (const n of nodes) { if (!n.c?.length) continue; withCls++; if (n.c.some((c) => variant(c) || UTIL_EXACT.has(c))) util++; }
    return withCls > 20 && util / withCls > 0.35;
  };
  const meaningful = (P, c) => !c.includes('#') && c.length < 40 && !variant(c) && !/^(active|selected|open|show|hover|focus|on|is-|has-)/.test(c)
    && !(P.tw && (UTIL_EXACT.has(c) || UTIL_RE.test(c)));
  const testSel = (n) => { for (const a of ['data-testid', 'data-test', 'data-qa', 'data-test-id', 'data-cy']) { const v = n.a?.[a]; if (v && !/[#[\]~"]/.test(v) && v.length < 60) return `[${a}="${v}"]`; } return null; };

  /** CSS candidates for node i (most stable first) and an XPath. */
  function selectors(P, i) {
    const { nodes } = P;
    const n = nodes[i];
    const own = [];
    const attrSel = (a) => { const v = n.a?.[a]; return v && !/[#[\]~]/.test(v) && v.length < 40 ? `${n.tg}[${a}="${v.replace(/"/g, '\\"')}"]` : null; };
    const ts = testSel(n);
    if (ts) own.push(`${n.tg}${ts}`); // test labels: made for automation, the same in every language
    if (stableId(n.id)) own.push(`#${cssEsc(n.id)}`);
    for (const a of ['name', 'aria-label', 'title', 'placeholder']) { const x = attrSel(a); if (x) own.push(x); }
    const cls = (n.c || []).filter((c) => meaningful(P, c));
    if (cls[0]) own.push(`${n.tg}.${cssEsc(cls[0])}`);
    if (cls[1]) own.push(`${n.tg}.${cssEsc(cls[0])}.${cssEsc(cls[1])}`);
    const role = attrSel('role');
    if (role) own.push(role);
    // nothing of its own (an icon button in a utility-CSS page): the nearest ancestor that has a stable handle + the tag
    if (own.length <= (role ? 1 : 0)) {
      for (let j = n.p, k = 0; j >= 0 && k < 8; j = nodes[j].p, k++) {
        const a = nodes[j];
        const h = testSel(a) || (stableId(a.id) ? `#${cssEsc(a.id)}` : null) || ((a.c || []).filter((c) => meaningful(P, c))[0] ? `${a.tg}.${cssEsc((a.c || []).filter((c) => meaningful(P, c))[0])}` : null);
        if (h) { own.push(`${h} ${role || n.tg}`); break; }
      }
    }
    if (!own.length) { const u = (n.c || []).find((c) => !c.includes('#') && !variant(c)); own.push(u ? `${n.tg}.${cssEsc(u)}` : n.tg); }
    const p = n.p >= 0 ? nodes[n.p] : null;
    const pc = p && (p.c || []).find((c) => meaningful(P, c));
    const css = [...new Set(own)];
    if (pc) css.push(`.${cssEsc(pc)} > ${own[own.length - 1]}`);
    // XPath from the same-tag sibling index of each ancestor, anchored at the nearest stable id
    const chain = [];
    for (let j = i; j >= 0 && chain.length < 30; j = nodes[j].p) {
      const x = nodes[j];
      chain.unshift(stableId(x.id) ? `*[@id="${x.id}"]` : `${x.tg}${x.k > 1 ? `[${x.k}]` : ''}`);
      if (stableId(x.id)) break;
      if (x.p < 0) break;
    }
    const xp = chain[0]?.startsWith('*[@id') ? `//${chain.join('/')}` : `/${chain.join('/')}`;
    return { css, xp };
  }
  const cssEsc = (s) => String(s).replace(/([^\w-])/g, '\\$1');

  const ROLE_NAMES = ['messageInput', 'sendButton', 'translateButton', 'attach', 'fileInput', 'letterButton', 'likeButton', 'favoriteButton', 'winkButton',
    'chatList', 'chatItem', 'unreadMark', 'tab', 'chatHeader', 'messageBubble', 'hintItem', 'counter', 'herCurrent', 'herSwitch', 'searchInput',
    'onlineMark', 'modal', 'danger'];

  /** Inside a search box / search form (a few levels up)? */
  function inSearch(P, i) {
    for (let j = P.nodes[i].p, k = 0; j >= 0 && k < 4; j = P.nodes[j].p, k++) {
      const a = P.nodes[j];
      if (a.r === 'search' || ((a.tg === 'form' || k < 2) && KW.search.test(P.f[j].cls + P.f[j].attrs))) return true;
    }
    return false;
  }
  /** The nearest form around node i, or -1. */
  function formOf(P, i) {
    for (let j = P.nodes[i].p, k = 0; j >= 0 && k < 10; j = P.nodes[j].p, k++) if (P.nodes[j].tg === 'form') return j;
    return -1;
  }

  function classify(snap) {
    const P = prepare(snap);
    const { nodes, vw, vh } = P;
    const out = Object.fromEntries(ROLE_NAMES.map((r) => [r, []]));
    const add = (role, i, score, why) => { if (score > 0) out[role].push({ i, score: Math.min(1, score / 8), why }); };
    const flags = { captcha: false, login: false, modal: false, foreign: snap.foreign?.count || 0 };

    nodes.forEach((n, i) => {
      if (n.f) return; // another extension's element
      const F = P.f[i];
      const vis = n.v === 1;
      const [x, y, w, h] = n.b || [0, 0, 0, 0];
      const why = [];
      const s = n.s || '';
      // ---- typing places ----
      if (n.tg === 'textarea' || s.includes('ce') || (n.tg === 'input' && ['text', '', undefined].includes(n.a?.type))) {
        let sc = n.tg === 'textarea' || s.includes('ce') ? 4 : 1;
        if (vis) sc += 1; else sc -= 2;
        if (KW.msg.test(F.named + F.cls)) { sc += 2; why.push('слова «повідомлення» в атрибутах'); }
        if (KW.notMsg.test(F.attrs + F.cls)) { sc -= 4; why.push('схоже на пошук / тему'); }
        const searching = inSearch(P, i);
        if (searching) { sc -= 4; why.push('усередині пошуку'); }
        if (y > vh * 0.45) sc += 1;
        if (w > 200) sc += 1;
        // a plain one-line field is never taken for the message box on its looks alone (search, filters, forms)
        if (n.tg === 'input' && !KW.msg.test(F.named + F.cls)) sc = Math.min(sc, 3);
        add('messageInput', i, sc, why);
        if (n.tg === 'input' && KW.search.test(F.attrs + F.cls)) add('searchInput', i, 6, ['слова пошуку']);
      }
      if (n.tg === 'input' && n.a?.type === 'file') add('fileInput', i, 7, [`accept=${n.a?.accept || '*'}`]);
      if (n.tg === 'input' && n.a?.type === 'password' && vis) flags.login = true;
      if ((n.tg === 'iframe' && KW.captcha.test(n.ifr || '')) || (vis && KW.captcha.test(F.cls + F.text))) flags.captcha = true;
      if ((n.r === 'dialog' || n.a?.['aria-modal'] === 'true' || KW.modal.test(F.cls)) && vis && n.cs?.pos === 'fixed') { flags.modal = true; add('modal', i, 6, ['фіксоване вікно']); }

      // ---- buttons ----
      if (isClickable(n) || n.cs?.cur || n.tg === 'svg' || n.tg === 'i') {
        const base = isClickable(n) ? 2 : n.cs?.cur ? 1 : 0;
        const t = F.all;
        // a «Letters» tab of the chat list is not the envelope button that opens a letter to this man
        const isTab = n.r === 'tab' || /(^|[\s_-])tabs?([\s_-]|$)/.test(F.cls);
        const btn = (role, re, label) => { if (re.test(t)) add(role, i, base + 4 + (vis ? 1 : 0) + (y > vh * 0.45 && role === 'sendButton' ? 1 : 0) - (role === 'letterButton' && isTab ? 2 : 0), [label]); };
        if (!inSearch(P, i)) btn('sendButton', KW.send, 'слово «надіслати»');
        // a form's submit button is Send only in a form that has a message box — not login, not search
        if (n.a?.type === 'submit' && !KW.send.test(t)) {
          const f = formOf(P, i);
          if (f >= 0 && P.hasMsgBox[f] && !inSearch(P, i)) add('sendButton', i, base + 3 + (vis ? 1 : 0), ['кнопка форми з полем повідомлення']);
        }
        btn('translateButton', KW.translate, 'слово «перекласти»');
        btn('attach', KW.attach, 'фото / файл / скрепка');
        btn('letterButton', KW.letter, 'лист / конверт');
        btn('likeButton', KW.like, 'лайк / серце');
        btn('favoriteButton', KW.fav, 'обране / зірка');
        btn('winkButton', KW.wink, 'підморгнути');
        btn('herSwitch', KW.switchKw, 'змінити / вибрати');
        if (KW.gift.test(t)) add('danger', i, 8, ['подарунок — не чіпати']);
        if (KW.pay.test(t)) add('danger', i, 8, ['оплата — не чіпати']);
        if (KW.destroy.test(t) && isClickable(n)) add('danger', i, 7, ['блок / видалення — не чіпати']);
        if (n.r === 'tab' || (isClickable(n) && n.tx && KW.tabs.test(F.text) && y < vh * 0.4)) add('tab', i, (n.r === 'tab' ? 6 : 3) + (vis ? 1 : 0), ['вкладка']);
      }

      // ---- repeated blocks: chat list items, message bubbles, hints ----
      if (n.rep >= 3) {
        const inLeft = x + w / 2 < vw * 0.4;
        const inRight = x > vw * 0.62;
        let ci = 0;
        if (inLeft) ci += 2;
        if (P.hasImg[i]) ci += 2;
        if (P.hasName[i]) ci += 1;
        if (KW.item.test(F.cls)) ci += 2;
        if (h < 130 && w > 120) ci += 1;
        add('chatItem', i, ci, [`повторюється ×${n.rep}`]);
        if (ci >= 5 && n.p >= 0) add('chatList', n.p, ci, ['батько повторюваних чатів']);
        let mb = 0;
        if (!inLeft && !inRight) mb += 2;
        if (P.hasLong[i]) mb += 2;
        if (KW.bubble.test(F.cls)) mb += 3;
        add('messageBubble', i, mb, []);
        let hi = 0;
        if (inRight) hi += 2;
        if (KW.hint.test(F.cls)) hi += 3;
        if (KW.hintText.test(lower(collectText(P, i)))) hi += 2;
        add('hintItem', i, hi, []);
      } else if (KW.hint.test(F.cls) && KW.hintText.test(lower(collectText(P, i)))) {
        add('hintItem', i, 4, ['одна підказка']);
      }
      if (KW.unread.test(F.cls) && w < 60 && h < 40) add('unreadMark', i, 4 + (P.hasNum[i] ? 1 : 0), ['значок непрочитаного']);
      if (KW.online.test(F.cls) && w < 120) add('onlineMark', i, 5, ['онлайн']);

      // ---- one-off places ----
      if (n.tx && KW.counter.test(F.text) && n.tx.includes('#')) add('counter', i, 7, [`шаблон: ${n.tx}`]);
      if (y < vh * 0.35 && x > vw * 0.2 && x < vw * 0.8 && KW.head.test(F.cls) && P.hasName[i] && w > 150 && h < 200) {
        add('chatHeader', i, 3 + (P.hasNum[i] ? 3 : 0), [P.hasNum[i] ? 'ім’я + число (схоже на ID)' : 'ім’я']);
      }
      if (y < vh * 0.3 && KW.her.test(F.cls + F.attrs) && (P.hasName[i] || P.hasNum[i]) && h < 160) add('herCurrent', i, 4 + (P.hasNum[i] ? 1 : 0), ['поточна анкета?']);
    });

    for (const r of ROLE_NAMES) {
      out[r].sort((a, b) => b.score - a.score);
      out[r] = out[r].slice(0, r === 'danger' ? 12 : 3).map((c) => ({ ...c, ...selectors(P, c.i), tg: nodes[c.i].tg, b: nodes[c.i].b }));
    }
    return { roles: out, flags };
  }

  function collectText(P, i, depth = 0) {
    let s = P.nodes[i].tx || '';
    if (depth < 4) for (const k of P.kids[i]) { s += ` ${collectText(P, k, depth + 1)}`; if (s.length > 200) break; }
    return s;
  }

  /** Over many states: for each role, the selectors that keep coming back. */
  function aggregate(results) {
    const agg = {};
    for (const { roles, route, count } of results) {
      for (const [role, list] of Object.entries(roles)) {
        for (const c of list) {
          const key = c.css[0];
          const a = ((agg[role] ||= {})[key] ||= { css: c.css, xp: c.xp, tg: c.tg, states: 0, seen: 0, score: 0, routes: new Set(), why: new Set() });
          a.states++;
          a.seen += count || 1;
          a.score = Math.max(a.score, c.score);
          a.routes.add(route);
          for (const w of c.why || []) a.why.add(w);
        }
      }
    }
    const out = {};
    for (const [role, m] of Object.entries(agg)) {
      out[role] = Object.values(m).map((a) => ({ ...a, routes: [...a.routes].slice(0, 8), why: [...a.why].slice(0, 5),
        confidence: Math.round(Math.min(1, a.score * (0.6 + 0.4 * Math.min(1, a.states / 5))) * 100) / 100 }))
        .sort((x, y) => y.confidence - x.confidence || y.seen - x.seen).slice(0, 5);
    }
    return out;
  }

  self.__scanRoles = { classify, aggregate, ROLE_NAMES, KW };
})();
