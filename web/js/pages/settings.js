import { h, field, input, textarea, busy, toast } from '../ui.js';
import { get, put, post } from '../api.js';
import { promptEditor } from './prompt-editor.js';

const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 — найкраща якість (за замовчуванням)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 — дешевше, швидко'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 — найдешевше'],
];

export default async function settingsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const [{ settings: s, agencyName, defaultPrompt, promptVars }, { profiles }] = await Promise.all([get('/api/settings'), get('/api/profiles')]);
  const master = promptEditor({ value: s.ai.masterPrompt || defaultPrompt, defaultPrompt, promptVars, profiles, rows: 18 });

  const els = {
    agencyName: input('agencyName', agencyName),
    timezone: input('timezone', s.timezone, { placeholder: 'Europe/Kyiv' }),
    model: h('select', { name: 'model' }, MODELS.map(([v, l]) => h('option', { value: v, selected: v === s.ai.model }, l)),
      MODELS.some(([v]) => v === s.ai.model) ? null : h('option', { value: s.ai.model, selected: true }, s.ai.model)),
    apiKey: input('apiKey', s.ai.apiKey, { placeholder: s.ai.envKey ? 'використовується ключ із сервера' : 'sk-ant-…', autocomplete: 'off' }),
    language: input('language', s.ai.language, { placeholder: 'English' }),
    instructions: textarea('instructions', s.ai.instructions, { rows: 3, placeholder: 'Напр.: пиши простою англійською, без сленгу; згадуй, що вона любить готувати' }),
    botToken: input('botToken', s.telegram.botToken, { placeholder: '123456:ABC…', autocomplete: 'off' }),
    chatId: input('chatId', s.telegram.chatId, { placeholder: '-100… або id користувача' }),
    dailyLimit: input('dailyLimit', s.defaults.dailyLimit, { type: 'number', min: 1, max: 5000 }),
    minDelay: input('minDelay', s.defaults.minDelay, { type: 'number', min: 5, max: 3600 }),
    maxDelay: input('maxDelay', s.defaults.maxDelay, { type: 'number', min: 5, max: 3600 }),
    inboxCheckEvery: input('inboxCheckEvery', s.inboxCheckEvery, { type: 'number', min: 0, max: 500 }),
    dedupe: h('input', { type: 'checkbox', checked: s.dedupeAcrossAgency }),
  };

  const save = h('button.btn.primary', 'Зберегти налаштування');
  save.addEventListener('click', () => busy(save, async () => {
    const r = await put('/api/settings', {
      agencyName: els.agencyName.value,
      settings: {
        timezone: els.timezone.value || 'Europe/Kyiv',
        ai: { model: els.model.value, apiKey: els.apiKey.value, language: els.language.value, instructions: els.instructions.value, masterPrompt: master.value() },
        telegram: { botToken: els.botToken.value, chatId: els.chatId.value },
        defaults: { dailyLimit: Number(els.dailyLimit.value), minDelay: Number(els.minDelay.value), maxDelay: Number(els.maxDelay.value) },
        inboxCheckEvery: Number(els.inboxCheckEvery.value),
        dedupeAcrossAgency: els.dedupe.checked,
      },
    });
    els.apiKey.value = r.settings.ai.apiKey;
    els.botToken.value = r.settings.telegram.botToken;
    toast('Налаштування збережено');
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

  page.replaceChildren(
    h('div.page-head', h('h1', 'Налаштування'), save),
    h('div.settings-grid',
      h('section.card', h('h3', 'Агенція'),
        field('Назва', els.agencyName),
        field('Часовий пояс', els.timezone, 'Від нього рахується «сьогодні» для лімітів і статистики (IANA, напр. Europe/Kyiv)')),
      h('section.card', h('h3', 'ШІ для інвайтів (Claude)'),
        field('Модель', els.model),
        field('Ключ Anthropic API', els.apiKey, s.ai.envKey && !s.ai.hasKey ? 'Ключ задано на сервері (ANTHROPIC_API_KEY). Можна вказати окремий для агенції.' : 'Без ключа інвайти генеруються простим шаблоном'),
        field('Мова інвайтів за замовчуванням', els.language),
        field('Додаткові інструкції для ШІ', els.instructions)),
      h('section.card.span-all', h('h3', 'Майстер-промт для інвайтів', master.badge),
        h('p.small.muted', 'Головна інструкція для ШІ: як саме писати інвайт. Діє на всі анкети агенції, крім тих, де задано свій промт. Дані анкети ШІ отримує автоматично; змінні — щоб вставити їх у конкретне місце промту. Зміни діють після «Зберегти налаштування».'),
        master.el),
      h('section.card', h('h3', 'Розсилка (за замовчуванням)'),
        field('Денний ліміт на анкету', els.dailyLimit),
        h('div.pair', field('Пауза від, с', els.minDelay), field('до, с', els.maxDelay)),
        field('Перевіряти вхідні кожні N повідомлень', els.inboxCheckEvery, '0 — тільки в кінці розсилки; після розсилки бот і так стежить за вхідними кожні 3 хв'),
        h('label.check', els.dedupe, 'Не писати чоловіку, якому вже писала інша анкета агенції на цьому сайті')),
      h('section.card', h('h3', 'Telegram-сповіщення про відповіді'),
        h('p.small.muted', 'Створіть бота в @BotFather, вставте токен. Сповіщення йдуть у цей чат, оператору та жінці (якщо в анкеті вказано її chat id).'),
        field('Токен бота', els.botToken),
        field('Chat id агенції', els.chatId),
        tgTest),
      h('section.card', h('h3', 'Мій пароль'),
        field('Поточний пароль', pw.current),
        field('Новий пароль (мін. 8)', pw.next),
        pwBtn)));
}
