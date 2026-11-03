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
};
const ACTIVE = ['running', 'waiting', 'sleeping', 'watching', 'limit'];
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

function updateNote() {
  const p = profiles.find((x) => String(x.id) === $('profile').value);
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

async function showMain(info) {
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
  if (!$('server').value) $('server').value = info.defaultServer;
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
    await init();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => { await send('logout'); init(); });
$('profile').addEventListener('change', updateNote);
$('test-mode').addEventListener('change', () => {
  $('start').textContent = $('test-mode').checked ? '🧪 Тест' : '▶ Старт';
  chrome.storage.local.set({ testMode: $('test-mode').checked });
});
chrome.storage.local.get('testMode').then(({ testMode }) => {
  $('test-mode').checked = Boolean(testMode);
  $('start').textContent = testMode ? '🧪 Тест' : '▶ Старт';
});

$('start').addEventListener('click', async () => {
  $('main-error').textContent = '';
  try {
    await send('start', { profileId: Number($('profile').value), tabId: await activeTabId(), test: $('test-mode').checked });
  } catch (e) { $('main-error').textContent = e.message; }
});
$('stop').addEventListener('click', () => send('stop').catch((e) => { $('main-error').textContent = e.message; }));
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
