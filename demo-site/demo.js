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

// Desk with several women (desk.html?women=1): each woman has her own chats, hints and counters.
// The IDs are made up for the demo.
const WOMEN = [
  { id: '5000000001', name: 'Kate', age: 29 },
  { id: '5000000002', name: 'Maria', age: 27 },
  { id: '5000000003', name: 'Olha', age: 35 },
];
let herSuffix = ''; // '' on ordinary pages; '@<her id>' on the women desk
const K = (k) => k + herSuffix;

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

const MSGS_PER_MAN = 10;
const LETTERS_PER_MAN = 3;

/** Keeps every message: the inbox and the tests look at the first time, the count and the attached files. */
function recordSent(id, text, files = [], translated = false) {
  const sent = store.get(K('demo_sent'), {});
  const prev = sent[id];
  sent[id] = {
    text, at: Date.now(), first: prev?.first || prev?.at || Date.now(), count: (prev?.count || 0) + 1,
    history: [...(prev?.history || []), text], files: [...(prev?.files || []), ...files], translated: translated || prev?.translated || false,
  };
  store.set(K('demo_sent'), sent);
}

/** Letters (the site's mail) are kept apart from chat messages. */
function recordLetter(id, subject, text, files = [], translated = false) {
  const all = store.get(K('demo_letters'), {});
  const prev = all[id];
  all[id] = { count: (prev?.count || 0) + 1, at: Date.now(), history: [...(prev?.history || []), { subject, text, files, translated }] };
  store.set(K('demo_letters'), all);
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
  // Like many real sites: a chat and a letter (mail) mode, each with "N left" for this man, and a translate button.
  const left = () => ({
    msgs: Math.max(0, MSGS_PER_MAN - (store.get('demo_sent', {})[m.id]?.count || 0)),
    letters: Math.max(0, LETTERS_PER_MAN - (store.get('demo_letters', {})[m.id]?.count || 0)),
  });
  const showMode = () => {
    const letter = box.dataset.mode === 'letter';
    const l = left();
    box.querySelector('.left-msgs').textContent = `Messages left: ${l.msgs}`;
    box.querySelector('.left-letters').textContent = `Letters left: ${l.letters}`;
    box.querySelector('.left-msgs').hidden = letter;
    box.querySelector('.left-letters').hidden = !letter;
    box.querySelector('.letter-subject').hidden = !letter;
  };
  box.querySelector('.btn-letter').addEventListener('click', () => { box.dataset.mode = 'letter'; showMode(); });
  box.querySelector('.btn-chat-mode').addEventListener('click', () => { box.dataset.mode = 'chat'; showMode(); });
  box.querySelector('.btn-translate').addEventListener('click', () => { box.dataset.translated = '1'; });
  showMode();
  box.querySelector('.btn-send').addEventListener('click', () => {
    const text = box.querySelector('textarea').value.trim();
    const status = box.querySelector('.status');
    const letter = box.dataset.mode === 'letter';
    if (!text && !(attached.get(box) || []).length) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
    if ((letter ? left().letters : left().msgs) === 0) { status.innerHTML = `<span class="send-error">No ${letter ? 'letters' : 'messages'} left for this man</span>`; return; }
    const files = takeFiles(box);
    const translated = box.dataset.translated === '1';
    delete box.dataset.translated;
    setTimeout(() => {
      if (letter) recordLetter(m.id, box.querySelector('.letter-subject').value.trim(), text, files, translated);
      else recordSent(m.id, text, files, translated);
      box.querySelector('textarea').value = '';
      box.querySelector('.letter-subject').value = '';
      status.innerHTML = '<span class="sent-ok">✓ Sent</span>';
      showMode();
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

// ---------- operator desk (desk.html): chat list, the open chat, the site's "write him" hints ----------
const allMen = () => Array.from({ length: PER_PAGE * PAGES }, (_, i) => man(i));
const label = (m) => `${m.name}, ${m.age}`;

/** Hints the "site" gives: 5 men from the last pages; the 2nd is a glitch that opens another man's chat.
 *  On the women desk: each woman gets her own men (beyond the search pages), no glitch. */
const WOMEN_MEN = { '5000000001': [40, 42], '5000000002': [45, 47], '5000000003': [49] };
function deskTasks() {
  let t = store.get(K('demo_tasks'), null);
  if (!t && herSuffix) {
    const her = herSuffix.slice(1);
    t = (WOMEN_MEN[her] || []).map((i, n) => ({ id: man(i).id, via: 'chat', opens: man(i).id, at: Date.now() - (3 - n) * 600000 }));
    store.set(K('demo_tasks'), t);
  }
  if (!t) {
    const men = allMen();
    const pick = [20, 22, 25, 27, 29].map((i) => men[i]);
    const first = (m) => m.name.split('_')[0].toLowerCase();
    const other = men.slice(23).find((m) => first(m) !== first(pick[1]) && !pick.includes(m));
    t = pick.map((m, i) => ({ id: m.id, via: i === 2 || i === 4 ? 'letter' : 'chat', opens: i === 1 ? other.id : m.id, at: Date.now() - (5 - i) * 600000 }));
    store.set('demo_tasks', t);
  }
  return t;
}

function renderDesk() {
  const men = Array.from({ length: 64 }, (_, i) => man(i));
  const byId = (id) => men.find((m) => m.id === id) || { id, name: id, age: '' };
  const box = document.querySelector('.chat');
  let current = null;
  const left = (id) => ({
    msgs: Math.max(0, MSGS_PER_MAN - (store.get(K('demo_sent'), {})[id]?.count || 0)),
    letters: Math.max(0, LETTERS_PER_MAN - (store.get(K('demo_letters'), {})[id]?.count || 0)),
  });
  // ---- several women: who works now, a switcher, her name in the chat header ----
  const women = new URLSearchParams(location.search).has('women');
  const herNow = () => WOMEN.find((w) => w.id === store.get('demo_her', WOMEN[0].id)) || WOMEN[0];
  function showHer() {
    if (!women) return;
    const w = herNow();
    herSuffix = `@${w.id}`;
    document.querySelector('.her-now').textContent = `${w.name}, ${w.age} · ID ${w.id}`;
    box.querySelector('.ch-her').textContent = current ? `від ${w.name} · ID ${w.id}` : '';
  }
  if (women) {
    const list = el('div', { class: 'her-list', hidden: '' }, ...WOMEN.map((w) => {
      const row = el('div', { class: 'her-item' }, el('b', { class: 'her-name' }, `${w.name}, ${w.age}`), el('span', { class: 'her-id' }, w.id));
      row.addEventListener('click', () => {
        list.hidden = true;
        setTimeout(() => { // like an SPA: the desk reloads its data for the other woman
          store.set('demo_her', w.id);
          current = null;
          box.querySelector('.ch-name').textContent = '—';
          box.querySelector('.ch-id').textContent = '';
          box.querySelector('.msgs').replaceChildren();
          showHer();
          renderTasks();
          renderList();
          showMode();
        }, 500);
      });
      return row;
    }));
    const sw = el('button', { class: 'her-switch', type: 'button' }, 'Анкети ▾');
    sw.addEventListener('click', () => { list.hidden = !list.hidden; });
    document.querySelector('.chats').prepend(el('div', { class: 'her-bar' }, el('span', { class: 'muted' }, 'Анкета:'), el('span', { class: 'her-now' }), sw, list));
  }
  showHer();

  function showMode() {
    const letter = box.dataset.mode === 'letter';
    const l = current ? left(current.id) : { msgs: 0, letters: 0 };
    box.querySelector('.left-msgs').textContent = `Залишилося ${l.msgs} повідомлень`;
    box.querySelector('.left-letters').textContent = `Залишилося ${l.letters} листів`;
    box.querySelector('.left-msgs').hidden = letter;
    box.querySelector('.left-letters').hidden = !letter;
    box.querySelector('.letter-subject').hidden = !letter;
  }

  function openChat(id) {
    current = byId(id);
    box.dataset.mode = 'chat';
    box.querySelector('.ch-name').textContent = label(current);
    box.querySelector('.ch-id').textContent = `ID ${current.id}`;
    const sent = store.get(K('demo_sent'), {})[id];
    box.querySelector('.msgs').replaceChildren(...(sent?.history || []).map((t) => el('div', { class: 'msg' }, t)));
    box.querySelector('.status').innerHTML = '';
    const read = store.get(K('demo_read'), {});
    read[id] = true;
    store.set(K('demo_read'), read);
    showHer();
    showMode();
    renderList();
  }

  function renderList() {
    const sent = store.get(K('demo_sent'), {});
    const letters = store.get(K('demo_letters'), {});
    const read = store.get(K('demo_read'), {});
    const q = document.querySelector('.find-id').value.trim();
    const ids = [...new Set([...deskTasks().map((t) => t.opens), ...deskTasks().map((t) => t.id), ...Object.keys(sent), ...Object.keys(letters)])]
      .filter((id) => !q || id.includes(q));
    document.querySelector('.chat-list').replaceChildren(...ids.map((id) => {
      const m = byId(id);
      const h = hash('reply' + id);
      const first = sent[id]?.first || sent[id]?.at;
      const replied = first && h % 10 < 4 && Date.now() - first > 4000 + (h % 8000);
      const item = el('div', { class: `chat-item${current?.id === id ? ' on' : ''}` },
        el('img', { src: `avatars/${id}.png`, alt: m.name[0] }),
        el('div', {}, el('div', { class: 'ci-name' }, label(m)), el('div', { class: 'ci-last' }, replied ? REPLIES[h % REPLIES.length].slice(0, 40) : sent[id] ? `You: ${sent[id].text.slice(0, 30)}…` : '—')),
        replied && !read[id] ? el('span', { class: 'ci-unread' }, 'new') : '');
      item.addEventListener('click', () => openChat(id));
      return item;
    }));
  }

  function renderTasks() {
    const t = deskTasks();
    document.querySelector('.tasks').replaceChildren(...t.map((x) => {
      const m = byId(x.id);
      const item = el('div', { class: 'task' },
        el('div', { class: 'avatar' }, m.name[0].toUpperCase()),
        el('div', {}, el('div', { class: 't-name' }, label(m)), el('div', { class: 't-text' }, `Please write him ${x.via === 'letter' ? 'letter' : 'message'}`)),
        el('span', { class: 't-time' }, new Date(x.at).toTimeString().slice(0, 5)));
      item.addEventListener('click', () => openChat(x.opens)); // the glitch hint opens somebody else
      return item;
    }));
  }

  document.querySelector('.find-id').addEventListener('input', renderList);
  box.querySelector('.btn-letter').addEventListener('click', () => { box.dataset.mode = 'letter'; showMode(); });
  box.querySelector('.btn-chat-mode').addEventListener('click', () => { box.dataset.mode = 'chat'; showMode(); });
  box.querySelector('.btn-like').addEventListener('click', () => {
    if (!current) return;
    const l = store.get(K('demo_likes'), {});
    l[current.id] = (l[current.id] || 0) + 1;
    store.set(K('demo_likes'), l);
  });
  box.querySelector('.btn-translate').addEventListener('click', () => {
    const src = box.querySelector('.tr-src').value.trim();
    if (src) box.querySelector('.tr-dst').value = `[EN] ${src}`;
    box.dataset.translated = '1';
  });
  box.querySelector('.btn-send').addEventListener('click', () => {
    const status = box.querySelector('.status');
    const text = box.querySelector('.tr-dst').value.trim();
    const letter = box.dataset.mode === 'letter';
    if (!current) { status.innerHTML = '<span class="send-error">Open a chat first</span>'; return; }
    if (!text) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
    if ((letter ? left(current.id).letters : left(current.id).msgs) === 0) { status.innerHTML = '<span class="send-error">Nothing left for this man</span>'; return; }
    const id = current.id;
    const translated = box.dataset.translated === '1';
    delete box.dataset.translated;
    setTimeout(() => {
      if (letter) recordLetter(id, box.querySelector('.letter-subject').value.trim(), text, [], translated);
      else recordSent(id, text, [], translated);
      store.set(K('demo_tasks'), deskTasks().filter((x) => x.id !== id)); // the hint is done
      box.querySelector('.tr-dst').value = '';
      box.querySelector('.tr-src').value = '';
      box.querySelector('.letter-subject').value = '';
      status.innerHTML = '<span class="sent-ok">✓ Sent</span>';
      openChat(id);
      box.querySelector('.status').innerHTML = '<span class="sent-ok">✓ Sent</span>';
      renderTasks();
    }, 400);
  });
  renderTasks();
  renderList();
  showMode();
}

window.addEventListener('DOMContentLoaded', () => {
  captcha();
  if (document.querySelector('.desk')) renderDesk();
  if (document.getElementById('profile-chat')) renderProfile();
  if (document.getElementById('results')) { renderSearch(); initModal(); }
  if (document.getElementById('dialogs')) renderInbox();
  const reset = document.getElementById('reset');
  reset?.addEventListener('click', () => {
    for (const k of Object.keys(localStorage)) if (/^demo_(sent|read|likes|letters|tasks|her)(@|$)/.test(k)) localStorage.removeItem(k);
    location.reload();
  });
});
