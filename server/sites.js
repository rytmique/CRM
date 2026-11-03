/**
 * Site adapter = a set of CSS selectors the extension uses to work on a dating site.
 * Extraction syntax for *Id/*Name/*Age/*Country fields:
 *   ".sel"        -> textContent of the element inside the card
 *   ".sel@attr"   -> attribute of the element inside the card
 *   "@attr"       -> attribute of the card itself
 * Any selector may end with :has-text("…") to match by the visible text (e.g. button:has-text("Like")).
 * Several selectors can be joined with a comma: the first visible match wins (handy when the chat box differs
 * between the search page and the man's profile page).
 */
export const SITE_FIELDS = [
  { key: 'searchUrl', group: 'Пошук', label: 'URL сторінки пошуку чоловіків', hint: 'Звідси бот починає розсилку' },
  { key: 'card', group: 'Пошук', label: 'Картка чоловіка', hint: 'CSS-селектор одного чоловіка у видачі', required: true },
  { key: 'cardId', group: 'Пошук', label: 'ID чоловіка', hint: '@data-id або a@href. Якщо в значенні є число з 5+ цифр — ID буде саме воно', required: true },
  { key: 'cardName', group: 'Пошук', label: 'Ім’я', hint: '.name' },
  { key: 'cardAge', group: 'Пошук', label: 'Вік', hint: '.age (з тексту береться перше число)' },
  { key: 'cardCountry', group: 'Пошук', label: 'Країна', hint: '.country' },
  { key: 'nextPage', group: 'Пошук', label: 'Кнопка «Наступна сторінка»', hint: 'Якщо порожньо — бот гортає список вниз (нескінченна стрічка)' },
  { key: 'openChat', group: 'Відправка', label: 'Кнопка «Написати» в картці', hint: 'Якщо порожньо — поле вводу шукається одразу', required: true },
  { key: 'messageInput', group: 'Відправка', label: 'Поле вводу повідомлення', hint: 'textarea / input / [contenteditable]', required: true },
  { key: 'sendButton', group: 'Відправка', label: 'Кнопка «Надіслати»', hint: 'Якщо порожньо — натискається Enter', required: false },
  { key: 'attachButton', group: 'Відправка', label: 'Кнопка «Прикріпити файл» (скрепка)', hint: 'Потрібна, якщо в сценарії є файли. Бот не відкриває вікно вибору — підставляє файл сам' },
  { key: 'attachDone', group: 'Відправка', label: 'Ознака, що файл прикріпився', hint: 'Необов’язково: прев’ю фото в чаті. Бот дочекається його перед «Надіслати»' },
  { key: 'fileInput', group: 'Відправка', label: 'Поле файлу (input type=file)', hint: 'Зазвичай знаходиться само. Заповнюйте, лише якщо бот не може прикріпити' },
  { key: 'sentConfirm', group: 'Відправка', label: 'Ознака успішної відправки', hint: 'Необов’язково: елемент, що з’являється після відправки' },
  { key: 'sendError', group: 'Відправка', label: 'Ознака помилки відправки', hint: 'Необов’язково: напр. «немає кредитів», «ліміт»' },
  { key: 'closeChat', group: 'Відправка', label: 'Закрити вікно чату', hint: 'Необов’язково' },
  { key: 'manUrl', group: 'Профіль чоловіка', label: 'URL профілю чоловіка', hint: 'Шаблон з {id}, напр. https://site.com/profile/{id}. Потрібен для повторних спроб і перегляду профілю' },
  { key: 'pageOpenChat', group: 'Профіль чоловіка', label: 'Кнопка «Написати» на його сторінці', hint: 'Необов’язково. Якщо порожньо — береться «Написати» з картки або поле вводу шукається одразу' },
  { key: 'inboxUrl', group: 'Вхідні', label: 'URL сторінки вхідних', hint: 'Бот періодично перевіряє тут відповіді' },
  { key: 'inboxItem', group: 'Вхідні', label: 'Діалог у вхідних', hint: 'CSS-селектор одного діалогу' },
  { key: 'inboxUnread', group: 'Вхідні', label: 'Ознака непрочитаного', hint: 'Селектор всередині діалогу або .unread на самому діалозі' },
  { key: 'inboxId', group: 'Вхідні', label: 'ID чоловіка в діалозі', hint: 'Має дати те саме число, що й ID у пошуку (напр. a@href)' },
  { key: 'inboxName', group: 'Вхідні', label: 'Ім’я в діалозі', hint: '.name' },
  { key: 'chatUrl', group: 'Вхідні', label: 'Посилання на чат', hint: 'Шаблон з {id}, для сповіщень у Telegram' },
];

const KEY_RE = /^[a-z0-9_-]{1,24}$/i;

/** Taught buttons (like, wink…) and card marks (online, premium…): [{ key, name, sel, where? }]. */
function sanitizeList(list, withWhere) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const a of list.slice(0, 20)) {
    const key = String(a?.key ?? '').trim();
    const sel = String(a?.sel ?? '').trim().slice(0, 500);
    if (!KEY_RE.test(key) || !sel || seen.has(key)) continue;
    seen.add(key);
    const item = { key, name: String(a?.name ?? '').trim().slice(0, 40) || key, sel };
    if (withWhere) item.where = a?.where === 'page' ? 'page' : 'card';
    out.push(item);
  }
  return out;
}

export function sanitizeSiteConfig(input = {}) {
  const out = {};
  for (const f of SITE_FIELDS) {
    const v = input[f.key];
    if (v !== undefined && v !== null) out[f.key] = String(v).trim().slice(0, 500);
  }
  out.actions = sanitizeList(input.actions, true);
  out.marks = sanitizeList(input.marks, false);
  return out;
}

/** Fills {id} in a URL template. */
export const fillUrl = (tpl, id) => (tpl ? String(tpl).replaceAll('{id}', encodeURIComponent(id)) : '');

export function demoSiteConfig(publicUrl) {
  const base = `${publicUrl.replace(/\/$/, '')}/demo-site`;
  return {
    searchUrl: `${base}/search.html`,
    card: '.man-card',
    cardId: '@data-man-id',
    cardName: '.man-name',
    cardAge: '.man-age',
    cardCountry: '.man-country',
    nextPage: 'a.next-page',
    openChat: '.btn-write',
    messageInput: '#chat-modal textarea, #profile-chat textarea',
    sendButton: '#chat-modal .btn-send, #profile-chat .btn-send',
    sentConfirm: '#chat-modal .sent-ok, #profile-chat .sent-ok',
    sendError: '#chat-modal .send-error, #profile-chat .send-error',
    closeChat: '#chat-modal .btn-close',
    attachButton: '#chat-modal .btn-attach, #profile-chat .btn-attach',
    attachDone: '.att-preview',
    manUrl: `${base}/profile.html?id={id}`,
    inboxUrl: `${base}/inbox.html`,
    inboxItem: '.dialog',
    inboxUnread: '.unread',
    inboxId: '@data-man-id',
    inboxName: '.dialog-name',
    chatUrl: `${base}/inbox.html#man-{id}`,
    actions: [{ key: 'like', name: 'Лайк', sel: '.btn-like', where: 'card' }],
    marks: [{ key: 'online', name: 'Онлайн', sel: '.online' }],
  };
}
