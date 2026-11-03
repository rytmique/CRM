// "Навчити бота": a panel on the dating site. The operator presses "Вибрати" and clicks the element on the page;
// the panel works out a CSS selector, shows what it found and saves it to the site settings in the panel.
// Needs content.js (window.__agencyBot.util) injected first.
(() => {
  if (window.__agencyPicker) return;
  const U = window.__agencyBot.util;
  const { qs, qsa, extract, normId, visible } = U;

  // ---------- field kinds ----------
  const CONTAINER = { card: 'list', inboxItem: 'inbox', taskItem: 'tasks', herItem: 'her' };
  const IN_CARD = ['cardId', 'cardName', 'cardAge', 'cardCountry', 'openChat'];
  const IN_ITEM = ['inboxUnread', 'inboxId', 'inboxName', 'inboxText'];
  const IN_TASK = ['taskName', 'taskText', 'taskId', 'taskOpen'];
  const IN_HER = ['herItemId', 'herItemName'];
  const ATTR_FIELDS = ['cardId', 'inboxId', 'taskId', 'herItemId'];
  const SELF_OK = ['openChat', 'taskOpen']; // clicking the card itself = "@self"
  const URL_FIELDS = ['searchUrl', 'inboxUrl', 'manUrl', 'chatUrl', 'herUrl'];
  const TABS = [
    ['list', 'Список', 'Пошук'],
    ['send', 'Відправка', 'Відправка'],
    ['man', 'Його сторінка', 'Профіль чоловіка'],
    ['letter', 'Листи', 'Листи'],
    ['inbox', 'Вхідні', 'Вхідні'],
    ['tasks', 'Підказки', 'Підказки сайту'],
    ['her', 'Анкети', 'Анкети'],
    ['extra', 'Кнопки й ознаки', null],
  ];
  const TIPS = {
    list: 'Відкрийте сторінку пошуку чоловіків. Почніть з «Картка чоловіка»: клікніть на порожнє місце в будь-якій картці.',
    send: 'Натисніть на сайті «Написати» як зазвичай (режим вибору вимкнений), щоб відкрилось вікно чату. Потім виберіть поле вводу і кнопку «Надіслати».',
    man: 'Відкрийте сторінку будь-якого чоловіка і натисніть «📍 Ця сторінка». Якщо поле вводу тут інше — виберіть його у вкладці «Відправка» прямо на цій сторінці, бот додасть варіант.',
    inbox: 'Відкрийте вхідні. Почніть з «Діалог у вхідних»: клікніть на порожнє місце в будь-якому діалозі.',
    tasks: 'Якщо сайт сам підкидає «Please write him message / letter» — виберіть «Підказка»: клікніть на порожнє місце в будь-якій підказці. Ім’я й текст бот знайде сам. ID зазвичай береться з шапки чату (вкладка «Відправка»).',
    her: 'Лише якщо оператор працює за кількох жінок. Виберіть, де видно поточну анкету (ім’я / ID), і перемикач. Потім відкрийте на сайті список жінок (режим вибору вимкнений) і виберіть один рядок. Ще — її ім’я в шапці чату. Тоді бот сам перемикає анкети й не пише від імені не тієї жінки.',
    letter: 'Відкрийте чат чоловіка і натисніть на сайті конверт «Лист» (режим вибору вимкнений). Потім виберіть кнопку «Лист», поле тексту й «Надіслати». Тему й лічильник «Залишилося N листів» — якщо є.',
    extra: 'Кнопки — що бот може натискати у сценарії (лайк, підморгнути, в обране). Ознаки — що бот бачить у картці (онлайн, преміум, вже писали) для фільтрів.',
  };

  // ---------- selector building ----------
  const BAD_CLASS = /^(css|sc|jsx|emotion|svelte|ng|v|tw)-|__[\w-]*\d|\d{3,}|^[a-z]{1,2}\d|^(active|hover|hovered|focus|focused|selected|open|opened|show|shown|visible|hidden|disabled|loading|animated?|fade|in|ng-\w+)$/i;
  const goodClasses = (el) => [...el.classList].filter((c) => c.length <= 40 && /^[a-zA-Z_][\w-]*$/.test(c) && !BAD_CLASS.test(c));
  const goodId = (id) => id && /^[a-zA-Z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && id.length <= 40;
  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-action', 'data-role', 'data-type', 'name', 'aria-label', 'role', 'type', 'placeholder', 'title'];
  const esc = (s) => CSS.escape(s);
  const tagOf = (el) => el.tagName.toLowerCase();
  const ownText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  /** Simple selectors that describe this element alone, best first. */
  function simple(el, { text = true } = {}) {
    const tag = tagOf(el);
    const out = [];
    if (goodId(el.id)) out.push(`#${esc(el.id)}`);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || v.length > 40 || /\d{4,}/.test(v) || /["\\]/.test(v)) continue;
      // descriptive attributes work whatever the tag is (a <button> here, a <label> on another page)
      if (!['type', 'role', 'name'].includes(a)) out.push(`[${a}="${v}"]`);
      out.push(`${tag}[${a}="${v}"]`);
    }
    const cls = goodClasses(el);
    for (const c of cls) out.push(`.${esc(c)}`, `${tag}.${esc(c)}`);
    for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) out.push(`.${esc(cls[i])}.${esc(cls[j])}`);
    const t = ownText(el);
    if (text && t && t.length <= 30 && !/["\\]/.test(t) && el.children.length <= 2) out.push(`${tag}:has-text("${t}")`);
    out.push(tag);
    return [...new Set(out)];
  }

  /** Path with :nth-of-type from `root` down to `el` (last resort). */
  function pathFrom(root, el) {
    const parts = [];
    for (let n = el; n && n !== root; n = n.parentElement) {
      const same = [...(n.parentElement?.children || [])].filter((x) => x.tagName === n.tagName);
      const cls = goodClasses(n)[0];
      parts.unshift(cls ? `${tagOf(n)}.${esc(cls)}` : same.length > 1 ? `${tagOf(n)}:nth-of-type(${same.indexOf(n) + 1})` : tagOf(n));
      if (goodId(n.id)) { parts[0] = `#${esc(n.id)}`; break; }
    }
    return parts.join(' > ');
  }

  /** A selector whose first visible match on the page is `el`. */
  function pageSelector(el) {
    const firstVisible = (s) => qsa(document, s).find(visible);
    const cands = simple(el);
    const unique = cands.find((s) => qsa(document, s).length === 1 && qs(document, s) === el);
    if (unique) return unique;
    // anchor on an ancestor with an id or a unique class
    for (let a = el.parentElement, depth = 0; a && a !== document.body && depth < 6; a = a.parentElement, depth++) {
      const anchor = simple(a, { text: false }).find((s) => s !== tagOf(a) && qsa(document, s).length === 1);
      if (!anchor) continue;
      const inner = cands.find((s) => { const full = `${anchor} ${s}`; return qsa(document, full).length === 1 && qs(document, full) === el; });
      if (inner) return `${anchor} ${inner}`;
    }
    const first = cands.find((s) => s !== tagOf(el) && firstVisible(s) === el);
    if (first) return first;
    return pathFrom(document.body, el);
  }

  /** Same kind of element: same tag and a shared class (state classes like "liked"/"active" may differ). */
  const sameKind = (a, b) => {
    if (a.tagName !== b.tagName) return false;
    const ca = goodClasses(a);
    const cb = goodClasses(b);
    return (!ca.length && !cb.length) || ca.some((c) => cb.includes(c));
  };

  /** A selector relative to `root` (a card) that finds `el` there and, ideally, the same thing in the other cards. */
  function relSelector(root, el, others = []) {
    if (el === root) return '';
    let best = null;
    for (const s of simple(el)) {
      if (qs(root, s) !== el) continue;
      const general = others.filter((o) => { const x = qs(o, s); return x && sameKind(x, el); }).length;
      // prefer classes/attributes over a bare tag or text
      const score = general * 1000 - s.length - (/^[a-z0-9]+$/i.test(s) ? 60 : 0) - (s.includes(':has-text(') ? 40 : 0);
      if (!best || score > best.score) best = { s, general, score };
    }
    if (best && (best.general >= others.length * 0.5 || !others.length)) return best.s;
    // try "parent-class > tag" style
    const p = el.parentElement;
    if (p && p !== root) {
      for (const ps of simple(p, { text: false })) {
        for (const s of simple(el, { text: false })) {
          const full = `${ps} > ${s}`;
          if (qs(root, full) === el) return full;
        }
      }
    }
    return best?.s || pathFrom(root, el);
  }

  /** The repeated block (man card / dialog) around the clicked element. */
  function containerFor(el) {
    for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const parent = a.parentElement;
      if (!parent) break;
      const sibs = [...parent.children].filter((x) => x !== a && x.tagName === a.tagName);
      if (!sibs.length) continue;
      if (ownText(a).length < 3 && !a.querySelector('img,a,button')) continue;
      const common = goodClasses(a).filter((c) => sibs.filter((x) => x.classList.contains(c)).length >= Math.max(1, Math.ceil(sibs.length * 0.6)));
      if (!common.length && sibs.length < 2) continue;
      const cands = [...common.map((c) => `.${esc(c)}`), ...common.map((c) => `${tagOf(a)}.${esc(c)}`)];
      if (!cands.length) cands.push(`${pageSelector(parent)} > ${tagOf(a)}`);
      for (const s of cands) {
        const all = qsa(document, s);
        if (all.length >= 2 && all.includes(a) && !all.some((x) => all.some((y) => y !== x && y.contains(x)))) return { el: a, sel: s, count: all.length };
      }
    }
    return null;
  }

  const DIGITS = /\d{5,}/;
  const SKIP_ATTR = new Set(['class', 'style', 'src', 'srcset', 'width', 'height']);

  /** "@attr" / "sel@attr" for the man's ID: from the clicked element (or the card) up/down. */
  function idSpec(card, start) {
    const tryNode = (n) => {
      for (const at of n.attributes) {
        if (SKIP_ATTR.has(at.name) || !DIGITS.test(at.value)) continue;
        return n === card ? `@${at.name}` : `${relSelector(card, n, others(card))}@${at.name}`;
      }
      return null;
    };
    if (start) for (let n = start; n; n = n === card ? null : n.parentElement) { const s = tryNode(n); if (s) return s; }
    const own = tryNode(card);
    if (own) return own;
    for (const n of card.querySelectorAll('a[href]')) { const s = tryNode(n); if (s) return s; }
    for (const n of card.querySelectorAll('*')) { const s = tryNode(n); if (s) return s; }
    return null;
  }

  // ---------- state ----------
  let ctx; // { siteId, siteName, fields, config, tab }
  let host;
  let root;
  let picking = null; // { key, kind, onPick }
  let hl;
  let tip;
  const last = {}; // key -> element picked last (for "ширше")

  const containerKey = (key) => (IN_ITEM.includes(key) || key === 'inboxItem' ? 'inboxItem' : IN_TASK.includes(key) || key === 'taskItem' ? 'taskItem'
    : IN_HER.includes(key) || key === 'herItem' ? 'herItem' : 'card');
  const containersFor = (key) => qsa(document, ctx.config[containerKey(key)]);
  const others = (card) => containersFor('card').filter((c) => c !== card).slice(0, 12);
  const othersOf = (key, box) => containersFor(key).filter((c) => c !== box).slice(0, 12);

  const tell = (msg) => { try { return globalThis.chrome?.runtime?.sendMessage?.(msg)?.catch?.(() => {}); } catch { return undefined; } };
  function draft() { tell({ type: 'teachDraft', config: ctx.config, tab: ctx.tab }); }

  // ---------- describing what a value finds ----------
  function describe(key) {
    const v = ctx.config[key];
    if (!v) return { text: '', ok: false };
    try {
      if (URL_FIELDS.includes(key)) return { text: key === 'manUrl' && !v.includes('{id}') ? 'немає {id} в адресі' : '', ok: true, warn: key === 'manUrl' && !v.includes('{id}') };
      if (key === 'card' || key === 'inboxItem' || key === 'taskItem' || key === 'herItem') {
        const n = qsa(document, v).length;
        return n ? { text: `знайдено ${n} на цій сторінці`, ok: true } : { text: 'на цій сторінці немає', ok: true, warn: true };
      }
      if (IN_CARD.includes(key) || IN_ITEM.includes(key) || IN_TASK.includes(key) || IN_HER.includes(key)) {
        const boxes = containersFor(key);
        if (!boxes.length) return { text: 'відкрийте сторінку, де є ці картки', ok: true, warn: true };
        if (v === '@self') return { text: 'клік по самій картці', ok: true };
        if (key === 'openChat' || key === 'taskOpen') { const n = boxes.filter((b) => qs(b, v)).length; return { text: `є у ${n} з ${boxes.length}`, ok: true, warn: !n }; }
        if (key === 'inboxUnread') { const n = boxes.filter((b) => qs(b, v) || b.matches?.(v)).length; return { text: `непрочитаних ${n} з ${boxes.length}`, ok: true }; }
        const vals = boxes.map((b) => (ATTR_FIELDS.includes(key) ? normId(extract(b, v)) : extract(b, v))).filter(Boolean);
        if (!vals.length) return { text: 'нічого не знайшов', ok: true, warn: true };
        if (key === 'herItemId' && new Set(vals).size < vals.length) return { text: `${vals.join(', ')} — ID повторюються!`, ok: true, warn: true };
        let text = `${vals.slice(0, 3).join(', ')}${vals.length > 3 ? '…' : ''} (${vals.length} з ${boxes.length})`;
        let warn = vals.length < boxes.length * 0.6;
        if (ATTR_FIELDS.includes(key) && new Set(vals).size < vals.length) { text += ' — ID повторюються!'; warn = true; }
        return { text, ok: true, warn };
      }
      const n = qsa(document, v).filter(visible).length;
      return { text: n ? 'видно на цій сторінці' : 'тут не видно (нормально, якщо воно на іншій сторінці або з’являється пізніше)', ok: true, warn: !n };
    } catch {
      return { text: 'помилка в селекторі', ok: false, warn: true };
    }
  }

  // ---------- picking ----------
  function startPick(key, kind, onPick, label) {
    stopPick();
    picking = { key, kind, onPick };
    hl = document.createElement('div');
    Object.assign(hl.style, { position: 'fixed', zIndex: 2147483646, pointerEvents: 'none', border: '2px solid #d6336c', background: 'rgba(214,51,108,.12)', borderRadius: '4px', transition: 'all .06s', display: 'none' });
    tip = document.createElement('div');
    Object.assign(tip.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', background: '#1f1a24', color: '#fff', font: '600 12px/1.4 system-ui,sans-serif', padding: '4px 8px', borderRadius: '6px', maxWidth: '360px', display: 'none' });
    document.documentElement.append(hl, tip);
    window.addEventListener('mousemove', onMove, true);
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) window.addEventListener(t, onClick, true);
    window.addEventListener('keydown', onKey, true);
    status(`Клікніть на сайті: ${label}. Esc — скасувати`);
    // fold the panel so it does not cover the page while picking
    root?.querySelector('.panel')?.classList.add('picking-now');
    const t = root?.querySelector('.head b');
    if (t) t.textContent = `Клікніть на сайті: ${label} · Esc — скасувати`;
    render();
  }

  function stopPick() {
    if (!picking) return;
    picking = null;
    hl?.remove(); tip?.remove();
    window.removeEventListener('mousemove', onMove, true);
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) window.removeEventListener(t, onClick, true);
    window.removeEventListener('keydown', onKey, true);
    root?.querySelector('.panel')?.classList.remove('picking-now');
    const t = root?.querySelector('.head b');
    if (t) t.textContent = `Навчання бота — ${ctx.siteName}`;
  }

  const ours = (e) => e.composedPath().includes(host);

  function onMove(e) {
    if (ours(e)) { hl.style.display = 'none'; tip.style.display = 'none'; return; }
    const el = e.target;
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const t = ownText(el).slice(0, 40);
    tip.textContent = `${tagOf(el)}${goodClasses(el)[0] ? `.${goodClasses(el)[0]}` : ''}${t ? ` — «${t}»` : ''}`;
    Object.assign(tip.style, { display: 'block', left: `${Math.min(e.clientX + 12, innerWidth - 370)}px`, top: `${Math.min(e.clientY + 16, innerHeight - 30)}px` });
  }

  function onClick(e) {
    if (ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const p = picking;
    stopPick();
    try { p.onPick(e.target); } catch (err) { status(`Не вийшло: ${err.message}`, true); }
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); stopPick(); status('Скасовано'); render(); }
  }

  /** Works out the selector for a picked element and stores it. */
  function pickField(key, el) {
    const c = ctx.config;
    last[key] = el;
    if (key === 'card' || key === 'inboxItem' || key === 'taskItem' || key === 'herItem') {
      const box = containerFor(el);
      if (!box) throw new Error('не бачу, що картки повторюються. Клікніть на порожнє місце в картці');
      c[key] = box.sel;
      last[key] = box.el;
      U.flash(box.el, `✓ ${box.count} шт.`);
      for (const x of qsa(document, box.sel).slice(0, 30)) x.style.outline = '2px dashed #d6336c';
      setTimeout(() => { for (const x of qsa(document, box.sel).slice(0, 30)) x.style.outline = ''; }, 2500);
      if (key === 'card') autoCard(box.el);
      if (key === 'inboxItem') autoInbox(box.el);
      if (key === 'taskItem') autoTask(box.el);
      if (key === 'herItem') autoHer(box.el);
      status(`✓ Знайдено ${box.count}. Перевірте нижче, що бот сам знайшов ID та ім’я`);
      return;
    }
    if (IN_CARD.includes(key) || IN_ITEM.includes(key) || IN_TASK.includes(key) || IN_HER.includes(key)) {
      const ck = containerKey(key);
      const sel = c[ck];
      if (!sel) throw new Error({ inboxItem: 'спочатку виберіть «Діалог у вхідних»', taskItem: 'спочатку виберіть «Підказка»', herItem: 'спочатку відкрийте на сайті список жінок і виберіть «Жінка в списку»' }[ck] || 'спочатку виберіть «Картка чоловіка»');
      const box = qsa(document, sel).find((b) => b.contains(el));
      if (!box) throw new Error('цей елемент не всередині картки');
      if (SELF_OK.includes(key) && (el === box || !relSelector(box, el, othersOf(key, box)))) {
        c[key] = '@self'; // the card itself opens his chat
        U.flash(box, '✓ клік по самій картці');
        status('✓ Чат відкривається кліком по самій картці');
        return;
      }
      if (ATTR_FIELDS.includes(key)) {
        const spec = idSpec(box, el);
        if (!spec) throw new Error('не знайшов тут числа з 5+ цифр. Клікніть на ім’я-посилання чи фото чоловіка');
        c[key] = spec;
      } else if (key === 'inboxUnread') {
        c[key] = relSelector(box, el, []) || goodClasses(box).map((x) => `.${esc(x)}`)[0] || '';
      } else {
        c[key] = relSelector(box, el, othersOf(key, box));
      }
      U.flash(el, '✓');
      status(`✓ ${describe(key).text}`);
      return;
    }
    // page-level field: if the old value finds nothing here (another page), keep it and add this one
    const sel = pageSelector(el);
    const old = c[key];
    const oldHere = old && qsa(document, old).some(visible);
    c[key] = old && !oldHere && !U.splitTop(old).includes(sel) ? `${old}, ${sel}` : sel;
    U.flash(el, '✓');
    status(old && !oldHere ? '✓ Додано варіант для цієї сторінки (старий теж лишився)' : '✓ Збережу після «Зберегти»');
  }

  /** After the card is picked: guess ID, name, age, "Write" button, so often nothing else is needed. */
  function autoCard(card) {
    const c = ctx.config;
    const oth = others(card);
    if (!c.cardId) c.cardId = idSpec(card) || '';
    const find = (re) => [...card.querySelectorAll('*')].find((n) => goodClasses(n).some((x) => re.test(x)) && ownText(n));
    if (!c.cardName) { const n = find(/name|nick|title/i) || card.querySelector('a[href]'); if (n && ownText(n)) c.cardName = relSelector(card, n, oth); }
    if (!c.cardAge) { const n = find(/age|years?|old/i) || [...card.querySelectorAll('*')].find((x) => !x.children.length && /^\d{2}(\s*(y\.?o\.?|years?|років|лет|г\.?))?$/i.test(ownText(x))); if (n) c.cardAge = relSelector(card, n, oth); }
    if (!c.cardCountry) { const n = find(/country|location|city|place/i); if (n) c.cardCountry = relSelector(card, n, oth); }
    if (!c.openChat) {
      const n = [...card.querySelectorAll('button,a,[role=button]')].find((x) => /write|message|chat|mail|letter|напис|повідом|чат|лист|написать|сообщ/i.test(`${ownText(x)} ${x.className} ${x.getAttribute('title') || ''} ${x.getAttribute('aria-label') || ''}`));
      if (n) c.openChat = relSelector(card, n, oth);
    }
  }

  function autoInbox(item) {
    const c = ctx.config;
    if (!c.inboxId) c.inboxId = idSpec(item) || '';
    const n = [...item.querySelectorAll('*')].find((x) => goodClasses(x).some((k) => /name|nick|title/i.test(k)) && ownText(x));
    if (!c.inboxName && n) c.inboxName = relSelector(item, n, othersOf('inboxItem', item));
  }

  function autoTask(item) {
    const c = ctx.config;
    const oth = othersOf('taskItem', item);
    if (!c.taskId) c.taskId = idSpec(item) || '';
    const find = (re) => [...item.querySelectorAll('*')].find((n) => goodClasses(n).some((x) => re.test(x)) && ownText(n));
    if (!c.taskName) { const n = find(/name|nick|title/i) || [...item.querySelectorAll('*')].find((x) => !x.children.length && /,\s*\d{2}\b/.test(ownText(x))); if (n) c.taskName = relSelector(item, n, oth); }
    if (!c.taskText) { const n = [...item.querySelectorAll('*')].find((x) => !x.children.length && /write|message|letter|напиш|повідом|лист|письм/i.test(ownText(x))); if (n) c.taskText = relSelector(item, n, oth); }
    if (!c.taskOpen) c.taskOpen = '@self';
  }

  function autoHer(item) {
    const c = ctx.config;
    const oth = othersOf('herItem', item);
    if (!c.herItemId) {
      const spec = idSpec(item);
      const n = spec ? null : [...item.querySelectorAll('*')].find((x) => !x.children.length && DIGITS.test(ownText(x)));
      c.herItemId = spec || (n ? relSelector(item, n, oth) : '');
    }
    if (!c.herItemName) {
      const n = [...item.querySelectorAll('*')].find((x) => goodClasses(x).some((k) => /name|nick|title/i.test(k)) && ownText(x));
      if (n) c.herItemName = relSelector(item, n, oth);
    }
  }

  function setUrl(key) {
    const href = location.href;
    if (key === 'manUrl' || key === 'chatUrl' || key === 'herUrl') {
      const m = href.match(DIGITS);
      ctx.config[key] = m ? href.replace(m[0], key === 'herUrl' ? '{pid}' : '{id}') : href;
      const ph = key === 'herUrl' ? '{pid}' : '{id}';
      status(m ? `✓ ID ${m[0]} у адресі замінено на ${ph}` : key === 'herUrl' ? '⚠ В адресі немає ID жінки (5+ цифр) — краще навчіть перемикач і список жінок' : '⚠ В адресі немає ID з 5+ цифр — бот піде за посиланням з картки', !m);
    } else {
      ctx.config[key] = href;
      status('✓ Адресу записано');
    }
  }

  // ---------- UI ----------
  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; top: 16px; right: 16px; width: 370px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #fff; color: #1f1a24;
      border: 1px solid #e6dce8; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.2); font: 13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; z-index: 2147483647; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #d6336c; color: #fff; cursor: move; user-select: none; }
    .head b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head button { background: rgba(255,255,255,.22); color: #fff; border: 0; border-radius: 6px; min-width: 26px; height: 26px; cursor: pointer; font: inherit; }
    .tabs { display: flex; gap: 4px; padding: 8px 10px 0; flex-wrap: wrap; }
    .tabs button { border: 1px solid #ece6ef; background: #faf7fb; color: #1f1a24; border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    .tabs button.on { background: #1f1a24; color: #fff; border-color: #1f1a24; }
    .tabs i { font-style: normal; color: #2f9e44; } .tabs button.on i { color: #8ce99a; }
    .body { overflow: auto; padding: 8px 12px 12px; display: grid; gap: 8px; }
    .tip { color: #5b5363; font-size: 12px; margin: 0; background: #faf7fb; border-radius: 8px; padding: 8px 10px; }
    .row { border: 1px solid #ece6ef; border-radius: 10px; padding: 8px 10px; display: grid; gap: 4px; }
    .row.ok { border-color: #b2e2bd; background: #f6fcf7; }
    .row.picking { border-color: #d6336c; box-shadow: 0 0 0 2px rgba(214,51,108,.2); }
    .label { font-weight: 600; } .req { color: #d6336c; }
    .sub { color: #7c7383; font-size: 11.5px; }
    .val { font: 11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color: #5b5363; word-break: break-all; }
    .prev { font-size: 12px; color: #2f9e44; } .prev.warn { color: #e8590c; }
    .btns { display: flex; gap: 6px; flex-wrap: wrap; }
    button.b { font: inherit; font-size: 12px; border: 1px solid #e3d9e6; background: #fff; border-radius: 8px; padding: 4px 9px; cursor: pointer; color: #1f1a24; }
    button.b:hover { border-color: #d6336c; }
    button.b.primary { background: #d6336c; border-color: #d6336c; color: #fff; font-weight: 600; }
    input.t { font: 12px ui-monospace,monospace; padding: 5px 7px; border: 1px solid #e3d9e6; border-radius: 6px; width: 100%; color: #1f1a24; background: #fff; }
    input.n { font: inherit; padding: 5px 7px; border: 1px solid #e3d9e6; border-radius: 6px; flex: 1; min-width: 0; color: #1f1a24; background: #fff; }
    h4 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #7c7383; }
    .foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #ece6ef; align-items: center; }
    .msg { flex: 1; font-size: 12px; color: #5b5363; } .msg.err { color: #e03131; }
    .min .tabs, .min .body, .min .foot, .picking-now .tabs, .picking-now .body, .picking-now .foot { display: none; }
    .picking-now { width: auto; max-width: 420px; } .picking-now .head { background: #1f1a24; }
  `;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  };

  let msgEl;
  function status(text, err = false) {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = `msg${err ? ' err' : ''}`;
  }

  const fieldsOfTab = (tab) => ctx.fields.filter((f) => f.group === TABS.find((t) => t[0] === tab)?.[2]);
  const tabDone = (tab) => tab !== 'extra' && fieldsOfTab(tab).filter((f) => f.required).every((f) => ctx.config[f.key]) && fieldsOfTab(tab).some((f) => ctx.config[f.key]);

  function fieldRow(f) {
    const v = ctx.config[f.key] || '';
    const d = describe(f.key);
    const isUrl = URL_FIELDS.includes(f.key);
    const edit = el('input', { class: 't', value: v, spellcheck: 'false', placeholder: f.hint || '', onchange: (e) => { ctx.config[f.key] = e.target.value.trim(); draft(); render(); } });
    edit.style.display = 'none';
    const row = el('div', { class: `row${v ? ' ok' : ''}${picking?.key === f.key ? ' picking' : ''}` },
      el('div', {}, el('span', { class: 'label' }, f.label), f.required ? el('span', { class: 'req' }, ' *') : null),
      v ? el('div', { class: 'val', title: v }, v.length > 90 ? `${v.slice(0, 90)}…` : v) : el('div', { class: 'sub' }, f.hint || ''),
      d.text ? el('div', { class: `prev${d.warn ? ' warn' : ''}` }, d.text) : null,
      edit,
      el('div', { class: 'btns' },
        isUrl
          ? el('button', { class: 'b primary', onclick: () => { setUrl(f.key); draft(); render(); } }, '📍 Ця сторінка')
          : el('button', { class: 'b primary', onclick: () => startPick(f.key, 'field', (x) => { pickField(f.key, x); draft(); }, `«${f.label}»`) }, picking?.key === f.key ? '…клікніть на сайті' : '🎯 Вибрати'),
        !isUrl && last[f.key] && (f.key === 'card' || f.key === 'inboxItem' || !ATTR_FIELDS.includes(f.key)) && last[f.key].parentElement && last[f.key].parentElement !== document.body
          ? el('button', { class: 'b', title: 'Взяти батьківський елемент', onclick: () => { const p = last[f.key].parentElement; try { if (f.key === 'card' || f.key === 'inboxItem') { const sib = [...(p.parentElement?.children || [])].filter((x) => x.tagName === p.tagName); const cls = goodClasses(p)[0]; ctx.config[f.key] = cls ? `.${esc(cls)}` : `${pageSelector(p.parentElement)} > ${tagOf(p)}`; last[f.key] = p; status(`Тепер: ${qsa(document, ctx.config[f.key]).length} шт. (${sib.length} поруч)`); } else pickField(f.key, p); } catch (err) { status(err.message, true); } draft(); render(); } }, '⬆ ширше')
          : null,
        el('button', { class: 'b', title: 'Ввести вручну', onclick: () => { edit.style.display = edit.style.display === 'none' ? 'block' : 'none'; edit.focus(); } }, '✎'),
        v ? el('button', { class: 'b', title: 'Очистити', onclick: () => { ctx.config[f.key] = ''; draft(); render(); } }, '✕') : null));
    return row;
  }

  function listEditor(kind) {
    const isAct = kind === 'actions';
    const list = (ctx.config[kind] ||= []);
    const name = el('input', { class: 'n', placeholder: isAct ? 'Назва, напр. Лайк' : 'Назва, напр. Онлайн' });
    const add = () => {
      const label = name.value.trim();
      if (!label) { name.focus(); status('Спочатку напишіть назву', true); return; }
      startPick(`${kind}:new`, kind, (x) => {
        const card = ctx.config.card ? qsa(document, ctx.config.card).find((b) => b.contains(x)) : null;
        if (!isAct && !card) throw new Error('ознака має бути всередині картки чоловіка');
        const key = (label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `${isAct ? 'btn' : 'mark'}`).slice(0, 16);
        let k = key; let i = 2;
        while (list.some((a) => a.key === k)) k = `${key}-${i++}`;
        const sel = card ? (relSelector(card, x, isAct ? others(card) : []) || goodClasses(x).map((c) => `.${esc(c)}`)[0]) : pageSelector(x);
        list.push(isAct ? { key: k, name: label, sel, where: card ? 'card' : 'page' } : { key: k, name: label, sel });
        U.flash(x, `✓ ${label}`);
        status(`✓ «${label}» додано${isAct ? (card ? ' (у картці)' : ' (на сторінці)') : ''}`);
        draft();
      }, `«${label}»`);
    };
    const markCount = (m) => {
      const cards = ctx.config.card ? qsa(document, ctx.config.card) : [];
      return cards.length ? ` · є у ${cards.filter((c) => qs(c, m.sel)).length} з ${cards.length}` : '';
    };
    return [
      el('h4', {}, isAct ? 'Кнопки, які бот може натискати' : 'Ознаки в картці'),
      ...list.map((a, i) => el('div', { class: 'row ok' },
        el('div', {}, el('span', { class: 'label' }, a.name), el('span', { class: 'sub' }, isAct ? (a.where === 'page' ? ' · на його сторінці' : ' · у картці') : markCount(a))),
        el('div', { class: 'val' }, a.sel),
        el('div', { class: 'btns' },
          el('button', { class: 'b', onclick: () => { const found = qsa(document, a.sel).filter(visible); found.slice(0, 20).forEach((x) => U.flash(x, a.name)); status(found.length ? `Видно: ${found.length}` : 'На цій сторінці не видно', !found.length); } }, '👁 Показати'),
          el('button', { class: 'b', onclick: () => { list.splice(i, 1); draft(); render(); } }, '✕ Видалити')))),
      el('div', { class: 'btns' }, name, el('button', { class: 'b primary', onclick: add }, picking?.key === `${kind}:new` ? '…клікніть' : '+ 🎯 Додати')),
    ];
  }

  function render() {
    if (!root) return;
    const panel = root.querySelector('.panel');
    const tabs = panel.querySelector('.tabs');
    const body = panel.querySelector('.body');
    tabs.replaceChildren(...TABS.map(([id, label]) => el('button', { class: ctx.tab === id ? 'on' : '', onclick: () => { ctx.tab = id; draft(); render(); } }, label, tabDone(id) ? el('i', {}, ' ✓') : null)));
    const content = ctx.tab === 'extra'
      ? [...listEditor('actions'), ...listEditor('marks')]
      : fieldsOfTab(ctx.tab).map(fieldRow);
    body.replaceChildren(el('p', { class: 'tip' }, TIPS[ctx.tab]), ...content);
  }

  function check() {
    const c = ctx.config;
    const cards = c.card ? qsa(document, c.card) : [];
    const lines = [];
    if (cards.length) {
      cards.slice(0, 20).forEach((x, i) => { if (i < 3) U.flash(x, `${extract(x, c.cardName) || '?'} · ${normId(extract(x, c.cardId)) || 'без ID'}`); else x.style.outline = '2px dashed #d6336c'; });
      setTimeout(() => cards.slice(3, 20).forEach((x) => { x.style.outline = ''; }), 2500);
      lines.push(`карток ${cards.length}`);
    }
    for (const k of ['messageInput', 'sendButton', 'nextPage', 'inboxItem']) {
      const found = c[k] ? qsa(document, c[k]).filter(visible) : [];
      if (found.length) { U.flash(found[0], k === 'messageInput' ? 'поле вводу' : k === 'sendButton' ? '«Надіслати»' : k === 'nextPage' ? 'наступна сторінка' : 'діалог'); lines.push(k); }
    }
    status(lines.length ? `На цій сторінці бот бачить: ${lines.join(', ')}` : 'На цій сторінці бот поки нічого не бачить', !lines.length);
  }

  async function save(btn) {
    btn.disabled = true;
    status('Зберігаю…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'saveSite', siteId: ctx.siteId, config: ctx.config });
      if (!r?.ok) throw new Error(r?.error || 'не збереглось');
      ctx.config = r.data.config;
      status('✓ Збережено. Тепер запустіть 🧪 тест у розширенні');
    } catch (e) {
      status(`Помилка: ${e.message}`, true);
    } finally {
      btn.disabled = false;
      render();
    }
  }

  function close() {
    stopPick();
    host?.remove();
    host = null;
    root = null;
    tell({ type: 'teachEnd' });
  }

  function open(data) {
    ctx = { tab: 'list', ...data, config: { actions: [], marks: [], ...(data.config || {}) } };
    host?.remove();
    host = document.createElement('div');
    host.id = '__agency_teach';
    root = host.attachShadow({ mode: 'open' });
    root.append(el('style', {}, CSS_TEXT));
    const saveBtn = el('button', { class: 'b primary' }, '💾 Зберегти');
    saveBtn.addEventListener('click', () => save(saveBtn));
    msgEl = el('div', { class: 'msg' }, data.message || 'Виберіть пункт і клікніть на сайті');
    const head = el('div', { class: 'head' },
      el('span', {}, '🎯'), el('b', {}, `Навчання бота — ${ctx.siteName}`),
      el('button', { title: 'Згорнути', onclick: () => panel.classList.toggle('min') }, '–'),
      el('button', { title: 'Закрити', onclick: close }, '✕'));
    const panel = el('div', { class: 'panel' }, head, el('div', { class: 'tabs' }), el('div', { class: 'body' }),
      el('div', { class: 'foot' }, msgEl, el('button', { class: 'b', onclick: check }, '👁 Перевірити'), saveBtn));
    root.append(panel);
    // drag by the header
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left; const dy = e.clientY - r.top;
      const mv = (ev) => { panel.style.left = `${Math.max(0, ev.clientX - dx)}px`; panel.style.top = `${Math.max(0, ev.clientY - dy)}px`; panel.style.right = 'auto'; };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    document.documentElement.append(host);
    render();
    return { ok: true };
  }

  window.__agencyPicker = {
    open, close,
    // exposed for tests
    _pick: (key, target) => { pickField(key, target); render(); return ctx.config; },
    _url: (key) => { setUrl(key); return ctx.config; },
    _addList: (kind, name, target) => {
      const list = (ctx.config[kind] ||= []);
      const card = ctx.config.card ? qsa(document, ctx.config.card).find((b) => b.contains(target)) : null;
      const sel = card ? relSelector(card, target, kind === 'actions' ? others(card) : []) : pageSelector(target);
      list.push(kind === 'actions' ? { key: name.toLowerCase(), name, sel, where: card ? 'card' : 'page' } : { key: name.toLowerCase(), name, sel });
      return ctx.config;
    },
    config: () => ctx?.config,
  };
})();
