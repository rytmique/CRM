import { h, field, input, textarea, busy, toast, fmtInt } from '../ui.js';
import { get, put, post } from '../api.js';

const MODEL_NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' };

/**
 * The team lead's settings: only what the team decides itself.
 * Prompts live in «Промпти»; the model, learning and caps — with the platform admin.
 */
export default async function settingsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const { settings: s, agencyName, usage = [], platformKey } = await get('/api/settings');
  const caps = s.caps || {};

  const els = {
    agencyName: input('agencyName', agencyName),
    timezone: input('timezone', s.timezone, { placeholder: 'Europe/Kyiv' }),
    apiKey: input('apiKey', s.ai.apiKey, { placeholder: 'sk-ant-…', autocomplete: 'off' }),
    language: input('language', s.ai.language, { placeholder: 'English' }),
    instructions: textarea('instructions', s.ai.instructions, { rows: 3, placeholder: 'Напр.: пиши простою англійською, без сленгу' }),
    botToken: input('botToken', s.telegram.botToken, { placeholder: '123456:ABC…', autocomplete: 'off' }),
    chatId: input('chatId', s.telegram.chatId, { placeholder: '-100… або id користувача' }),
    dailyLimit: input('dailyLimit', s.defaults.dailyLimit, { type: 'number', min: 1, max: caps.dailyMax || 5000 }),
    minDelay: input('minDelay', s.defaults.minDelay, { type: 'number', min: caps.minDelayFloor || 5, max: 3600 }),
    maxDelay: input('maxDelay', s.defaults.maxDelay, { type: 'number', min: 5, max: 3600 }),
    inboxCheckEvery: input('inboxCheckEvery', s.inboxCheckEvery, { type: 'number', min: 0, max: 500 }),
    dedupe: h('input', { type: 'checkbox', checked: s.dedupeAcrossAgency }),
  };

  const save = h('button.btn.primary', 'Зберегти');
  save.addEventListener('click', () => busy(save, async () => {
    const r = await put('/api/settings', {
      agencyName: els.agencyName.value,
      settings: {
        timezone: els.timezone.value || 'Europe/Kyiv',
        ai: { apiKey: els.apiKey.value, language: els.language.value, instructions: els.instructions.value },
        telegram: { botToken: els.botToken.value, chatId: els.chatId.value },
        defaults: { dailyLimit: Number(els.dailyLimit.value), minDelay: Number(els.minDelay.value), maxDelay: Number(els.maxDelay.value) },
        inboxCheckEvery: Number(els.inboxCheckEvery.value),
        dedupeAcrossAgency: els.dedupe.checked,
      },
    });
    els.apiKey.value = r.settings.ai.apiKey;
    els.botToken.value = r.settings.telegram.botToken;
    toast('Збережено');
  }).catch(() => {}));

  const tgTest = h('button.btn', 'Надіслати тест');
  tgTest.addEventListener('click', () => busy(tgTest, async () => {
    await post('/api/settings/telegram-test', { chatId: els.chatId.value });
    toast('Тестове повідомлення надіслано в Telegram');
  }).catch(() => {}));

  const pw = { current: input('current', '', { type: 'password', autocomplete: 'current-password' }), next: input('next', '', { type: 'password', autocomplete: 'new-password', minlength: 8 }) };
  const pwBtn = h('button.btn', 'Змінити пароль');
  pwBtn.addEventListener('click', () => busy(pwBtn, async () => {
    await post('/api/auth/password', { current: pw.current.value, next: pw.next.value });
    pw.current.value = pw.next.value = '';
    toast('Пароль змінено');
  }).catch(() => {}));

  const keyHint = s.ai.hasKey ? 'Ключ команди: ним користуються всі з вашої команди.'
    : platformKey ? 'Свого ключа немає — поки працює ключ платформи.' : 'Без ключа тексти пишуться простими шаблонами.';
  const capsNote = [caps.dailyMax ? `не більше ${caps.dailyMax} повідомлень на анкету в день` : '', caps.minDelayFloor ? `пауза не менше ${caps.minDelayFloor} с` : '']
    .filter(Boolean).join(', ');

  page.replaceChildren(
    h('div.page-head', h('h1', 'Налаштування'), save),
    h('div.settings-grid',
      h('section.card', h('h3', 'Команда'),
        field('Назва', els.agencyName),
        field('Часовий пояс', els.timezone, 'Від нього рахується «сьогодні» для лімітів і статистики (напр. Europe/Kyiv)')),
      h('section.card', h('h3', '🤖 ШІ команди (Claude)'),
        field('Ключ Anthropic API', els.apiKey, keyHint),
        h('details.small', h('summary', 'Як отримати ключ'), h('ol.steps.small',
          h('li', 'console.anthropic.com → зареєструйтесь.'),
          h('li', 'Billing → поповніть баланс.'),
          h('li', 'API Keys → Create Key → скопіюйте сюди → «Зберегти».'))),
        field('Мова інвайтів', els.language),
        field('Побажання для всіх текстів', els.instructions, 'Свій стиль кожен задає в «Промпти»'),
        h('p.small.muted', `Модель: ${MODEL_NAMES[s.ai.model] || s.ai.model} (обирає постачальник).`)),
      h('section.card', h('h3', 'Хто скільки використав ШІ (цей місяць)'),
        usage.length ? h('table.table', h('thead', h('tr', h('th', 'Хто'), h('th.num', 'Текстів'), h('th.num', 'Токенів'))),
          h('tbody', usage.map((u) => h('tr', h('td', u.name), h('td.num', fmtInt(u.calls)), h('td.num', fmtInt((u.input || 0) + (u.output || 0)))))))
          : h('p.small.muted', 'Ще нічого. Тут видно, хто з команди скільки текстів написав ключем команди.'),
        h('p.small.muted', 'Точна сума — в console.anthropic.com → Usage.')),
      h('section.card', h('h3', 'Розсилка (за замовчуванням)'),
        field('Денний ліміт на анкету', els.dailyLimit),
        h('div.pair', field('Пауза від, с', els.minDelay), field('до, с', els.maxDelay)),
        capsNote ? h('p.small.muted', `Межі від постачальника: ${capsNote}.`) : null,
        field('Перевіряти вхідні кожні N повідомлень', els.inboxCheckEvery, '0 — тільки в кінці розсилки'),
        h('label.check', els.dedupe, 'Не писати чоловіку, якому вже писала інша анкета команди на цьому сайті')),
      h('section.card', h('h3', 'Telegram-сповіщення'),
        h('p.small.muted', 'Про відповіді чоловіків і нові реєстрації в команду. Створіть бота в @BotFather, вставте токен.'),
        field('Токен бота', els.botToken),
        field('Chat id команди', els.chatId),
        tgTest),
      h('section.card', h('h3', 'Мій пароль'),
        field('Поточний пароль', pw.current),
        field('Новий пароль (мін. 8)', pw.next),
        pwBtn),
      h('section.card', h('h3', 'Ще'),
        h('ul.tips',
          h('li', h('a', { href: '#/licenses' }, 'Ліцензії'), ' — які анкети мають ліцензію, скільки вільних'),
          h('li', h('a', { href: '#/setup' }, '🚀 Підключення'), ' — покроковий майстер для нового сайту'),
          h('li', h('a', { href: '#/extension' }, 'Бот-розширення'), ' — як встановити і запустити')))));
}
