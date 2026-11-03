import { h, toast, busy } from './ui.js';
import { api, post, session, setUnauthorizedHandler } from './api.js';
import dashboard from './pages/dashboard.js';
import profiles from './pages/profiles.js';
import operators from './pages/operators.js';
import licenses from './pages/licenses.js';
import journal from './pages/journal.js';
import sites from './pages/sites.js';
import settings from './pages/settings.js';
import extension from './pages/extension.js';
import adminAgencies from './pages/admin-agencies.js';
import adminLicenses from './pages/admin-licenses.js';
import adminMemory from './pages/admin-memory.js';
import setup from './pages/setup.js';
import billing from './pages/billing.js';
import adminBilling from './pages/admin-billing.js';
import { get } from './api.js';

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  profiles: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  operators: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.5 2.4 3.5 5.2"/>',
  licenses: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/>',
  journal: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  sites: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z"/>',
  extension: '<path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/><circle cx="12" cy="12" r="6.5"/>',
  agencies: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
};
function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', 'nav-icon');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}

const NAV = {
  owner: [
    ['dashboard', 'Дашборд', 'dashboard', dashboard],
    ['setup', 'Підключення', 'extension', setup],
    ['profiles', 'Анкети', 'profiles', profiles],
    ['operators', 'Оператори', 'operators', operators],
    ['licenses', 'Ліцензії', 'licenses', licenses],
    ['journal', 'Журнал', 'journal', journal],
    ['billing', 'Оплата за бота', 'licenses', billing],
    ['sites', 'Сайти', 'sites', sites],
    ['extension', 'Розширення', 'extension', extension],
    ['settings', 'Налаштування', 'settings', settings],
  ],
  operator: [
    ['dashboard', 'Дашборд', 'dashboard', dashboard],
    ['setup', 'Підключення', 'extension', setup],
    ['profiles', 'Мої анкети', 'profiles', profiles],
    ['journal', 'Журнал', 'journal', journal],
    ['billing', 'Мій заробіток', 'licenses', billing],
    ['sites', 'Сайти', 'sites', sites],
    ['extension', 'Розширення', 'extension', extension],
  ],
  admin: [
    ['agencies', 'Агенції', 'agencies', adminAgencies],
    ['admin-licenses', 'Ліцензії', 'licenses', adminLicenses],
    ['memory', 'Пам’ять ШІ', 'settings', adminMemory],
    ['admin-billing', 'Оплата за бота', 'licenses', adminBilling],
  ],
};

const root = document.getElementById('app');
let cleanup = null;

// ---------- theme ----------
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() { try { return localStorage.getItem('agc_theme') || 'auto'; } catch { return 'auto'; } }
function cycleTheme() {
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[currentTheme()];
  try { localStorage.setItem('agc_theme', next); } catch { /* ignore */ }
  applyTheme(next);
  return next;
}
applyTheme(currentTheme());
const themeLabel = (t) => ({ auto: 'Тема: авто', light: 'Тема: світла', dark: 'Тема: темна' }[t]);

// ---------- login ----------
function renderLogin(message) {
  cleanup?.();
  const err = h('p.form-error', { role: 'alert' }, message || '');
  const form = h('form.login-card',
    h('div.brand.big', h('img', { src: 'favicon.png', alt: '', width: 32, height: 32 }), h('span', 'Agency CRM')),
    h('p.muted', 'Панель керівника агенції'),
    h('div.field', h('label', { for: 'l-email' }, 'Email / логін'), h('input#l-email', { name: 'email', autocomplete: 'username', required: true })),
    h('div.field', h('label', { for: 'l-pass' }, 'Пароль'), h('input#l-pass', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Увійти'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    try {
      await busy(btn, async () => {
        const r = await post('/api/auth/login', { email: form.email.value, password: form.password.value });
        session.token = r.token;
        session.user = r.user;
      });
      location.hash = '';
      route();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  root.replaceChildren(h('div.login-wrap', form));
  form.email.focus();
}

setUnauthorizedHandler(() => renderLogin('Сесія завершилась — увійдіть знову'));

// ---------- layout ----------
function layout(items, activeKey) {
  const u = session.user;
  const themeText = h('span', themeLabel(currentTheme()));
  const themeBtn = h('button.nav-item.subtle', { onclick: () => { themeText.textContent = themeLabel(cycleTheme()); } }, icon('theme'), themeText);
  const nav = h('nav.sidebar', { 'aria-label': 'Розділи' },
    h('div.brand', h('img', { src: 'favicon.png', alt: '', width: 24, height: 24 }), h('span', 'Agency CRM')),
    u.agencyName ? h('div.agency-name', u.agencyName) : null,
    h('div.nav-list', items.map(([key, label, ic]) =>
      h(`a.nav-item${key === activeKey ? '.active' : ''}`, { href: `#/${key}`, 'aria-current': key === activeKey ? 'page' : null },
        icon(ic), label))),
    h('div.nav-foot',
      themeBtn,
      h('div.me', h('b', u.name), h('small', { title: u.email }, { admin: 'Адміністратор платформи', owner: 'Керівник', operator: 'Оператор' }[u.role])),
      h('button.nav-item.subtle', { onclick: logout }, icon('logout'), 'Вийти')));
  const main = h('main.content', { id: 'main', tabindex: -1 });
  const burger = h('button.burger', { 'aria-label': 'Меню', onclick: () => document.body.classList.toggle('nav-open') }, '☰');
  root.replaceChildren(h('div.shell', nav, h('div.topbar', burger, h('span', 'Agency CRM')), main));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  return main;
}

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  session.token = '';
  session.user = null;
  renderLogin();
}

async function route() {
  if (!session.token) return renderLogin();
  if (!session.user) {
    try { session.user = (await api('/api/auth/me')).user; } catch { return renderLogin(); }
  }
  const items = NAV[session.user.role] || [];
  let key = (location.hash.replace(/^#\/?/, '').split('?')[0]) || items[0][0];
  // A brand-new user lands in the setup wizard ("за руку") instead of an empty dashboard.
  if (!location.hash && session.user.role !== 'admin') {
    try {
      const s = await get('/api/stats/setup');
      if (s.steps.filter((x) => x.done).length <= 1) key = 'setup';
    } catch { /* the dashboard then */ }
  }
  const item = items.find((i) => i[0] === key) || items[0];
  cleanup?.();
  cleanup = null;
  const main = layout(items, item[0]);
  document.title = `${item[1]} · Agency CRM`;
  try {
    cleanup = (await item[3](main, { user: session.user, navigate: (k) => { location.hash = `#/${k}`; } })) || null;
  } catch (e) {
    main.replaceChildren(h('div.page', h('div.empty', h('p', `Не вдалося завантажити: ${e.message}`))));
    if (e.status !== 401) toast(e.message, 'err');
  }
}

window.addEventListener('hashchange', route);
route();
