import { h, field, input, textarea, select, busy, toast, badge } from '../ui.js';
import { downloadBot } from './extension.js';
import { get, post, patch } from '../api.js';

/**
 * "Підключення за руку": one step at a time, from nothing to a running bot.
 * The page asks the server where the user is every few seconds, so steps done in the extension tick by themselves.
 */
const STEPS = {
  site: { title: 'Сайт знайомств', icon: '🌐' },
  profile: { title: 'Анкета жінки', icon: '👩' },
  extension: { title: 'Розширення в Chrome', icon: '🧩' },
  teach: { title: 'Навчити бота сайту', icon: '🎯' },
  test: { title: 'Тест без відправки', icon: '🧪' },
  start: { title: 'Старт', icon: '▶' },
};

export default async function setupPage(main, { navigate }) {
  const page = h('div.page.setup');
  main.replaceChildren(page);
  let profileId = null;
  let openKey = null; // a done step the user opened again
  let timer = null;
  let last = '';

  async function load(force = false) {
    const s = await get(`/api/stats/setup${profileId ? `?profile_id=${profileId}` : ''}`);
    const sig = JSON.stringify(s);
    if (!force && sig === last) return; // nothing changed: don't redraw over what the user is typing
    last = sig;
    render(s);
  }

  function render(s) {
    const current = s.steps.find((x) => !x.done)?.key || null;
    const shown = openKey || current;
    const doneCount = s.steps.filter((x) => x.done).length;
    page.replaceChildren(...[
      h('div.page-head', h('h1', '🚀 Підключення'), h('span.muted', `${doneCount} з ${s.steps.length}`)),
      h('div.progress', h('i', { style: `width:${Math.round((doneCount / s.steps.length) * 100)}%` })),
      s.demoOnly && !s.profile ? h('div.callout', '🧪 Анкети, що вже є (', s.profiles.map((p) => p.name).join(', '), '), — на демо-сайтах, для проби. Майстер рахує лише ваш справжній сайт: почніть з кроку 1.') : null,
      s.profiles.length > 1 ? h('div.row-wrap', h('span.small.muted', 'Анкета:'), h('select', { onchange: (e) => { profileId = Number(e.target.value); openKey = null; load(true); } },
        !s.profile ? h('option', { value: '', selected: true }, '— ваша справжня анкета ще не створена —') : null,
        s.profiles.map((p) => h('option', { value: p.id, selected: p.id === s.profile?.id }, `${p.name}${p.demo ? ' (демо)' : ''}`)))) : null,
      s.done && !openKey ? h('section.card.setup-done',
        h('h2', '🎉 Готово — бот працює'),
        h('p', 'Далі все саме: бот пише новим чоловікам, робить повторні спроби, а ви відповідаєте тим, хто відповів (прийде сповіщення).'),
        h('p', 'Порада: у вікні розширення поставте галочку ⏰ Автопілот — бот сам вмикатиметься в робочий час щодня.'),
        h('div.row-wrap', h('button.btn.primary', { onclick: () => navigate('dashboard') }, 'На дашборд'), h('button.btn', { onclick: () => navigate('journal') }, 'Журнал відправок'))) : null,
      h('ol.setup-steps', s.steps.map((st, i) => {
        const meta = STEPS[st.key];
        const isOpen = st.key === shown;
        return h(`li${st.done ? '.done' : ''}${isOpen ? '.open' : ''}`,
          h('button.setup-head', { type: 'button', onclick: () => { openKey = isOpen ? null : st.key; render(s); } },
            h('span.setup-num', st.done ? '✓' : String(i + 1)), h('b', `${meta.icon} ${meta.title}`),
            st.done ? badge('зроблено', 'ok') : st.key === current ? badge('зараз', 'accent') : null),
          isOpen ? h('div.setup-body', body(st, s)) : null);
      })),
    ].filter(Boolean)); // DOM replaceChildren would print "null"
  }

  // ---------- what to do on each step ----------
  function body(st, s) {
    switch (st.key) {
      case 'site': return siteStep(s);
      case 'profile': return profileStep(st, s);
      case 'extension': return extensionStep(st);
      case 'teach': return teachStep(st, s);
      case 'test': return testStep(st);
      default: return startStep(st);
    }
  }

  function siteStep(s) {
    const name = input('name', '', { placeholder: 'Напр. DateRu', maxlength: 120 });
    const url = input('searchUrl', '', { type: 'url', placeholder: 'https://site.com/search' });
    const add = h('button.btn.primary', 'Додати сайт');
    add.addEventListener('click', () => busy(add, async () => {
      if (!name.value.trim() || !url.value.trim()) throw new Error('Вкажіть назву і посилання');
      let base = '';
      try { base = `${new URL(url.value.trim()).origin}/`; } catch { throw new Error('Посилання має починатися з https://'); }
      await post('/api/sites', { name: name.value.trim(), base_url: base, config: { searchUrl: url.value.trim() } });
      toast('Сайт додано');
      openKey = null;
      await load(true);
    }).catch(() => {}));
    const own = s.sites.filter((x) => !x.demo);
    return [
      h('p', 'На якому сайті працює анкета? Відкрийте на ньому пошук чоловіків і скопіюйте адресу з рядка браузера.'),
      own.length ? h('p.small', 'Уже є: ', own.map((x) => x.name).join(', ')) : null,
      h('div.form-grid', field('Назва сайту', name), field('Сторінка пошуку чоловіків', url)),
      h('div.row-wrap', add,
        s.sites.some((x) => x.demo) ? h('span.small.muted', 'або спершу спробуйте на «Демо-сайті» — виберіть його в анкеті на наступному кроці') : null),
    ];
  }

  function profileStep(st, s) {
    if (s.profile && !s.profile.site_id) {
      const sel = select('site_id', '', [['', '— виберіть сайт —'], ...s.sites.map((x) => [x.id, x.name])]);
      const save = h('button.btn.primary', 'Зберегти');
      save.addEventListener('click', () => busy(save, async () => {
        if (!sel.value) throw new Error('Виберіть сайт');
        await patch(`/api/profiles/${s.profile.id}`, { site_id: Number(sel.value) });
        await load(true);
      }).catch(() => {}));
      return [h('p', `Анкеті «${s.profile.name}» потрібен сайт.`), field('Сайт', sel), save];
    }
    if (s.profile && st.license !== 'active' && st.license !== 'free') {
      const take = h('button.btn.primary', '🔑 Взяти вільну ліцензію');
      take.addEventListener('click', () => busy(take, async () => {
        await post(`/api/profiles/${s.profile.id}/license/auto`);
        toast('Ліцензію прив’язано');
        await load(true);
      }).catch(() => {}));
      return [h('p', `Анкета «${s.profile.name}» без дійсної ліцензії — бот не запуститься.`), take,
        h('p.small.muted', 'Немає вільних — попросіть керівника (або постачальника) додати ліцензії.')];
    }
    const f = {
      name: input('name', '', { maxlength: 80, placeholder: 'Anna' }),
      age: input('age', '', { type: 'number', min: 18, max: 99 }),
      site: select('site_id', s.site?.id || s.sites.find((x) => !x.demo)?.id || s.sites[0]?.id || '', s.sites.map((x) => [x.id, x.name])),
      bio: textarea('bio', '', { rows: 3, placeholder: 'Хто вона, характер, робота, як проводить час…' }),
      interests: input('interests', '', { placeholder: 'йога, подорожі, кулінарія' }),
    };
    const add = h('button.btn.primary', 'Створити анкету');
    add.addEventListener('click', () => busy(add, async () => {
      if (!f.name.value.trim()) throw new Error('Вкажіть ім’я');
      const r = await post('/api/profiles', {
        name: f.name.value.trim(), age: f.age.value ? Number(f.age.value) : undefined, site_id: Number(f.site.value) || undefined,
        bio: f.bio.value, interests: f.interests.value, license_id: 'auto',
      });
      profileId = r.id;
      toast(r.licensed ? 'Анкету створено, ліцензію прив’язано' : 'Анкету створено, але вільних ліцензій немає', r.licensed ? 'ok' : 'warn');
      openKey = null;
      await load(true);
    }).catch(() => {}));
    return [
      h('p', 'Кілька слів про жінку — з цього ШІ напише інвайт. Решту можна дописати потім в «Анкети».'),
      h('div.form-grid', field('Ім’я', f.name), field('Вік', f.age), field('Сайт', f.site), field('Інтереси', f.interests), h('div.span-2', field('Про себе', f.bio))),
      add,
    ];
  }

  function extensionStep(st) {
    return [
      h('ol.steps',
        h('li', h('button.btn.primary', { onclick: (e) => downloadBot(e.currentTarget) }, '⬇ Завантажити бота'), h('div.small.muted', 'Ваша особиста копія: адреса панелі вже вписана всередині')),
        h('li', 'Розпакуйте архів у постійну папку (не видаляйте її потім).'),
        h('li', 'Відкрийте ', h('code', 'chrome://extensions'), ' (в Опері — ', h('code', 'opera://extensions'), ') → увімкніть «Режим розробника».'),
        h('li', '«Завантажити розпаковане» → виберіть папку ', h('code', 'agency-bot'), '.'),
        h('li', 'Натисніть значок ❤ на панелі браузера → увійдіть своїм email і паролем.')),
      st.done ? null : h('p.small.muted.waiting', '⏳ Чекаю, поки ви увійдете в розширення — ця сторінка оновиться сама.'),
    ];
  }

  function teachStep(st, s) {
    return [
      h('ol.steps',
        h('li', 'Відкрийте сайт і залогіньтесь в анкету: ', s.site?.searchUrl ? h('a.btn.sm', { href: s.site.searchUrl, target: '_blank', rel: 'noopener' }, '🌐 Відкрити пошук') : h('span.muted', 'сторінку пошуку чоловіків')),
        h('li', 'Натисніть значок ❤ → ', h('b', '🎯 Навчити бота на цьому сайті'), '. Праворуч з’явиться панель з підказками.'),
        h('li', 'Клікніть «🎯 Вибрати» біля «Картка чоловіка» → клікніть на порожнє місце будь-якої картки. Ім’я, вік і «Написати» бот знайде сам.'),
        h('li', 'Натисніть на сайті «Написати» як зазвичай → вкладка «Відправка» → виберіть поле вводу й кнопку «Надіслати».'),
        h('li', 'Натисніть ', h('b', '💾 Зберегти'), '.')),
      st.missing?.length ? h('p.small', 'Ще не показано боту: ', h('b', st.missing.join(', '))) : null,
      st.done ? null : h('p.small.muted.waiting', '⏳ Чекаю, поки ви збережете навчання — сторінка оновиться сама.'),
    ];
  }

  function testStep(st) {
    return [
      h('ol.steps',
        h('li', 'Відкрийте сторінку пошуку на сайті.'),
        h('li', 'Значок ❤ → поставте галочку ', h('b', '🧪 Тест-режим'), ' → натисніть ', h('b', '🧪 Тест'), '.'),
        h('li', 'Бот пройде весь шлях на 3 чоловіках, але нічого не надішле. В кінці — «Тест пройдено ✓» або що поправити.')),
      st.failed ? h('div.callout.warn', h('b', 'Минулий тест знайшов проблеми:'), h('ul', st.failed.split('\n').map((x) => h('li', x))),
        h('p.small', 'Виправте через 🎯 «Навчити бота» (зазвичай — ще раз вибрати картку або поле вводу) і запустіть тест знову.')) : null,
      st.done ? null : h('p.small.muted.waiting', '⏳ Чекаю результат тесту — сторінка оновиться сама.'),
    ];
  }

  function startStep(st) {
    return [
      h('ol.steps',
        h('li', 'Значок ❤ → зніміть галочку «🧪 Тест-режим».'),
        h('li', 'Натисніть ', h('b', '▶ Старт'), '. Перші дні тримайте невеликий ліміт (Анкети → Денний ліміт), щоб подивитись очима.'),
        h('li', 'Щоб бот вмикався сам щодня — поставте галочку ', h('b', '⏰ Автопілот'), '. Робочі години й дні — Сайти → ⚙ Сценарій.')),
      st.done ? h('p', `✓ Надіслано: ${st.sent}`) : h('p.small.muted.waiting', '⏳ Чекаю першого надісланого інвайту.'),
    ];
  }

  await load(true);
  timer = setInterval(() => load().catch(() => {}), 4000);
  return () => clearInterval(timer);
}
