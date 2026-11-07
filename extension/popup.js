const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type, ...extra }, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    res?.ok ? resolve(res.data) : reject(new Error(res?.error || 'Помилка'));
  });
});

const STATUS = {
  idle: ['Вимкнено', ''],
  running: ['Працює', 'on'],
  waiting: ['Пауза між повідомленнями', 'on'],
  sleeping: ['Неробочий час · стежить за відповідями', 'warn'],
  watching: ['Працює · стежить за відповідями', 'on'],
  limit: ['Ліміт на сьогодні · стежить за відповідями', 'warn'],
  stopped: ['Вимкнено', ''],
  error: ['Помилка', 'err'],
  blocked: ['🛑 Капча / блок — потрібна людина', 'err'],
};
const ACTIVE = ['running', 'waiting', 'sleeping', 'watching', 'limit', 'blocked'];
const fmtTime = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

function render(s) {
  let [label, cls] = STATUS[s.status] || STATUS.idle;
  if (s.test) label = { running: '🧪 Тест іде', stopped: '🧪 Тест завершено', error: '🧪 Тест: є проблеми' }[s.status] || label;
  document.body.classList.toggle('testing', Boolean(s.test) && s.status !== 'idle');
  $('s-sent-label').textContent = s.test ? 'перевірено' : 'надіслано';
  $('status-text').textContent = label;
  $('dot').className = `dot ${cls}`;
  $('status-msg').textContent = s.message || '';
  $('s-sent').textContent = s.sent ?? 0;
  $('s-replies').textContent = s.replies ?? 0;
  $('s-profile').textContent = ACTIVE.includes(s.status) && s.profileName ? s.profileName : '—';
  const active = ACTIVE.includes(s.status);
  $('start').hidden = active;
  $('stop').hidden = !active;
  $('test-mode').disabled = active;
  $('hint').hidden = active;
  $('log').replaceChildren(...(s.log || []).slice(0, 40).map((e) => {
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
  send('profiles').then((r) => renderUpdate(r.bot)).catch((e) => {
    $('main-error').textContent = e.message;
    if (/увійдіть|Сесія/.test(e.message)) init();
  });
  send('seen').catch(() => {});
}

// ---------- 🔄 a new version of the bot ----------
const newer = (a, b) => { // a > b ("1.3.0" > "1.2.9")
  const pa = String(a || '0').split('.').map(Number); const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
async function renderUpdate(bot) {
  const box = $('update');
  const mine = chrome.runtime.getManifest().version;
  const { updateTried } = await chrome.storage.local.get('updateTried');
  if (!bot?.latest || !newer(bot.latest, mine)) {
    box.hidden = true;
    if (updateTried) chrome.storage.local.remove('updateTried');
    return;
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const head = el('div', 'update-head');
  head.append(el('b', '', `🔄 Є нова версія бота: ${bot.latest}`), el('span', 'muted', ` (у вас ${mine})`));
  const steps = el('ol', 'update-steps');
  const dl = el('button', 'primary', '⬇ Завантажити оновлення');
  const li1 = el('li'); li1.append(dl);
  const li2 = el('li', '', 'Розпакуйте архів туди ж, куди першого разу, — із заміною файлів (Windows спитає «Замінити?» → «Так»).');
  const restart = el('button', '', '🔄 Перезапустити бота');
  const manual = el('a', 'small', 'Не спрацювало? Відкрити сторінку розширень і натиснути ⟳ біля Agency Bot');
  manual.href = '#';
  manual.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions' }); });
  const li3 = el('li'); li3.append(restart, manual);
  steps.append(li1, li2, li3);
  const note = el('p', 'small muted');
  if (updateTried === mine) note.textContent = '⚠ Версія не змінилась: схоже, архів розпаковано в іншу папку. Потрібна саме та папка, яку вибирали в chrome://extensions → «Завантажити розпаковане».';
  else if (bot.min && newer(bot.min, mine)) note.textContent = 'Ця версія вже застаріла — бот не запуститься, доки не оновите.';
  dl.addEventListener('click', async () => {
    dl.disabled = true;
    try {
      const { auth } = await chrome.storage.local.get('auth');
      const res = await fetch(`${auth.server}/api/extension/download`, { headers: { authorization: `Bearer ${auth.token}` } });
      if (!res.ok) throw new Error(`помилка ${res.status}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = 'agency-bot.zip';
      document.body.append(a);
      a.click();
      a.remove();
      dl.textContent = '✓ Завантажено — тепер крок 2';
    } catch (e) {
      dl.disabled = false;
      $('main-error').textContent = `Не вдалося завантажити: ${e.message}`;
    }
  });
  restart.addEventListener('click', () => send('reload').catch(() => {}));
  box.replaceChildren(head, steps, note);
  box.hidden = false;
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
const showTest = () => { $('start').textContent = $('test-mode').checked ? '🧪 Запустити тест' : '▶ Увімкнути'; };
$('test-mode').addEventListener('change', () => { showTest(); chrome.storage.local.set({ testMode: $('test-mode').checked }); });
chrome.storage.local.get('testMode').then(({ testMode }) => { $('test-mode').checked = Boolean(testMode); showTest(); });

$('start').addEventListener('click', async () => {
  $('main-error').textContent = '';
  try {
    await send('start', { tabId: await activeTabId(), test: $('test-mode').checked });
  } catch (e) { $('main-error').textContent = e.message; }
});
$('stop').addEventListener('click', () => send('stop').catch((e) => { $('main-error').textContent = e.message; }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state?.newValue) render(changes.state.newValue);
});

init().catch((e) => { $('login-error').textContent = e.message; showLogin({ defaultServer: '' }); });
