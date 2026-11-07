import { h, field, input, busy, toast, fmtInt } from '../ui.js';
import { get, put, post } from '../api.js';

/** The platform admin: one Telegram bot for everyone, and the closed features. */
export default async function adminPlatformPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const [tg, feat, me] = await Promise.all([get('/api/admin/telegram'), get('/api/admin/features'), get('/api/me/telegram')]);
  const token = input('token', '', { placeholder: tg.on ? 'збережено — вставте новий, щоб замінити' : '123456789:AA…', autocomplete: 'off' });
  const save = h('button.btn.primary', 'Зберегти токен');
  save.addEventListener('click', () => busy(save, async () => {
    const r = await put('/api/admin/telegram', { token: token.value });
    toast(r.on ? `Бот @${r.bot} підключено` : 'Бот вимкнено');
    adminPlatformPage(main);
  }).catch(() => {}));
  const off = h('button.btn.ghost', 'Вимкнути бота');
  off.addEventListener('click', () => busy(off, async () => { await put('/api/admin/telegram', { token: '' }); adminPlatformPage(main); }).catch(() => {}));
  const link = h('button.btn', me.linked ? 'Підключити мій Telegram заново' : 'Підключити мій Telegram');
  link.addEventListener('click', () => busy(link, async () => { const r = await post('/api/me/telegram/link', {}); if (r.url) window.open(r.url, '_blank', 'noopener'); }).catch(() => {}));
  const strict = h('input', { type: 'checkbox', checked: feat.strictBotVersion });
  strict.addEventListener('change', () => put('/api/admin/features', { strictBotVersion: strict.checked }).then((r) => toast(r.strictBotVersion ? 'Лише нова версія бота' : 'Старі версії теж працюють')).catch(() => { strict.checked = !strict.checked; }));
  const auto = h('input', { type: 'checkbox', checked: feat.autoReply });
  auto.addEventListener('change', () => put('/api/admin/features', { autoReply: auto.checked }).then((r) => toast(r.autoReply ? 'Відкрито для команд' : 'Закрито')).catch(() => { auto.checked = !auto.checked; }));
  page.replaceChildren(
    h('div.page-head', h('h1', 'Telegram і функції')),
    h('div.settings-grid',
      h('section.card', h('h3', '📲 Telegram-бот платформи'),
        h('p', tg.on ? `✅ Працює: @${tg.bot}. Підключили свій Telegram: ${fmtInt(tg.linked)}.` : 'Ще не налаштований.'),
        h('ol.steps.small',
          h('li', 'У Telegram відкрийте @BotFather → /newbot → дайте назву.'),
          h('li', 'Скопіюйте токен (123456789:AA…) сюди → «Зберегти токен».'),
          h('li', 'Усі в командах натискають «Підключити Telegram» у панелі — і отримують свої звіти.')),
        field('Токен від @BotFather', token), h('div.row-wrap', save, tg.on ? off : null), tg.on ? link : null),
      h('section.card', h('h3', '🔄 Оновлення бота'),
        h('p', `Поточна версія: `, h('b', feat.latestBot)),
        h('label.check', strict, 'Працює лише найновіша версія'),
        h('p.small.muted', 'Нова версія → кожному в Telegram приходить «оновіть» (поза його зміною). Стара копія не стартує й чітко пише, що робити. Бот, що вже працює, доробляє зміну.')),
      h('section.card', h('h3', '✉️ Пошта (скидання пароля)'),
        h('p', feat.mail ? '✅ Налаштована — «Забули пароль?» надсилає посилання на email.' : 'Не налаштована — посилання приходить лише в Telegram (якщо підключений).'),
        h('p.small.muted', 'Щоб увімкнути: змінна SMTP_URL на сервері, напр. smtps://логін:пароль-застосунку@smtp.gmail.com:465 (і за бажанням MAIL_FROM).')),
      h('section.card', h('h3', '🔒 Закриті функції'),
        h('label.check', auto, 'Бот сам продовжує розмову після відповіді чоловіка'),
        h('p.small.muted', 'Поки закрито, команди бачать «скоро». Відкрийте, коли будете готові: тоді тімліди зможуть увімкнути це у себе.'))));
}
