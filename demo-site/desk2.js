// A mock of the operator desk the real site has (as the operator's scanner report shows it): the chats of all her women in one
// list (his name and the woman's name + ID in each row), «Chance» and «All chats» in the menu, the chat header with both IDs,
// a translator with two boxes (the right one — English — is sent), the letter page with photos from her gallery in a popup.
// Routes (history API): <base>/chat, <base>/chance, <base>/chat/<cid>, <base>/chance/<cid>, <base>/letter/<cid>. State: localStorage desk2_*.
(() => {
  const WOMEN = [
    { id: '5000000001', name: 'Kate', age: 29, city: 'Brighton', about: 'I am a kind and cheerful woman, I work as a nurse and love the sea at sunrise.', hobbies: 'yoga, cooking, long walks' },
    { id: '5000000002', name: 'Olivia', age: 31, city: 'Bristol', about: 'I teach dance to children and believe in true, quiet love.', hobbies: 'dancing, reading, gardening' },
  ];
  // what each man tells about himself on his profile page (the bot reads it there)
  const HOBBIES = ['fishing, camping', 'cooking, jazz', 'art, photography', 'hiking, dogs', 'gardening, old films', 'travel, golf', 'chess, cycling', 'sailing, books', 'woodwork, music', 'running, coffee', 'painting, history', 'motorbikes, the sea'];
  const ABOUT = ['I am a calm man who loves nature and good jokes.', 'Retired engineer, I love my garden and long drives.', 'I work in arts and communications and love people.',
    'A simple man with a big heart, I like to cook for friends.', 'Open-minded, I notice beauty in everyday things.', 'I build boats and dream of travelling in a camper.'];
  const NAMES = ['Robert', 'David', 'Michael', 'James', 'William', 'Richard', 'Thomas', 'Steven', 'Paul', 'Andrew', 'Kevin', 'George'];
  const SEED = [
    { n: 1, name: 'Brian', age: 52, msgs: [['h', 'I love fishing on the lake near my house'], ['m', 'Fishing sounds so peaceful! What do you usually catch?']] },
    { n: 2, name: 'Edward', age: 58, msgs: [['m', 'Hello Edward! How is your week going?']] },
    { n: 3, name: 'Gary', age: 49, msgs: [['m', 'Do you like to travel?'], ['h', 'Yes, I was in Italy last summer!']] },
    { n: 4, name: 'Frank', age: 61, msgs: [['h', 'Hi there'], ['m', 'Hi Frank, nice to meet you'], ['h', 'What do you do for a living?']] },
    { n: 5, name: 'Henry', age: 55, msgs: [['h', 'My dog is my best friend'], ['m', 'What breed is your dog? I adore dogs!']] },
    { n: 6, name: 'Jack', age: 47, msgs: [['m', 'Good morning Jack!'], ['h', 'Morning! Busy day at work'], ['m', 'I hope it was not too tiring. What do you do to relax?']] },
  ];
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const base = location.pathname.replace(/\/desk2(\/.*)?$/, '/desk2');
  const cidOf = (her, man) => `c${her.slice(-2)}${man}`;

  function chats() {
    let c = get('desk2_chats', null);
    if (c) return c;
    c = {};
    const t = Date.now() - 6 * 3600000;
    WOMEN.forEach((w, k) => {
      NAMES.forEach((name, i) => {
        const id = String(7000001 + k * 100 + i);
        c[cidOf(w.id, id)] = { cid: cidOf(w.id, id), her: w.id, chance: true, man: { id, name, age: 41 + i * 2, online: i % 3 !== 2, city: ['Leeds', 'York', 'Bath', 'Derby'][i % 4], hobbies: HOBBIES[i], about: ABOUT[i % ABOUT.length] }, msgs: [], left: { msgs: 30, letters: 5 } };
      });
      for (const s of SEED) {
        const id = String(8000000 + k * 100 + s.n);
        c[cidOf(w.id, id)] = { cid: cidOf(w.id, id), her: w.id, chance: false, man: { id, name: s.name, age: s.age, online: true },
          msgs: s.msgs.map(([who, text], i) => ({ mine: who === 'm', text, at: t + i * 60000 + k })), left: { msgs: 30, letters: 5 } };
      }
    });
    set('desk2_chats', c);
    return c;
  }
  const save = (c) => set('desk2_chats', c);
  const woman = (id) => WOMEN.find((w) => w.id === id);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const x of kids) if (x !== null && x !== undefined && x !== false) e.append(x);
    return e;
  };
  const go = (path) => { history.pushState({}, '', base + path); render(); };
  const route = () => {
    const rest = location.pathname.slice(base.length).replace(/^\//, '');
    const [section = 'chat', cid = ''] = rest.split('/');
    return { section, cid };
  };
  const last = (x) => x.msgs[x.msgs.length - 1];
  let gallery = null;
  let chanceShown = 10;

  function menu(r) {
    const item = (cls, testid, text, on, path, val) => el('div', { class: `clmn_1_menu_item-OoLICg ${cls}${on ? ' active-pHK3F' : ''}`, 'data-testid': testid, 'aria-label': '', onclick: () => go(path) },
      el('div', { class: 'clmn_1_menu_item_text-t4mow5' }, text), val ? el('div', { class: 'clmn_1_menu_item_val-dopI3 red-A3BCqj' }, val) : null);
    const waits = Object.values(chats()).filter((x) => x.msgs.length && !last(x).mine).length;
    return el('div', { class: 'clmn_1-R8mlkB clmn_1' },
      el('div', { class: 'clmn_1_logo-RbKihh', 'data-testid': 'main-logo' }, '♥ DemoDate'),
      el('div', { class: 'clmn_1_mm_chat_wrap-ir_IEt', 'data-testid': 'profiles-btn' }, `Мої анкети (${WOMEN.length})`),
      el('div', { class: 'clmn_1_menu_list-s4yrCR', 'data-testid': 'main-menu-list' },
        item('chat-aU3rgj', 'all chats', 'All chats', r.section === 'chat', '/chat'),
        item('unanswered-Hiqi3v', 'main-menu-item-unanswered', 'Unanswered', false, '/chat', waits ? 'New' : ''),
        item('matches-UdzjR8', 'main-menu-item-chance', 'Chance', r.section === 'chance', '/chance'),
        item('letters-aPgDFc', 'main-menu-item-Letters', 'Letters', r.section === 'letter', '/chat')));
  }

  function row(x, section, active) {
    const l = last(x);
    const w = woman(x.her);
    return el('div', { class: `clmn_2_chat_block_item-aYZSKz in_active-Belx3${l && !l.mine ? ' unanswered-K2pQ7s' : ''}${active ? ' active-x2Lk9a' : ''}`, 'data-testid': `${x.cid}-row`,
      onclick: () => go(`/${section}/${x.cid}`) },
      el('div', { class: `clmn_2_chat_block_item_left-Ggv0Ds${x.man.online ? ' online-nD6EbO' : ''}`, 'data-testid': 'man-photo' }, x.man.name[0]),
      el('div', { class: 'clmn_2_chat_block_item_middle-Xw2GO2' },
        el('div', { class: 'clmn_2_chat_block_item_middle_name-w1HVgD', 'data-testid': 'man-name' }, `${x.man.name}, ${x.man.age}`),
        el('div', { class: `clmn_2_chat_block_item_middle_text-jXczoA${l && !l.mine ? ' from_man-Q3eR1t' : ''}`, 'data-testid': 'content' }, l ? (l.letter ? 'Letter' : l.text) : 'New match'),
        l?.mine ? el('span', { class: 'ot4et-chat-operator-sent-badge', 'aria-label': 'Sent' }, '✓ sent') : null),
      el('div', { class: 'clmn_2_chat_block_item_profile-f7tZ_T' },
        el('div', { class: 'clmn_2_chat_block_item_profile_photo_wrap-AUZOGC online-nD6EbO', 'data-testid': 'woman-photo' }),
        el('div', { class: 'clmn_2_chat_block_item_profile_name-zcXgCC', 'data-testid': 'woman-name' }, `${w.name}, ${w.age}`),
        el('div', { class: 'clmn_2_chat_block_item_profile_id-QZZDt6', 'data-testid': 'woman-external_id' }, `ID ${w.id}`),
        el('div', { class: 'clmn_2_chat_block_item_profile_prof_btn-UfvQsR', 'data-testid': 'profile-btn', title: 'Profile', onclick: (e) => { e.stopPropagation(); window.open(`${base}/profile-woman/${w.id}`, '_blank'); } }, '👤')));
  }

  function list(r) {
    // the letter page has its own column (folders of letters), not the list of chats — as on the real site
    if (r.section !== 'chance') chanceShown = 10;
    if (r.section === 'letter') {
      return el('div', { class: 'clmn_2_letters-aptDWM', 'data-testid': 'letter-filter-block' },
        el('div', { class: 'letters_folders-W5TzjO', 'data-testid': 'letter-menu' },
          el('div', { class: 'letters_folder_item-siJrCt mailbox-jrxltZ active-prXOql' }, 'Mailbox'), el('div', { class: 'letters_folder_item-siJrCt trash-_cWGbQ' }, 'Trash')));
    }
    const all = Object.values(chats());
    const chance = r.section === 'chance';
    const rows = chance ? all.filter((x) => x.chance) : all.filter((x) => x.msgs.length).sort((a, b) => (last(b)?.at || 0) - (last(a)?.at || 0));
    // «Chance» shows 10 rows and «Load more» (the real one shows ~30); the extra rows are gone once another page was opened
    const shown = chance ? rows.slice(0, chanceShown) : rows;
    const more = chance && shown.length < rows.length
      ? el('div', { class: 'clmn_2_chat_loadmore_btn-YTKsFt', onclick: () => { chanceShown += 10; refreshSide(); } }, 'Load more') : null;
    return el('div', { class: 'clmn_2-UZvWb3 clmn_2_chat-JMJGk8', 'data-testid': 'chat-list-block' },
      el('div', { class: 'clmn_2_chat_top_filters_container-GNfN_U', 'data-testid': 'chat-list-filter' }, el('input', { placeholder: 'Search ID or name', type: 'text' })),
      el('div', { class: 'clmn_2_chat_block_title-X1Fir' }, chance ? 'Chance' : 'Chats'),
      el('div', { class: 'clmn_2_chat_block_list-kytTFk', 'data-testid': 'chat-list' }, ...shown.map((x) => row(x, chance ? 'chance' : 'chat', x.cid === r.cid)), more));
  }

  function header(x, letter) {
    const w = woman(x.her);
    return el('div', { class: 'chat_head-doHxxv', 'data-testid': 'chat-header' },
      el('div', { class: 'chat_head_profile-Nhx5pm left-a1Wir' },
        el('div', { class: `chat_head_profile_photo-GMRJz_${x.man.online ? ' online-IFKz1K' : ''}`, 'data-testid': 'man-photo', onclick: () => window.open(`${base}/profile-man/${x.man.id}`, '_blank') }, x.man.name[0]),
        el('div', {}, el('div', { class: 'chat_head_profile_name-bMfsQo', 'data-testid': 'man-name' }, `${x.man.name}, ${x.man.age}`),
          el('div', { class: 'chat_head_profile_id-BpbFCY', 'data-testid': 'man-external_id' }, `ID ${x.man.id}`))),
      el('div', { class: 'chat_head_middle-a_lfy0', 'data-testid': 'options-btn' },
        letter ? el('div', { class: 'chat_head_nav_btn-gDTMMQ chat-hhGB3', 'data-testid': 'open-chat-btn', title: 'Open chat', onclick: () => go(`/${x.chance ? 'chance' : 'chat'}/${x.cid}`) }, '💬')
          : el('div', { class: 'chat_head_nav_btn-gDTMMQ letters-Xqk4EK', 'data-testid': 'send-letter-btn', title: 'Send letter', onclick: () => go(`/letter/${x.cid}`) }, '✉'),
        el('div', { class: 'chat_head_nav_btn-gDTMMQ favs-mY6BBf', 'data-testid': 'set-favorite-btn', title: 'Set/Unset favorite' }, '☆')),
      el('div', { class: 'chat_head_profile-Nhx5pm right-UhorX3' },
        el('div', {}, el('div', { class: 'chat_head_profile_name-bMfsQo', 'data-testid': 'woman-name' }, `${w.name}, ${w.age}`),
          el('div', { class: 'chat_head_profile_id-BpbFCY', 'data-testid': 'woman-external_id' }, `ID ${w.id}`)),
        el('div', { class: 'chat_head_profile_photo-GMRJz_ online-IFKz1K', 'data-testid': 'woman-photo' }, w.name[0])));
  }

  /** The translator: left — her language, right — English (this one is sent). The arrow translates left → right. */
  function double(kind) {
    const wrap = kind === 'chat' ? 'clmn_3_chat_textarea_wrap-qTbBpw' : 'clmn_3_chat_textarea_wrap-lEyjW4';
    const ta = (ph) => el('textarea', kind === 'chat' ? { class: 'clmn_3_chat_textarea_inner-HEFNQ6', 'data-testid': 'text', placeholder: ph } : { class: 'clmn_3_chat_textarea_inner-bjRne9', placeholder: ph });
    const left = ta('Українська');
    const right = ta('English');
    const arrow = el('div', { class: 'clmn_3_chat_textarea_translate_arrow-RB4D_i', 'data-testid': 'translate-btn', onclick: () => { if (left.value.trim()) right.value = `[EN] ${left.value.trim()}`; } }, '→');
    const box = el('div', { class: kind === 'chat' ? 'clmn_3_chat_textarea_double-hsycm_' : 'clmn_3_chat_textarea_double-e2emqK' },
      el('div', { class: wrap }, el('div', { class: 'clmn_3_chat_textarea_translate_info-PkXZJK' }, 'Українська'), left),
      el('div', { class: kind === 'chat' ? 'clmn_3_chat_textarea_translate_arrow_wrap-yn1fa' : 'clmn_3_chat_textarea_translate_arrow_wrap-hRqdzP' }, arrow),
      el('div', { class: wrap }, el('div', { class: 'clmn_3_chat_textarea_translate_info-PkXZJK' }, 'English'), right));
    return { box, left, right };
  }

  function maybeReply(cid, letter) {
    const c = chats()[cid];
    const n = Number(c.man.id) % 4;
    if (!(letter ? n === 1 : n === 1 || c.man.id.endsWith('01'))) return;
    setTimeout(() => {
      const all = chats();
      all[cid].msgs.push({ mine: false, text: letter ? `Thank you for your letter, ${woman(all[cid].her).name}! Tell me more about you.` : 'Haha yes, you remember! Tell me about your day.', at: Date.now() });
      save(all);
      refreshSide(); // like React: the lists change, the box she types in stays as it is
      const r = route();
      const scroll = document.querySelector('.clmn_3_chat_scroll-DuQEOh');
      if (r.cid === cid && r.section !== 'letter' && scroll) {
        scroll.append(el('div', { class: 'clmn_3_chat_message-Z3kYBe left-LN1dv5', 'data-testid': `received-message-${all[cid].msgs.length}` }, all[cid].msgs.at(-1).text));
      }
    }, 4000);
  }

  function chatPane(x) {
    const d = double('chat');
    const status = el('span', { class: 'status' });
    const send = el('div', { class: 'clmn_3_chat_bottom_send_btn-LYXEYH', 'data-testid': 'send-btn', onclick: () => {
      const text = d.right.value.trim();
      if (!text) { status.replaceChildren(el('span', { class: 'send-error' }, 'Translate the message first')); return; }
      const all = chats();
      if (all[x.cid].left.msgs <= 0) { status.replaceChildren(el('span', { class: 'send-error' }, 'No messages left')); return; }
      setTimeout(() => {
        all[x.cid].msgs.push({ mine: true, text, at: Date.now() });
        all[x.cid].left.msgs--;
        save(all);
        render();
        maybeReply(x.cid, false);
      }, 300);
    } }, 'Відправити');
    let k = 0;
    return el('div', { class: 'clmn_3-CbfLOz clmn_3_chat-fCcPsD' }, header(x, false),
      el('div', { class: 'clmn_3_chat_scroll-DuQEOh' }, ...x.msgs.filter((m) => !m.letter).map((m) => el('div', { class: `clmn_3_chat_message-Z3kYBe ${m.mine ? 'right-u7r2bI' : 'left-LN1dv5'}`, 'data-testid': `${m.mine ? 'sent' : 'received'}-message-${++k}` }, m.text))),
      el('div', { class: 'clmn_3_chat_bottom-gel8h0', 'data-testid': 'chat-actions' }, d.box,
        el('div', { class: 'clmn_3_chat_bottom_nav-DSxiNy' },
          el('button', { class: 'clmn_3_chat_bottom_option_btn-QuKoS_ image-Usfg_G', 'data-testid': 'add-image-btn', type: 'button', title: 'Add image' }, '📷'),
          el('div', { class: 'chat_typing_right-wqs8Ru', 'data-testid': 'message-limit' }, `Залишилося ${x.left.msgs} повідомлень`), status, send)));
  }

  function openGallery(onAttach) {
    const picked = new Set();
    const close = () => { gallery?.remove(); gallery = null; };
    const items = Array.from({ length: 10 }, (_, i) => {
      const it = el('div', { class: 'upload_popup_tabs_content_item' }, `photo ${i + 1}`);
      const lab = el('label', { class: 'no-drag', onclick: (e) => { e.stopPropagation(); if (picked.has(i)) picked.delete(i); else picked.add(i); it.classList.toggle('selected', picked.has(i)); lab.textContent = picked.has(i) ? '☑' : '☐'; } }, '☐');
      it.append(el('div', { class: 'no-drag' }, lab));
      return it;
    });
    gallery = el('div', { class: 'ReactModal__Overlay ReactModal__Overlay--after-open', onclick: (e) => { if (e.target === gallery) close(); } },
      el('div', { class: 'ReactModal__Content ReactModal__Content--after-open', role: 'dialog' },
        el('div', { class: 'attach_new_popup_tab_wrap' }, el('b', {}, 'Photos'),
          el('div', { class: 'upload_popup_tabs_content_middle photo' }, ...items),
          el('div', { class: 'attach_new_popup_tab_content_bottom' },
            el('div', { class: 'attach_new_popup_send_btn', 'data-testid': 'send-btn', onclick: () => { onAttach([...picked].map((i) => `photo${i + 1}.jpg`)); close(); } }, 'Відправити')))));
    document.body.append(gallery);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && gallery) { gallery.remove(); gallery = null; } });

  let attached = [];
  function letterPane(x) {
    const d = double('letter');
    const status = el('span', { class: 'status' });
    const files = el('div', { class: 'letters_attach_files_list-a1B2c3' }, ...attached.map((f) => el('div', { class: 'letters_attach_files_item file_photo' }, f.replace('.jpg', ''))));
    const send = el('div', { class: 'clmn_3_chat_bottom_send_btn-Pscy3l', 'data-testid': 'send-btn', onclick: () => {
      const text = d.right.value.trim();
      if (!text) { status.replaceChildren(el('span', { class: 'send-error' }, 'Translate the letter first')); return; }
      const all = chats();
      if (all[x.cid].left.letters <= 0) { status.replaceChildren(el('span', { class: 'send-error' }, 'No letters left')); return; }
      const photos = attached;
      attached = [];
      setTimeout(() => {
        all[x.cid].msgs.push({ mine: true, letter: true, text, files: photos, at: Date.now() });
        all[x.cid].left.letters--;
        save(all);
        render();
        maybeReply(x.cid, true);
      }, 300);
    } }, 'Відправити');
    let k = 0;
    return el('div', { class: 'clmn_3-CbfLOz clmn_3_letters-lrr4e' }, header(x, true),
      el('div', { class: 'letters_chat_list_scroll-wI8MvB', 'data-testid': 'letter-body' }, ...x.msgs.filter((m) => m.letter).map((m) => el('div', { class: `letters_chat_item-GioNa4 ${m.mine ? 'from_you-oZa3M' : 'to_you-myIddH'}`, 'data-testid': `${m.mine ? 'sent' : 'received'}-letter-${++k}` },
        m.text, m.files?.length ? el('div', { class: 'small' }, `📷 ${m.files.join(', ')}`) : null))),
      el('div', { class: 'clmn_3_chat_bottom-ojMbQx', 'data-testid': 'letter-actions' }, d.box, files,
        el('div', { class: 'clmn_3_chat_bottom_nav-DSxiNy' },
          el('button', { class: 'clmn_3_chat_bottom_option_btn-JBuJhL image-O8iry2', 'data-testid': 'add-image-btn', type: 'button', title: 'Add image',
            onclick: () => openGallery((names) => { attached = [...attached, ...names]; files.replaceChildren(...attached.map((f) => el('div', { class: 'letters_attach_files_item file_photo' }, f.replace('.jpg', '')))); }) }, '📷'),
          el('span', { class: 'chat_typing_right-DzsQ5D', 'data-testid': 'letters-limit' }, `Залишилося ${x.left.letters} листів`), status, send)));
  }

  function refreshSide() {
    const wrap = document.querySelector('.wchat_wrap-rzEzhI');
    if (!wrap) return;
    const r = route();
    wrap.children[0].replaceWith(menu(r));
    wrap.children[1].replaceWith(list(r));
  }

  /** A profile page (his or hers), the layout of the real one: the header block and the «about» block. */
  function profilePage(kind, id) {
    const x = kind === 'man' ? Object.values(chats()).find((c) => c.man.id === id)?.man : WOMEN.find((w) => w.id === id);
    if (!x) return el('div', {}, 'Profile not found');
    const item = (h, v) => el('li', { class: 'list-item' }, el('span', { class: 'list-item-header' }, `${h}:`), ' ', el('span', { class: 'list-item-value' }, v));
    return el('div', { class: `column-3 profile_${kind} profile_flex` },
      el('main', {},
        el('div', { class: 'main-content', 'data-testid': 'main-content' },
          el('span', { class: 'info__name', 'data-testid': 'name-age' }, `${x.name}, ${x.age}`),
          el('span', { class: 'info__id', 'data-testid': `${kind}-id` }, `ID ${x.id}`),
          el('span', { class: 'place-info', 'data-testid': 'place' }, x.city || 'Not specified'),
          el('ol', { class: 'list' }, item('Hobbies', x.hobbies || 'Not specified'), item('Smoking', 'Not specified'), item('Education', 'Not specified'))),
        el('div', { class: 'main-content-about' },
          el('div', { class: 'node-header' }, 'MY SELF-SUMMARY'), el('div', { class: 'node-about' }, x.about || ''),
          el('div', { class: 'node-header' }, 'Who AM I looking for'), el('div', { class: 'node-about' }, kind === 'man' ? 'A kind woman who likes to laugh and travel.' : 'A caring, honest man who knows what he wants.'))));
  }

  function render() {
    const rr = route();
    if (rr.section === 'profile-man' || rr.section === 'profile-woman') {
      document.getElementById('root').replaceChildren(profilePage(rr.section === 'profile-man' ? 'man' : 'woman', rr.cid));
      return;
    }
    const r = route();
    const x = chats()[r.cid];
    const root = document.getElementById('root');
    const pane = !x ? el('div', { class: 'clmn_3_chat_empty-Gy8x5R' }, 'Select a chat')
      : r.section === 'letter' ? letterPane(x) : chatPane(x);
    if (r.section !== 'letter') attached = [];
    root.replaceChildren(el('div', { class: 'wchat_wrap-rzEzhI' }, menu(r), list(r), pane));
  }

  window.addEventListener('popstate', render);
  window.addEventListener('DOMContentLoaded', () => {
    if (!/\/(chat|chance|letter|profile-man|profile-woman)(\/|$)/.test(location.pathname)) history.replaceState({}, '', `${base}/chat`);
    document.getElementById('reset')?.addEventListener('click', () => { for (const k of Object.keys(localStorage)) if (k.startsWith('desk2_')) localStorage.removeItem(k); location.href = `${base}/chat`; });
    render();
  });
  window.__desk2 = { chats, WOMEN };
})();
