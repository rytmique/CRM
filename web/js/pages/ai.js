import { h, field, input, busy, toast, fmtInt, dayLabel } from '../ui.js';
import { get, put } from '../api.js';

const MODEL_INFO = {
  'claude-opus-5-5': ['Opus', 'найкращі тексти (за замовчуванням)'],
  'claude-sonnet-5-5': ['Sonnet', 'добре й дешевше'],
  'claude-haiku-5-5': ['Haiku', 'найдешевше й найшвидше'],
};

/** 🤖 ШІ (team lead): the key, the model, the language of the texts and who used how much. */
export default async function aiPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const conf = await get('/api/settings');
  const s = conf.settings;
  const key = input('apiKey', s.ai.apiKey, { placeholder: 'sk-ant-…', autocomplete: 'off' });
  const language = input('language', s.ai.language, { placeholder: 'English' });
  const models = conf.models || Object.keys(MODEL_INFO);
  let model = models.includes(s.ai.model) ? s.ai.model : models[0];
  const modelBox = h('div.choice-list', { role: 'radiogroup', 'aria-label': 'Модель' });
  const renderModels = () => modelBox.replaceChildren(...models.map((m) => {
    const [name, hint] = MODEL_INFO[m] || [m, ''];
    return h(`label.choice${m === model ? '.on' : ''}`,
      h('input', { type: 'radio', name: 'model', value: m, checked: m === model, onchange: () => { model = m; renderModels(); } }),
      h('span', h('b', name), hint ? h('span.small.muted', ` — ${hint}`) : null));
  }));
  renderModels();

  const save = h('button.btn.primary', 'Зберегти');
  save.addEventListener('click', () => busy(save, async () => {
    const r = await put('/api/settings', { settings: { ai: { apiKey: key.value, model, language: language.value || 'English' } } });
    key.value = r.settings.ai.apiKey;
    toast('Збережено');
  }).catch(() => {}));

  const keyHint = s.ai.hasKey ? '✅ Ключ є — ним пишуть тексти всі з вашої команди.'
    : conf.platformKey ? 'Свого ключа немає — поки працює ключ платформи.' : 'Без ключа бот пише простими шаблонами. З ключем — живі тексти під кожного.';
  const tok = (u) => (u.input || 0) + (u.output || 0);
  const month = conf.usage || [];
  const total = month.reduce((a, u) => ({ calls: a.calls + (u.calls || 0), tokens: a.tokens + tok(u) }), { calls: 0, tokens: 0 });
  const days = conf.usageDays || [];
  const peak = Math.max(1, ...days.map((d) => d.calls || 0));

  page.replaceChildren(
    h('div.page-head', h('h1', '🤖 ШІ'), save),
    h('div.tiles',
      h('div.tile.good', h('span.tile-label', 'Текстів цього місяця'), h('span.tile-value', fmtInt(total.calls)), h('span.tile-sub', `${fmtInt(total.tokens)} токенів`)),
      h('div.tile', h('span.tile-label', 'Ключ'), h('span.tile-value', s.ai.hasKey ? '✅' : conf.platformKey ? '🟡' : '—'),
        h('span.tile-sub', s.ai.hasKey ? 'свій ключ команди' : conf.platformKey ? 'ключ платформи' : 'шаблони без ШІ')),
      h('div.tile', h('span.tile-label', 'Модель'), h('span.tile-value', (MODEL_INFO[model] || [model])[0]), h('span.tile-sub', 'для всієї команди'))),
    h('div.settings-grid',
      h('section.card', h('h3', '🔑 Ключ Claude'),
        field('Ключ Anthropic API', key, keyHint),
        h('ol.steps.small',
          h('li', 'Відкрийте console.anthropic.com і зареєструйтесь.'),
          h('li', 'Billing → поповніть баланс (від $5).'),
          h('li', 'API Keys → Create Key → скопіюйте сюди → «Зберегти».')),
        field('Мова текстів', language, 'Англійська для більшості сайтів')),
      h('section.card', h('h3', '🧠 Модель'), modelBox,
        h('p.small.muted', 'Модель — для всіх текстів команди: інвайти, листи Шансу, Аллчат.'))),
    h('section.card', h('h3', '👥 Хто скільки використав (цей місяць)'),
      month.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Хто'), h('th.num', 'Текстів'), h('th.num', 'Токенів'), h('th.num', 'Частка'))),
        h('tbody', month.map((u) => h('tr', h('td', u.name), h('td.num', fmtInt(u.calls)), h('td.num', fmtInt(tok(u))),
          h('td.num', `${total.tokens ? Math.round((tok(u) / total.tokens) * 100) : 0}%`))))))
        : h('p.muted', 'Цього місяця ШІ ще не писав.'),
      h('p.small.muted', 'Точна сума в доларах — у console.anthropic.com → Usage.')),
    h('section.card', h('h3', '📅 По днях (30 днів)'),
      days.length ? h('div.bars', days.map((d) => h('div.bar-row', h('span.bar-day', dayLabel(d.day)),
        h('span.bar', h('span.bar-fill', { style: { width: `${Math.round(((d.calls || 0) / peak) * 100)}%` } })),
        h('span.bar-num', `${fmtInt(d.calls)} · ${fmtInt(tok(d))} ток.`))))
        : h('p.muted', 'Даних ще немає.')));
}
