const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const params = new URLSearchParams(location.search);

const LABELS = {
  start: 'Запис почато', resume: 'Запис продовжено', stop: 'Запис зупинено', 'tab-closed': 'Вкладку сайту закрито',
  'browser-started': 'Браузер перезапущено — запис іде далі', 'scanner-updated': 'Сканер оновлено — запис іде далі',
  gap: 'Перерва (сон комп’ютера або браузер був закритий)', offline: 'Пропав інтернет', online: 'Інтернет повернувся',
  'pc-idle': 'Комп’ютер без дій', 'pc-locked': 'Комп’ютер заблоковано', 'pc-active': 'Комп’ютер знову активний',
  'storage-full': 'Місце для запису закінчилось — нове вже не пишеться', 'snapshot-error': 'Помилка запису сторінки (пропущено)',
  'register-error': 'Запис на сторінках не ввімкнувся — натисніть «Зупинити», потім «Продовжити»',
};
const WARN = new Set(['gap', 'offline', 'storage-full', 'snapshot-error', 'tab-closed', 'register-error']);
const WAKING = /establish connection|receiving end/i;
const plain = (m) => (WAKING.test(m || '') ? 'Сканер прокидається… натисніть ще раз за кілька секунд' : m);
const fmt = (n) => new Intl.NumberFormat('uk-UA').format(n || 0);
const hm = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год ${m % 60} хв`;
}

async function tabId() {
  if (params.get('tab')) return Number(params.get('tab'));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id;
}

let timer = null;
async function render() {
  const s = await send('status').catch((e) => ({ ok: false, error: e.message }));
  const err = $('error');
  // the background may be waking up: say so in plain words, and clear it by itself once it answers
  if (!s?.ok) { err.textContent = WAKING.test(s?.error || '') ? 'Сканер прокидається… зачекайте кілька секунд' : (s?.error || 'Помилка'); err.dataset.r = '1'; return; }
  if (err.dataset.r) { err.textContent = ''; delete err.dataset.r; }
  $('ver').textContent = s.version ? `v${s.version}` : '';
  $('idle').hidden = s.scanning || s.has;
  $('rec').hidden = !s.scanning;
  $('stopped').hidden = s.scanning || !s.has;
  if (!s.scanning && !s.has) {
    const id = await tabId();
    const t = id ? await chrome.tabs.get(id).catch(() => null) : null;
    const ok = /^https?:\/\//.test(t?.url || '');
    $('start').disabled = !ok;
    $('site').replaceChildren();
    if (ok) { const b = document.createElement('b'); b.textContent = new URL(t.url).hostname; $('site').append('Сайт: ', b, ' — це ваш робочий сайт?'); }
    $('idle-note').textContent = ok ? '' : 'Спочатку відкрийте свій сайт у цій вкладці.';
  }
  if (s.scanning) {
    $('rec-time').textContent = s.startedAt ? dur(Date.now() - s.startedAt) : '';
    $('s-states').textContent = fmt(s.states);
    $('s-events').textContent = fmt(s.events);
    $('s-net').textContent = fmt(s.net);
    $('rec-title').textContent = s.full ? 'Місце закінчилось' : 'Іде запис';
    $('rec-site').textContent = s.sites?.length ? `Сайт: ${s.sites.join(', ')}` : '';
    $('recent').replaceChildren(...(s.recent || []).slice().reverse().filter((r) => LABELS[r.kind]).slice(0, 6).map((r) => {
      const li = document.createElement('li');
      const tm = document.createElement('time'); tm.textContent = hm(r.t);
      const sp = document.createElement('span'); sp.textContent = LABELS[r.kind] + (r.kind === 'gap' && r.minutes ? ` — ${r.minutes} хв` : '');
      if (WARN.has(r.kind)) sp.className = 'w';
      li.append(tm, sp);
      return li;
    }));
  }
  if (!s.scanning && s.has) $('st-time').textContent = s.stoppedAt ? `о ${hm(s.stoppedAt)}` : '';
}

function openReport() { chrome.tabs.create({ url: chrome.runtime.getURL('report.html') }); }

$('start').addEventListener('click', async () => {
  $('error').textContent = '';
  const r = await send('start', { tabId: await tabId() }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { $('error').textContent = plain(r?.error) || 'Не вдалося — закрийте це віконце й натисніть ще раз'; delete $('error').dataset.r; }
  render();
});
$('resume').addEventListener('click', async () => {
  $('error').textContent = '';
  const r = await send('resume').catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { $('error').textContent = plain(r?.error) || 'Не вдалося — закрийте це віконце й натисніть ще раз'; delete $('error').dataset.r; }
  render();
});
$('stop').addEventListener('click', async () => {
  if (!confirm('Зупинити запис? Звіт можна скачати й без зупинки.')) return;
  await send('stop');
  render();
});
$('reset').addEventListener('click', async () => {
  if (!confirm('Видалити записане й почати заново? Спершу скачайте звіт, якщо ще не скачали.')) return;
  await send('reset');
  render();
});
$('report').addEventListener('click', openReport);
$('report2').addEventListener('click', openReport);

render();
timer = setInterval(render, 3000);
