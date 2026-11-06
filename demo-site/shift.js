// Demo «night shift» desk (shift.html): the «Шанс» tab with online men, «Усі чати» with running dialogs,
// the open chat with letters (subject, photos), a translator and replies that come in a few seconds later.
// Everything lives in localStorage (keys shift_*), so the extension can be tested end to end.
(() => {
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  };
  const NAMES = ['Robert', 'David', 'Michael', 'James', 'William', 'Richard', 'Thomas', 'Steven', 'Paul', 'Andrew', 'Kevin', 'George'];
  const COUNTRIES = ['USA', 'Canada', 'UK', 'Australia', 'Germany', 'Ireland'];
  /** «Шанс»: 12 men, 8 of them online right now (the green dot). */
  const CHANCE = NAMES.map((name, i) => ({ id: String(7000001 + i), name, age: 41 + i * 2, country: COUNTRIES[i % COUNTRIES.length], online: i % 3 !== 2 }));
  /** Running dialogs: who wrote last decides whether the bot may write («Аллчат») or a person must answer. */
  const SEED = [
    { id: '8000001', name: 'Brian', age: 52, msgs: [['h', 'I love fishing on the lake near my house'], ['m', 'Fishing sounds so peaceful! What do you usually catch?']] },
    { id: '8000002', name: 'Edward', age: 58, msgs: [['m', 'Hello Edward! How is your week going?']] },
    { id: '8000003', name: 'Gary', age: 49, msgs: [['m', 'Do you like to travel?'], ['h', 'Yes, I was in Italy last summer!']], unread: true },
    { id: '8000004', name: 'Frank', age: 61, msgs: [['h', 'Hi Kate'], ['m', 'Hi Frank, nice to meet you'], ['h', 'What do you do for a living?']] },
    { id: '8000005', name: 'Henry', age: 55, msgs: [['h', 'My dog is my best friend'], ['m', 'What breed is your dog? I adore dogs!']] },
    { id: '8000006', name: 'Jack', age: 47, msgs: [['m', 'Good morning Jack!'], ['h', 'Morning! Busy day at work'], ['m', 'I hope it was not too tiring. What do you do to relax?']] },
  ];
  const LEFT = { msgs: 30, letters: 5 };
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else e.setAttribute(k, v); }
    for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
    return e;
  };

  function dialogs() {
    let d = store.get('shift_dialogs', null);
    if (!d) {
      d = {};
      const t = Date.now() - 6 * 3600000;
      for (const s of SEED) d[s.id] = { id: s.id, name: s.name, age: s.age, unread: Boolean(s.unread), msgs: s.msgs.map(([w, text], i) => ({ mine: w === 'm', text, at: t + i * 60000 })) };
      store.set('shift_dialogs', d);
    }
    return d;
  }
  const save = (d) => store.set('shift_dialogs', d);
  const label = (m) => `${m.name}, ${m.age}`;
  const left = (id) => store.get('shift_left', {})[id] || { ...LEFT };
  const setLeft = (id, v) => { const all = store.get('shift_left', {}); all[id] = v; store.set('shift_left', all); };

  function init() {
    const box = document.querySelector('.chat');
    let current = null;
    let files = [];
    const tab = () => (location.hash === '#all' ? 'all' : 'chance');

    function showTab() {
      const t = tab();
      document.querySelector('.tab-chance').classList.toggle('on', t === 'chance');
      document.querySelector('.tab-all').classList.toggle('on', t === 'all');
      document.querySelector('.list-chance').hidden = t !== 'chance';
      document.querySelector('.list-all').hidden = t !== 'all';
    }
    function renderChance() {
      document.querySelector('.list-chance').replaceChildren(...CHANCE.map((m) => {
        const item = el('div', { class: `chance-item${current?.id === m.id ? ' on' : ''}` },
          el('div', { class: 'ava' }, m.name[0], m.online ? el('span', { class: 'online-dot', title: 'online' }) : null),
          el('div', {}, el('div', { class: 'c-name' }, label(m)), el('div', { class: 'c-country' }, m.country)));
        item.addEventListener('click', () => openChat(m));
        return item;
      }));
    }
    function renderAll() {
      const d = dialogs();
      const rows = Object.values(d).sort((a, b) => (b.msgs.at(-1)?.at || 0) - (a.msgs.at(-1)?.at || 0));
      document.querySelector('.list-all').replaceChildren(...rows.map((x) => {
        const last = x.msgs.at(-1);
        const item = el('div', { class: `chat-row${current?.id === x.id ? ' on' : ''}` },
          el('div', { class: 'ava' }, x.name[0]),
          el('div', {}, el('div', { class: 'r-name' }, label(x)), el('div', { class: 'r-last' }, last ? `${last.mine ? 'You: ' : ''}${last.text.slice(0, 34)}${last.text.length > 34 ? '…' : ''}` : '—')),
          x.unread ? el('span', { class: 'unread' }, 'new') : null);
        item.addEventListener('click', () => openChat(x));
        return item;
      }));
    }
    function showMode() {
      const letter = box.dataset.mode === 'letter';
      const l = current ? left(current.id) : { msgs: 0, letters: 0 };
      box.querySelector('.left-msgs').textContent = `Залишилося ${l.msgs} повідомлень`;
      box.querySelector('.left-letters').textContent = `Залишилося ${l.letters} листів`;
      box.querySelector('.left-msgs').hidden = letter;
      box.querySelector('.left-letters').hidden = !letter;
      box.querySelector('.letter-subject').hidden = !letter;
    }
    function renderMsgs() {
      const d = dialogs();
      const msgs = current ? d[current.id]?.msgs || [] : [];
      box.querySelector('.msgs').replaceChildren(...msgs.map((m) => el('div', { class: `msg ${m.mine ? 'mine' : 'his'}${m.letter ? ' letter' : ''}` },
        m.subject ? el('small', {}, `✉ ${m.subject}`) : null, m.text, m.files?.length ? el('small', {}, `📷 ${m.files.join(', ')}`) : null)));
    }
    function openChat(m) {
      const d = dialogs();
      current = { id: m.id, name: m.name, age: m.age };
      if (d[m.id]?.unread) { d[m.id].unread = false; save(d); } // opening reads it
      box.dataset.mode = 'chat';
      box.querySelector('.ch-name').textContent = label(current);
      box.querySelector('.ch-id').textContent = `ID ${current.id}`;
      box.querySelector('.status').innerHTML = '';
      files = [];
      box.querySelector('.atts').replaceChildren();
      renderMsgs(); showMode(); renderChance(); renderAll();
    }
    /** Some men answer a few seconds later (the inbox shows «new»). */
    function maybeReply(id, kind) {
      const n = Number(id) % 4;
      if (!(kind === 'letter' ? n === 1 : n === 1 || id === '8000001')) return;
      setTimeout(() => {
        const d = dialogs();
        if (!d[id]) return;
        d[id].msgs.push({ mine: false, text: kind === 'letter' ? 'Thank you for your letter, Kate! Tell me more about you.' : 'Haha yes, you remember! Tell me about your day.', at: Date.now() });
        if (current?.id !== id) d[id].unread = true;
        save(d);
        renderAll();
        if (current?.id === id) renderMsgs();
      }, 5000);
    }

    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab === 'all' ? '#all' : '#chance'; }));
    window.addEventListener('hashchange', () => { showTab(); renderAll(); });
    box.querySelector('.btn-letter').addEventListener('click', () => { box.dataset.mode = 'letter'; showMode(); });
    box.querySelector('.btn-chat-mode').addEventListener('click', () => { box.dataset.mode = 'chat'; showMode(); });
    box.querySelector('.btn-translate').addEventListener('click', () => {
      const src = box.querySelector('.tr-src').value.trim();
      if (src) box.querySelector('.tr-dst').value = `[EN] ${src}`;
    });
    const fileIn = box.querySelector('.file-input');
    fileIn.addEventListener('change', () => {
      files = [...files, ...fileIn.files];
      fileIn.value = '';
      box.querySelector('.atts').replaceChildren(...files.map((f) => el('span', { class: 'att-preview' }, el('img', { src: URL.createObjectURL(f), alt: '' }), f.name)));
    });
    box.querySelector('.btn-send').addEventListener('click', () => {
      const status = box.querySelector('.status');
      const text = box.querySelector('.tr-dst').value.trim();
      const letter = box.dataset.mode === 'letter';
      if (!current) { status.innerHTML = '<span class="send-error">Open a chat first</span>'; return; }
      if (!text) { status.innerHTML = '<span class="send-error">Message is empty</span>'; return; }
      const l = left(current.id);
      if ((letter ? l.letters : l.msgs) <= 0) { status.innerHTML = '<span class="send-error">Nothing left for this man</span>'; return; }
      const id = current.id;
      const subject = box.querySelector('.letter-subject').value.trim();
      const names = files.map((f) => f.name);
      setTimeout(() => {
        const d = dialogs();
        d[id] ||= { id, name: current.name, age: current.age, unread: false, msgs: [] };
        d[id].msgs.push({ mine: true, text, at: Date.now(), ...(letter ? { letter: true, subject, files: names } : {}) });
        save(d);
        setLeft(id, letter ? { ...l, letters: l.letters - 1 } : { ...l, msgs: l.msgs - 1 });
        box.querySelector('.tr-dst').value = '';
        box.querySelector('.tr-src').value = '';
        box.querySelector('.letter-subject').value = '';
        files = [];
        box.querySelector('.atts').replaceChildren();
        renderMsgs(); showMode(); renderAll();
        status.innerHTML = '<span class="sent-ok">✓ Sent</span>';
        maybeReply(id, letter ? 'letter' : 'chat');
      }, 400);
    });
    document.getElementById('reset')?.addEventListener('click', () => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('shift_')) localStorage.removeItem(k);
      location.reload();
    });
    showTab(); renderChance(); renderAll(); showMode();
  }
  window.addEventListener('DOMContentLoaded', init);
  window.__shift = { dialogs, CHANCE };
})();
