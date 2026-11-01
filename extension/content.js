// Injected into the dating-site tab. Only reads the page and clicks/fills what the site adapter points to.
(() => {
  if (window.__agencyBot) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const qs = (root, sel) => { try { return sel ? root.querySelector(sel) : null; } catch { return null; } };
  const qsa = (root, sel) => { try { return sel ? [...root.querySelectorAll(sel)] : []; } catch { return []; } };

  /** "@attr" | "sel@attr" | "sel" | "" → string */
  function extract(root, spec) {
    if (!spec) return '';
    const at = spec.lastIndexOf('@');
    if (at === 0) return (root.getAttribute(spec.slice(1)) || '').trim();
    if (at > 0) {
      const el = qs(root, spec.slice(0, at).trim());
      return (el?.getAttribute(spec.slice(at + 1).trim()) || '').trim();
    }
    const el = qs(root, spec);
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

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

  function cardsOf(site) {
    return qsa(document, site.card).map((card) => {
      const ageText = extract(card, site.cardAge);
      const age = Number.parseInt((ageText.match(/\d{2}/) || [])[0], 10);
      return {
        el: card,
        id: extract(card, site.cardId),
        name: extract(card, site.cardName),
        age: Number.isFinite(age) ? age : null,
        country: extract(card, site.cardCountry),
      };
    }).filter((c) => c.id);
  }

  function setInputValue(input, text) {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = '';
      document.execCommand('insertText', false, text);
      if (input.textContent.trim() !== text.trim()) input.textContent = text;
    } else {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(input, text) : (input.value = text);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const valueOf = (input) => (input.isContentEditable ? input.textContent : input.value) || '';

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  async function send({ site, man }) {
    const card = cardsOf(site).find((c) => c.id === man.id);
    if (!card) return { ok: false, error: 'картку чоловіка не знайдено на сторінці' };
    card.el.scrollIntoView({ block: 'center' });
    await sleep(300);

    if (site.openChat) {
      const btn = qs(card.el, site.openChat) || (card.el.matches(site.openChat) ? card.el : null);
      if (!btn) return { ok: false, error: 'кнопку «Написати» не знайдено' };
      btn.click();
    }
    const input = await waitFor(() => qsa(document, site.messageInput).find(visible));
    if (!input) return { ok: false, error: 'поле вводу не з’явилось' };
    await sleep(400);
    setInputValue(input, man.text);
    await sleep(300);
    if (!valueOf(input).trim()) return { ok: false, error: 'не вдалося вставити текст' };

    const prevConfirm = new Set(qsa(document, site.sentConfirm));
    if (site.sendButton) {
      const btn = await waitFor(() => qsa(document, site.sendButton).find((b) => visible(b) && !b.disabled), 4000);
      if (!btn) return { ok: false, error: 'кнопка «Надіслати» недоступна' };
      btn.click();
    } else {
      pressEnter(input);
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
      await sleep(300);
      qsa(document, site.closeChat).find(visible)?.click();
    }
    await sleep(300);
    return result;
  }

  function scan({ site }) {
    const nextEl = qs(document, site.nextPage);
    return {
      url: location.href,
      candidates: cardsOf(site).map(({ el, ...c }) => c),
      hasNext: Boolean(nextEl && visible(nextEl) && !nextEl.disabled && nextEl.getAttribute('aria-disabled') !== 'true'),
    };
  }

  function next({ site }) {
    const el = qs(document, site.nextPage);
    if (!el) return { ok: false };
    el.click();
    return { ok: true, url: location.href };
  }

  async function inbox({ site }) {
    await waitFor(() => qsa(document, site.inboxItem).length, 5000);
    const items = qsa(document, site.inboxItem);
    const unread = items.filter((it) => !site.inboxUnread || it.matches(site.inboxUnread) || qs(it, site.inboxUnread));
    return {
      total: items.length,
      men: unread.map((it) => ({ id: extract(it, site.inboxId), name: extract(it, site.inboxName) })).filter((m) => m.id),
    };
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
    };
  }

  window.__agencyBot = { scan, send, next, inbox, probe };
})();
