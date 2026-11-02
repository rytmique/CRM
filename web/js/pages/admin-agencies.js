import { h, field, input, formData, busy, toast, modal, badge, empty, fmtInt, fmtDate, copy, safe, confirmDialog } from '../ui.js';
import { get, post, patch, session } from '../api.js';

export function showKeys(keys) {
  const text = keys.join('\n');
  modal({
    title: `Видано ключів: ${keys.length}`,
    body: h('div', h('p.small.muted', 'Ключі вже з’явилися в розділі «Ліцензії» агенції. Керівник прив’язує їх до анкет.'), h('pre.keys', text)),
    actions: [h('button.btn.primary', { onclick: () => copy(text) }, 'Скопіювати всі')],
  });
}

function randomPassword(len = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => abc[b % abc.length]).join('');
}

/** Ready-to-send message with the client's access — the admin just copies it. */
export function accessModal({ title, email, password, licenses = 0, days = 0 }) {
  const text = [
    'Привіт! Ось твій доступ до Agency CRM:',
    '',
    `Панель: ${location.origin}`,
    `Логін: ${email}`,
    `Пароль: ${password}`,
    '',
    'Що зробити:',
    '1. Увійди в панель і зміни пароль (Налаштування → Мій пароль).',
    '2. На головній сторінці є «Перші кроки» — просто йди по них зверху вниз.',
    '3. Бот-розширення: розділ «Розширення» → «Завантажити».',
    licenses ? `\nЛіцензій: ${licenses} на ${days} днів — вони вже в розділі «Ліцензії».` : '',
  ].join('\n').trim();
  const area = h('textarea.access-text', { rows: 13, readonly: true });
  area.value = text;
  const m = modal({
    title,
    body: h('div.stack', h('p', 'Скопіюй і надішли клієнту в Telegram чи куди зручно. Пароль більше ніде не показується.'), area),
    actions: [h('button.btn', { onclick: () => m.close() }, 'Закрити'), h('button.btn.primary', { onclick: () => copy(text) }, 'Скопіювати повідомлення')],
  });
}

/** Downloads the whole database as one file (Bearer auth, so via fetch + blob). */
async function downloadBackup(btn) {
  await busy(btn, async () => {
    const res = await fetch('/api/admin/backup', { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new Error('Не вдалося зробити бекап');
    const blob = await res.blob();
    const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || 'agency-backup.db';
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Бекап завантажено — збережи файл у надійне місце');
  }).catch(() => {});
}

export default async function adminAgencies(main) {
  const page = h('div.page');
  main.replaceChildren(page);

  async function load() {
    const [{ agencies }, health] = await Promise.all([get('/api/admin/agencies'), get('/api/health')]);
    const backupBtn = h('button.btn', { title: 'Уся база одним файлом', onclick: () => downloadBackup(backupBtn) }, '⬇ Бекап');
    page.replaceChildren(
      health.persistentStorage === false ? h('div.alert.err', { role: 'alert' },
        h('b', '⚠ Диск не підключено — після наступного оновлення всі дані зникнуть.'),
        h('div', 'Railway → твій сервіс → правий клік → Attach Volume → шлях /data. Потім зайди сюди знову.')) : null,
      h('div.page-head', h('h1', 'Агенції', h('span.count', fmtInt(agencies.length))),
        h('div.row-wrap', backupBtn, h('button.btn.primary', { onclick: openForm }, '+ Нова агенція'))),
      h('div.card.table-wrap', agencies.length ? h('table.table',
        h('thead', h('tr', h('th', 'Агенція'), h('th', 'Керівник'), h('th.num', 'Операторів'), h('th.num', 'Анкет'), h('th.num', 'Діючих ліцензій'), h('th.num', 'Інвайтів за 30 дн'), h('th', 'Створено'), h('th', 'Статус'), h('th', ''))),
        h('tbody', agencies.map((a) => h('tr',
          h('td', h('b', a.name)),
          h('td', a.owner_email || '—'),
          h('td.num', fmtInt(a.operators)),
          h('td.num', fmtInt(a.profiles)),
          h('td.num', fmtInt(a.licenses_live)),
          h('td.num', fmtInt(a.sent_30d)),
          h('td', fmtDate(a.created_at, false)),
          h('td', h('button.btn.sm', { onclick: safe(async () => {
            await patch(`/api/admin/agencies/${a.id}`, { active: !a.active });
            toast(a.active ? 'Агенцію призупинено' : 'Агенцію активовано');
            load();
          }) }, a.active ? badge('Активна', 'ok') : badge('Призупинена', 'err'))),
          h('td.actions', h('button.btn.sm', { title: 'Якщо клієнт забув пароль', onclick: safe(async () => {
            if (!(await confirmDialog(`Згенерувати новий пароль для керівника «${a.name}»? Старий перестане діяти.`, { ok: 'Згенерувати' }))) return;
            const r = await post(`/api/admin/agencies/${a.id}/reset-owner`);
            accessModal({ title: `Новий доступ: ${a.name}`, email: r.email, password: r.password });
          }) }, 'Новий пароль')))))) : empty('Агенцій ще немає. Натисни «+ Нова агенція» — це твій перший клієнт (або тестова агенція для себе).')));
  }

  function openForm() {
    const form = h('form.form-grid',
      h('div.span-2', field('Назва агенції *', input('name', '', { required: true }))),
      field('Ім’я керівника *', input('ownerName', '', { required: true })),
      field('Email керівника (логін) *', input('ownerEmail', '', { required: true, type: 'email' })),
      field('Пароль керівника *', input('ownerPassword', randomPassword(), { required: true, minlength: 8, autocomplete: 'off' }), 'Вже згенеровано — можна залишити'),
      h('div.pair', field('Ліцензій одразу', input('licenses', 5, { type: 'number', min: 0, max: 500 })), field('днів кожна', input('days', 30, { type: 'number', min: 1, max: 3650 }))));
    const save = h('button.btn.primary', 'Створити');
    const m = modal({ title: 'Нова агенція', body: form, actions: [h('button.btn', { onclick: () => m.close() }, 'Скасувати'), save] });
    const submit = () => busy(save, async () => {
      if (!form.reportValidity()) return;
      const data = formData(form);
      const r = await post('/api/admin/agencies', data);
      m.close();
      load();
      accessModal({ title: `Готово! Агенцію «${data.name}» створено`, email: data.ownerEmail, password: data.ownerPassword, licenses: r.keys.length, days: data.days });
    }).catch(() => {});
    save.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  await load();
}
