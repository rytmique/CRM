import { h, field, input, textarea, select, formData, busy, toast, modal, confirmDialog, badge, avatar, empty, fmtInt, fmtDate, safe } from '../ui.js';
import { get, post, patch, put, del, upload, blobUrl } from '../api.js';
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
  let refs = { operators: [], sites: [], licenses: [], templates: [] };
  let q = '';
  let statusFilter = '';

  async function loadRefs() {
    if (!owner) {
      // Operators add their own profiles; a free license is taken from the agency pool by itself.
      const [sites, sc] = await Promise.all([get('/api/sites'), get('/api/scenarios')]);
      refs = { operators: [], sites: sites.sites, licenses: [], templates: sc.templates };
      return;
    }
    const [ops, sites, lic, sc] = await Promise.all([get('/api/operators'), get('/api/sites'), get('/api/licenses'), get('/api/scenarios')]);
    refs = { operators: ops.operators, sites: sites.sites, licenses: lic.licenses, templates: sc.templates };
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
        : empty(all.length ? 'Нічого не знайдено' : 'Додайте першу анкету — бот почне розсилку інвайтів з неї.',
          !all.length ? h('button.btn.primary', { onclick: safe(() => openForm()) }, '+ Додати анкету') : null));
    };
    renderTable();
    page.replaceChildren(
      h('div.page-head', h('h1', owner ? 'Анкети' : 'Мої анкети', h('span.count', fmtInt(all.length))),
        h('button.btn.primary', { onclick: safe(() => openForm()) }, '+ Додати анкету')),
      h('div.toolbar', search, status),
      tableBox);
  }

  // ---------- create / edit ----------
  async function openForm(p = null) {
    await loadRefs();
    const freeLicenses = refs.licenses.filter((l) => (l.state === 'free') || (p && l.profile_id === p.id));
    const { defaultPrompt, promptVars } = await get('/api/settings/prompt-info');
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
      field('ID анкети на сайті', input('site_profile_id', p?.site_profile_id, { maxlength: 120 }), 'Її ID на сайті. Потрібно для 🔁 «Міняти анкети»: бот перемикає жінку на сайті й перевіряє, що пише саме від неї'),
      owner ? field('Оператор', select('operator_id', p?.operator_id, [['', '— не призначено —'], ...refs.operators.filter((o) => o.active).map((o) => [o.id, o.name])], { 'data-num': '' })) : null,
      field('Сценарій', select('scenario_id', p?.scenario_id, [['', 'Як у сайту (за замовчуванням)'], ...refs.templates.map((t) => [t.id, `Шаблон: ${t.name}`])], { 'data-num': '' }),
        refs.templates.length ? 'Можна дати цій анкеті свій сценарій' : 'Шаблони створюються в «Сайти» → «Шаблони сценаріїв»'),
      owner
        ? field('Ліцензія', select('license_id', p?.license?.id, licOptions, { 'data-num': '' }), refs.licenses.length ? 'Термін іде з моменту першої прив’язки' : 'Ліцензій немає — зверніться до постачальника')
        : h('p.small.muted', p ? '' : '🔑 Ліцензія підбереться сама з вільних ліцензій агенції.'),
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
      let created = null;
      if (p) await patch(`/api/profiles/${p.id}`, data);
      else created = await post('/api/profiles', data);
      toast(p ? 'Збережено' : created?.licensed === false && !owner ? 'Анкету створено, але вільних ліцензій немає — попросіть керівника' : 'Анкету створено');
      m.close();
      await load();
      if (p) openDetail(p.id);
    }).catch(() => {});
    saveBtn.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  // ---------- details + invites ----------
  async function openDetail(id) {
    const { profile: p, invites, followups = [], followupSteps = [], funnel, media = [], steps: stepCount = 1, scenarioName, reengage, afterReply, bestInvite, variantsWanted = 3, letter, usesLetters } = await get(`/api/profiles/${id}`);
    const body = h('div.detail');
    const m = modal({ title: `${p.name}${p.age ? `, ${p.age}` : ''}`, body, wide: true });

    // ---------- invite variants (A/B test): the bot sends the ones that get more replies more often ----------
    const live = invites.filter((i) => i.active);
    const pct = (i) => (i.sent ? `${Math.round((i.replies / i.sent) * 1000) / 10}%` : '—');
    const variantCard = (i) => {
      const ta = textarea(`inv-${i.id}`, i.text, { rows: 4, maxlength: 1000 });
      const counter = h('small.hint');
      const upd = () => { counter.textContent = `${ta.value.length} символів · {name} підставляється ім’ям чоловіка`; };
      ta.addEventListener('input', upd);
      upd();
      const save = h('button.btn.sm', 'Зберегти правки');
      save.addEventListener('click', () => busy(save, async () => {
        await patch(`/api/profiles/${p.id}/invites/${i.id}`, { text: ta.value });
        toast('Збережено');
      }).catch(() => {}));
      const off = h('button.btn.sm.ghost', { disabled: live.length <= 1, title: live.length <= 1 ? 'Останній варіант не вимикається' : '' }, '⏸ Вимкнути');
      off.addEventListener('click', () => busy(off, async () => {
        await post(`/api/profiles/${p.id}/invites/${i.id}/retire`);
        toast('Варіант вимкнено');
        reopen();
      }).catch(() => {}));
      return h(`div.variant${i.id === bestInvite ? '.best' : ''}`,
        h('div.row-wrap.small',
          i.id === bestInvite ? badge('🏆 найкращий', 'ok') : null,
          badge(SOURCE[i.source] || i.source, 'muted'),
          h('span', `надіслано ${fmtInt(i.sent)} · відповіли ${fmtInt(i.replies)} · `, h('b', pct(i)))),
        ta, counter, h('div.row-wrap', save, off));
    };
    const genBtn = h('button.btn.primary', { disabled: live.length >= 5 }, '✨ Ще варіант (ШІ)');
    genBtn.addEventListener('click', () => busy(genBtn, async () => {
      const r = await post(`/api/profiles/${p.id}/invites/generate`, { variant: true });
      toast(r.invite.source === 'template' ? 'Згенеровано шаблоном (ключ Claude не налаштовано)' : 'Новий варіант додано', r.invite.source === 'template' ? 'warn' : 'ok');
      reopen();
      load();
    }).catch(() => {}));
    const ownBtn = h('button.btn', { disabled: live.length >= 5 }, '+ Свій варіант');
    ownBtn.addEventListener('click', () => {
      const ta = textarea('own', '', { rows: 5, maxlength: 1000, placeholder: 'Hi {name}! …' });
      const ok = h('button.btn.primary', 'Додати');
      const mm = modal({ title: 'Свій варіант інвайту', body: h('div', ta, h('p.small.muted', '{name} — ім’я чоловіка. Варіант одразу піде в ротацію.')), actions: [h('button.btn', { onclick: () => mm.close() }, 'Скасувати'), ok] });
      ok.addEventListener('click', () => busy(ok, async () => {
        await post(`/api/profiles/${p.id}/invites`, { text: ta.value, variant: true });
        toast('Варіант додано');
        mm.close();
        reopen();
      }).catch(() => {}));
    });

    const history = invites.filter((i) => !i.active);
    const reopen = () => { m.close(); openDetail(p.id); };
    // ---------- files the bot attaches ----------
    const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
    const mediaCard = (f) => {
      const thumb = h('div.media-thumb', f.type.startsWith('image/') ? '🖼' : f.type.startsWith('video/') ? '🎬' : f.type.startsWith('audio/') ? '🎵' : '📄');
      if (f.type.startsWith('image/')) blobUrl(`/api/profiles/${p.id}/media/${f.id}/file`).then((u) => thumb.replaceChildren(h('img', { src: u, alt: '' }))).catch(() => {});
      const boxes = Array.from({ length: Math.max(stepCount, ...f.steps) }, (_, i) => i + 1).map((n) => h('label.check.small',
        h('input', { type: 'checkbox', checked: f.steps.includes(n), onchange: safe(async (e) => {
          const next = e.target.checked ? [...new Set([...f.steps, n])] : f.steps.filter((x) => x !== n);
          await patch(`/api/profiles/${p.id}/media/${f.id}`, { steps: next });
          f.steps = next;
        }) }), `крок ${n}`));
      return h('div.media-card', thumb,
        h('div.media-info', h('b.clamp', { title: f.name }, f.name), h('span.small.muted', fmtSize(f.size)),
          h('div.row-wrap', boxes),
          h('button.btn.sm.ghost', { onclick: safe(async () => { await del(`/api/profiles/${p.id}/media/${f.id}`); toast('Файл видалено'); reopen(); }) }, '✕ Видалити')));
    };
    const picker = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*,application/pdf', hidden: true });
    const addFiles = h('button.btn.sm.primary', '+ Додати файли з ПК');
    addFiles.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => busy(addFiles, async () => {
      let n = 0;
      for (const file of picker.files) {
        if (file.size > 15 * 1024 * 1024) { toast(`«${file.name}» більше 15 МБ — пропущено`, 'warn'); continue; }
        await upload(`/api/profiles/${p.id}/media`, file);
        n++;
      }
      if (n) toast(`Додано файлів: ${n}`);
      reopen();
    }).catch(() => reopen()));
    const filesSection = h('section',
      h('h3', '📎 Файли до повідомлень'),
      h('p.small.muted', 'Фото чи відео, які бот сам прикріплює до повідомлень. Позначте, на якому кроці сценарію надсилати файл. У сценарії можна вибрати «усі» або «один випадковий». До 15 МБ, до 30 файлів.'),
      media.length ? h('div.media-grid', media.map(mediaCard)) : null,
      h('div.row-wrap', addFiles, picker));

    const REENGAGE = 100;
    const LETTER = 200;
    const followupBox = (step) => {
      const f = step === REENGAGE ? reengage : step === LETTER ? letter : followups.find((x) => x.step === step);
      const ta = textarea(`followup-${step}`, f?.text || '', step >= REENGAGE
        ? { rows: step === LETTER ? 10 : 6, maxlength: 3000, placeholder: step === LETTER ? 'Ще не написано — з’явиться при першому запуску бота або натисніть ✨' : 'Ще не написано — з’явиться при першому запуску бота або натисніть ✨. Варіанти розділяйте рядком ---' }
        : { rows: 3, maxlength: 1000, placeholder: 'Ще не написано — з’явиться при першому запуску бота або натисніть ✨' });
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
      return h('div.followup-box', h('b.small', step === REENGAGE ? 'Нагадування (бот бере випадковий варіант)' : step === LETTER ? 'Лист' : `Спроба ${step}`, f ? h('span.muted', ` · ${SOURCE[f.source] || f.source}`) : null), ta, h('div.row-wrap', gen, save));
    };
    body.append(...[
      h('div.detail-head',
        avatar(p.name, p.photo_url),
        h('div', h('div.row-wrap', licenseBadge(p.license), botBadge(p), p.status === 'paused' ? badge('Пауза', 'muted') : badge('Активна', 'ok'), p.prompt ? badge('Свій промт', 'accent') : null),
          h('div.small.muted', [p.city, p.country].filter(Boolean).join(', '), p.site_name ? ` · ${p.site_name}` : '', p.operator_name ? ` · оператор: ${p.operator_name}` : '')),
        h('div.row-wrap.right',
          h('button.btn', { onclick: safe(async () => { await patch(`/api/profiles/${p.id}`, { status: p.status === 'active' ? 'paused' : 'active' }); toast(p.status === 'active' ? 'Анкету поставлено на паузу — бот зупиниться' : 'Анкету активовано'); m.close(); load(); openDetail(p.id); }) },
            p.status === 'active' ? '⏸ Пауза' : '▶ Активувати'),
          !owner && !p.license?.valid ? h('button.btn', { onclick: safe(async () => { await post(`/api/profiles/${p.id}/license/auto`); toast('Ліцензію прив’язано'); m.close(); load(); openDetail(p.id); }) }, '🔑 Взяти вільну ліцензію') : null,
          h('button.btn', { onclick: safe(() => { m.close(); return openForm(p); }) }, '✎ Редагувати'))),
      h('div.stat-row',
        h('div', h('b', fmtInt(p.sent_today)), h('span', `сьогодні з ${p.limits.dailyLimit}`)),
        h('div', h('b', fmtInt(p.replies_today)), h('span', 'відповідей сьогодні')),
        h('div', h('b', fmtInt(p.sent_total)), h('span', 'інвайтів усього')),
        h('div', h('b', p.sent_total ? `${Math.round((p.replies_total / p.sent_total) * 1000) / 10}%` : '—'), h('span', 'конверсія'))),
      funnel ? h('div.funnel',
        h('span', `↻ чекають повторної спроби: ${fmtInt(funnel.waiting)}`),
        h('span', `🚫 не відповіли на всі спроби: ${fmtInt(funnel.done)}`),
        h('span', `💌 відповіли: ${fmtInt(funnel.replied)}`),
        funnel.talking ? h('span', `💬 у розмові (бот нагадає, якщо замовкне): ${fmtInt(funnel.talking)}`) : null,
        funnel.negative ? h('span', `🙅 «не цікаво»: ${fmtInt(funnel.negative)}`) : null) : null,
      h('section',
        h('h3', 'Інвайти', badge(`у ротації: ${live.length}`, 'accent')),
        h('p.small.muted', `Бот пише новим чоловікам одним із варіантів і частіше бере той, на який більше відповідають. Слабкі варіанти він сам вимикає й пише нові, щоб у ротації було ${variantsWanted} (Налаштування → ШІ). Відповіді веде жінка сама.`),
        live.length ? h('div.variants', live.map(variantCard)) : h('p.muted', 'Ще немає — з’явиться при першому запуску бота або натисніть ✨'),
        h('div.row-wrap', genBtn, ownBtn)),
      filesSection,
      followupSteps.length ? h('section',
        h('h3', 'Повторні повідомлення', scenarioName ? badge(`шаблон: ${scenarioName}`, 'accent') : null),
        h('p.small.muted', 'Бот надсилає їх тим, хто не відповів, за сценарієм сайту (Сайти → ⚙ Сценарій). {name} — ім’я чоловіка.'),
        followupSteps.map(followupBox)) : null,
      usesLetters || letter ? h('section',
        h('h3', '✉ Лист'),
        h('p.small.muted', 'Довший лист через пошту сайту — якщо в сценарії є крок «✉ листом». Тема — перший рядок. {name} — ім’я чоловіка.'),
        followupBox(LETTER)) : null,
      afterReply?.attempts ? h('section',
        h('h3', 'Після відповіді: якщо він замовк'),
        h('p.small.muted', `Через ${afterReply.silenceHours} год тиші бот нагадає про себе, далі кожні ${afterReply.everyHours} год, до ${afterReply.attempts} разів (+${afterReply.attempts} за кожну нову відповідь). {name} — ім’я чоловіка.`),
        followupBox(REENGAGE)) : null,
      history.length ? h('section',
        h('h3', 'Вимкнені варіанти'),
        h('ul.invite-history', history.map((i) => h('li',
          h('p', i.text),
          h('div.row-wrap', h('small.muted', `${SOURCE[i.source] || i.source} · ${fmtDate(i.created_at)} · надіслано ${fmtInt(i.sent || 0)}, відповіли ${pct(i)}${i.retired_at ? ' · вимкнув бот або ви' : ''}`),
            h('button.btn.sm', { disabled: live.length >= 5, onclick: safe(async () => { await post(`/api/profiles/${p.id}/invites/${i.id}/activate`, { add: true }); toast('Повернуто в ротацію'); reopen(); load(); }) }, '↺ Повернути в ротацію'),
            h('button.btn.sm.ghost', { onclick: safe(async () => { await del(`/api/profiles/${p.id}/invites/${i.id}`); m.close(); openDetail(p.id); }) }, 'Видалити')))))) : null,
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
