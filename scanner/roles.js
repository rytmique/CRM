// Guesses what each element of a recorded page state is (message box, Send, chat list, hints…), with a score 0–1.
// Works only on the masked snapshot, so it runs the same in the page (hourly probe) and in the report.
(() => {
  if (self.__scanRoles) return;

  const KW = {
    msg: /messag|write|type a|typing|chat|msg|reply|compose|english|text|повідом|напиш|напис|сообщ|українськ|english|translat/i,
    notMsg: /search|find|пошук|поиск|знайти|найти|login|email|password|пароль|subject|тема|\bid\b/i,
    send: /\bsend\b|submit|надіслати|надішліть|відправити|отправить|отправь|➤|➢|✈/i,
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
    return { cls: lower(`${(n.c || []).join(' ')} ${n.id || ''}`), attrs: lower(attrs), text: lower(n.tx || ''), all: lower(`${(n.c || []).join(' ')} ${n.id || ''} ${n.r || ''} ${attrs} ${n.tx || ''}`) };
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
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (['img', 'picture', 'svg', 'canvas', 'video'].includes(n.tg) || /avatar|photo|pic|image|img/i.test((n.c || []).join(' '))) hasImg[i] = true;
      if (/#/.test(n.tx || '')) hasNum[i] = true;
      if (/\[W\]/.test(n.tx || '')) hasName[i] = true;
      if (/\[текст/.test(n.tx || '')) hasLong[i] = true;
      const p = n.p;
      if (p >= 0) { hasImg[p] ||= hasImg[i]; hasNum[p] ||= hasNum[i]; hasName[p] ||= hasName[i]; hasLong[p] ||= hasLong[i]; }
    }
    return { nodes, kids, hasImg, hasNum, hasName, hasLong, vw: snap.vw || 1280, vh: snap.vh || 800, f: nodes.map(features) };
  }

  /** CSS candidates for node i (best first) and an XPath. */
  function selectors(P, i) {
    const { nodes } = P;
    const n = nodes[i];
    const own = [];
    if (n.id && !n.id.includes('#')) own.push(`#${cssEsc(n.id)}`);
    const cls = (n.c || []).filter((c) => !c.includes('#') && c.length < 40 && !/^(active|selected|open|show|hover|focus|on|is-|has-)/.test(c));
    const attrSel = (a) => { const v = n.a?.[a]; return v && !/[#[\]~]/.test(v) && v.length < 40 ? `${n.tg}[${a}="${v.replace(/"/g, '\\"')}"]` : null; };
    for (const a of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'title', 'placeholder']) { const x = attrSel(a); if (x) own.push(x); }
    if (cls[0]) own.push(`${n.tg}.${cssEsc(cls[0])}`);
    if (cls[1]) own.push(`${n.tg}.${cssEsc(cls[0])}.${cssEsc(cls[1])}`);
    { const x = attrSel('role'); if (x) own.push(x); }
    if (!own.length) own.push(n.tg);
    const p = n.p >= 0 ? nodes[n.p] : null;
    const pc = p && (p.c || []).find((c) => !c.includes('#'));
    const css = [...own];
    if (pc) css.push(`.${cssEsc(pc)} > ${own[own.length - 1]}`);
    // XPath from the same-tag sibling index of each ancestor
    const chain = [];
    for (let j = i; j >= 0 && chain.length < 30; j = nodes[j].p) {
      const x = nodes[j];
      chain.unshift(x.id && !x.id.includes('#') ? `*[@id="${x.id}"]` : `${x.tg}${x.k > 1 ? `[${x.k}]` : ''}`);
      if (x.id && !x.id.includes('#')) break;
      if (x.p < 0) break;
    }
    const xp = chain[0]?.startsWith('*[@id') ? `//${chain.join('/')}` : `/${chain.join('/')}`;
    return { css, xp };
  }
  const cssEsc = (s) => String(s).replace(/([^\w-])/g, '\\$1');

  const ROLE_NAMES = ['messageInput', 'sendButton', 'translateButton', 'attach', 'fileInput', 'letterButton', 'likeButton', 'favoriteButton', 'winkButton',
    'chatList', 'chatItem', 'unreadMark', 'tab', 'chatHeader', 'messageBubble', 'hintItem', 'counter', 'herCurrent', 'herSwitch', 'searchInput',
    'onlineMark', 'modal', 'danger'];

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
        if (KW.msg.test(F.attrs + F.cls)) { sc += 2; why.push('слова «повідомлення» в атрибутах'); }
        if (KW.notMsg.test(F.attrs + F.cls)) { sc -= 4; why.push('схоже на пошук / тему'); }
        if (y > vh * 0.45) sc += 1;
        if (w > 200) sc += 1;
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
        const btn = (role, re, label) => { if (re.test(t)) add(role, i, base + 4 + (vis ? 1 : 0) + (y > vh * 0.45 && role === 'sendButton' ? 1 : 0), [label]); };
        btn('sendButton', KW.send, 'слово «надіслати»');
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
