// Demo dating site: fake men, a write-message modal and an inbox with simulated replies.
// Everything lives in localStorage so the extension can be tested end to end.
const FIRST = ['Michael', 'David', 'James', 'Robert', 'John', 'William', 'Richard', 'Thomas', 'Mark', 'Steven', 'Paul', 'Andrew', 'Kevin', 'Brian', 'George', 'Edward'];
const COUNTRIES = ['USA', 'Canada', 'UK', 'Australia', 'Germany', 'Ireland', 'New Zealand', 'Netherlands'];
const PER_PAGE = 8;
const PAGES = 4;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function man(i) {
  const h = hash('man' + i);
  const nickname = h % 7 === 0;
  const first = FIRST[h % FIRST.length];
  return {
    id: String(100000 + i * 37),
    name: nickname ? `${first.toLowerCase()}_${1960 + (h % 30)}` : first,
    age: 30 + (h % 35),
    country: COUNTRIES[(h >> 4) % COUNTRIES.length],
  };
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function renderSearch() {
  const page = Math.min(PAGES, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1));
  const list = document.getElementById('results');
  for (let i = (page - 1) * PER_PAGE; i < page * PER_PAGE; i++) {
    const m = man(i);
    list.append(el('div', { class: 'man-card', 'data-man-id': m.id },
      el('div', { class: 'avatar' }, m.name[0].toUpperCase()),
      el('div', { class: 'info' },
        el('div', { class: 'man-name' }, m.name),
        el('div', { class: 'meta' }, el('span', { class: 'man-age' }, `${m.age} y.o.`), ' · ', el('span', { class: 'man-country' }, m.country))),
      el('button', { class: 'btn-write', type: 'button', onclick: () => openChat(m) }, 'Write')));
  }
  const pager = document.getElementById('pager');
  pager.append(el('span', {}, `Page ${page} / ${PAGES}`));
  if (page < PAGES) pager.append(el('a', { class: 'next-page', href: `search.html?page=${page + 1}` }, 'Next →'));
}

function openChat(m) {
  const modal = document.getElementById('chat-modal');
  modal.querySelector('.to').textContent = m.name;
  modal.querySelector('textarea').value = '';
  modal.querySelector('.status').innerHTML = '';
  modal.dataset.manId = m.id;
  modal.hidden = false;
  modal.querySelector('textarea').focus();
}

function initModal() {
  const modal = document.getElementById('chat-modal');
  modal.querySelector('.btn-close').addEventListener('click', () => { modal.hidden = true; });
  modal.querySelector('.btn-send').addEventListener('click', () => {
    const text = modal.querySelector('textarea').value.trim();
    const status = modal.querySelector('.status');
    if (!text) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
    setTimeout(() => {
      const sent = store.get('demo_sent', {});
      sent[modal.dataset.manId] = { text, at: Date.now() };
      store.set('demo_sent', sent);
      status.innerHTML = '<span class="sent-ok">✓ Sent</span>';
    }, 300 + Math.random() * 500);
  });
}

const REPLIES = ['Hi! Thank you for your message, you seem lovely. Tell me more about yourself?', 'Hello :) Nice to hear from you. I love travelling too!', 'Wow, what a nice surprise. How is your day going?'];

function renderInbox() {
  const sent = store.get('demo_sent', {});
  const read = store.get('demo_read', {});
  const list = document.getElementById('dialogs');
  const ids = Object.keys(sent).sort((a, b) => sent[b].at - sent[a].at);
  if (!ids.length) list.append(el('p', { class: 'empty' }, 'No conversations yet.'));
  const all = Array.from({ length: PER_PAGE * PAGES }, (_, i) => man(i));
  for (const id of ids) {
    const m = all.find((x) => x.id === id) || { id, name: id };
    const h = hash('reply' + id);
    const replies = h % 10 < 4 && Date.now() - sent[id].at > 4000 + (h % 8000);
    const unread = replies && !read[id];
    const item = el('div', { class: 'dialog', 'data-man-id': id, id: `man-${id}` },
      el('div', { class: 'avatar' }, m.name[0].toUpperCase()),
      el('div', { class: 'info' },
        el('div', { class: 'dialog-name' }, m.name),
        el('div', { class: 'last' }, replies ? REPLIES[h % REPLIES.length] : `You: ${sent[id].text.slice(0, 70)}…`)),
      unread ? el('span', { class: 'unread' }, 'new') : '');
    item.addEventListener('click', () => { read[id] = true; store.set('demo_read', read); item.querySelector('.unread')?.remove(); });
    list.append(item);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('results')) { renderSearch(); initModal(); }
  if (document.getElementById('dialogs')) renderInbox();
  const reset = document.getElementById('reset');
  reset?.addEventListener('click', () => { localStorage.removeItem('demo_sent'); localStorage.removeItem('demo_read'); location.reload(); });
});
