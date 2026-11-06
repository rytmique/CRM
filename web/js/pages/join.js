import { h, busy } from '../ui.js';
import { get, post } from '../api.js';

/** Registration by a link: a team lead (from the platform admin) or an operator (from the team lead). */
export async function renderJoin(root, token, { loggedIn, onDone }) {
  const card = h('div.login-card');
  root.replaceChildren(h('div.login-wrap', card));
  const brand = h('div.brand.big', h('img', { src: 'favicon.png', alt: '', width: 32, height: 32 }), h('span', 'Agency CRM'));
  let info;
  try {
    info = await get(`/api/auth/join/${encodeURIComponent(token)}`);
  } catch (e) {
    card.replaceChildren(brand, h('p.form-error', { role: 'alert' }, e.message), h('button.btn.block', { onclick: onDone }, 'До входу'));
    return;
  }
  const owner = info.kind === 'owner';
  const err = h('p.form-error', { role: 'alert' });
  const fields = [
    ['name', 'Ваше ім’я', { autocomplete: 'name', required: true, maxlength: 120 }],
    owner ? ['agencyName', 'Назва команди', { placeholder: 'напр. Команда Ігоря', maxlength: 120 }] : null,
    ['email', 'Email (буде логіном)', { type: 'email', autocomplete: 'email', required: true }],
    ['password', 'Пароль (мін. 8 символів)', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }],
    ['password2', 'Ще раз пароль', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }],
  ].filter(Boolean);
  const form = h('form.stack',
    ...fields.map(([name, label, attrs]) => h('div.field', h('label', { for: `j-${name}` }, label), h(`input#j-${name}`, { name, ...attrs }))),
    err,
    h('button.btn.primary.block', { type: 'submit' }, 'Зареєструватися'));
  // a referral link: a new team, or one operator working on their own ("solo")
  const choice = info.referral ? h('div.seg-group.block-seg', { role: 'radiogroup', 'aria-label': 'Хто реєструється' },
    h('button.seg.on', { type: 'button', 'data-v': 'team' }, '👥 Я тімлід — моя команда'),
    h('button.seg', { type: 'button', 'data-v': 'solo' }, '🙋 Я працюю сам (соло)')) : null;
  let solo = false;
  choice?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    solo = b.dataset.v === 'solo';
    choice.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    form.querySelector('[name="agencyName"]').closest('.field').hidden = solo;
  });
  card.replaceChildren(
    brand,
    h('h2.center', info.referral ? 'Реєстрація' : owner ? 'Реєстрація команди' : `Реєстрація в команду${info.agencyName ? ` «${info.agencyName}»` : ''}`),
    info.referral ? h('p.center', `🎁 Вас запросив(ла) ${info.referrer}. Налаштування бота на вашому сайті — безкоштовно.`) : null,
    choice,
    h('p.muted.center', info.referral ? 'Після реєстрації постачальник підтвердить доступ. Команда: потім додасте своїх операторів. Соло: працюєте самі зі своїми анкетами.'
      : owner ? 'Ви — керівник команди. Після реєстрації постачальник підтвердить доступ, і ви зможете додати своїх операторів.'
      : 'Після реєстрації керівник команди підтвердить вас — і можна входити.'),
    loggedIn ? h('p.small.muted.center', 'Ви вже увійшли під іншим акаунтом — цю форму заповнює нова людина.') : null,
    form);
  const val = (n) => form.querySelector(`[name="${n}"]`)?.value || ''; // (form.name is the form's own name, not the field)
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (val('password') !== val('password2')) { err.textContent = 'Паролі не збігаються'; return; }
    try {
      await busy(form.querySelector('button[type=submit]'), () => post(`/api/auth/join/${encodeURIComponent(token)}`, {
        name: val('name'), email: val('email'), password: val('password'), agencyName: solo ? '' : val('agencyName'), solo,
      }));
      card.replaceChildren(brand, h('div.join-done',
        h('div.big-emoji', '✅'),
        h('h2', 'Заявку надіслано'),
        h('p', owner ? 'Щойно постачальник підтвердить — увійдіть з цим email і паролем.' : 'Щойно керівник команди підтвердить — увійдіть з цим email і паролем.'),
        h('p.small.muted', 'Зазвичай це кілька хвилин. Якщо довго — напишіть тому, хто дав посилання.'),
        h('button.btn.primary.block', { onclick: onDone }, 'До входу')));
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  form.querySelector('[name="name"]').focus();
}
