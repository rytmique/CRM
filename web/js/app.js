import { h, toast, busy } from './ui.js';
import { api, post, put, session, setUnauthorizedHandler } from './api.js';
import operators from './pages/operators.js';
import adminAgencies from './pages/admin-agencies.js';
import adminLicenses from './pages/admin-licenses.js';
import adminMemory from './pages/admin-memory.js';
import adminBilling from './pages/admin-billing.js';
import adminOverview from './pages/admin-overview.js';
import adminAgency from './pages/admin-agency.js';
import adminRegistrations from './pages/admin-registrations.js';
import adminDevices from './pages/admin-devices.js';
import adminPlatform from './pages/admin-platform.js';
import home from './pages/home.js';
import ai from './pages/ai.js';
import mySettings from './pages/my-settings.js';
import { renderJoin } from './pages/join.js';
import { renderForgot, renderReset, renderTeamName, langSwitch } from './pages/auth-extra.js';
import { t, getLang, setLang } from './i18n.js';
import { downloadBot } from './pages/extension.js';
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
  prompts: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  bot: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M9 12h.01M15 12h.01M9 16h6"/><circle cx="12" cy="3.5" r="1"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
};
function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', 'nav-icon');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}

// [key, label, icon, page, { hidden: not in the menu but opens by link, parent: menu item to highlight }]
const NAV = {
  // as little as possible: the bot finds the profiles on the site by itself
  owner: [
    ['home', 'Головна', 'dashboard', home],
    ['ai', 'ШІ', 'bot', ai],
    ['team', 'Команда', 'operators', operators],
    ['settings', 'Налаштування', 'settings', mySettings],
  ],
  operator: [
    ['home', 'Головна', 'dashboard', home],
    ['settings', 'Налаштування', 'settings', mySettings],
  ],
  admin: [
    ['overview', 'Огляд', 'dashboard', adminOverview],
    ['agencies', 'Команди', 'agencies', adminAgencies],
    ['registrations', 'Реєстрації', 'operators', adminRegistrations],
    ['devices', 'Пристрої й копії бота', 'shield', adminDevices],
    ['admin-licenses', 'Ліцензії (старі)', 'licenses', adminLicenses, { hidden: true, parent: 'agencies' }],
    ['admin-billing', 'Оплата за бота', 'licenses', adminBilling],
    ['memory', 'Пам’ять ШІ', 'settings', adminMemory],
    ['platform', 'Telegram і функції', 'bot', adminPlatform],
    ['agency', 'Команда', 'agencies', adminAgency, { hidden: true, parent: 'agencies' }],
  ],
};
/** Menu item → where its "new" counter comes from (registrations waiting). */
const BADGES = { owner: 'team', admin: 'registrations' };

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
let langPicked = false; // UA / RU pressed on the login screen
function renderLogin(message) {
  cleanup?.();
  const err = h('p.form-error', { role: 'alert' }, message || '');
  const form = h('form.login-card',
    h('div.row-between', h('div.brand.big', h('img', { src: 'favicon.png', alt: '', width: 32, height: 32 }), h('span', 'Agency CRM')),
      langSwitch(() => { langPicked = true; renderLogin(message); })),
    h('p.muted', 'Вхід для керівників і операторів'),
    h('div.field', h('label', { for: 'l-email' }, 'Email'), h('input#l-email', { name: 'email', autocomplete: 'username', required: true })),
    h('div.field', h('label', { for: 'l-pass' }, 'Пароль'), h('input#l-pass', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Увійти'),
    h('button.btn.ghost.block', { type: 'button', onclick: () => renderForgot(root, () => renderLogin()) }, 'Забули пароль?'),
    h('p.small.muted.center', 'Немає акаунта? Попросіть у керівника посилання для реєстрації.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    try {
      await busy(btn, async () => {
        const r = await post('/api/auth/login', { email: form.email.value, password: form.password.value });
        session.token = r.token;
        session.user = r.user;
        // the language picked on this screen becomes the person's language (the bot and Telegram follow it)
        if (langPicked && r.user.lang !== getLang()) session.user = (await put('/api/auth/lang', { lang: getLang() })).user;
      });
      location.hash = '';
      route();
    } catch (ex) {
      err.textContent = t(ex.message);
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
    h('div.nav-list', items.filter((i) => !i[4]?.hidden).map(([key, label, ic]) =>
      h(`a.nav-item${key === activeKey ? '.active' : ''}`, { href: `#/${key}`, 'aria-current': key === activeKey ? 'page' : null, 'data-key': key },
        icon(ic), h('span.nav-label', label)))),
    h('div.nav-foot',
      u.role !== 'admin' ? h('button.nav-item.subtle.nav-bot', { onclick: (e) => downloadBot(e.currentTarget), title: 'Бот-розширення для браузера: ваша особиста копія' }, icon('extension'), 'Завантажити бота') : null,
      themeBtn,
      h('div.me', h('b', u.name), h('small', { title: u.email }, { admin: 'Адміністратор платформи', owner: 'Керівник', operator: 'Оператор' }[u.role])),
      h('button.nav-item.subtle', { onclick: logout }, icon('logout'), 'Вийти')));
  const main = h('main.content', { id: 'main', tabindex: -1 });
  const burger = h('button.burger', { 'aria-label': 'Меню', onclick: () => document.body.classList.toggle('nav-open') }, '☰');
  root.replaceChildren(h('div.shell', nav, h('div.topbar', burger, h('span', 'Agency CRM')), main));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  // "N new" next to the menu item: registrations waiting for approval
  const badgeKey = BADGES[u.role];
  if (badgeKey) {
    get('/api/auth/me').then(({ user }) => {
      const link = nav.querySelector(`[data-key="${badgeKey}"]`);
      if (link && user?.pendingCount) link.append(h('span.nav-badge', String(user.pendingCount)));
    }).catch(() => {});
  }
  return main;
}

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  session.token = '';
  session.user = null;
  renderLogin();
}

async function route() {
  // a registration link works with or without being logged in
  const join = /^#\/join\/([\w-]+)/.exec(location.hash);
  if (join) { cleanup?.(); cleanup = null; return renderJoin(root, join[1], { loggedIn: Boolean(session.token), onDone: () => { location.hash = ''; route(); } }); }
  const reset = /^#\/reset\/([\w-]+)/.exec(location.hash);
  if (reset) { cleanup?.(); cleanup = null; return renderReset(root, reset[1], () => { location.hash = ''; session.token = ''; session.user = null; route(); }); }
  if (!session.token) return renderLogin();
  if (!session.user) {
    try { session.user = (await api('/api/auth/me')).user; } catch { return renderLogin(); }
  }
  // the person's language (set in Settings; the bot and Telegram use the same)
  if (session.user.lang && session.user.lang !== getLang()) setLang(session.user.lang);
  // a new team lead names the team first
  if (session.user.teamNameNeeded) { cleanup?.(); cleanup = null; return renderTeamName(root, () => route()); }
  const items = NAV[session.user.role] || [];
  const key = (location.hash.replace(/^#\/?/, '').split('?')[0]) || items[0][0];
  const item = items.find((i) => i[0] === key) || items[0];
  cleanup?.();
  cleanup = null;
  const main = layout(items, item[4]?.parent || item[0]);
  document.title = `${t(item[1])} · Agency CRM`;
  try {
    cleanup = (await item[3](main, { user: session.user, navigate: (k) => { location.hash = `#/${k}`; } })) || null;
  } catch (e) {
    main.replaceChildren(h('div.page', h('div.empty', h('p', `${t('Не вдалося завантажити')}: ${t(e.message)}`))));
    if (e.status !== 401) toast(e.message, 'err');
  }
}

window.addEventListener('hashchange', route);
route();
