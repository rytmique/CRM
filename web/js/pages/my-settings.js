import { h, field, input, select, textarea, busy, toast, safe } from '../ui.js';
import { get, put, post, del, patch, upload, blobUrl, session } from '../api.js';
import { getLang, setLang } from '../i18n.js';

const CHANCE = 300; // media step: the photos of «Шанс» letters
const EVERY = [[10, 'кожні 10 хв'], [15, 'кожні 15 хв'], [20, 'кожні 20 хв'], [30, 'кожні 30 хв'], [45, 'кожні 45 хв'], [60, 'щогодини'], [90, 'кожні 1,5 год'], [120, 'кожні 2 год']];
const TIMES = [1, 2, 3, 4, 5, 6].map((n) => [n, `${n} ${n === 1 ? 'раз' : n < 5 ? 'рази' : 'разів'} за ніч`]);
const WHO = [['silent', 'Хто замовк'], ['replied', 'Хто колись відповідав'], ['all', 'Усім чатам']];
const HOURS = Array.from({ length: 24 }, (_, i) => [i, `${String(i).padStart(2, '0')}:00`]);

/**
 * ⚙ Налаштування. Operator: the master prompt, how often «Шанс», how many «Аллчат» a night, the photos for «Шанс», the password.
 * Team lead: the same for the team (the defaults of everyone), the team and time zone.
 */
export default async function settingsPage(main) {
  const page = h('div.page');
  main.replaceChildren(page);
  const owner = session.user.role === 'owner';
  const [prefs, conf, { profiles }] = await Promise.all([get('/api/me/prefs'), owner ? get('/api/settings') : Promise.resolve(null), get('/api/profiles').catch(() => ({ profiles: [] }))]);

  // ---- the master prompt: mine (operator) / the team's (team lead) ----
  const base = owner ? (prefs.teamPrompt || prefs.defaultPrompt) : (prefs.prompt || prefs.teamPrompt || prefs.defaultPrompt);
  const prompt = textarea('prompt', base, { rows: 12, 'aria-label': 'Мастер-промпт' });
  // samples of invites and letters: the AI learns their style (separated by a line with ---)
  const SEP = '\n\n---\n\n';
  const samples = owner ? (conf.samples || { invites: [], letters: [] }) : (prefs.samples || prefs.teamSamples || { invites: [], letters: [] });
  const defaults = owner ? conf.defaultSamples : prefs.teamSamples;
  const invitesBox = textarea('sampleInvites', samples.invites.join(SEP), { rows: 9, 'aria-label': 'Взірці інвайтів' });
  const lettersBox = textarea('sampleLetters', samples.letters.join(SEP), { rows: 12, 'aria-label': 'Взірці листів' });
  const split = (t) => String(t || '').split(/\n\s*---\s*\n/).map((x) => x.trim()).filter(Boolean);
  const resetSamples = h('button.btn.ghost.sm', { type: 'button', onclick: () => { invitesBox.value = defaults.invites.join(SEP); lettersBox.value = defaults.letters.join(SEP); } }, owner ? '↺ Взірці агенції' : '↺ Взірці команди');
  const reset = h('button.btn.ghost.sm', { type: 'button', onclick: () => { prompt.value = owner ? prefs.defaultPrompt : (prefs.teamPrompt || prefs.defaultPrompt); } }, '↺ Стандартний');

  // ---- the shift ----
  const m = conf?.settings.modes;
  const every = select('everyMin', owner ? m.chance.everyMin : prefs.chanceEveryMin, EVERY);
  const times = select('perNight', owner ? m.allchat.perNight : prefs.allchatPerNight, TIMES);
  const team = owner ? {
    chanceOn: h('input', { type: 'checkbox', checked: m.chance.on }),
    online: h('input', { type: 'checkbox', checked: m.chance.onlineOnly }),
    acOn: h('input', { type: 'checkbox', checked: m.allchat.on }),
    who: select('who', m.allchat.who, WHO),
    silent: input('silentHours', m.allchat.silentHours, { type: 'number', min: 1, max: 72 }),
    gap: input('gapHours', m.allchat.gapHours, { type: 'number', min: 1, max: 12 }),
    reports: h('input', { type: 'checkbox', checked: conf.settings.reports.eachPass }),
    auto: h('input', { type: 'checkbox', checked: m.autoReply.on, disabled: !conf.autoReplyOpen }),
    name: input('agencyName', conf.agencyName),
    tz: input('timezone', conf.settings.timezone, { placeholder: 'Europe/Kyiv' }),
  } : null;

  // ---- the shift hours: the team lead sets them, an operator may narrow them for herself ----
  const ts = owner ? conf.settings.shift : prefs.teamShift;
  const shiftFrom = select('shiftFrom', owner ? ts.from : (prefs.myShift?.own ? prefs.myShift.from : ''), owner ? HOURS : [['', 'як у команди'], ...HOURS]);
  const shiftTo = select('shiftTo', owner ? ts.to : (prefs.myShift?.own ? prefs.myShift.to : ''), owner ? HOURS : [['', 'як у команди'], ...HOURS]);
  const autoShift = owner ? h('input', { type: 'checkbox', checked: ts.auto !== false }) : null;
  const shiftCard = h('section.card', h('h3', '⏰ Години зміни'),
    owner ? h('label.check', autoShift, h('span', h('b', 'Бот сам вмикається й вимикається'), ' за цими годинами')) : null,
    h('div.pair', field(owner ? 'Початок зміни' : 'Мій початок', shiftFrom), field(owner ? 'Кінець зміни' : 'Мій кінець', shiftTo)),
    h('p.small.muted', owner
      ? 'На початку зміни бот сам стартує в кожного: спершу Шанс, потім чекає відповідей і кілька разів за ніч — Аллчат. У кінці — сам вимикається до наступної зміни. Оператор може звузити години собі, але не вийти за ці межі.'
      : `Зміна команди: ${ts?.text || '—'}. Можна звузити години собі, але не вийти за межі команди. «Як у команди» — працюєте всю зміну.`));

  // ---- the language of the panel, the bot and Telegram ----
  const langSel = select('lang', getLang(), [['uk', 'Українська'], ['ru', 'Русский']]);
  langSel.addEventListener('change', () => put('/api/auth/lang', { lang: langSel.value }).then((r) => { session.user = r.user; setLang(r.user.lang); location.reload(); }).catch((e) => toast(e.message, 'err')));
  const langCard = h('section.card', h('h3', '🌐 Мова'), field('Мова панелі, бота й повідомлень у Telegram', langSel));

  const save = h('button.btn.primary', 'Зберегти');
  save.addEventListener('click', () => busy(save, async () => {
    if (owner) {
      await put('/api/settings', { agencyName: team.name.value, settings: {
        shift: { auto: autoShift.checked, from: Number(shiftFrom.value), to: Number(shiftTo.value) },
        timezone: team.tz.value || 'Europe/Kyiv',
        modes: {
          chance: { on: team.chanceOn.checked, everyMin: Number(every.value), onlineOnly: team.online.checked },
          allchat: { on: team.acOn.checked, perNight: Number(times.value), who: team.who.value, silentHours: Number(team.silent.value), gapHours: Number(team.gap.value) },
          autoReply: { on: team.auto.checked },
        },
        reports: { eachPass: team.reports.checked },
      } });
      await put('/api/prompts/team', { prompt: prompt.value });
      await put('/api/settings', { settings: { ai: { samples: { invites: split(invitesBox.value), letters: split(lettersBox.value) } } } });
    } else {
      const own = shiftFrom.value !== '' && shiftTo.value !== '';
      await put('/api/me/prefs', { prompt: prompt.value, chanceEveryMin: Number(every.value), allchatPerNight: Number(times.value),
        shiftFrom: own ? Number(shiftFrom.value) : null, shiftTo: own ? Number(shiftTo.value) : null,
        samples: { invites: split(invitesBox.value), letters: split(lettersBox.value) } });
    }
    toast('Збережено. Бот візьме нове при наступному запуску');
  }).catch(() => {}));

  const shift = h('section.card', h('h3', '🌙 Нічна зміна'),
    owner ? h('label.check', team.chanceOn, h('span', h('b', '🎯 Шанс'), ' — лист-інвайт з фото тим, кому ще не писали')) : h('p', h('b', '🎯 Шанс'), ' — лист-інвайт з фото онлайн-чоловікам, кому ще не писали.'),
    field('Як часто', every, owner ? 'Для всіх, хто не змінив собі' : null),
    owner ? h('label.check', team.online, 'Лише тим, хто онлайн') : null,
    owner ? h('label.check', team.acOn, h('span', h('b', '💬 Аллчат'), ' — повідомлення на тему розмови в постійні чати')) : h('p', h('b', '💬 Аллчат'), ' — повідомлення на тему розмови в постійні чати.'),
    field('Скільки разів за ніч', times, owner ? 'Для всіх, хто не змінив собі' : null),
    owner ? h('div.pair', field('Кому', team.who), field('«Замовк» — мовчить годин', team.silent)) : null,
    owner ? field('Пауза між повідомленнями в один чат, год', team.gap) : null,
    owner ? h('label.check', team.reports, '📲 Звіт у Telegram після кожної розсилки') : null,
    owner ? h('label.check', team.auto, h('span', '🔒 Бот сам продовжує розмову після відповіді', conf.autoReplyOpen ? null : h('span.small.muted', ' — скоро'))) : null,
    h('p.small.muted', 'Бот ніколи не пише туди, де чоловік чекає відповіді, і не відкриває непрочитані — відповідає жива людина.'));

  page.replaceChildren(...[
    h('div.page-head', h('h1', '⚙ Налаштування'), save),
    h('div.settings-grid',
      h('section.card.span-2', h('div.row-between', h('h3', owner ? '🧠 Мастер-промпт команди' : '🧠 Мій мастер-промпт'), reset), prompt,
        h('p.small.muted', owner ? 'Стиль текстів для всієї команди. Оператор може переписати собі свій.' : 'Як ШІ пише від імені ваших анкет. Порожньо або «Стандартний» — промпт команди.')),
      shiftCard,
      shift,
      h('section.card.span-2', h('div.row-between', h('h3', '📝 Взірці інвайтів і листів'), resetSamples),
        h('p.small.muted', 'ШІ вчиться на них стилю (не копіює). Кожен взірець — окремо, між ними рядок «---». Ім’я чоловіка можна писати як {name}.'
          + (owner ? ' Це взірці всієї команди; оператор може поставити собі свої.' : ' Порожньо або «Взірці команди» — беруться взірці тімліда.')),
        h('div.pair', field('Інвайти (з гачком на початку)', invitesBox), field('Листи', lettersBox)),
        h('p.small.muted', 'Бот ще й сам вчиться: інвайти, що отримали відповідь, ШІ бачить як приклади, а тип гачка, що відповідає найчастіше, пише частіше.')),
      photosCard(profiles),
      owner ? h('section.card', h('h3', '👥 Команда'), field('Назва', team.name), field('Часовий пояс', team.tz, 'Від нього рахуються ночі, ліміти й звіти (напр. Europe/Kyiv)')) : null,
      langCard,
      passwordCard()),
  ].filter(Boolean));
}

/** 📷 The photos of «Шанс» letters, per profile (the bot found the profiles on the site). */
function photosCard(profiles) {
  const box = h('section.card', h('h3', '📷 Фото для Шансу'));
  if (!profiles.length) {
    box.append(h('p.muted', 'Анкети з’являться тут самі, коли бот уперше відкриє сайт.'));
    return box;
  }
  const list = h('div.stack');
  const one = async (p) => {
    const row = h('div.photo-row', h('b', p.name, p.operator_name && session.user.role === 'owner' ? h('span.small.muted', ` · ${p.operator_name}`) : null));
    const strip = h('div.photo-strip');
    const add = h('label.btn.sm', '+ Фото', h('input', { type: 'file', accept: 'image/*', hidden: true, multiple: true, onchange: safe(async (e) => {
      for (const file of e.target.files) {
        await upload(`/api/profiles/${p.id}/media?steps=${CHANCE}`, file);
      }
      toast('Фото додано');
      draw();
    }) }));
    const draw = async () => {
      const { media } = await get(`/api/profiles/${p.id}/media`);
      const photos = media.filter((f) => f.type.startsWith('image/') && f.steps.includes(CHANCE));
      strip.replaceChildren(...photos.map((f) => {
        const t = h('div.photo', '🖼');
        blobUrl(`/api/profiles/${p.id}/media/${f.id}/file`).then((u) => t.replaceChildren(h('img', { src: u, alt: '' }))).catch(() => {});
        t.append(h('button.photo-x', { title: 'Прибрати з Шансу', onclick: safe(async () => {
          if (f.steps.length > 1) await patch(`/api/profiles/${p.id}/media/${f.id}`, { steps: f.steps.filter((x) => x !== CHANCE) });
          else await del(`/api/profiles/${p.id}/media/${f.id}`);
          draw();
        }) }, '✕'));
        return t;
      }), add);
    };
    row.append(strip);
    list.append(row);
    await draw().catch(() => strip.replaceChildren(add));
  };
  for (const p of profiles.slice(0, 40)) one(p);
  box.append(list, h('p.small.muted', 'Бот прикріплює ці фото до листа в «Шансі». Якщо сайт дає фото з галереї анкети (як «робочий стіл»), бот бере 2 фото звідти — тоді ці не потрібні.'));
  return box;
}

function passwordCard() {
  const cur = input('current', '', { type: 'password', autocomplete: 'current-password' });
  const next = input('next', '', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const btn = h('button.btn', 'Змінити пароль');
  btn.addEventListener('click', () => busy(btn, async () => {
    await post('/api/auth/password', { current: cur.value, next: next.value });
    cur.value = next.value = '';
    toast('Пароль змінено');
  }).catch(() => {}));
  return h('section.card', h('h3', '🔒 Мій пароль'), field('Поточний пароль', cur), field('Новий пароль (мін. 8)', next), btn);
}
