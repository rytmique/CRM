// Injected into the dating-site tab. Only reads the page and clicks/fills what the site adapter points to.
(() => {
  if (window.__agencyBot) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------- selectors: CSS + comma lists + :has-text("…") ----------
  /** Splits "a, b:has-text("x, y")" on top-level commas only. */
  function splitTop(sel) {
    const out = [];
    let depth = 0;
    let quote = '';
    let cur = '';
    for (const ch of sel) {
      if (quote) { if (ch === quote) quote = ''; cur += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function queryPart(root, part) {
    const m = /^(.*?):has-text\((["'])(.*)\2\)\s*$/.exec(part);
    if (!m) return [...root.querySelectorAll(part)];
    const want = norm(m[3]);
    const els = [...root.querySelectorAll(m[1].trim() || '*')].filter((el) => norm(el.textContent).includes(want));
    // keep the innermost matches (a whole <body> also "contains" the text)
    return els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  }

  const qsa = (root, sel) => {
    if (!sel || !root) return [];
    if (sel.includes('||')) { // "a || b": the first alternative that finds something visible (unlike "a, b": all, in page order)
      const alts = sel.split('||').map((x) => x.trim()).filter(Boolean);
      for (const a of alts) { const r = qsa(root, a); if (r.some((el) => visible(el))) return r; }
      return qsa(root, alts[alts.length - 1]);
    }
    try {
      const parts = splitTop(sel);
      if (parts.length === 1) return queryPart(root, parts[0]);
      const set = new Set(parts.flatMap((p) => queryPart(root, p)));
      return [...set].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    } catch { return []; }
  };
  const qs = (root, sel) => qsa(root, sel)[0] || null;

  /** "@attr" | "sel@attr" | "sel" | "" → string */
  function extract(root, spec) {
    if (!spec) return '';
    const at = spec.lastIndexOf('@');
    if (at === 0) return (root.getAttribute(spec.slice(1)) || '').trim();
    if (at > 0 && !/["')]/.test(spec.slice(at))) {
      const el = qs(root, spec.slice(0, at).trim());
      return (el?.getAttribute(spec.slice(at + 1).trim()) || '').trim();
    }
    const el = qs(root, spec);
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Same man must get the same ID in search and inbox: "/profile/123456", "/chat/123456?x" and "123456" → "123456". */
  const normId = (v) => {
    const raw = String(v || '').trim();
    const m = raw.match(/\d{5,}/);
    return m ? m[0] : raw;
  };

  const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  async function waitFor(fn, timeout = 8000, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const selfMatch = (el, sel) => { try { return el.matches(sel); } catch { return false; } };

  /** Link to his profile from the card: one that contains his ID, else the first real link. */
  function cardLink(card, id) {
    const links = [...(card.matches('a[href]') ? [card] : []), ...card.querySelectorAll('a[href]')]
      .filter((a) => /^https?:/i.test(a.href));
    const withId = id && links.find((a) => a.href.includes(id));
    return (withId || links[0])?.href || '';
  }

  function cardsOf(site) {
    const marks = Array.isArray(site.marks) ? site.marks : [];
    return qsa(document, site.card).map((card) => {
      const ageText = extract(card, site.cardAge);
      const age = Number.parseInt((ageText.match(/\d{2}/) || [])[0], 10);
      const id = normId(extract(card, site.cardId));
      return {
        el: card,
        id,
        name: extract(card, site.cardName),
        age: Number.isFinite(age) ? age : null,
        country: extract(card, site.cardCountry),
        url: cardLink(card, id),
        marks: marks.filter((mk) => qs(card, mk.sel) || selfMatch(card, mk.sel)).map((mk) => mk.key),
        info: (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300), // what his card says: for ranking
      };
    }).filter((c) => c.id);
  }

  // ---------- acting like a person ----------
  /** Scrolls to the element, moves the "mouse" over it and clicks. */
  async function humanClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(350, 800));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * rand(0.3, 0.7);
    const y = r.top + r.height * rand(0.3, 0.7);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
    }
    await sleep(rand(80, 260));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(rand(40, 140));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function nativeSet(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(input, value) : (input.value = value);
  }

  function setInputValue(input, text) {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = '';
      document.execCommand('insertText', false, text);
      if (input.textContent.trim() !== text.trim()) input.textContent = text;
    } else {
      nativeSet(input, text);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const valueOf = (input) => (input.isContentEditable ? input.textContent : input.value) || '';

  /** Types the text letter by letter with an uneven rhythm (≈ 20–25 s for a long message). */
  /** cpm: characters per minute the operator set; a long text never takes much more than ~25 s. */
  async function typeText(input, text, cpm = 600) {
    input.focus();
    if (input.isContentEditable) input.textContent = '';
    else nativeSet(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const base = Math.min(60000 / Math.max(60, cpm), 25000 / Math.max(1, text.length));
    for (const ch of text) {
      if (window.__agencyBotStop) return false; // Stop pressed: leave it, nothing is sent
      const key = { key: ch, bubbles: true };
      input.dispatchEvent(new KeyboardEvent('keydown', key));
      if (input.isContentEditable) document.execCommand('insertText', false, ch);
      else nativeSet(input, input.value + ch);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      input.dispatchEvent(new KeyboardEvent('keyup', key));
      let d = base * rand(0.4, 1.6);
      if (/[.!?,]/.test(ch) && Math.random() < 0.6) d += rand(150, 450);
      else if (ch === ' ' && Math.random() < 0.08) d += rand(200, 700);
      await sleep(d);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (norm(valueOf(input)) !== norm(text)) setInputValue(input, text); // the site's editor fought back
    return true;
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function pressEscape() {
    const t = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) t.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }

  /** Test mode: outline an element and show a short label next to it. */
  function flash(el, label) {
    if (!el) return;
    const prev = [el.style.outline, el.style.outlineOffset];
    el.style.outline = '3px solid #d6336c';
    el.style.outlineOffset = '2px';
    let tag;
    if (label) {
      const r = el.getBoundingClientRect();
      tag = document.createElement('div');
      tag.textContent = label;
      Object.assign(tag.style, {
        position: 'fixed', zIndex: 2147483647, left: `${Math.max(4, r.left)}px`, top: `${Math.max(4, r.top - 30)}px`,
        background: '#d6336c', color: '#fff', font: '600 12px/1.4 system-ui, sans-serif', padding: '4px 8px', borderRadius: '6px', pointerEvents: 'none',
      });
      document.documentElement.append(tag);
    }
    setTimeout(() => { [el.style.outline, el.style.outlineOffset] = prev; tag?.remove(); }, 2500);
  }

  // ---------- steps ----------
  /** Click "Write" in the man's card. It may open a box here or go to his profile/chat page. */
  async function open({ site, man, dry }) {
    const card = cardsOf(site).find((c) => c.id === man.id);
    if (!card) return { ok: false, error: 'картку чоловіка не знайдено на сторінці' };
    card.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(rand(400, 900));
    if (dry) { flash(card.el, '🧪 тест: цей чоловік'); await sleep(900); }
    if (!site.openChat) return { ok: true };
    // "@self": the card itself opens his chat (chat lists of operator desks)
    const btn = site.openChat === '@self' ? card.el : qs(card.el, site.openChat) || (selfMatch(card.el, site.openChat) ? card.el : null);
    if (!btn) return { ok: false, error: 'кнопку «Написати» не знайдено' };
    const link = btn.closest('a[target]');
    if (link) link.removeAttribute('target'); // keep the bot in the same tab
    await humanClick(btn);
    return { ok: true };
  }

  /** On his profile/chat page: press "Write" if there is one (otherwise the box is already here). */
  async function openPage({ site, dry }) {
    await sleep(rand(600, 1400));
    const sel = site.pageOpenChat || site.openChat;
    const input = qsa(document, site.messageInput).find(visible);
    if (input || !sel) return { ok: true, clicked: false };
    const btn = qsa(document, sel).find(visible);
    if (!btn) return { ok: true, clicked: false };
    if (dry) flash(btn, '🧪 «Написати»');
    btn.closest('a[target]')?.removeAttribute('target');
    await humanClick(btn);
    return { ok: true, clicked: true };
  }

  /** Paste/type the text into the message box (no sending yet). think: [from, to] s before typing; cpm: typing speed. */
  async function fill({ site, man, dry, typing, think = [0.3, 0.8], cpm = 600 }) {
    const input = await waitFor(() => qsa(document, site.messageInput).find(visible));
    if (!input) return { ok: false, error: 'поле вводу не з’явилось' };
    await sleep(dry ? rand(300, 800) : rand(think[0], think[1]) * 1000);
    if (!man.text) return { ok: true, empty: true }; // a message with files only
    if (typing && !dry) {
      if ((await typeText(input, man.text, cpm)) === false) { setInputValue(input, ''); return { ok: false, error: 'зупинено' }; }
    }
    else setInputValue(input, man.text);
    await sleep(rand(300, 900));
    if (!valueOf(input).trim()) return { ok: false, error: 'не вдалося вставити текст' };
    if (dry) { flash(input, '🧪 текст вставлено'); await sleep(1200); }
    return { ok: true };
  }

  /** Press "Send" (or Enter) and wait for the site to confirm. Test mode: only shows the button and wipes the text. */
  async function submit({ site, dry }) {
    const input = qsa(document, site.messageInput).find(visible);
    if (window.__agencyBotStop && !dry) { if (input) setInputValue(input, ''); return { ok: false, error: 'зупинено' }; }
    if (dry) {
      const btn = site.sendButton ? await waitFor(() => qsa(document, site.sendButton).find((b) => visible(b) && !b.disabled), 4000) : null;
      if (input) setInputValue(input, '');
      if (input?.isContentEditable) input.textContent = '';
      if (site.sendButton && !btn) return { ok: false, error: 'кнопка «Надіслати» недоступна' };
      if (btn) { flash(btn, '🧪 тут бот натиснув би «Надіслати»'); await sleep(1800); }
      if (site.closeChat) qsa(document, site.closeChat).find(visible)?.click();
      await sleep(300);
      return { ok: true, dry: true };
    }

    const prevConfirm = new Set(qsa(document, site.sentConfirm));
    if (site.sendButton) {
      const btn = await waitFor(() => qsa(document, site.sendButton).find((b) => visible(b) && !b.disabled), 6000);
      if (!btn) return { ok: false, error: 'кнопка «Надіслати» недоступна' };
      await humanClick(btn);
    } else if (input) {
      pressEnter(input);
    } else {
      return { ok: false, error: 'поле вводу зникло' };
    }

    let result;
    if (site.sentConfirm || site.sendError) {
      result = await waitFor(() => {
        const err = qsa(document, site.sendError).find(visible);
        if (err) return { ok: false, error: `сайт: ${(err.textContent || 'помилка').trim().slice(0, 120)}` };
        const okEl = qsa(document, site.sentConfirm).find((e) => visible(e) && !prevConfirm.has(e));
        if (okEl) return { ok: true };
        return null;
      }, 12000);
      if (!result) result = site.sentConfirm ? { ok: false, error: 'не дочекались підтвердження відправки' } : { ok: true };
    } else {
      await sleep(1500);
      result = { ok: true };
    }

    if (site.closeChat) {
      await sleep(rand(300, 900));
      const close = qsa(document, site.closeChat).find(visible);
      if (close) await humanClick(close);
    }
    await sleep(300);
    return result;
  }

  async function compose(p) {
    const f = await fill(p);
    return f.ok ? submit(p) : f;
  }

  // ---------- attachments (the file itself is put in by the page-world helper in background.js) ----------
  const attachedCount = ({ site }) => qsa(document, site.attachDone).filter(visible).length;

  async function waitAttached({ site, before = 0, timeout = 20000 }) {
    const ok = await waitFor(() => attachedCount({ site }) > before, timeout, 250);
    return { ok: Boolean(ok) };
  }

  /** Test mode: is there somewhere to attach a file? */
  async function attachCheck({ site }) {
    const btn = qsa(document, site.attachButton).find(visible);
    if (btn) { flash(btn, '🧪 сюди бот прикріпив би файл'); await sleep(1500); return { ok: true }; }
    if (qsa(document, site.fileInput || 'input[type=file]').length) return { ok: true };
    return { ok: false, error: 'не знайшов кнопку «Прикріпити файл» — навчіть її (🎯 → Відправка)' };
  }

  async function send(p) {
    const o = await open(p);
    return o.ok ? compose(p) : o;
  }

  /**
   * Click a taught button (like, wink, favourites…).
   * ctx 'card' — inside his card on the search list; ctx 'page' — anywhere visible on his page.
   */
  async function clickAction({ site, man, sel, name, ctx, dry }) {
    let el = null;
    if (ctx === 'card') {
      const card = cardsOf(site).find((c) => c.id === man.id);
      if (!card) return { ok: false, missing: true, error: 'картку чоловіка не знайдено' };
      el = qsa(card.el, sel).find(visible) || null;
    } else {
      el = qsa(document, sel).find(visible) || null;
    }
    if (!el) return { ok: false, missing: true, error: `кнопку «${name}» не знайдено` };
    if (dry) {
      el.scrollIntoView({ block: 'center' });
      flash(el, `🧪 тут бот натиснув би «${name}»`);
      await sleep(1500);
      return { ok: true, dry: true };
    }
    el.closest('a[target]')?.removeAttribute('target');
    await humanClick(el);
    await sleep(rand(500, 1200));
    return { ok: true };
  }

  // ---------- operator desks: one page with a chat list, the open chat and the site's "write him" hints ----------
  const firstName = (s) => norm(String(s || '').split(',')[0]).split(' ')[0];
  const DIGITS = /\d{5,}/;

  /** Who is in the open chat (its header). */
  function chatHeader({ site }) {
    const name = site.chatName ? (qsa(document, site.chatName).find(visible)?.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const idText = site.chatId ? (qsa(document, site.chatId).find(visible)?.textContent || '') : '';
    const place = site.chatPlace ? (qsa(document, site.chatPlace).find(visible)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return { name, id: (idText.match(DIGITS) || [''])[0], place };
  }

  /** Safety: is the open chat really his? (by ID when both are known, else by first name) */
  function chatIs({ site, name, id }) {
    if (!site.chatName && !site.chatId) return { ok: true, unknown: true };
    const h = chatHeader({ site });
    if (id && h.id) return { ok: h.id === String(id), ...h };
    if (name && h.name) return { ok: norm(h.name).includes(firstName(name)), ...h };
    return { ok: Boolean(h.name || h.id), ...h };
  }

  async function waitChat({ site, name, id }, timeout = 8000) {
    if (!site.chatName && !site.chatId) { await sleep(rand(600, 1200)); return { ok: true, unknown: true }; }
    const r = await waitFor(() => { const c = chatIs({ site, name, id }); return c.ok && (c.name || c.id) ? c : null; }, timeout, 200);
    return r || { ok: false, ...chatHeader({ site }) };
  }

  /** The site's hints "Please write him letter / message". */
  function tasks({ site }) {
    return qsa(document, site.taskItem).filter(visible).map((el, index) => {
      const all = (el.textContent || '').replace(/\s+/g, ' ').trim();
      // "Gene, 65" — taught, or found in the hint's own text
      const nameText = extract(el, site.taskName) || (all.match(/[^\s,][^,]{0,40}?,\s*\d{2}\b/) || [''])[0];
      const text = extract(el, site.taskText) || all;
      const age = Number.parseInt((nameText.match(/\b(1[89]|[2-9]\d)\b/) || [])[0], 10);
      return {
        index, name: nameText.split(',')[0].trim(), age: Number.isFinite(age) ? age : null,
        id: site.taskId ? normId(extract(el, site.taskId)) : '',
        via: /letter|лист|письм/i.test(text) ? 'letter' : 'chat', text: text.slice(0, 120),
      };
    }).filter((t) => t.name || t.id);
  }

  /** Opens the hinted man's chat and tells who opened (his ID from the header if the hint had none). */
  async function openTask({ site, task, dry }) {
    const el = qsa(document, site.taskItem).filter(visible).find((x, i) => i === task.index && (!task.name || norm(x.textContent).includes(norm(task.name))))
      || qsa(document, site.taskItem).filter(visible).find((x) => task.name && norm(x.textContent).includes(norm(task.name)));
    if (!el) return { ok: false, error: 'підказка зникла' };
    const target = site.taskOpen && site.taskOpen !== '@self' ? qs(el, site.taskOpen) || el : el;
    if (dry) flash(el, '🧪 підказка сайту');
    await humanClick(target);
    const c = await waitChat({ site, name: task.name, id: task.id });
    if (!c.ok) return { ok: false, wrongChat: true, error: `відкрився чат іншого чоловіка (${c.name || c.id || 'невідомо'}) — не пишу` };
    return { ok: true, id: task.id || c.id || '', name: task.name || firstName(c.name) };
  }

  // ---------- the night shift: «Шанс» (men to write to first) and «Усі чати» (running dialogs) ----------
  const has = (el, sel) => Boolean(sel && (selfMatch(el, sel) || qs(el, sel)));

  /** Opens a tab of the site («Шанс» / «Усі чати») and waits for its list. */
  const isActive = (el) => [...el.classList].some((c) => /^active|[-_]active/i.test(c)) || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'page';
  async function openTab({ site, kind }) {
    const item = site[`${kind}Item`];
    const tab = site[`${kind}Tab`] ? qsa(document, site[`${kind}Tab`]).find(visible) : null;
    // «Шанс» and «Усі чати» may show the same kind of rows: then only an active tab says which list is on the screen
    const shared = site.chanceItem && site.chanceItem === site.allchatItem;
    const seen = qsa(document, item).some(visible);
    if (tab && (shared ? !isActive(tab) || !seen : !seen)) {
      const before = qsa(document, item).filter(visible)[0];
      await humanClick(tab);
      await sleep(rand(600, 1200));
      if (shared) await waitFor(() => isActive(qsa(document, site[`${kind}Tab`]).find(visible) || tab) && qsa(document, item).filter(visible)[0] !== before, 6000, 200);
    }
    const ok = await waitFor(() => qsa(document, item).some(visible), 8000, 200);
    return ok ? { ok: true } : { ok: false, error: `список «${kind === 'chance' ? 'Шанс' : 'Усі чати'}» не видно` };
  }

  /** The men of a tab: name, age, ID if shown, online (chance), who wrote last and unread (dialogs). */
  function listItems({ site, kind }) {
    return qsa(document, site[`${kind}Item`]).filter(visible).slice(0, 200).map((el, index) => {
      const all = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const nameText = extract(el, site[`${kind}Name`]) || (all.match(/[^\s,][^,]{0,40}?,\s*\d{2}\b/) || [''])[0];
      const age = Number.parseInt((nameText.match(/\b(1[89]|[2-9]\d)\b/) || [])[0], 10);
      const out = { index, name: nameText.split(',')[0].trim(), age: Number.isFinite(age) ? age : null, id: site[`${kind}Id`] ? normId(extract(el, site[`${kind}Id`])) : '' };
      if (site.listHerId) out.her = normId(extract(el, site.listHerId)); // the chats of all her women in one list: whose row
      if (kind === 'chance') out.online = site.chanceOnline ? has(el, site.chanceOnline) : null;
      if (kind === 'allchat') {
        out.unread = site.allchatUnread ? has(el, site.allchatUnread) : false;
        out.mine = site.allchatMine ? has(el, site.allchatMine) : null;
      }
      return out;
    }).filter((x) => x.name || x.id);
  }

  /** «Load more» under the list until there are more rows than «until» (a few clicks at most). */
  async function listMore({ site, kind, until = 0, max = 4 }) {
    const count = () => qsa(document, site[`${kind}Item`]).filter(visible).length;
    for (let i = 0; i < max && count() <= until; i++) {
      const btn = qsa(document, site.listMore).find(visible);
      if (!btn) break;
      const n = count();
      await humanClick(btn);
      await waitFor(() => count() > n, 6000, 250);
      await sleep(rand(400, 900));
    }
    return { ok: count() > until, count: count() };
  }

  /** Opens one man of a tab (found again by place and name — lists move) and tells who opened (ID from the chat header). */
  async function openItem({ site, kind, item, dry }) {
    let list = qsa(document, site[`${kind}Item`]).filter(visible);
    const named = (x) => !item.name || norm(x.textContent).includes(norm(item.name));
    // a row from a «Load more» page is gone after the list was opened again: load it again
    if (item.index >= list.length && site.listMore) { await listMore({ site, kind, until: item.index }); list = qsa(document, site[`${kind}Item`]).filter(visible); }
    const el = (list[item.index] && named(list[item.index]) ? list[item.index] : null) || list.find(named);
    if (!el) return { ok: false, error: 'його вже немає в списку' };
    if (dry) flash(el, '🧪 відкриваю');
    await humanClick(el);
    const c = await waitChat({ site, name: item.name, id: item.id });
    if (!c.ok) return { ok: false, wrongChat: true, error: `відкрився чат іншого чоловіка (${c.name || c.id || 'невідомо'}) — не пишу` };
    return { ok: true, id: item.id || c.id || '', name: item.name || firstName(c.name), place: c.place || chatHeader({ site }).place || '' };
  }

  /** The last messages of the open chat (oldest first): whose and what — to write on the topic of the talk. */
  function history({ site, limit = 12 }) {
    if (!site.msgItem) return [];
    return qsa(document, site.msgItem).filter(visible).slice(-limit).map((el) => ({
      mine: has(el, site.msgMine), text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    })).filter((m) => m.text);
  }

  /** No page of his own: type his ID into the site's search and open his chat. */
  async function findMan({ site, id, name }) {
    const input = qsa(document, site.findInput).find(visible);
    if (!input) return { ok: false, error: 'поле пошуку за ID не знайдено' };
    input.focus();
    setInputValue(input, '');
    await sleep(rand(200, 500));
    setInputValue(input, String(id));
    pressEnter(input);
    const pick = site.findResult || site.inboxItem || site.card;
    const item = await waitFor(() => qsa(document, pick).find(visible), 6000, 200);
    if (!item) return { ok: false, error: `за ID ${id} нікого не знайдено` };
    await sleep(rand(400, 900));
    await humanClick(item);
    const c = await waitChat({ site, name, id });
    if (!c.ok) return { ok: false, wrongChat: true, error: `за ID ${id} відкрився чужий чат — не пишу` };
    return { ok: true };
  }

  // ---------- several women on one desk: which one is working now, switch to another ----------
  const textOf = (sel) => (sel ? (qsa(document, sel).find(visible)?.textContent || '') : '').replace(/\s+/g, ' ').trim();
  /** Does this text name her? An ID on the page must be hers; with no ID there, her first name must be. */
  function namesHer(text, id, name) {
    const t = norm(text);
    if (!t) return false;
    const ids = t.match(/\d{5,}/g) || [];
    if (id && ids.length) return ids.includes(String(id));
    return Boolean(name && t.includes(firstName(name)));
  }
  /** Is the site working as her right now (the taught "which profile" element)? */
  function herIs({ site, id, name }) {
    const now = textOf(site.herCurrent);
    return { ok: namesHer(now, id, name), now };
  }
  /** The open chat is written as her (the woman's side of the chat header)? */
  function chatHerIs({ site, id, name }) {
    const now = textOf(site.chatHer);
    return { ok: !site.chatHer || namesHer(now, id, name), now };
  }
  /** Switches the site to her: opens the list of women if needed, clicks her row, waits until the site shows her. */
  async function herPick({ site, id, name }) {
    if (site.herCurrent && herIs({ site, id, name }).ok) return { ok: true, already: true };
    let rows = qsa(document, site.herItem).filter(visible);
    if (!rows.length && site.herSwitch) {
      const sw = qsa(document, site.herSwitch).find(visible);
      if (!sw) return { ok: false, error: 'перемикач анкет не знайдено' };
      await humanClick(sw);
      rows = (await waitFor(() => { const l = qsa(document, site.herItem).filter(visible); return l.length ? l : null; }, 6000, 200)) || [];
    }
    if (!rows.length) return { ok: false, error: 'список анкет на сайті не знайдено' };
    const row = rows.find((el) => {
      const rid = site.herItemId ? normId(extract(el, site.herItemId)) : ((el.textContent || '').match(/\d{5,}/) || [''])[0];
      if (id && rid) return rid === String(id);
      return namesHer(site.herItemName ? extract(el, site.herItemName) : el.textContent, '', name);
    });
    if (!row) return { ok: false, error: `анкети ${name || id} немає в списку сайту` };
    await sleep(rand(400, 900));
    await humanClick(row);
    if (!site.herCurrent) { await sleep(rand(1500, 2500)); return { ok: true }; }
    const done = await waitFor(() => herIs({ site, id, name }).ok, 10000, 250);
    return done ? { ok: true } : { ok: false, error: `сайт не перемкнув на ${name || id} (зараз: ${textOf(site.herCurrent) || '—'})` };
  }

  /** "Kate, 29 · ID 5000000001" → { id, name, age } (whatever of it the text has). */
  function parseHer(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const id = (t.match(/\d{5,}/) || [''])[0];
    const rest = t.replace(/\b(?:ID|id)\b[:\s#№]*\d{5,}/g, ' ').replace(/\d{5,}/g, ' ');
    const name = (rest.split(/[,·|•(\-–—\d]/)[0] || '').trim().slice(0, 60);
    const age = Number((rest.match(/\b(1[89]|[2-9]\d)\b/) || [])[1]) || null;
    return { id, name, age };
  }
  /** All the women of this operator on the site (the list of the switcher), and the one working now. Clicks only to open / close the list. */
  async function herList({ site }) {
    const current = site.herCurrent && textOf(site.herCurrent) ? parseHer(textOf(site.herCurrent)) : null;
    if (!site.herItem && site.listHerId) {
      // the women are seen in the rows of the chat list (her name and ID in each)
      const hers = [];
      for (const el of qsa(document, [site.allchatItem, site.chanceItem].filter(Boolean).join(', '))) {
        const id = normId(extract(el, site.listHerId));
        const p = parseHer(site.listHerName ? extract(el, site.listHerName) : '');
        if (/^\d{5,}$/.test(id) && !hers.some((x) => x.id === id)) hers.push({ id, name: p.name || `ID ${id}`, age: p.age });
      }
      return { hers, current };
    }
    if (!site.herItem) return { hers: current ? [current] : [], current };
    let rows = qsa(document, site.herItem).filter(visible);
    let opened = false;
    if (!rows.length && site.herSwitch) {
      const sw = qsa(document, site.herSwitch).find(visible);
      if (sw) {
        await humanClick(sw);
        opened = true;
        rows = (await waitFor(() => { const l = qsa(document, site.herItem).filter(visible); return l.length ? l : null; }, 6000, 200)) || [];
      }
    }
    const hers = [];
    for (const el of rows) {
      const p = parseHer(el.textContent);
      const id = site.herItemId ? normId(extract(el, site.herItemId)) : p.id;
      const named = site.herItemName ? parseHer(extract(el, site.herItemName)) : p;
      const h = { id: id || '', name: named.name || p.name, age: named.age || p.age };
      if ((h.id || h.name) && !hers.some((x) => (h.id ? x.id === h.id : x.name === h.name))) hers.push(h);
    }
    if (opened) { // close the list again, as a person would
      await sleep(rand(300, 700));
      const sw = qsa(document, site.herSwitch).find(visible);
      if (sw && qsa(document, site.herItem).some(visible)) await humanClick(sw);
    }
    if (!hers.length && current) hers.push(current);
    return { hers, current };
  }

  /** Photos to a letter from her gallery on the site: opens it, picks a few of the first ones, attaches. In a test only looks. */
  async function galleryPick({ site, count = 2, dry }) {
    const btn = qsa(document, site.galleryOpen).find(visible);
    if (!btn) return { ok: false, error: 'кнопку «Додати фото» не знайдено' };
    const before = qsa(document, site.attachDone).filter(visible).length;
    await humanClick(btn);
    const items = (await waitFor(() => { const l = qsa(document, site.galleryItem).filter(visible); return l.length ? l : null; }, 8000, 250)) || [];
    if (!items.length) return { ok: false, error: 'галерея анкети порожня або не відкрилась' };
    const pool = items.slice(0, Math.max(count, 8));
    const picked = [];
    while (picked.length < Math.min(count, pool.length)) { const x = pool[Math.floor(Math.random() * pool.length)]; if (!picked.includes(x)) picked.push(x); }
    if (dry) {
      for (const el of picked) flash(el, '🧪 це фото бот вибрав би');
      await sleep(1500);
      pressEscape();
      await sleep(400);
      const overlay = document.querySelector('.ReactModal__Overlay');
      if (overlay && qsa(document, site.galleryItem).some(visible)) overlay.click();
      return { ok: true, dry: true, picked: picked.length };
    }
    for (const el of picked) {
      await sleep(rand(400, 900));
      await humanClick((site.gallerySelect && qs(el, site.gallerySelect)) || el);
    }
    const ok = qsa(document, site.galleryConfirm).find(visible);
    if (!ok) return { ok: false, error: 'кнопку «Прикріпити» в галереї не знайдено' };
    await sleep(rand(400, 900));
    await humanClick(ok);
    const done = site.attachDone ? await waitFor(() => qsa(document, site.attachDone).filter(visible).length >= before + picked.length, 10000, 250) : true;
    return done ? { ok: true, picked: picked.length } : { ok: false, error: 'фото не прикріпились до листа' };
  }

  /** Between men: scroll the list a bit and look around, like a person (opens nothing, so unread stays unread). */
  async function idle({ site, seconds = 8 }) {
    const list = qsa(document, site.inboxItem || site.card || site.taskItem).filter(visible);
    const box = list[0]?.parentElement;
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (box && box.scrollHeight > box.clientHeight) box.scrollBy({ top: rand(-200, 260), behavior: 'smooth' });
      else window.scrollBy({ top: rand(-200, 260), behavior: 'smooth' });
      const it = list[Math.floor(Math.random() * list.length)];
      if (it) for (const type of ['pointerover', 'mouseover', 'mousemove']) it.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      await sleep(rand(900, 2200));
    }
    return { ok: true };
  }

  /** The site's own counter ("Залишилося 9 повідомлень"): the number, or null when there is no counter here. */
  function leftCount({ sel }) {
    const el = qsa(document, sel).find(visible);
    if (!el) return null;
    const m = (el.textContent || '').match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  /** Letter subject (if the form has one). */
  async function fillSubject({ sel, text, dry }) {
    const input = await waitFor(() => qsa(document, sel).find(visible), 4000);
    if (!input) return { ok: false, error: 'поле теми листа не знайдено' };
    setInputValue(input, text);
    if (dry) flash(input, '🧪 тема листа');
    return { ok: true };
  }

  /** Looks through his profile: slow scrolling down and a little back up. */
  async function view({ seconds = 8 }) {
    const end = Date.now() + seconds * 1000;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    while (Date.now() < end) {
      const down = scrollY < max * rand(0.5, 0.9) || Math.random() < 0.75;
      window.scrollBy({ top: (down ? 1 : -1) * rand(120, 420), behavior: 'smooth' });
      await sleep(rand(700, 1800));
    }
    window.scrollTo({ top: rand(0, Math.min(300, max)), behavior: 'smooth' });
    await sleep(500);
    return { ok: true };
  }

  function scan({ site }) {
    const nextEl = qs(document, site.nextPage);
    return {
      url: location.href,
      candidates: cardsOf(site).map(({ el, ...c }) => c),
      hasNext: Boolean(nextEl && visible(nextEl) && !nextEl.disabled && nextEl.getAttribute('aria-disabled') !== 'true'),
    };
  }

  /** Infinite feed: scroll to the last card and wait for new men to load. */
  async function more({ site }) {
    const seen = new Set(cardsOf(site).map((c) => c.id));
    const cards = qsa(document, site.card);
    (cards[cards.length - 1] || document.body).scrollIntoView({ block: 'end' });
    window.scrollBy(0, Math.round(window.innerHeight / 2));
    const grew = await waitFor(() => cardsOf(site).some((c) => !seen.has(c.id)), 6000, 250);
    return { grew: Boolean(grew), count: cardsOf(site).length };
  }

  async function next({ site }) {
    const el = qs(document, site.nextPage);
    if (!el) return { ok: false };
    await humanClick(el);
    return { ok: true, url: location.href };
  }

  async function inbox({ site, her = '' }) {
    await waitFor(() => qsa(document, site.inboxItem).length, 5000);
    // one list for all her women: only the rows of the woman the bot works as now
    const items = qsa(document, site.inboxItem).filter((it) => !her || !site.listHerId || normId(extract(it, site.listHerId)) === String(her));
    const unread = items.filter((it) => !site.inboxUnread || selfMatch(it, site.inboxUnread) || qs(it, site.inboxUnread));
    return {
      total: items.length,
      // No ID in the list (some sites show it only in the open chat): the server matches the dialog by his name.
      men: unread.map((it) => ({ id: normId(extract(it, site.inboxId)), name: extract(it, site.inboxName), text: site.inboxText ? extract(it, site.inboxText) : '' })).filter((m) => m.id || m.name),
    };
  }

  /**
   * Captcha, "too many requests" or a login form instead of the site: the bot must stop and call a person.
   * Only looks — never touches the captcha.
   */
  const CAPTCHA_FRAME = /recaptcha|hcaptcha|captcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;
  const HUMAN_CHECK = /verify (that )?you are (a )?human|i'?m not a robot|are you a robot|підтвердіть,? що ви не робот|подтвердите,? что вы не робот|unusual (traffic|activity)|подозрительн\S* активност/i;
  const RATE = /too many requests|rate limit(ed)?\b|занадто багато запитів|слишком много запросов/i;
  /** Really on the screen: has a size, not hidden by CSS (visibility / opacity), not the invisible reCAPTCHA badge every page has. */
  const BADGE = '.grecaptcha-badge, .grecaptcha-logo, .grecaptcha-error, textarea.g-recaptcha-response';
  const shown = (el) => visible(el) && !el.closest(BADGE)
    && (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).visibility !== 'hidden')
    && el.getBoundingClientRect().width >= 60 && el.getBoundingClientRect().height >= 40;
  function blocked({ site } = {}) {
    if ([...document.querySelectorAll('iframe')].some((f) => CAPTCHA_FRAME.test(f.src || '') && !/[?&]size=invisible\b/.test(f.src || '') && shown(f))) return { kind: 'captcha', text: 'Сайт показав капчу' };
    const box = [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i], [id*="captcha" i]')].filter((el) => !el.matches(BADGE)).find(shown);
    if (box) return { kind: 'captcha', text: 'Сайт показав капчу' };
    const text = (document.body?.innerText || '').slice(0, 4000);
    if (HUMAN_CHECK.test(text)) return { kind: 'captcha', text: 'Сайт просить підтвердити, що ви людина' };
    if (RATE.test(text)) return { kind: 'rate', text: 'Сайт каже «забагато запитів»' };
    const pass = [...document.querySelectorAll('input[type=password]')].find(visible);
    if (pass && site?.card && !qsa(document, site.card).length && !qsa(document, site.messageInput).find(visible)) {
      return { kind: 'login', text: 'Схоже, сайт розлогінив анкету' };
    }
    return null;
  }

  /** Quick check of the adapter on the current page (used by the popup "Перевірити сторінку"). */
  function probe({ site }) {
    const cards = cardsOf(site);
    return {
      url: location.href,
      cards: cards.length,
      sample: cards.slice(0, 3).map(({ el, ...c }) => c),
      nextPage: Boolean(qs(document, site.nextPage)),
      inboxItems: qsa(document, site.inboxItem).length,
      messageInput: Boolean(qsa(document, site.messageInput).find(visible)),
    };
  }

  window.__agencyBot = {
    scan, open, openPage, fill, submit, compose, send, clickAction, view, next, more, inbox, probe, blocked, leftCount, fillSubject,
    chatHeader, chatIs, waitChat, tasks, openTask, findMan, idle, herIs, chatHerIs, herPick, herList, galleryPick, listMore, openTab, listItems, openItem, history,
    attachedCount, waitAttached, attachCheck,
    util: { qs, qsa, extract, normId, cardsOf, visible, flash, splitTop },
  };
})();
