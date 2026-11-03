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

// Every third man is "online" — a mark the bot can be taught to look for.
const isOnline = (m) => hash('online' + m.id) % 3 === 0;

function likeButton(m) {
  const likes = store.get('demo_likes', {});
  const b = el('button', { class: `btn-like${likes[m.id] ? ' liked' : ''}`, type: 'button' }, likes[m.id] ? '♥ Liked' : '♡ Like');
  b.addEventListener('click', () => {
    const l = store.get('demo_likes', {});
    l[m.id] = (l[m.id] || 0) + 1;
    store.set('demo_likes', l);
    b.classList.add('liked');
    b.textContent = '♥ Liked';
  });
  return b;
}

function card(m) {
  return el('div', { class: 'man-card', 'data-man-id': m.id },
    el('div', { class: 'avatar' }, m.name[0].toUpperCase()),
    el('div', { class: 'info' },
      el('a', { class: 'man-name', href: `profile.html?id=${m.id}` }, m.name),
      isOnline(m) ? el('span', { class: 'online' }, 'online') : '',
      el('div', { class: 'meta' }, el('span', { class: 'man-age' }, `${m.age} y.o.`), ' · ', el('span', { class: 'man-country' }, m.country))),
    el('div', { class: 'actions' },
      likeButton(m),
      el('button', { class: 'btn-write', type: 'button', onclick: () => openChat(m) }, 'Write')));
}

/** Keeps every message: the inbox and the tests look at the first time, the count and the attached files. */
function recordSent(id, text, files = []) {
  const sent = store.get('demo_sent', {});
  const prev = sent[id];
  sent[id] = {
    text, at: Date.now(), first: prev?.first || prev?.at || Date.now(), count: (prev?.count || 0) + 1,
    history: [...(prev?.history || []), text], files: [...(prev?.files || []), ...files],
  };
  store.set('demo_sent', sent);
}

// Attachments: the chat keeps picked files until "Send".
const attached = new WeakMap();
function showFiles(box, files) {
  const list = [...(attached.get(box) || []), ...files];
  attached.set(box, list);
  const atts = box.querySelector('.atts');
  atts.replaceChildren(...list.map((f) => {
    const chip = el('span', { class: 'att-preview' });
    if (f.type.startsWith('image/')) chip.append(el('img', { src: URL.createObjectURL(f), alt: '' }));
    chip.append(f.name);
    return chip;
  }));
}
const takeFiles = (box) => { const l = (attached.get(box) || []).map((f) => f.name); attached.set(box, []); box.querySelector('.atts').replaceChildren(); return l; };

/** Search page chat: the paperclip creates a file input on the fly and clicks it (like many real sites). */
function initAttachDynamic(box) {
  box.querySelector('.btn-attach')?.addEventListener('click', () => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'image/*,video/*';
    i.onchange = () => showFiles(box, [...i.files]);
    i.click();
  });
}

// Infinite feed variant (search.html?feed=1): no pager, more men load when you scroll to the end.
function renderFeed() {
  const list = document.getElementById('results');
  let shown = 0;
  const load = () => { for (const end = Math.min(shown + PER_PAGE, PER_PAGE * PAGES); shown < end; shown++) list.append(card(man(shown))); };
  load();
  const sentinel = el('div', { id: 'sentinel', style: 'height:1px' });
  list.after(sentinel);
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && shown < PER_PAGE * PAGES) setTimeout(load, 600);
  }).observe(sentinel);
}

function renderSearch() {
  if (new URLSearchParams(location.search).get('feed')) return renderFeed();
  const page = Math.min(PAGES, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1));
  const list = document.getElementById('results');
  for (let i = (page - 1) * PER_PAGE; i < page * PER_PAGE; i++) {
    list.append(card(man(i)));
  }
  const pager = document.getElementById('pager');
  pager.append(el('span', {}, `Page ${page} / ${PAGES}`));
  if (page < PAGES) pager.append(el('a', { class: 'next-page', href: `search.html?page=${page + 1}` }, 'Next →'));
}

function openChat(m) {
  const modal = document.getElementById('chat-modal');
  modal.querySelector('.to').textContent = m.name;
  modal.querySelector('textarea').value = '';
  takeFiles(modal.querySelector('.box'));
  modal.querySelector('.status').innerHTML = '';
  modal.dataset.manId = m.id;
  modal.hidden = false;
  modal.querySelector('textarea').focus();
}

function initModal() {
  const modal = document.getElementById('chat-modal');
  modal.querySelector('.btn-close').addEventListener('click', () => { modal.hidden = true; });
  const box = modal.querySelector('.box');
  initAttachDynamic(box);
  modal.querySelector('.btn-send').addEventListener('click', () => {
    const text = modal.querySelector('textarea').value.trim();
    const status = modal.querySelector('.status');
    if (!text && !(attached.get(box) || []).length) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
    const files = takeFiles(box);
    setTimeout(() => {
      recordSent(modal.dataset.manId, text, files);
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
    const replies = h % 10 < 4 && Date.now() - (sent[id].first || sent[id].at) > 4000 + (h % 8000);
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

function renderProfile() {
  const id = new URLSearchParams(location.search).get('id');
  const m = Array.from({ length: PER_PAGE * PAGES }, (_, i) => man(i)).find((x) => x.id === id) || { id, name: 'Unknown', age: '', country: '' };
  document.getElementById('profile').append(el('div', { class: 'man-card profile-head' },
    el('div', { class: 'avatar' }, m.name[0].toUpperCase()),
    el('div', { class: 'info' }, el('div', { class: 'man-name' }, m.name), el('div', { class: 'meta' }, `${m.age} y.o. · ${m.country}`)),
    m.age ? likeButton(m) : ''));
  const about = el('div', { class: 'about' });
  about.style.cssText = 'background:#fff;border-radius:12px;padding:14px 16px;margin-top:12px;min-height:700px;color:#5b4b60';
  about.textContent = 'About me: I like hiking, old movies and good coffee. Looking for a kind woman to share my life with.';
  document.getElementById('profile').append(about);
  const box = document.getElementById('profile-chat');
  // Profile page chat: a <label> with a hidden file input inside (the other common pattern).
  const fileIn = box.querySelector('input[type=file]');
  fileIn.addEventListener('change', () => { showFiles(box, [...fileIn.files]); fileIn.value = ''; });
  box.querySelector('.btn-send').addEventListener('click', () => {
    const text = box.querySelector('textarea').value.trim();
    const status = box.querySelector('.status');
    if (!text && !(attached.get(box) || []).length) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
    const files = takeFiles(box);
    setTimeout(() => {
      recordSent(m.id, text, files);
      box.querySelector('textarea').value = '';
      status.innerHTML = '<span class="sent-ok">✓ Sent</span>';
      setTimeout(() => { status.innerHTML = ''; }, 2500);
    }, 400);
  });
}

/** Demo "captcha": shown while localStorage.demo_captcha is set; the button plays the person who solves it. */
function captcha() {
  if (!store.get('demo_captcha', false)) return;
  const box = el('div', { class: 'captcha-box', id: 'captcha' },
    el('p', 'Please verify you are human'),
    el('button', { class: 'btn-not-robot', onclick: () => { localStorage.removeItem('demo_captcha'); box.remove(); } }, "I'm not a robot"));
  box.style.cssText = 'position:fixed;inset:30% 30% auto;padding:24px;background:#fff;border:2px solid #c2255c;border-radius:12px;z-index:99;text-align:center';
  document.body.append(box);
}

window.addEventListener('DOMContentLoaded', () => {
  captcha();
  if (document.getElementById('profile-chat')) renderProfile();
  if (document.getElementById('results')) { renderSearch(); initModal(); }
  if (document.getElementById('dialogs')) renderInbox();
  const reset = document.getElementById('reset');
  reset?.addEventListener('click', () => { for (const k of ['demo_sent', 'demo_read', 'demo_likes']) localStorage.removeItem(k); location.reload(); });
});
