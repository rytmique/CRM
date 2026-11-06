import { h, field, input, busy, toast } from '../ui.js';
import { get, put, post } from '../api.js';

/** ⚙ The few settings a team lead needs: the team, the time zone, the AI key. Everything else — «Розширені». */
export default async function basicSettingsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const { settings: s, agencyName, platformKey } = await get('/api/settings');
  const els = {
    agencyName: input('agencyName', agencyName),
    timezone: input('timezone', s.timezone, { placeholder: 'Europe/Kyiv' }),
    apiKey: input('apiKey', s.ai.apiKey, { placeholder: 'sk-ant-…', autocomplete: 'off' }),
    language: input('language', s.ai.language, { placeholder: 'English' }),
  };
  const save = h('button.btn.primary', 'Зберегти');
  save.addEventListener('click', () => busy(save, async () => {
    const r = await put('/api/settings', { agencyName: els.agencyName.value,
      settings: { timezone: els.timezone.value || 'Europe/Kyiv', ai: { apiKey: els.apiKey.value, language: els.language.value || 'English' } } });
    els.apiKey.value = r.settings.ai.apiKey;
    toast('Збережено');
  }).catch(() => {}));
  const pw = { current: input('current', '', { type: 'password', autocomplete: 'current-password' }), next: input('next', '', { type: 'password', autocomplete: 'new-password', minlength: 8 }) };
  const pwBtn = h('button.btn', 'Змінити пароль');
  pwBtn.addEventListener('click', () => busy(pwBtn, async () => {
    await post('/api/auth/password', { current: pw.current.value, next: pw.next.value });
    pw.current.value = pw.next.value = '';
    toast('Пароль змінено');
  }).catch(() => {}));
  const keyHint = s.ai.hasKey ? '✅ Ключ є — ним пишуть тексти всі з вашої команди.'
    : platformKey ? 'Свого ключа немає — поки працює ключ платформи.' : 'Без ключа бот пише простими шаблонами. З ключем — живі тексти під кожного.';
  page.replaceChildren(
    h('div.page-head', h('h1', '⚙ Налаштування'), save),
    h('div.settings-grid',
      h('section.card', h('h3', '🔑 Ключ ШІ (Claude)'),
        field('Ключ Anthropic API', els.apiKey, keyHint),
        h('ol.steps.small',
          h('li', 'Відкрийте console.anthropic.com і зареєструйтесь.'),
          h('li', 'Billing → поповніть баланс (від $5).'),
          h('li', 'API Keys → Create Key → скопіюйте сюди → «Зберегти».')),
        field('Мова текстів', els.language, 'Англійська для більшості сайтів')),
      h('section.card', h('h3', 'Команда'),
        field('Назва', els.agencyName),
        field('Часовий пояс', els.timezone, 'Від нього рахуються ночі зміни, ліміти й звіти (напр. Europe/Kyiv)')),
      h('section.card', h('h3', 'Мій пароль'), field('Поточний пароль', pw.current), field('Новий пароль (мін. 8)', pw.next), pwBtn),
      h('section.card', h('h3', 'Розширені'),
        h('p.small.muted', 'Зазвичай не потрібні: усе налаштовано за вас.'),
        h('ul.tips',
          h('li', h('a', { href: '#/settings-advanced' }, 'Розширені налаштування'), ' — ліміти, паузи, свій Telegram-бот команди'),
          h('li', h('a', { href: '#/prompts' }, 'Промпти'), ' — стиль текстів команди й операторів'),
          h('li', h('a', { href: '#/sites' }, 'Сайти'), ' — адаптери сайтів і сценарії'),
          h('li', h('a', { href: '#/journal' }, 'Журнал'), ' — кожне повідомлення бота'),
          h('li', h('a', { href: '#/extension' }, 'Бот-розширення'), ' — завантажити й встановити')))));
}
