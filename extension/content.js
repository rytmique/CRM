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
  async function typeText(input, text) {
    input.focus();
    if (input.isContentEditable) input.textContent = '';
    else nativeSet(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const base = Math.min(110, 22000 / Math.max(1, text.length));
    for (const ch of text) {
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
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
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
    const btn = qs(card.el, site.openChat) || (selfMatch(card.el, site.openChat) ? card.el : null);
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

  /** Paste/type the text into the message box (no sending yet). */
  async function fill({ site, man, dry, typing }) {
    const input = await waitFor(() => qsa(document, site.messageInput).find(visible));
    if (!input) return { ok: false, error: 'поле вводу не з’явилось' };
    await sleep(rand(300, 800));
    if (!man.text) return { ok: true, empty: true }; // a message with files only
    if (typing && !dry) await typeText(input, man.text);
    else setInputValue(input, man.text);
    await sleep(rand(300, 900));
    if (!valueOf(input).trim()) return { ok: false, error: 'не вдалося вставити текст' };
    if (dry) { flash(input, '🧪 текст вставлено'); await sleep(1200); }
    return { ok: true };
  }

  /** Press "Send" (or Enter) and wait for the site to confirm. Test mode: only shows the button and wipes the text. */
  async function submit({ site, dry }) {
    const input = qsa(document, site.messageInput).find(visible);
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

  async function inbox({ site }) {
    await waitFor(() => qsa(document, site.inboxItem).length, 5000);
    const items = qsa(document, site.inboxItem);
    const unread = items.filter((it) => !site.inboxUnread || selfMatch(it, site.inboxUnread) || qs(it, site.inboxUnread));
    return {
      total: items.length,
      men: unread.map((it) => ({ id: normId(extract(it, site.inboxId)), name: extract(it, site.inboxName), text: site.inboxText ? extract(it, site.inboxText) : '' })).filter((m) => m.id),
    };
  }

  /**
   * Captcha, "too many requests" or a login form instead of the site: the bot must stop and call a person.
   * Only looks — never touches the captcha.
   */
  const CAPTCHA_FRAME = /recaptcha|hcaptcha|captcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;
  const HUMAN_CHECK = /verify (that )?you are (a )?human|i'?m not a robot|are you a robot|підтвердіть,? що ви не робот|подтвердите,? что вы не робот|unusual (traffic|activity)|подозрительн\S* активност/i;
  const RATE = /too many requests|rate limit(ed)?\b|занадто багато запитів|слишком много запросов/i;
  function blocked({ site } = {}) {
    if ([...document.querySelectorAll('iframe')].some((f) => CAPTCHA_FRAME.test(f.src || '') && visible(f))) return { kind: 'captcha', text: 'Сайт показав капчу' };
    const box = [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i], [id*="captcha" i]')].find(visible);
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
    scan, open, openPage, fill, submit, compose, send, clickAction, view, next, more, inbox, probe, blocked,
    attachedCount, waitAttached, attachCheck,
    util: { qs, qsa, extract, normId, cardsOf, visible, flash, splitTop },
  };
})();
