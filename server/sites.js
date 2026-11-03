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
  { key: 'card', group: 'Пошук', label: 'Картка чоловіка', hint: 'Один чоловік у видачі або в списку чатів. Не потрібна, якщо сайт сам дає підказки «напиши йому»' },
  { key: 'cardId', group: 'Пошук', label: 'ID чоловіка', hint: '@data-id або a@href. Якщо в значенні є число з 5+ цифр — ID буде саме воно. Немає в картці — заповніть «ID у шапці відкритого чату»' },
  { key: 'cardName', group: 'Пошук', label: 'Ім’я', hint: '.name' },
  { key: 'cardAge', group: 'Пошук', label: 'Вік', hint: '.age (з тексту береться перше число)' },
  { key: 'cardCountry', group: 'Пошук', label: 'Країна', hint: '.country' },
  { key: 'nextPage', group: 'Пошук', label: 'Кнопка «Наступна сторінка»', hint: 'Якщо порожньо — бот гортає список вниз (нескінченна стрічка)' },
  { key: 'openChat', group: 'Відправка', label: 'Кнопка «Написати» в картці', hint: '@self — клік по самій картці. Порожньо — поле вводу шукається одразу' },
  { key: 'messageInput', group: 'Відправка', label: 'Поле вводу повідомлення', hint: 'textarea / input / [contenteditable]', required: true },
  { key: 'sendButton', group: 'Відправка', label: 'Кнопка «Надіслати»', hint: 'Якщо порожньо — натискається Enter', required: false },
  { key: 'attachButton', group: 'Відправка', label: 'Кнопка «Прикріпити файл» (скрепка)', hint: 'Потрібна, якщо в сценарії є файли. Бот не відкриває вікно вибору — підставляє файл сам' },
  { key: 'attachDone', group: 'Відправка', label: 'Ознака, що файл прикріпився', hint: 'Необов’язково: прев’ю фото в чаті. Бот дочекається його перед «Надіслати»' },
  { key: 'fileInput', group: 'Відправка', label: 'Поле файлу (input type=file)', hint: 'Зазвичай знаходиться само. Заповнюйте, лише якщо бот не може прикріпити' },
  { key: 'chatName', group: 'Відправка', label: 'Ім’я в шапці відкритого чату', hint: 'Запобіжник: бот пише, лише якщо тут ім’я саме цього чоловіка' },
  { key: 'chatId', group: 'Відправка', label: 'ID у шапці відкритого чату', hint: 'Якщо в картці немає ID — бот візьме його звідси (число з 5+ цифр)' },
  { key: 'translateButton', group: 'Відправка', label: 'Кнопка «Перекласти»', hint: 'Необов’язково: якщо сайт перекладає текст — бот натисне її після тексту й зачекає переклад' },
  { key: 'chatLeft', group: 'Відправка', label: 'Лічильник «Залишилося N повідомлень»', hint: 'Необов’язково: бот читає число в чаті; 0 — цьому чоловіку в чат більше не пише' },
  { key: 'sentConfirm', group: 'Відправка', label: 'Ознака успішної відправки', hint: 'Необов’язково: елемент, що з’являється після відправки' },
  { key: 'sendError', group: 'Відправка', label: 'Ознака помилки відправки', hint: 'Необов’язково: напр. «немає кредитів», «ліміт»' },
  { key: 'closeChat', group: 'Відправка', label: 'Закрити вікно чату', hint: 'Необов’язково' },
  { key: 'taskItem', group: 'Підказки сайту', label: 'Підказка «напиши йому» (одна)', hint: 'Сайт сам підкидає чоловіків — бот бере їх звідси першими' },
  { key: 'taskName', group: 'Підказки сайту', label: 'Ім’я в підказці', hint: '.name' },
  { key: 'taskText', group: 'Підказки сайту', label: 'Текст підказки', hint: 'Є «letter» / «лист» — бот пише листом, інакше в чат' },
  { key: 'taskId', group: 'Підказки сайту', label: 'ID у підказці', hint: 'Необов’язково: якщо немає — бот візьме ID з шапки чату' },
  { key: 'taskOpen', group: 'Підказки сайту', label: 'Що клікнути в підказці', hint: 'Порожньо — саму підказку' },
  { key: 'herCurrent', group: 'Анкети', label: 'Яка анкета зараз (ім’я / ID жінки)', hint: 'Де на сайті видно, від чийого імені зараз працює оператор. Бот звіряє перед роботою' },
  { key: 'herSwitch', group: 'Анкети', label: 'Перемикач анкет (відкрити список жінок)', hint: 'Кнопка або меню, що показує список жінок. Не потрібен, якщо список видно завжди' },
  { key: 'herItem', group: 'Анкети', label: 'Жінка в списку (одна)', hint: 'Один рядок списку жінок — бот клікне потрібну за ID або ім’ям' },
  { key: 'herItemId', group: 'Анкети', label: 'ID жінки в рядку', hint: 'Число з 5+ цифр; має збігатися з «ID анкети на сайті» в панелі' },
  { key: 'herItemName', group: 'Анкети', label: 'Ім’я жінки в рядку', hint: '.name' },
  { key: 'herUrl', group: 'Анкети', label: 'Адреса робочого столу анкети', hint: 'Замість кліків: шаблон з {pid} (ID жінки), якщо в кожної анкети своя адреса' },
  { key: 'chatHer', group: 'Анкети', label: 'Її ім’я / ID у шапці чату', hint: 'Запобіжник: бот пише, лише якщо чат від імені саме цієї жінки' },
  { key: 'letterOpen', group: 'Листи', label: 'Кнопка «Лист» (конверт)', hint: 'Відкриває лист у його чаті або на його сторінці' },
  { key: 'letterSubject', group: 'Листи', label: 'Поле теми листа', hint: 'Необов’язково, якщо в листа є тема' },
  { key: 'letterInput', group: 'Листи', label: 'Поле тексту листа', hint: 'Порожньо — те саме поле, що й у чаті' },
  { key: 'letterSend', group: 'Листи', label: 'Кнопка «Надіслати лист»', hint: 'Порожньо — та сама «Надіслати», що й у чаті' },
  { key: 'letterLeft', group: 'Листи', label: 'Лічильник «Залишилося N листів»', hint: 'Необов’язково: 0 — листа цьому чоловіку не пише' },
  { key: 'letterConfirm', group: 'Листи', label: 'Ознака, що лист пішов', hint: 'Необов’язково' },
  { key: 'manUrl', group: 'Профіль чоловіка', label: 'URL профілю чоловіка', hint: 'Шаблон з {id}, напр. https://site.com/profile/{id}. Потрібен для повторних спроб і перегляду профілю' },
  { key: 'findInput', group: 'Профіль чоловіка', label: 'Пошук чоловіка за ID (поле)', hint: 'Якщо в нього немає своєї сторінки: бот впише ID сюди й відкриє його чат зі списку' },
  { key: 'findResult', group: 'Профіль чоловіка', label: 'Результат пошуку (що клікнути)', hint: 'Порожньо — перший чат у списку («Діалог у вхідних» або «Картка чоловіка»)' },
  { key: 'pageOpenChat', group: 'Профіль чоловіка', label: 'Кнопка «Написати» на його сторінці', hint: 'Необов’язково. Якщо порожньо — береться «Написати» з картки або поле вводу шукається одразу' },
  { key: 'inboxUrl', group: 'Вхідні', label: 'URL сторінки вхідних', hint: 'Бот періодично перевіряє тут відповіді' },
  { key: 'inboxItem', group: 'Вхідні', label: 'Діалог у вхідних', hint: 'CSS-селектор одного діалогу' },
  { key: 'inboxUnread', group: 'Вхідні', label: 'Ознака непрочитаного', hint: 'Селектор всередині діалогу або .unread на самому діалозі' },
  { key: 'inboxId', group: 'Вхідні', label: 'ID чоловіка в діалозі', hint: 'Має дати те саме число, що й ID у пошуку (напр. a@href)' },
  { key: 'inboxName', group: 'Вхідні', label: 'Ім’я в діалозі', hint: '.name' },
  { key: 'inboxText', group: 'Вхідні', label: 'Текст його повідомлення', hint: 'Необов’язково: останнє повідомлення в діалозі. Бот зрозуміє «не цікаво» і не турбуватиме його' },
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

/**
 * Can the bot work on this site? A chat box, and men from somewhere:
 * cards with an ID (or the ID read from the open chat), or the site's own "write him" hints.
 */
export function siteReady(c = {}) {
  if (!c.messageInput) return false;
  return Boolean(c.taskItem || (c.card && (c.cardId || c.chatId)));
}

/** What is still missing, in the words of the teaching panel. */
export function siteMissing(c = {}) {
  const label = (k) => SITE_FIELDS.find((f) => f.key === k)?.label || k;
  const out = [];
  if (!c.taskItem && !c.card) out.push(`${label('card')} або ${label('taskItem')}`);
  if (c.card && !c.cardId && !c.chatId && !c.taskItem) out.push(label('cardId'));
  if (!c.messageInput) out.push(label('messageInput'));
  return out;
}

/** Fills {id} in a URL template. */
export const fillUrl = (tpl, id) => (tpl ? String(tpl).replaceAll('{id}', encodeURIComponent(id)) : '');

/** The demo "operator desk" (demo-site/desk.html): the site's hints, ID only in the chat header, letters, counters. */
export function deskSiteConfig(publicUrl) {
  const base = `${publicUrl.replace(/\/$/, '')}/demo-site`;
  return {
    searchUrl: `${base}/desk.html`,
    taskItem: '.task', taskName: '.t-name', taskText: '.t-text', taskOpen: '@self',
    messageInput: '.tr-dst', sendButton: '.btn-send', sentConfirm: '.chat .sent-ok', sendError: '.chat .send-error',
    chatName: '.ch-name', chatId: '.ch-id', chatLeft: '.left-msgs', translateButton: '.btn-translate',
    letterOpen: '.btn-letter', letterSubject: '.letter-subject', letterLeft: '.left-letters',
    findInput: '.find-id', inboxUrl: `${base}/desk.html`, inboxItem: '.chat-item', inboxUnread: '.ci-unread', inboxName: '.ci-name', inboxText: '.ci-last',
    actions: [{ key: 'like', name: 'Лайк', sel: '.btn-like', where: 'page' }],
    marks: [],
  };
}

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
    chatLeft: '#profile-chat .left-msgs',
    letterOpen: '#profile-chat .btn-letter',
    letterSubject: '#profile-chat .letter-subject',
    letterLeft: '#profile-chat .left-letters',
    manUrl: `${base}/profile.html?id={id}`,
    inboxUrl: `${base}/inbox.html`,
    inboxItem: '.dialog',
    inboxUnread: '.unread',
    inboxId: '@data-man-id',
    inboxName: '.dialog-name',
    inboxText: '.last',
    chatUrl: `${base}/inbox.html#man-{id}`,
    actions: [{ key: 'like', name: 'Лайк', sel: '.btn-like', where: 'card' }],
    marks: [{ key: 'online', name: 'Онлайн', sel: '.online' }],
  };
}
