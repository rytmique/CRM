/**
 * Site adapter = a set of CSS selectors the extension uses to work on a dating site.
 * Extraction syntax for *Id/*Name/*Age/*Country fields:
 *   ".sel"        -> textContent of the element inside the card
 *   ".sel@attr"   -> attribute of the element inside the card
 *   "@attr"       -> attribute of the card itself
 */
export const SITE_FIELDS = [
  { key: 'searchUrl', group: 'Пошук', label: 'URL сторінки пошуку чоловіків', hint: 'Звідси бот починає розсилку' },
  { key: 'card', group: 'Пошук', label: 'Картка чоловіка', hint: 'CSS-селектор одного чоловіка у видачі', required: true },
  { key: 'cardId', group: 'Пошук', label: 'ID чоловіка', hint: '@data-id або .link@href — унікальний ID', required: true },
  { key: 'cardName', group: 'Пошук', label: 'Ім’я', hint: '.name' },
  { key: 'cardAge', group: 'Пошук', label: 'Вік', hint: '.age (з тексту береться перше число)' },
  { key: 'cardCountry', group: 'Пошук', label: 'Країна', hint: '.country' },
  { key: 'nextPage', group: 'Пошук', label: 'Кнопка «Наступна сторінка»', hint: 'Якщо порожньо — тільки поточна сторінка' },
  { key: 'openChat', group: 'Відправка', label: 'Кнопка «Написати» в картці', hint: 'Якщо порожньо — поле вводу шукається одразу', required: true },
  { key: 'messageInput', group: 'Відправка', label: 'Поле вводу повідомлення', hint: 'textarea / input / [contenteditable]', required: true },
  { key: 'sendButton', group: 'Відправка', label: 'Кнопка «Надіслати»', hint: 'Якщо порожньо — натискається Enter', required: false },
  { key: 'sentConfirm', group: 'Відправка', label: 'Ознака успішної відправки', hint: 'Необов’язково: елемент, що з’являється після відправки' },
  { key: 'sendError', group: 'Відправка', label: 'Ознака помилки відправки', hint: 'Необов’язково: напр. «немає кредитів», «ліміт»' },
  { key: 'closeChat', group: 'Відправка', label: 'Закрити вікно чату', hint: 'Необов’язково' },
  { key: 'inboxUrl', group: 'Вхідні', label: 'URL сторінки вхідних', hint: 'Бот періодично перевіряє тут відповіді' },
  { key: 'inboxItem', group: 'Вхідні', label: 'Діалог у вхідних', hint: 'CSS-селектор одного діалогу' },
  { key: 'inboxUnread', group: 'Вхідні', label: 'Ознака непрочитаного', hint: 'Селектор всередині діалогу або .unread на самому діалозі' },
  { key: 'inboxId', group: 'Вхідні', label: 'ID чоловіка в діалозі', hint: 'Той самий формат, що й ID у пошуку' },
  { key: 'inboxName', group: 'Вхідні', label: 'Ім’я в діалозі', hint: '.name' },
  { key: 'chatUrl', group: 'Вхідні', label: 'Посилання на чат', hint: 'Шаблон з {id}, для сповіщень у Telegram' },
];

export function sanitizeSiteConfig(input = {}) {
  const out = {};
  for (const f of SITE_FIELDS) {
    const v = input[f.key];
    if (v !== undefined && v !== null) out[f.key] = String(v).trim().slice(0, 500);
  }
  return out;
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
    messageInput: '#chat-modal textarea',
    sendButton: '#chat-modal .btn-send',
    sentConfirm: '#chat-modal .sent-ok',
    sendError: '#chat-modal .send-error',
    closeChat: '#chat-modal .btn-close',
    inboxUrl: `${base}/inbox.html`,
    inboxItem: '.dialog',
    inboxUnread: '.unread',
    inboxId: '@data-man-id',
    inboxName: '.dialog-name',
    chatUrl: `${base}/inbox.html#man-{id}`,
  };
}
