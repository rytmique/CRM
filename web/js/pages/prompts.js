import { h, busy, toast, badge, fmtInt, fmtPct, confirmDialog, safe, empty } from '../ui.js';
import { get, put } from '../api.js';
import { promptEditor } from './prompt-editor.js';

const SOURCE = { own: ['свій', 'accent'], team: ['команди', 'info'], default: ['стандартний', 'muted'] };

/**
 * Prompts: my own prompt and "tricks" (my messages that got replies), what works in the team (by real replies),
 * and — for the team lead — the team's base prompt.
 */
export default async function promptsPage(main, { user }) {
  const owner = user.role === 'owner';
  const page = h('div.page');
  main.replaceChildren(page);
  let tab = 'mine';
  let data;
  let profiles = [];

  async function load() {
    [data, { profiles }] = await Promise.all([get('/api/prompts'), get('/api/profiles')]);
    render();
  }

  function tabs() {
    const list = [['mine', 'Мій промпт'], ['tricks', `Мої фішки (${data.mine.examples.length})`], ['works', '🔥 Що залітає'], owner ? ['team', 'Промпт команди'] : null].filter(Boolean);
    return h('div.tabs-row', { role: 'tablist' }, list.map(([k, label]) => h(`button${k === tab ? '.on' : ''}`, { role: 'tab', 'aria-selected': k === tab, onclick: () => { tab = k; render(); } }, label)));
  }

  function minePanel() {
    const ed = promptEditor({ value: data.mine.prompt || data.team.prompt || data.defaultPrompt, defaultPrompt: data.defaultPrompt, promptVars: data.promptVars, profiles, rows: 16 });
    const save = h('button.btn.primary', 'Зберегти мій промпт');
    save.addEventListener('click', () => busy(save, async () => {
      await put('/api/prompts/mine', { prompt: ed.value() });
      toast('Збережено: діє на всі ваші анкети, де немає свого промпту');
      load();
    }).catch(() => {}));
    const useTeam = h('button.btn.ghost', { onclick: safe(async () => {
      await put('/api/prompts/mine', { prompt: '' });
      toast('Тепер діє промпт команди');
      load();
    }) }, 'Не мати свого (діє промпт команди)');
    return h('section.card.stack',
      h('div.row-wrap', h('h3', 'Мій промпт'), badge(data.mine.prompt ? 'свій' : data.team.prompt ? 'зараз діє промпт команди' : 'зараз діє стандартний', data.mine.prompt ? 'accent' : 'muted')),
      h('p.small.muted', 'Головна інструкція для ШІ, як писати інвайти — ваш стиль і ваші фішки. Діє на всі ваші анкети (крім тих, де в анкеті задано свій). «Перевірити на анкеті» — нічого не зберігає.'),
      ed.el, h('div.row-wrap', save, data.mine.prompt ? useTeam : null));
  }

  function tricksPanel() {
    const rows = data.mine.examples.map((e) => e.text);
    const list = h('div.stack');
    const draw = () => list.replaceChildren(...rows.map((t, i) => {
      const ta = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'Hi {name}! …' });
      ta.value = t;
      ta.addEventListener('input', () => { rows[i] = ta.value; });
      return h('div.example-row', ta, h('button.btn.sm.ghost', { title: 'Прибрати', onclick: () => { rows.splice(i, 1); draw(); } }, '✕'));
    }), rows.length < 10 ? h('button.btn', { onclick: () => { rows.push(''); draw(); } }, '+ Додати приклад') : h('p.small.muted', 'Максимум 10 прикладів'));
    draw();
    const save = h('button.btn.primary', 'Зберегти фішки');
    save.addEventListener('click', () => busy(save, async () => {
      const clean = rows.map((t) => t.trim()).filter((t) => t.length >= 15);
      await put('/api/prompts/mine', { examples: clean.map((text) => ({ text })) });
      toast(`Збережено прикладів: ${clean.length}. ШІ писатиме у вашому стилі`);
      load();
    }).catch(() => {}));
    return h('section.card.stack',
      h('h3', 'Мої фішки'),
      h('p.small.muted', 'Вставте 3–10 своїх повідомлень, на які чоловіки відповідали. ШІ вчиться на них і пише у вашому стилі — не копіюючи дослівно. {name} — ім’я чоловіка. Контакти й посилання сюди не ставте.'),
      list, h('div.row-wrap', save));
  }

  function worksPanel() {
    const takePrompt = (p) => safe(async () => {
      if (!(await confirmDialog(`Взяти промпт «${p.name}» собі? Ваш теперішній промпт буде замінено.`, { ok: 'Взяти' }))) return;
      await put('/api/prompts/mine', { prompt: p.prompt });
      toast('Готово: тепер це ваш промпт (можна підправити у «Мій промпт»)');
      tab = 'mine';
      load();
    });
    const addTrick = (inv) => safe(async () => {
      const ex = [...data.mine.examples.map((e) => ({ text: e.text })), { text: inv.text }].slice(-10);
      await put('/api/prompts/mine', { examples: ex });
      toast('Додано в «Мої фішки»');
      load();
    });
    return h('div.stack',
      h('section.card.stack',
        h('h3', 'Хто пише найкраще (30 днів)'),
        h('p.small.muted', `За справжніми відповідями чоловіків. Рейтинг рахується від ${data.minSent} інвайтів — раніше це випадковість.`),
        data.people.length ? h('div', data.people.map((p, i) => h('div.rank-row',
          h('span.rank-num', p.enough ? String(i + 1) : '·'),
          h('div', h('b', p.name), p.me ? h('span.muted', ' (я)') : null, ' ', badge(`промпт ${SOURCE[p.promptSource][0]}`, SOURCE[p.promptSource][1]),
            p.examples ? h('span.small.muted', ` · фішок ${p.examples}`) : null,
            h('div.small.muted', p.sent ? `${fmtInt(p.sent)} інвайтів → ${fmtInt(p.replies)} відповідей` : 'ще не писав(-ла)')),
          h('div.row-actions', p.enough ? h('b', fmtPct(p.rate)) : h('span.small.muted', 'мало даних'),
            !p.me && p.prompt ? h('button.btn.sm', { onclick: takePrompt(p) }, 'Взяти собі') : null)))) : empty('У команді ще немає статистики.')),
      h('section.card.stack',
        h('h3', 'Інвайти команди, що залітають'),
        data.best.length ? h('div.stack', data.best.map((inv) => h('div.best-invite',
          h('div.row-wrap', h('b', fmtPct(inv.rate)), h('span.small.muted', `${fmtInt(inv.sent)} надіслано · ${inv.operator_name || '—'} · ${inv.profile_name}`),
            h('button.btn.sm', { style: 'margin-left:auto', onclick: addTrick(inv) }, '+ У мої фішки')),
          h('p', inv.text)))) : empty(`Тут з’являться інвайти, що отримали найбільше відповідей (від ${data.minSent} надсилань).`)));
  }

  function teamPanel() {
    const ed = promptEditor({ value: data.team.prompt || data.defaultPrompt, defaultPrompt: data.defaultPrompt, promptVars: data.promptVars, profiles, rows: 16 });
    const save = h('button.btn.primary', 'Зберегти промпт команди');
    save.addEventListener('click', () => busy(save, async () => {
      await put('/api/prompts/team', { prompt: ed.value() });
      toast('Збережено: діє для всіх, у кого немає свого промпту');
      load();
    }).catch(() => {}));
    return h('section.card.stack',
      h('h3', 'Промпт команди'),
      h('p.small.muted', 'Основа для всіх, хто не написав свій. Свій промпт оператора завжди важливіший.'),
      ed.el, h('div.row-wrap', save));
  }

  function render() {
    page.replaceChildren(
      h('div.page-head', h('h1', owner ? 'Промпти' : 'Мій промпт')),
      h('div.callout', 'Кожен пише по-своєму: свій промпт і свої фішки. Система рахує, чиї інвайти отримують більше відповідей — це видно в «🔥 Що залітає», найкраще можна взяти собі в один клік.'),
      tabs(),
      { mine: minePanel, tricks: tricksPanel, works: worksPanel, team: teamPanel }[tab]());
  }

  await load();
}
