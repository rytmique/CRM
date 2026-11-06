import { h, field, input, busy, toast, badge, fmtInt, ago, copy, safe, confirmDialog, empty, modal } from '../ui.js';
import { get, post, put, patch } from '../api.js';
import { accessModal } from './admin-agencies.js';
import { devicesTable } from './admin-devices.js';

const MODEL_NAMES = { 'claude-opus-5-5': 'Claude Opus 5.5 — найкраща якість', 'claude-sonnet-5-5': 'Claude Sonnet 5.5 — дешевше, швидко', 'claude-haiku-5-5': 'Claude Haiku 5.5 — найдешевше' };

/** A team's card in the admin's control panel: people, caps, AI, devices — and the big buttons. */
export default async function adminAgency(main, { navigate }) {
  const id = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id'));
  const page = h('div.page');
  main.replaceChildren(page);
  let tab = 'people';

  async function load() {
    const c = await get(`/api/admin/agencies/${id}/card`);
    const a = c.agency;
    const tabs = [['people', `Люди (${c.people.length})`], ['caps', 'План і ліміти'], ['ai', 'ШІ'], ['devices', 'Пристрої']];
    const panel = { people: peoplePanel, caps: capsPanel, ai: aiPanel, devices: devicesPanel }[tab](c);
    page.replaceChildren(
      h('div.page-head',
        h('h1', h('a.muted', { href: '#/agencies', title: 'Усі команди' }, '← '), a.name, ' ', a.active ? badge('працює', 'ok') : badge('призупинена', 'err'),
          a.solo ? ' ' : null, a.solo ? badge('соло', 'info') : null),
        h('div.row-wrap',
          h('button.btn', { title: 'Усі боти команди зупиняться протягом ~30 с (їх можна запустити знову)', onclick: safe(async () => {
            if (!(await confirmDialog(`Зупинити всіх ботів команди «${a.name}»?`, { ok: 'Зупинити' }))) return;
            const r = await post(`/api/admin/agencies/${a.id}/stop-bots`);
            toast(`Зупиняю ботів: анкет ${r.profiles}`);
          }) }, '⏹ Зупинити ботів'),
          h(`button.btn${a.active ? '.danger.ghost' : '.primary'}`, { onclick: safe(async () => {
            if (a.active && !(await confirmDialog(`Призупинити команду «${a.name}»? Усі вийдуть із панелі й ботів, увійти не зможуть, доки не увімкнеш.`, { ok: 'Призупинити', danger: true }))) return;
            await patch(`/api/admin/agencies/${a.id}`, { active: !a.active });
            toast(a.active ? 'Команду призупинено' : 'Команду увімкнено');
            load();
          }) }, a.active ? 'Призупинити команду' : 'Увімкнути команду'))),
      a.referrer || a.solo ? h('div.row-wrap',
        a.referrer ? h('span.small.muted', `🎁 Привів(ла): ${a.referrer.name}${a.referrer.team ? ` (${a.referrer.team})` : ''} — отримує 10% від оплат цієї команди 6 місяців`) : null,
        a.solo ? h('button.btn.sm', { onclick: safe(() => mergeInto(a)) }, '➜ Перенести в команду…') : null) : null,
      h('div.tiles',
        h('div.tile', h('span.tile-label', 'План команди'), h('b.tile-value', c.plan.profiles ? `${fmtInt(c.plan.used)} / ${fmtInt(c.plan.profiles)}` : '—'),
          h('span.tile-sub', !c.plan.profiles ? 'немає — бот не працює' : c.plan.until ? `активних анкет · до ${new Date(c.plan.until).toLocaleDateString('uk-UA')}` : 'активних анкет · без терміну')),
        h('div.tile', h('span.tile-label', 'Анкет усього'), h('b.tile-value', fmtInt(c.profiles)), h('span.tile-sub', 'разом з тими, що на паузі')),
        h('div.tile', h('span.tile-label', 'ШІ цього місяця'), h('b.tile-value', fmtInt(c.ai.usage.calls)), h('span.tile-sub', c.ai.teamKey ? 'ключ команди' : c.ai.platformKey && c.ai.platformKeySet ? 'ключ платформи' : 'шаблони (ключа немає)'))),
      c.link ? h('div.link-box', h('span.small.muted', 'Посилання для операторів цієї команди:'), h('input', { value: `${location.origin}/#/join/${c.link.token}`, readonly: true }),
        h('button.btn.sm', { onclick: () => copy(`${location.origin}/#/join/${c.link.token}`) }, 'Скопіювати')) : null,
      h('div.tabs-row', { role: 'tablist' }, tabs.map(([k, label]) => h(`button${k === tab ? '.on' : ''}`, { role: 'tab', 'aria-selected': k === tab, onclick: () => { tab = k; load(); } }, label))),
      panel);
  }

  /** A solo operator whose team came too: move them in with profiles, sites and numbers. */
  async function mergeInto(a) {
    const { agencies } = await get('/api/admin/agencies');
    const sel = h('select', { 'aria-label': 'Команда' }, agencies.filter((x) => x.id !== a.id).map((x) => h('option', { value: x.id }, x.name)));
    const ok = h('button.btn.primary', 'Перенести');
    const m = modal({
      title: `Перенести «${a.name}» в команду`,
      body: h('div.stack', h('p.small.muted', 'Людина стане оператором вибраної команди. Анкети, сайти, статистика й історія підуть з нею, а порожня соло-команда зникне.'), field('Команда', sel)),
      actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok],
    });
    ok.addEventListener('click', () => busy(ok, async () => {
      await post(`/api/admin/agencies/${a.id}/merge`, { into: Number(sel.value) });
      m.close();
      toast('Перенесено');
      location.hash = `#/agency?id=${sel.value}`;
    }).catch(() => {}));
  }

  function peoplePanel(c) {
    const act = (path, msg) => safe(async () => { await post(path); toast(msg); load(); });
    return h('section.card.table-wrap', c.people.length ? h('table.table.people-table',
      h('thead', h('tr', h('th', 'Хто'), h('th', 'Стан'), h('th.num', 'Анкет'), h('th.num', 'Ботів'), h('th.num', 'Сьогодні'), h('th.num', 'ШІ (міс.)'), h('th.num', 'Пристроїв'), h('th', 'Вхід'), h('th', ''))),
      h('tbody', c.people.map((u) => h('tr',
        h('td', h('b', u.name), ' ', u.role === 'owner' ? badge('тімлід', 'accent') : null, h('div.small.muted', u.email)),
        h('td', u.pending ? badge('чекає підтвердження', 'warn') : u.active ? badge('активний', 'ok') : badge('заблоковано', 'err')),
        h('td.num', fmtInt(u.profiles)),
        h('td.num', u.bots_online ? badge(`● ${u.bots_online}`, 'ok') : h('span.muted', '0')),
        h('td.num', `${fmtInt(u.sent_today)} / ${fmtInt(u.replies_today)}`),
        h('td.num', fmtInt(u.ai_calls)),
        h('td.num', fmtInt(u.devices)),
        h('td', ago(u.last_login_at)),
        h('td', h('div.row-actions', u.pending ? [
          h('button.btn.primary.sm', { onclick: act(`/api/admin/users/${u.id}/approve`, 'Підтверджено') }, '✓ Підтвердити'),
          h('button.btn.sm.danger.ghost', { onclick: safe(async () => {
            if (!(await confirmDialog(`Відхилити «${u.name}»?`, { ok: 'Відхилити', danger: true }))) return;
            await post(`/api/admin/users/${u.id}/reject`); toast('Відхилено'); load();
          }) }, '✕ Відхилити'),
        ] : [
          u.bots_online ? h('button.btn.sm', { title: 'Зупинити ботів цієї людини (~30 с)', onclick: act(`/api/admin/users/${u.id}/stop-bots`, 'Боти зупиняться за ~30 с') }, '⏹ Стоп') : null,
          h('button.btn.sm', { title: 'Вийти з усіх пристроїв (бот теж)', onclick: act(`/api/admin/users/${u.id}/signout`, 'Вийшов з усіх пристроїв') }, 'Вийти скрізь'),
          h('button.btn.sm', { title: 'Новий пароль', onclick: safe(async () => {
            if (!(await confirmDialog(`Новий пароль для «${u.name}»? Старий перестане діяти.`, { ok: 'Згенерувати' }))) return;
            const r = await post(`/api/admin/users/${u.id}/password`);
            accessModal({ title: `Новий доступ: ${u.name}`, email: r.email, password: r.password });
          }) }, 'Пароль'),
          u.active
            ? h('button.btn.sm.danger.ghost', { title: 'Заблокувати: вийде з усіх пристроїв, увійти не зможе', onclick: safe(async () => {
              if (!(await confirmDialog(`Заблокувати «${u.name}»?`, { ok: 'Заблокувати', danger: true }))) return;
              await post(`/api/admin/users/${u.id}/block`); toast('Заблоковано'); load();
            }) }, 'Блок')
            : h('button.btn.sm', { title: 'Розблокувати', onclick: act(`/api/admin/users/${u.id}/unblock`, 'Розблоковано') }, 'Розблокувати'),
        ].filter(Boolean))))))) : empty('Людей ще немає.'));
  }

  function capsPanel(c) {
    // the plan: how many active profiles may work, until when (empty date = no end)
    const planProfiles = input('planProfiles', c.plan.profiles || '', { type: 'number', min: 0, max: 10000, placeholder: 'напр. 50' });
    const planUntil = input('planUntil', c.plan.until ? new Date(c.plan.until).toISOString().slice(0, 10) : '', { type: 'date' });
    const savePlan = h('button.btn.primary', 'Зберегти план');
    savePlan.addEventListener('click', () => busy(savePlan, async () => {
      await put(`/api/admin/agencies/${c.agency.id}/control`, { plan: { profiles: Number(planProfiles.value) || 0, until: planUntil.value ? `${planUntil.value}T23:59:59` : null } });
      toast('План збережено');
      load();
    }).catch(() => {}));
    const f = {
      dailyMax: input('dailyMax', c.caps.dailyMax || '', { type: 'number', min: 0, max: 5000, placeholder: 'без обмеження' }),
      minDelayFloor: input('minDelayFloor', c.caps.minDelayFloor || '', { type: 'number', min: 0, max: 3600, placeholder: 'без обмеження' }),
      maxOperators: input('maxOperators', c.caps.maxOperators || '', { type: 'number', min: 0, max: 1000, placeholder: 'без обмеження' }),
    };
    const save = h('button.btn.primary', 'Зберегти ліміти');
    save.addEventListener('click', () => busy(save, async () => {
      await put(`/api/admin/agencies/${c.agency.id}/control`, { caps: Object.fromEntries(Object.entries(f).map(([k, el]) => [k, Number(el.value) || 0])) });
      toast('Ліміти збережено — команда не зможе їх перевищити');
      load();
    }).catch(() => {}));
    return h('div.stack',
      h('section.card.stack',
        h('h3', 'План команди'),
        h('p.small.muted', 'Одна «ліцензія» на всю команду: скільки активних анкет може працювати одночасно. Тімлід нічого не роздає — анкети просто працюють. Анкети на паузі не рахуються.'),
        h('div.caps-grid',
          field('Анкет у плані', planProfiles, `зараз активних: ${c.plan.used}`),
          field('Діє до', planUntil, 'порожньо — без терміну')),
        h('div.row-wrap', savePlan)),
      h('section.card.stack',
        h('h3', 'Ліміти'),
        h('p.small.muted', 'Межі, які команда не може перевищити (порожньо або 0 — без обмеження). Свої ліміти тімлід ставить усередині цих меж.'),
        h('div.caps-grid',
          field('Макс. повідомлень на анкету в день', f.dailyMax, `у команди зараз: ${c.defaults.dailyLimit}`),
          field('Мін. пауза між чоловіками, с', f.minDelayFloor, `у команди зараз: ${c.defaults.minDelay}–${c.defaults.maxDelay} с`),
          field('Макс. операторів', f.maxOperators)),
        h('div.row-wrap', save)));
  }

  function aiPanel(c) {
    const model = h('select', { 'aria-label': 'Модель' }, [...new Set([...c.models, c.ai.model])].map((m) => h('option', { value: m, selected: m === c.ai.model }, MODEL_NAMES[m] || m)));
    const variants = input('variants', c.ai.variants, { type: 'number', min: 1, max: 5 });
    const check = (on) => h('input', { type: 'checkbox', checked: on });
    const auto = check(c.ai.autoOptimize);
    const mem = check(c.ai.sharedMemory);
    const plat = check(c.ai.platformKey);
    const save = h('button.btn.primary', 'Зберегти');
    save.addEventListener('click', () => busy(save, async () => {
      await put(`/api/admin/agencies/${c.agency.id}/control`, { ai: { model: model.value, variants: Number(variants.value), autoOptimize: auto.checked, sharedMemory: mem.checked, platformKey: plat.checked } });
      toast('Збережено');
      load();
    }).catch(() => {}));
    return h('section.card.stack',
      h('p.small.muted', `Ключ ШІ: ${c.ai.teamKey ? 'команда додала свій ✓' : 'своєї ключа команда ще не додала'}. Цього місяця: текстів ${fmtInt(c.ai.usage.calls)}, токенів ${fmtInt(c.ai.usage.input + c.ai.usage.output)}.`),
      h('div.caps-grid', field('Модель', model), field('Варіантів інвайту в ротації', variants, '1 — без порівняння; 3 — оптимально')),
      h('label.check', auto, 'Самі вимикати слабкі варіанти й писати нові'),
      h('label.check', mem, 'Спільна пам’ять платформи (анонімні уроки з відповідей усіх команд)'),
      h('label.check', plat, c.ai.platformKeySet ? 'Якщо в команди немає свого ключа — дозволити ключ платформи (платиш ти)' : 'Дозволити ключ платформи (зараз на сервері його немає)'),
      h('div.row-wrap', save));
  }

  async function devicesPanelAsync(c, box) {
    const d = await get(`/api/admin/devices?agency_id=${c.agency.id}`);
    box.replaceChildren(devicesTable(d.devices, load));
  }
  function devicesPanel(c) {
    const box = h('section.card.table-wrap', h('p.muted', 'Завантаження…'));
    devicesPanelAsync(c, box).catch((e) => box.replaceChildren(h('p.form-error', e.message)));
    return box;
  }

  if (!id) { navigate('agencies'); return; }
  await load();
}
