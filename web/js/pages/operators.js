import { h, field, input, formData, busy, toast, modal, confirmDialog, badge, fmtInt, ago, safe, copy } from '../ui.js';
import { get, post, patch, del } from '../api.js';

export const joinUrl = (token) => `${location.origin}/#/join/${token}`;

/** "Команда": the registration link, who is waiting for approval, and everyone with today's numbers. */
export default async function operatorsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const [{ operators }, { link }] = await Promise.all([get('/api/operators'), get('/api/operators/link')]);
    const waiting = operators.filter((o) => o.pending);
    // the "new" counter in the menu follows what is left to approve
    const navBadge = document.querySelector('[data-key="team"] .nav-badge');
    if (navBadge) { if (waiting.length) navBadge.textContent = String(waiting.length); else navBadge.remove(); }
    const team = operators.filter((o) => !o.pending);
    const url = joinUrl(link.token);
    const message = `Привіт! Реєструйся в нашій команді в Agency CRM за цим посиланням:\n${url}\nПісля реєстрації я підтверджу — і можна входити.`;
    const urlBox = h('input', { value: url, readonly: true, 'aria-label': 'Посилання для реєстрації', onclick: (e) => e.target.select() });
    page.replaceChildren(...[
      h('div.page-head', h('h1', 'Команда', h('span.count', fmtInt(team.length))), h('button.btn', { onclick: () => openForm() }, '+ Додати вручну')),
      h('section.card.stack',
        h('h3', '🔗 Посилання для реєстрації операторів'),
        h('p.small.muted', 'Надішліть його своїм операторам. Кожен, хто зареєструється, з’явиться нижче — ви підтверджуєте або відхиляєте. Якщо посилання кудись потрапило — зробіть нове, старе одразу перестане працювати.'),
        h('div.link-box', urlBox,
          h('button.btn.primary', { onclick: () => copy(message) }, 'Скопіювати повідомлення'),
          h('button.btn', { onclick: () => copy(url) }, 'Лише посилання'),
          h('button.btn.ghost', { onclick: safe(async () => {
            if (!(await confirmDialog('Зробити нове посилання? Старе перестане працювати одразу.', { ok: 'Нове посилання' }))) return;
            await post('/api/operators/link/reset');
            toast('Нове посилання готове');
            load();
          }) }, '↻ Нове')),
        link.uses ? h('p.small.muted', `За цим посиланням зареєструвались: ${link.uses}`) : null),
      waiting.length ? h('section.card.stack',
        h('h3', `👋 Чекають підтвердження: ${waiting.length}`),
        h('div.pending-list', waiting.map((o) => h('div.pending-row',
          h('div.who', h('b', o.name), h('small', `${o.email} · ${ago(o.created_at)}`)),
          h('button.btn.primary.sm', { onclick: safe(async () => { await post(`/api/operators/${o.id}/approve`); toast(`${o.name} — у команді`); load(); }) }, '✓ Підтвердити'),
          h('button.btn.sm.danger.ghost', { onclick: safe(async () => {
            if (!(await confirmDialog(`Відхилити «${o.name}» (${o.email})? Заявку буде видалено.`, { ok: 'Відхилити', danger: true }))) return;
            await post(`/api/operators/${o.id}/reject`);
            toast('Відхилено');
            load();
          }) }, '✕ Відхилити'))))) : null,
      h('div.card.table-wrap', team.length ? h('table.table.hover',
        h('thead', h('tr', h('th', 'Оператор'), h('th.num', 'Анкет'), h('th.num', 'Ботів зараз'), h('th.num', 'Надіслано сьогодні'), h('th.num', 'Відповідей сьогодні'), h('th', 'Останній вхід'), h('th', 'Статус'), h('th', 'Бот і ШІ'), h('th', ''))),
        h('tbody', team.map((o) => h('tr', { onclick: () => openForm(o), tabindex: 0 },
          h('td', h('b', o.name), h('div.small.muted', o.email)),
          h('td.num', fmtInt(o.profiles)),
          h('td.num', o.bots_online ? badge(`● ${o.bots_online}`, 'ok') : h('span.muted', '0')),
          h('td.num', fmtInt(o.sent_today)),
          h('td.num', fmtInt(o.replies_today)),
          h('td', ago(o.last_login_at)),
          h('td', o.active ? badge('Активний', 'ok') : badge('Вимкнено', 'muted'),
            o.bot_outdated ? h('div', h('span.badge.warn', { title: 'Стара версія бота не запуститься — попросіть оновити (прийде й у Telegram)' }, `старий бот ${o.bot_version || ''}`)) : null),
          h('td', { onclick: (e) => e.stopPropagation() }, h('div.row-wrap',
            h(`button.btn.sm${o.bot_off ? '.danger' : ''}`, { title: o.bot_off ? `Бот призупинено${o.bot_off_note ? `: ${o.bot_off_note}` : ''} — натисніть, щоб повернути` : 'Призупинити бота (штраф, порушення)', onclick: safe(() => toggleBot(o)) },
              o.bot_off ? '⛔ Бот призупинено' : '🤖 Бот ✓'),
            h(`button.btn.sm${o.ai_off ? '.danger' : ''}`, { title: o.ai_off ? 'ШІ вимкнено — тексти з шаблонів. Натисніть, щоб увімкнути' : 'Вимкнути ключ ШІ (не оплатив)', onclick: safe(() => toggleAi(o)) },
              o.ai_off ? '🧠 ШІ вимкнено' : '🧠 ШІ ✓'))),
          h('td.actions', o.bots_online ? h('button.btn.sm', { title: 'Зупинити ботів цього оператора зараз (~30 с)', onclick: safe(async (e) => {
            e.stopPropagation();
            await post(`/api/operators/${o.id}/stop-bots`);
            toast(`Боти ${o.name} зупиняться протягом ~30 секунд`);
          }) }, '⏹ Стоп') : null)))))
        : h('div.empty', h('p', 'У команді ще нікого. Надішліть посилання вище своїм операторам — або додайте вручну.'))),
    ].filter(Boolean));
  }

  /** ⛔ / ✓ the bot of one operator: suspended — it stops now and cannot start (the panel stays); a Telegram note goes to them. */
  async function toggleBot(o) {
    if (o.bot_off) {
      await post(`/api/operators/${o.id}/access`, { botOff: false });
      toast(`${o.name}: бот знову доступний`);
      return load();
    }
    const note = input('note', '', { placeholder: 'напр. штраф за порушення правил', maxlength: 200 });
    const ok = h('button.btn.danger', 'Призупинити');
    const m = modal({ title: `Призупинити бота: ${o.name}`, body: h('div.stack',
      h('p', 'Бот зупиниться зараз і не запуститься, доки ви не повернете доступ. Панель у людини працює далі.'),
      field('Причина (людина побачить її в Telegram)', note)),
    actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), ok] });
    ok.addEventListener('click', () => busy(ok, async () => {
      await post(`/api/operators/${o.id}/access`, { botOff: true, note: note.value });
      m.close();
      toast(`${o.name}: бот призупинено`);
      load();
    }).catch(() => {}));
  }
  /** 🧠 the team's AI key for one operator: off = the bot keeps working with template texts (did not pay for the key). */
  async function toggleAi(o) {
    if (!o.ai_off && !(await confirmDialog(`Вимкнути ключ ШІ для «${o.name}»? Бот працюватиме далі, але тексти — з шаблонів. Людина отримає повідомлення в Telegram.`, { ok: 'Вимкнути ШІ', danger: true }))) return;
    await post(`/api/operators/${o.id}/access`, { aiOff: !o.ai_off });
    toast(o.ai_off ? `${o.name}: ШІ знову увімкнено` : `${o.name}: ШІ вимкнено`);
    load();
  }

  function openForm(o = null) {
    const form = h('form.form-grid',
      field('Ім’я *', input('name', o?.name, { required: true })),
      field('Email / логін *', input('email', o?.email, { required: true, autocomplete: 'off' })),
      field(o ? 'Новий пароль' : 'Пароль *', input('password', '', { type: 'text', minlength: 8, required: !o, autocomplete: 'new-password', placeholder: o ? 'залиште порожнім, щоб не міняти' : 'мінімум 8 символів' })),
      o ? h('label.check.span-2', h('input', { type: 'checkbox', name: 'active', checked: Boolean(o.active) }), 'Активний (вимкнений не зможе увійти)') : null);
    const save = h('button.btn.primary', o ? 'Зберегти' : 'Створити');
    const actions = [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save];
    if (o) actions.unshift(h('button.btn.danger.ghost.left', { onclick: safe(async () => {
      if (!(await confirmDialog(`Видалити «${o.name}» з команди назавжди? Доступ до панелі й бота закриється одразу, людина отримає повідомлення в Telegram. Її анкети лишаться в команді.`, { ok: 'Видалити з команди', danger: true }))) return;
      await del(`/api/operators/${o.id}`);
      toast('Оператора видалено');
      m.close();
      load();
    }) }, 'Видалити з команди'));
    const m = modal({ title: o ? `Оператор: ${o.name}` : 'Новий оператор', body: form, actions });
    const submit = () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const data = formData(form);
      if (o && !data.password) delete data.password;
      if (o) await patch(`/api/operators/${o.id}`, data);
      else await post('/api/operators', data);
      toast(o ? 'Збережено' : 'Оператора створено. Передайте логін і пароль — він увійде в бота.');
      m.close();
      load();
    }).catch(() => {});
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  await load();
}
