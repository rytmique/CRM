const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type, ...extra }, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    res?.ok ? resolve(res.data) : reject(new Error(res?.error || 'Помилка'));
  });
});

const STATUS = {
  idle: ['Не запущено', ''],
  running: ['Працює', 'on'],
  waiting: ['Пауза між повідомленнями', 'on'],
  sleeping: ['Неробочий час · стежить за відповідями', 'warn'],
  watching: ['Стежить за відповідями', 'on'],
  limit: ['Ліміт вичерпано · стежить за відповідями', 'warn'],
  stopped: ['Зупинено', ''],
  error: ['Помилка', 'err'],
  blocked: ['🛑 Капча / блок — потрібна людина', 'err'],
};
const ACTIVE = ['running', 'waiting', 'sleeping', 'watching', 'limit', 'blocked'];
let profiles = [];
let current = null;

function fmtTime(t) {
  return new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function render(s) {
  current = s;
  let [label, cls] = STATUS[s.status] || STATUS.idle;
  if (s.test) label = { running: '🧪 Тест іде', stopped: '🧪 Тест завершено', error: '🧪 Тест: є проблеми' }[s.status] || label;
  document.body.classList.toggle('testing', Boolean(s.test) && s.status !== 'idle');
  $('s-sent-label').textContent = s.test ? 'перевірено' : 'надіслано';
  $('status-text').textContent = s.profileName && s.status !== 'idle' ? `${label} — ${s.profileName}` : label;
  $('dot').className = `dot ${cls}`;
  $('status-msg').textContent = s.message || '';
  $('s-sent').textContent = s.sent ?? 0;
  $('s-replies').textContent = s.replies ?? 0;
  $('s-remaining').textContent = s.remaining ?? '—';
  $('pending').hidden = !s.pending && !s.followups;
  $('pending').textContent = `↻ Повторні спроби: зроблено ${s.followups || 0}, чекають ${s.pending || 0}`;
  const active = ACTIVE.includes(s.status);
  $('start').hidden = active;
  $('stop').hidden = !active;
  $('profile').disabled = active;
  $('test-mode').disabled = active;
  $('test-full').disabled = active;
  $('rotate').disabled = active;
  $('teach').disabled = active;
  $('invite-box').hidden = !s.inviteText;
  $('invite').textContent = s.inviteText || '';
  if (active && s.profileId) $('profile').value = String(s.profileId);
  const log = $('log');
  log.replaceChildren(...(s.log || []).slice(0, 40).map((e) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmtTime(e.t);
    const span = document.createElement('span');
    span.textContent = e.text;
    span.className = e.level;
    li.append(time, span);
    return li;
  }));
}

function renderProfiles() {
  const sel = $('profile');
  const prev = sel.value;
  sel.replaceChildren(...profiles.map((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    const lic = p.license.valid ? '' : ' · ⛔ без ліцензії';
    const paused = p.status !== 'active' ? ' · пауза' : '';
    o.textContent = `${p.name}${p.age ? `, ${p.age}` : ''} — ${p.site_name || 'сайт не вибрано'} (${p.sentToday}/${p.dailyLimit})${lic}${paused}`;
    return o;
  }));
  if (!profiles.length) {
    const o = document.createElement('option');
    o.textContent = 'Немає призначених анкет';
    o.value = '';
    sel.append(o);
  }
  if (prev && profiles.some((p) => String(p.id) === prev)) sel.value = prev;
  else if (current?.profileId) sel.value = String(current.profileId);
  updateNote();
}

/** "За руку": the one next thing to do, and the button to press glows. */
function updateGuide(p) {
  const g = $('guide');
  for (const id of ['teach', 'start', 'test-mode']) $(id).classList.remove('pulse');
  let html = '';
  let glow = null;
  if (!profiles.length) {
    html = '<b>Крок 1.</b> Створіть анкету в панелі: розділ <b>🚀 Підключення</b> покаже, що робити.';
  } else if (p && p.license.valid && p.status === 'active' && !ACTIVE.includes(current?.status)) {
    if (!p.siteReady) {
      html = '<b>Навчіть бота сайту:</b> відкрийте на сайті сторінку пошуку чоловіків і натисніть <b>🎯 Навчити бота</b> нижче. Далі — підказки на сторінці.';
      glow = 'teach';
    } else if (!p.tested) {
      html = '<b>Перевірте без відправки:</b> поставте галочку <b>🧪 Тест-режим</b> і натисніть <b>🧪 Тест</b>.';
      glow = $('test-mode').checked ? 'start' : 'test-mode';
    } else if (!p.started) {
      html = '<b>Усе готово!</b> Зніміть галочку тесту й натисніть <b>▶ Старт</b>. Щоб бот вмикався сам щодня — <b>⏰ Автопілот</b>.';
      glow = $('test-mode').checked ? 'test-mode' : 'start';
    }
  }
  g.innerHTML = html;
  g.hidden = !html;
  if (glow) $(glow).classList.add('pulse');
}

function updateNote() {
  const p = profiles.find((x) => String(x.id) === $('profile').value);
  updateGuide(p);
  let note = '';
  if (p) {
    if (!p.license.valid) note = 'Анкета без дійсної ліцензії — бот не запуститься.';
    else if (p.license.daysLeft <= 3) note = `Ліцензія закінчується через ${p.license.daysLeft} дн.`;
    if (p.status !== 'active') note = 'Анкету поставлено на паузу в панелі.';
  }
  $('profile-note').textContent = note;
  $('start').disabled = !p || !p.license.valid || p.status !== 'active';
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function renderAutopilot(ap) {
  const on = Boolean(ap?.on);
  $('autopilot').checked = on;
  $('autopilot-text').textContent = on
    ? `— ${ap.profileName ? `${ap.profileName}, ` : ''}${ap.schedule || 'за розкладом'}`
    : '— сам вмикається й вимикається за розкладом';
}

async function showMain(info) {
  renderAutopilot(info.autopilot);
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  $('logout').hidden = false;
  $('who').textContent = info.auth.user?.name || '';
  $('panel-link').href = info.auth.server;
  render(info.state);
  try {
    profiles = (await send('profiles')).profiles;
    renderProfiles();
  } catch (e) {
    $('main-error').textContent = e.message;
    if (/увійдіть|Сесія/.test(e.message)) init();
  }
  send('seen').catch(() => {});
}

function showLogin(info) {
  $('main-view').hidden = true;
  $('login-view').hidden = false;
  $('logout').hidden = true;
  $('who').textContent = '';
  // What was typed survives the popup closing (it closes on any click outside)
  chrome.storage.session.get('loginDraft').then(({ loginDraft: d }) => {
    $('server').value = d?.server || $('server').value || info.defaultServer;
    if (d?.email) $('email').value = d.email;
    if (d?.password) $('password').value = d.password;
  }).catch(() => { if (!$('server').value) $('server').value = info.defaultServer; });
}
for (const id of ['server', 'email', 'password']) {
  $(id).addEventListener('input', () => chrome.storage.session.set({ loginDraft: { server: $('server').value, email: $('email').value, password: $('password').value } }).catch(() => {}));
}

async function init() {
  const info = await send('state');
  info.auth ? showMain(info) : showLogin(info);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await send('login', { server: $('server').value, email: $('email').value, password: $('password').value });
    $('password').value = '';
    chrome.storage.session.remove('loginDraft').catch(() => {});
    await init();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => { await send('logout'); init(); });
$('profile').addEventListener('change', updateNote);
$('test-full').addEventListener('change', () => chrome.storage.local.set({ testFull: $('test-full').checked }));
$('test-mode').addEventListener('change', () => {
  $('start').textContent = $('test-mode').checked ? '🧪 Тест' : '▶ Старт';
  $('test-full-row').hidden = !$('test-mode').checked;
  updateNote();
  chrome.storage.local.set({ testMode: $('test-mode').checked });
});
chrome.storage.local.get(['testMode', 'testFull']).then(({ testMode, testFull }) => {
  $('test-mode').checked = Boolean(testMode);
  $('test-full').checked = Boolean(testFull);
  $('test-full-row').hidden = !testMode;
  $('start').textContent = testMode ? '🧪 Тест' : '▶ Старт';
});

$('start').addEventListener('click', async () => {
  $('main-error').textContent = '';
  try {
    await send('start', { profileId: Number($('profile').value), tabId: await activeTabId(), test: $('test-mode').checked, full: $('test-mode').checked && $('test-full').checked, rotate: $('rotate').checked });
  } catch (e) { $('main-error').textContent = e.message; }
});
$('stop').addEventListener('click', () => send('stop').catch((e) => { $('main-error').textContent = e.message; }));
const SPEED_TEXT = { 1: '🐢🐢 дуже повільно', 2: '🐢 повільно', 3: 'звичайний', 4: '⚡ швидко', 5: '⚡⚡ дуже швидко' };
const showSpeed = (v) => { $('speed').value = String(v); $('speed-text').textContent = SPEED_TEXT[v] || SPEED_TEXT[3]; };
chrome.storage.local.get('speed').then(({ speed }) => showSpeed(speed || 3));
$('speed').addEventListener('input', () => {
  const v = Number($('speed').value);
  showSpeed(v);
  chrome.storage.local.set({ speed: v }); // the running bot picks it up at once
});
chrome.storage.local.get('rotate').then(({ rotate }) => { $('rotate').checked = Boolean(rotate); });
$('rotate').addEventListener('change', () => chrome.storage.local.set({ rotate: $('rotate').checked }));
$('autopilot').addEventListener('change', async () => {
  $('main-error').textContent = '';
  const on = $('autopilot').checked;
  try {
    const r = await send('autopilot', { on, profileId: Number($('profile').value) });
    const info = await send('state');
    renderAutopilot(info.autopilot);
    $('main-info').textContent = r.on ? `⏰ Автопілот: ${r.schedule}. Змінити дні й години — у панелі: Сайти → ⚙ Сценарій.` : 'Автопілот вимкнено';
  } catch (e) {
    $('autopilot').checked = !on;
    $('main-error').textContent = e.message;
  }
});
$('inbox').addEventListener('click', async () => {
  $('main-error').textContent = '';
  $('main-info').textContent = 'Перевіряю вхідні…';
  try {
    const r = await send('checkInbox');
    $('main-info').textContent = r.new ? `Нових відповідей: ${r.new}` : 'Нових відповідей немає';
  } catch (e) { $('main-info').textContent = ''; $('main-error').textContent = e.message; }
});
$('teach').addEventListener('click', async () => {
  $('main-error').textContent = '';
  try {
    await send('teach', { profileId: Number($('profile').value), tabId: await activeTabId() });
    window.close();
  } catch (e) { $('main-error').textContent = e.message; }
});
$('report').addEventListener('click', async () => {
  $('main-error').textContent = '';
  $('main-info').textContent = 'Готую звіт…';
  try {
    const r = await send('report', { profileId: Number($('profile').value), tabId: await activeTabId() });
    await navigator.clipboard.writeText(r.text);
    $('main-info').textContent = '📋 Звіт скопійовано — встав його в повідомлення розробнику. Імен, ID і даних сайту в ньому немає.';
  } catch (e) { $('main-info').textContent = ''; $('main-error').textContent = `Звіт не вдався: ${e.message}`; }
});
$('probe').addEventListener('click', async () => {
  $('main-error').textContent = '';
  $('main-info').textContent = 'Перевіряю сторінку…';
  try {
    const r = await send('probe', { profileId: Number($('profile').value), tabId: await activeTabId() });
    const sample = r.sample.map((m) => `${m.name || '?'}${m.age ? ` ${m.age}` : ''} [${m.id}]`).join('; ');
    $('main-info').textContent = r.cards
      ? `✓ Бачу чоловіків: ${r.cards}. Наприклад: ${sample}. Наступна сторінка: ${r.nextPage ? 'є' : 'немає'}`
      : `Карток чоловіків на цій сторінці не знайдено${r.inboxItems ? ` (діалогів у вхідних: ${r.inboxItems})` : ''}. Перевірте селектори сайту в панелі.`;
  } catch (e) { $('main-info').textContent = ''; $('main-error').textContent = `Перевірка не вдалась: ${e.message}`; }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state?.newValue) return;
  const prev = changes.state.oldValue?.status;
  render(changes.state.newValue);
  if (prev !== changes.state.newValue.status || changes.state.newValue.sent !== changes.state.oldValue?.sent) {
    send('profiles').then((r) => { profiles = r.profiles; renderProfiles(); }).catch(() => {});
  }
});

init().catch((e) => { $('login-error').textContent = e.message; showLogin({ defaultServer: '' }); });
