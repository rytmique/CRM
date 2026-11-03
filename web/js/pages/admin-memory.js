import { h, input, busy, toast, badge, fmtDate, fmtInt, safe } from '../ui.js';
import { get, post, patch, del } from '../api.js';

const SOURCE = { stats: ['з цифр', 'info'], ai: ['ШІ з прикладів', 'accent'], admin: ['ваш', 'ok'] };

/** Shared memory of the platform: lessons for writing invites, learned from real replies of all agencies. */
export default async function adminMemoryPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  const render = (data) => {
    const { lessons, stats } = data;
    const text = input('lesson', '', { maxlength: 300, placeholder: 'Напр.: Згадуй одне конкретне хобі й питай про його вихідні' });
    const add = h('button.btn.primary', 'Додати урок');
    add.addEventListener('click', () => busy(add, async () => {
      render(await post('/api/admin/memory', { text: text.value }));
      toast('Урок додано');
    }).catch(() => {}));
    const refresh = h('button.btn', '↻ Оновити зараз');
    refresh.addEventListener('click', () => busy(refresh, async () => {
      const r = await post('/api/admin/memory/refresh');
      render(r);
      toast(`Переглянуто інвайтів: ${r.refreshed?.invites ?? 0}, уроків: ${r.refreshed?.lessons ?? 0}`);
    }).catch(() => {}));
    page.replaceChildren(
      h('div.page-head', h('h1', 'Пам’ять ШІ'), refresh),
      h('div.callout', 'Уроки, які бот додає до кожного промту інвайту (у всіх агенцій, що не вимкнули спільну пам’ять). Цифрові уроки рахуються самі з реальних відповідей; ',
        stats.aiKey ? 'ШІ-уроки пише Claude, порівнюючи найкращі й найгірші інвайти (без імен і міст).' : 'для ШІ-уроків задайте ANTHROPIC_API_KEY на сервері.',
        ' Оновлюється кожні 6 год.'),
      h('div.stat-row',
        h('div', h('b', fmtInt(stats.sent)), h('span', 'інвайтів надіслано')),
        h('div', h('b', fmtInt(stats.replied)), h('span', 'позитивних відповідей')),
        h('div', h('b', stats.sent ? `${Math.round((stats.replied / stats.sent) * 1000) / 10}%` : '—'), h('span', 'конверсія платформи')),
        h('div', h('b', stats.ranking.ready ? '✓' : '…'), h('span', stats.ranking.ready ? 'пріоритет чоловіків працює' : `пріоритет чоловіків: потрібно ${60}+ інвайтів`))),
      h('section.card',
        h('h3', 'Уроки'),
        lessons.length ? h('ul.memory-list', lessons.map((l) => h('li', { class: l.active ? '' : 'off' },
          h('div', h('span', l.text), h('div.small.muted', badge(...SOURCE[l.source] || [l.source, 'muted']), ` ${fmtDate(l.created_at)}`)),
          h('div.row-wrap',
            h('button.btn.sm', { onclick: safe(async () => render(await patch(`/api/admin/memory/${l.id}`, { active: !l.active }))) }, l.active ? '⏸ Вимкнути' : '▶ Увімкнути'),
            h('button.btn.sm.ghost', { onclick: safe(async () => render(await del(`/api/admin/memory/${l.id}`))) }, '✕')))))
          : h('p.muted', 'Поки порожньо: уроки з’являться, коли інвайти наберуть статистику (від 30 надсилань на варіант).'),
        h('div.row-wrap', text, add),
        stats.updated ? h('p.small.muted', `Останнє оновлення: ${fmtDate(stats.updated)}`) : null));
  };
  render(await get('/api/admin/memory'));
}
