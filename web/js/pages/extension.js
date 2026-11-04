import { h, busy, toast } from '../ui.js';
import { session } from '../api.js';

/** The bot as a zip: a personal copy (marked for this person; the panel's address is inside). */
export async function downloadBot(btn) {
  await busy(btn, async () => {
    const res = await fetch('/api/extension/download', { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Не вдалося завантажити бота');
    const a = h('a', { href: URL.createObjectURL(await res.blob()), download: 'agency-bot.zip' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Бота завантажено: розпакуйте архів і додайте папку в браузер (кроки нижче)');
  }).catch(() => {});
}

export default async function extensionPage(main, { user }) {
  main.replaceChildren(h('div.page',
    h('div.page-head', h('h1', 'Розширення-бот')),
    h('div.grid-2',
      h('section.card',
        h('h3', 'Встановлення (Chrome, Opera, Edge, Brave)'),
        h('ol.steps',
          h('li', h('button.btn.primary', { onclick: (e) => downloadBot(e.currentTarget) }, '⬇ Завантажити бота'), h('div.small.muted', 'Це ваша особиста копія: адреса панелі вже всередині. Не передавайте її іншим — кожен завантажує свою.')),
          h('li', 'Розпакуйте архів у постійну папку (не видаляйте її).'),
          h('li', 'Відкрийте ', h('code', 'chrome://extensions'), ' (в Опері — ', h('code', 'opera://extensions'), ') і ввімкніть «Режим розробника».'),
          h('li', 'Натисніть «Завантажити розпаковане» і виберіть папку ', h('code', 'agency-bot'), '.'),
          h('li', 'Закріпіть іконку ♥ на панелі браузера.'))),
      h('section.card',
        h('h3', 'Як працює'),
        h('ol.steps',
          h('li', 'Увійдіть у розширення логіном ', user.role === 'operator' ? 'та паролем, які дав керівник' : 'оператора', '.'),
          h('li', 'Відкрийте сайт знайомств, залогіньтесь в анкету жінки.'),
          h('li', 'У розширенні виберіть цю анкету та натисніть ', h('b', '▶ Старт'), '.'),
          h('li', 'Бот бере інвайт анкети (згенерований ШІ), відкриває пошук і надсилає його новим чоловікам з паузами та в межах денного ліміту.'),
          h('li', 'Бот перевіряє вхідні. Щойно чоловік відповів — приходить сповіщення (браузер + Telegram). ', h('b', 'Далі переписку веде жінка сама.')))),
    ),
    h('section.card',
      h('h3', 'Поради'),
      h('ul.tips',
        h('li', h('b', '🧪 Тест-режим'), ' (галочка в розширенні): бот проходить увесь шлях на сайті — знаходить чоловіків, відкриває чат, вставляє текст, перевіряє пагінацію і вхідні — але не натискає «Надіслати» і не витрачає ліміт. Запускайте його першим на новому сайті.'),
        h('li', 'Кнопка 🔍 у розширенні перевіряє, чи бот бачить чоловіків на поточній сторінці — корисно після налаштування нового сайту.'),
        h('li', 'Якщо поставити анкету на паузу в панелі, бот зупиниться протягом ~30 секунд.'),
        h('li', 'Повторно одному й тому самому чоловіку з однієї анкети бот не пише ніколи.'),
        h('li', 'Не закривайте вкладку з сайтом, поки бот працює. Можна працювати в інших вкладках.'),
        user.role === 'owner' ? h('li', 'Для тесту без реального сайту: додайте «Демо-сайт» у розділі Сайти, призначте його анкеті й запустіть бота.') : null))));
}
