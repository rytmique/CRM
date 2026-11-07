import { h, busy } from '../ui.js';
import { get, post, put, session } from '../api.js';
import { getLang, setLang, t } from '../i18n.js';

export const brand = () => h('div.brand.big', h('img', { src: 'favicon.png', alt: '', width: 32, height: 32 }), h('span', 'Agency CRM'));

/** UA | RU before logging in (after — in Settings); `onChange` re-renders the screen. */
export function langSwitch(onChange) {
  const btn = (code, label) => h(`button.seg${getLang() === code ? '.on' : ''}`, { type: 'button', onclick: () => { setLang(code); onChange?.(); } }, label);
  return h('div.seg-group.lang-switch', { role: 'group', 'aria-label': 'Мова' }, btn('uk', 'UA'), btn('ru', 'RU'));
}

/** «Забули пароль?»: the email → a one-time link to the email and the linked Telegram. */
export function renderForgot(root, onBack) {
  const err = h('p.form-error', { role: 'alert' });
  const email = h('input#f-email', { name: 'email', type: 'email', autocomplete: 'email', required: true });
  const form = h('form.login-card.stack', brand(),
    h('h2.center', 'Забули пароль?'),
    h('p.muted.center', 'Вкажіть email, з яким реєструвались. Надішлемо посилання для нового пароля — на пошту й у Telegram (якщо підключений).'),
    h('div.field', h('label', { for: 'f-email' }, 'Email'), email),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Надіслати посилання'),
    h('button.btn.ghost.block', { type: 'button', onclick: onBack }, '← До входу'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await busy(form.querySelector('button[type=submit]'), () => post('/api/auth/forgot', { email: email.value }));
      form.replaceChildren(brand(), h('div.join-done', h('div.big-emoji', '📬'), h('h2', 'Перевірте пошту й Telegram'),
        h('p', 'Якщо такий email є — посилання вже летить. Воно діє 1 годину.'),
        h('p.small.muted', 'Нічого не прийшло? Попросіть керівника задати вам новий пароль у панелі.'),
        h('button.btn.primary.block', { type: 'button', onclick: onBack }, 'До входу')));
    } catch (ex) { err.textContent = t(ex.message); }
  });
  root.replaceChildren(h('div.login-wrap', form));
  email.focus();
}

/** The link from the letter: a new password, then logging in with it. */
export async function renderReset(root, token, onDone) {
  const card = h('div.login-card');
  root.replaceChildren(h('div.login-wrap', card));
  try { await get(`/api/auth/reset/${encodeURIComponent(token)}`); } catch (e) {
    card.replaceChildren(brand(), h('p.form-error', { role: 'alert' }, e.message), h('button.btn.block', { onclick: onDone }, 'До входу'));
    return;
  }
  const err = h('p.form-error', { role: 'alert' });
  const p1 = h('input#r-p1', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const p2 = h('input#r-p2', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const form = h('form.stack', h('div.field', h('label', { for: 'r-p1' }, 'Новий пароль (мін. 8 символів)'), p1),
    h('div.field', h('label', { for: 'r-p2' }, 'Ще раз'), p2), err, h('button.btn.primary.block', { type: 'submit' }, 'Зберегти пароль'));
  card.replaceChildren(brand(), h('h2.center', 'Новий пароль'), form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (p1.value !== p2.value) { err.textContent = t('Паролі не збігаються'); return; }
    try {
      await busy(form.querySelector('button[type=submit]'), () => post(`/api/auth/reset/${encodeURIComponent(token)}`, { password: p1.value }));
      card.replaceChildren(brand(), h('div.join-done', h('div.big-emoji', '✅'), h('h2', 'Пароль змінено'),
        h('p', 'Увійдіть з новим паролем. На інших пристроях вхід скинуто.'), h('button.btn.primary.block', { onclick: onDone }, 'До входу')));
    } catch (ex) { err.textContent = t(ex.message); }
  });
  p1.focus();
}

/** Right after a new team lead registered: the team's name, then the panel. */
export function renderTeamName(root, onDone) {
  const err = h('p.form-error', { role: 'alert' });
  const name = h('input#t-name', { name: 'name', required: true, maxlength: 120, placeholder: 'напр. Команда Ігоря', value: '' });
  const form = h('form.login-card.stack', brand(),
    h('div.big-emoji.center', '👥'),
    h('h2.center', 'Як назвемо вашу команду?'),
    h('p.muted.center', 'Цю назву бачитимуть ваші оператори, коли реєструватимуться за вашим посиланням. Змінити можна потім у Налаштуваннях.'),
    h('div.field', h('label', { for: 't-name' }, 'Назва команди'), name),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Далі →'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const r = await busy(form.querySelector('button[type=submit]'), () => put('/api/auth/team-name', { name: name.value }));
      session.user = r.user;
      onDone();
    } catch (ex) { err.textContent = t(ex.message); }
  });
  root.replaceChildren(h('div.login-wrap', form));
  name.focus();
}
