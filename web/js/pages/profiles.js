import { h, field, input, textarea, select, formData, busy, toast, modal, confirmDialog, badge, avatar, empty, fmtInt, fmtDate, safe } from '../ui.js';
import { get, post, patch, put, del } from '../api.js';
import { botBadge } from './dashboard.js';
import { promptEditor } from './prompt-editor.js';

export function licenseBadge(lic) {
  if (!lic || lic.state === 'none') return badge('Без ліцензії', 'err');
  if (lic.state === 'expired') return badge('Прострочена', 'err');
  if (lic.state === 'revoked') return badge('Відкликана', 'err');
  if (lic.daysLeft <= 3) return badge(`${lic.daysLeft} дн`, 'warn');
  return badge(`${lic.daysLeft} дн`, 'ok');
}

const SOURCE = { ai: 'ШІ', template: 'Шаблон', manual: 'Вручну', 'ai+edit': 'ШІ + правки', 'template+edit': 'Шаблон + правки' };

export default async function profilesPage(main, { user }) {
  const owner = user.role === 'owner';
  const page = h('div.page');
  main.replaceChildren(page);
  let all = [];
  let refs = { operators: [], sites: [], licenses: [] };
  let q = '';
  let statusFilter = '';

  async function loadRefs() {
    if (!owner) return;
    const [ops, sites, lic] = await Promise.all([get('/api/operators'), get('/api/sites'), get('/api/licenses')]);
    refs = { operators: ops.operators, sites: sites.sites, licenses: lic.licenses };
  }

  async function load() {
    all = (await get('/api/profiles')).profiles;
    render();
  }

  function render() {
    const search = h('input.search', { type: 'search', placeholder: 'Пошук: ім’я, місто, ID, оператор…', value: q, oninput: (e) => { q = e.target.value.toLowerCase(); renderTable(); } });
    const status = h('select', { onchange: (e) => { statusFilter = e.target.value; renderTable(); }, 'aria-label': 'Статус' },
      h('option', { value: '' }, 'Усі'), h('option', { value: 'active', selected: statusFilter === 'active' }, 'Активні'), h('option', { value: 'paused', selected: statusFilter === 'paused' }, 'На паузі'));
    const tableBox = h('div.card.table-wrap');
    const renderTable = () => {
      const rows = all.filter((p) => (!statusFilter || p.status === statusFilter)
        && (!q || `${p.name} ${p.city} ${p.country} ${p.site_profile_id} ${p.operator_name || ''}`.toLowerCase().includes(q)));
      tableBox.replaceChildren(rows.length ? h('table.table.hover',
        h('thead', h('tr', h('th', 'Анкета'), h('th', 'Сайт'), owner ? h('th', 'Оператор') : null, h('th', 'Ліцензія'), h('th', 'Бот'), h('th.num', 'Сьогодні'), h('th', 'Інвайт'))),
        h('tbody', rows.map((p) => h('tr', { onclick: safe(() => openDetail(p.id)), tabindex: 0, onkeydown: safe((e) => { if (e.key === 'Enter') return openDetail(p.id); }) },
          h('td', h('div.person', avatar(p.name, p.photo_url), h('div', h('b', p.name), p.age ? `, ${p.age}` : '',
            h('div.small.muted', [p.city, p.country].filter(Boolean).join(', ') || '—'), p.status === 'paused' ? badge('Пауза', 'muted') : null))),
          h('td', p.site_name || h('span.muted', 'не вибрано'), p.site_profile_id ? h('div.small.muted', `ID ${p.site_profile_id}`) : null),
          owner ? h('td', p.operator_name || h('span.muted', '—')) : null,
          h('td', licenseBadge(p.license)),
          h('td', botBadge(p), p.bot_info ? h('div.small.muted', p.bot_info) : null),
          h('td.num', h('b', `${fmtInt(p.sent_today)}`), h('span.muted', ` / ${p.limits.dailyLimit}`), h('div.small.muted', `відп.: ${p.replies_today}`)),
          h('td.invite-cell', p.invite_text ? h('span.clamp', p.invite_text) : h('span.muted', 'ще не згенеровано'))))))
        : empty(all.length ? 'Нічого не знайдено' : owner ? 'Додайте першу анкету — бот почне розсилку інвайтів з неї.' : 'Вам ще не призначили анкет.',
          owner && !all.length ? h('button.btn.primary', { onclick: safe(() => openForm()) }, '+ Додати анкету') : null));
    };
    renderTable();
    page.replaceChildren(
      h('div.page-head', h('h1', owner ? 'Анкети' : 'Мої анкети', h('span.count', fmtInt(all.length))),
        owner ? h('button.btn.primary', { onclick: safe(() => openForm()) }, '+ Додати анкету') : null),
      h('div.toolbar', search, status),
      tableBox);
  }

  // ---------- create / edit ----------
  async function openForm(p = null) {
    await loadRefs();
    const freeLicenses = refs.licenses.filter((l) => (l.state === 'free') || (p && l.profile_id === p.id));
    const { defaultPrompt, promptVars } = await get('/api/settings');
    let form;
    const ownPrompt = promptEditor({
      value: p?.prompt || '', defaultPrompt, promptVars, fixedProfileId: p?.id, name: 'prompt', rows: 10, allowEmpty: true,
      placeholder: 'Порожньо — діє майстер-промт агенції', getFields: () => formData(form),
    });
    if (!p) ownPrompt.el.querySelector('.btn.primary')?.remove();
    const licOptions = [['', '— без ліцензії —'], ...freeLicenses.map((l) => [l.id, `${l.key} · ${l.daysLeft} дн${l.profile_id ? ' (поточна)' : ''}`])];
    form = h('form.form-grid',
      h('h4.span-2', 'Основне'),
      field('Ім’я *', input('name', p?.name, { required: true, maxlength: 80 })),
      field('Вік', input('age', p?.age, { type: 'number', min: 18, max: 99 })),
      field('Місто', input('city', p?.city)),
      field('Країна', input('country', p?.country)),
      field('Сайт', select('site_id', p?.site_id, [['', '— вибрати —'], ...refs.sites.map((s) => [s.id, s.name])], { 'data-num': '' })),
      field('ID анкети на сайті', input('site_profile_id', p?.site_profile_id)),
      field('Оператор', select('operator_id', p?.operator_id, [['', '— не призначено —'], ...refs.operators.filter((o) => o.active).map((o) => [o.id, o.name])], { 'data-num': '' })),
      field('Ліцензія', select('license_id', p?.license?.id, licOptions, { 'data-num': '' }), refs.licenses.length ? 'Термін іде з моменту першої прив’язки' : 'Ліцензій немає — зверніться до постачальника'),
      field('Фото (URL)', input('photo_url', p?.photo_url, { type: 'url', placeholder: 'https://…' }), null),
      field('Статус', select('status', p?.status || 'active', [['active', 'Активна'], ['paused', 'Пауза']])),

      h('h4.span-2', 'Для ШІ — з цього пишеться інвайт'),
      h('div.span-2', field('Про себе', textarea('bio', p?.bio, { rows: 4, maxlength: 3000, placeholder: 'Хто вона, характер, робота, як проводить час…' }))),
      field('Інтереси', input('interests', p?.interests, { placeholder: 'йога, подорожі, кулінарія' })),
      field('Кого шукає', input('looking_for', p?.looking_for, { placeholder: 'серйозні стосунки з добрим чоловіком' })),
      field('Тон', input('tone', p?.tone || 'warm', { placeholder: 'теплий, грайливий, скромний…' })),
      field('Мова інвайту', input('language', p?.language, { placeholder: 'з налаштувань (English)' })),
      h('div.span-2', field('Нотатки для ШІ', textarea('notes', p?.notes, { rows: 2, placeholder: 'Чого уникати, на що робити акцент' }))),
      h('details.span-2.own-prompt', { open: Boolean(p?.prompt) },
        h('summary', 'Свій промт для цієї анкети (необов’язково) ', ownPrompt.badge),
        h('p.small.muted', 'Якщо заповнено — повністю замінює майстер-промт агенції для цієї анкети.'),
        ownPrompt.el),

      h('h4.span-2', 'Розсилка'),
      field('Денний ліміт', input('daily_limit', p?.daily_limit, { type: 'number', min: 1, max: 5000, placeholder: 'з налаштувань' })),
      h('div.pair', field('Пауза від, с', input('min_delay', p?.min_delay, { type: 'number', min: 5, placeholder: 'авто' })), field('до, с', input('max_delay', p?.max_delay, { type: 'number', min: 5, placeholder: 'авто' }))),
      h('div.pair', field('Вік чоловіків від', input('target_age_min', p?.target_age_min, { type: 'number', min: 18, max: 99 })), field('до', input('target_age_max', p?.target_age_max, { type: 'number', min: 18, max: 99 }))),
      field('Telegram chat id жінки', input('tg_chat_id', p?.tg_chat_id, { placeholder: 'для сповіщень про відповіді' }), 'Сповіщення про відповіді прийдуть їй особисто'));

    const saveBtn = h('button.btn.primary', { type: 'button' }, p ? 'Зберегти' : 'Створити');
    const m = modal({ title: p ? `Анкета: ${p.name}` : 'Нова анкета', body: form, wide: true, actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), saveBtn] });
    const submit = () => busy(saveBtn, async () => {
      if (!form.reportValidity()) return;
      const data = formData(form);
      if (p) await patch(`/api/profiles/${p.id}`, data);
      else await post('/api/profiles', data);
      toast(p ? 'Збережено' : 'Анкету створено');
      m.close();
      await load();
      if (p) openDetail(p.id);
    }).catch(() => {});
    saveBtn.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  // ---------- details + invites ----------
  async function openDetail(id) {
    const { profile: p, invites, followups = [], followupSteps = [], funnel } = await get(`/api/profiles/${id}`);
    const body = h('div.detail');
    const m = modal({ title: `${p.name}${p.age ? `, ${p.age}` : ''}`, body, wide: true });

    const active = invites.find((i) => i.active);
    const inviteText = textarea('text', active?.text || '', { rows: 5, maxlength: 1000 });
    const counter = h('small.hint');
    const updCounter = () => { counter.textContent = `${inviteText.value.length} символів · {name} підставляється ім’ям чоловіка`; };
    inviteText.addEventListener('input', updCounter);
    updCounter();

    const genBtn = h('button.btn.primary', '✨ Згенерувати ШІ');
    genBtn.addEventListener('click', () => busy(genBtn, async () => {
      const r = await post(`/api/profiles/${p.id}/invites/generate`);
      toast(r.invite.source === 'template' ? 'Згенеровано шаблоном (ключ Claude не налаштовано)' : 'Новий інвайт згенеровано', r.invite.source === 'template' ? 'warn' : 'ok');
      m.close();
      load();
      openDetail(p.id);
    }).catch(() => {}));
    const saveBtn = h('button.btn', active ? 'Зберегти правки' : 'Зберегти як інвайт');
    saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
      if (active) await patch(`/api/profiles/${p.id}/invites/${active.id}`, { text: inviteText.value });
      else await post(`/api/profiles/${p.id}/invites`, { text: inviteText.value });
      toast('Інвайт збережено');
      m.close();
      openDetail(p.id);
      load();
    }).catch(() => {}));

    const history = invites.filter((i) => !i.active);
    const reopen = () => { m.close(); openDetail(p.id); };
    const followupBox = (step) => {
      const f = followups.find((x) => x.step === step);
      const ta = textarea(`followup-${step}`, f?.text || '', { rows: 3, maxlength: 1000, placeholder: 'Ще не написано — з’явиться при першому запуску бота або натисніть ✨' });
      const gen = h('button.btn.sm', '✨ ШІ');
      gen.addEventListener('click', () => busy(gen, async () => {
        const r = await post(`/api/profiles/${p.id}/followups/${step}/generate`);
        toast(r.followup.source === 'template' ? 'Шаблон (ключ Claude не налаштовано)' : 'Згенеровано', r.followup.source === 'template' ? 'warn' : 'ok');
        reopen();
      }).catch(() => {}));
      const save = h('button.btn.sm', 'Зберегти');
      save.addEventListener('click', () => busy(save, async () => {
        await put(`/api/profiles/${p.id}/followups/${step}`, { text: ta.value });
        toast('Збережено');
      }).catch(() => {}));
      return h('div.followup-box', h('b.small', `Спроба ${step}`, f ? h('span.muted', ` · ${SOURCE[f.source] || f.source}`) : null), ta, h('div.row-wrap', gen, save));
    };
    body.append(...[
      h('div.detail-head',
        avatar(p.name, p.photo_url),
        h('div', h('div.row-wrap', licenseBadge(p.license), botBadge(p), p.status === 'paused' ? badge('Пауза', 'muted') : badge('Активна', 'ok'), p.prompt ? badge('Свій промт', 'accent') : null),
          h('div.small.muted', [p.city, p.country].filter(Boolean).join(', '), p.site_name ? ` · ${p.site_name}` : '', p.operator_name ? ` · оператор: ${p.operator_name}` : '')),
        h('div.row-wrap.right',
          h('button.btn', { onclick: safe(async () => { await patch(`/api/profiles/${p.id}`, { status: p.status === 'active' ? 'paused' : 'active' }); toast(p.status === 'active' ? 'Анкету поставлено на паузу — бот зупиниться' : 'Анкету активовано'); m.close(); load(); openDetail(p.id); }) },
            p.status === 'active' ? '⏸ Пауза' : '▶ Активувати'),
          owner ? h('button.btn', { onclick: safe(() => { m.close(); return openForm(p); }) }, '✎ Редагувати') : null)),
      h('div.stat-row',
        h('div', h('b', fmtInt(p.sent_today)), h('span', `сьогодні з ${p.limits.dailyLimit}`)),
        h('div', h('b', fmtInt(p.replies_today)), h('span', 'відповідей сьогодні')),
        h('div', h('b', fmtInt(p.sent_total)), h('span', 'інвайтів усього')),
        h('div', h('b', p.sent_total ? `${Math.round((p.replies_total / p.sent_total) * 1000) / 10}%` : '—'), h('span', 'конверсія'))),
      funnel ? h('div.funnel',
        h('span', `↻ чекають повторної спроби: ${fmtInt(funnel.waiting)}`),
        h('span', `🚫 не відповіли на всі спроби: ${fmtInt(funnel.done)}`),
        h('span', `💌 відповіли: ${fmtInt(funnel.replied)}`)) : null,
      h('section',
        h('h3', 'Інвайт-повідомлення', active ? badge(SOURCE[active.source] || active.source, 'muted') : null),
        h('p.small.muted', 'Бот надсилає цей текст усім новим чоловікам. Відповіді веде жінка сама.'),
        inviteText, counter,
        h('div.row-wrap', genBtn, saveBtn)),
      followupSteps.length ? h('section',
        h('h3', 'Повторні повідомлення'),
        h('p.small.muted', 'Бот надсилає їх тим, хто не відповів, за сценарієм сайту (Сайти → ⚙ Сценарій). {name} — ім’я чоловіка.'),
        followupSteps.map(followupBox)) : null,
      history.length ? h('section',
        h('h3', 'Попередні варіанти'),
        h('ul.invite-history', history.map((i) => h('li',
          h('p', i.text),
          h('div.row-wrap', h('small.muted', `${SOURCE[i.source] || i.source} · ${fmtDate(i.created_at)}`),
            h('button.btn.sm', { onclick: safe(async () => { await post(`/api/profiles/${p.id}/invites/${i.id}/activate`); toast('Інвайт активовано'); m.close(); openDetail(p.id); load(); }) }, 'Зробити активним'),
            owner ? h('button.btn.sm.ghost', { onclick: safe(async () => { await del(`/api/profiles/${p.id}/invites/${i.id}`); m.close(); openDetail(p.id); }) }, 'Видалити') : null))))) : null,
      owner ? h('div.danger-zone', h('button.btn.danger.ghost', { onclick: safe(async () => {
        if (!(await confirmDialog(`Видалити анкету «${p.name}» разом зі статистикою? Ліцензія звільниться.`, { ok: 'Видалити', danger: true }))) return;
        await del(`/api/profiles/${p.id}`);
        toast('Анкету видалено');
        m.close();
        load();
      }) }, 'Видалити анкету')) : null,
    ].filter(Boolean));
  }

  await load();
}
