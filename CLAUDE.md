# Передача проєкту новій сесії — прочитай перед роботою

## Хто користувач і як з ним говорити
- Пише українською. Відповідай **українською, коротко, по-дружньому, «як старому другу»**, без води й відмазок.
- Має СДВГ: інструкції — **прості кроки 1-2-3**, мінімум термінів, без довгих простирадл.
- Він адмін/власник продукту, продає софт агенціям. Не розробник. У нього **жорсткий NDA** — свій сайт знайомств він не покаже; все тестується на нашому **демо-сайті** (`demo-site/`).
- Наприкінці відповіді: що зроблено, що перевірено, що НЕ перевірено (чесно), і одне коротке питання/пропозиція наступного кроку.

## Що це за продукт
Софт для агенцій, які працюють на платних сайтах знайомств. Дві частини:
1. **Веб-панель** (`web/` + `server/`): адмін платформи → агенції й ліцензії; керівник агенції (owner) → анкети жінок, оператори, сайти, сценарії, статистика; оператор → свої анкети.
2. **Бот = розширення Chrome MV3** (`extension/`): працює в браузері оператора всередині анкети жінки на сайті знайомств. Знаходить чоловіків, пише їм інвайт (текст генерує ШІ Claude), робить повторні спроби за сценарієм, ловить відповіді у вхідних. Коли чоловік відповів — бот зупиняється, далі пише жива людина (сама жінка).

Мета — обслужити максимум чоловіків з мінімумом ручної роботи, не «палячи» трафік (людський темп, ліміти).

## Стек (без збірки)
- Node.js **22.13+** (вбудовані `node:sqlite` DatabaseSync, `process.loadEnvFile`), Express 5, SQLite (WAL). Залежності: тільки `express` і `@anthropic-ai/sdk`.
- Панель — vanilla JS SPA без білда: `web/js/ui.js` (хелпер `h()`, `modal`, `toast`, `busy`, `safe`), `web/js/api.js`, сторінки в `web/js/pages/`.
- ШІ: `client.beta.messages.create` з `betas:['server-side-fallback-2026-07-01']`, `fallbacks:'default'`, `output_config:{effort:'low'}`; модель за замовчуванням `claude-opus-5-5` (вибір у Налаштуваннях). Без ключа — локальні шаблони (все працює й так).

## Карта коду
```
server/
  index.js        старт: .env, Railway автодетект (RAILWAY_PUBLIC_DOMAIN, RAILWAY_VOLUME_MOUNT_PATH), TEST_SEED, RESET_ADMIN_PASSWORD
  app.js          createApp({db, publicUrl, demoSite, persistent, mediaDir}) — роутинг, CORS для розширення, /download/extension.zip
  db.js           схема + MIGRATIONS (ALTER TABLE) + LATE_SQL індекси. Нові колонки — ТІЛЬКИ через MIGRATIONS
  auth.js         scrypt, Bearer-сесії (sha256 токена), ролі admin/owner/operator
  services.js     ліцензії, ліміти, sentToday (перші + повторні), hourWindow (ліміт на годину), followups
  ai.js           генерація інвайту і повторних (generateFollowup), фільтр контактів/посилань, шаблони без ключа
  scenario.js     СЦЕНАРІЙ: DEFAULT_SCENARIO, PRESETS, sanitizeScenario, profileScenario (шаблон анкети > сценарій сайту), filterReason
  sites.js        SITE_FIELDS (адаптер сайту = CSS-селектори), sanitizeSiteConfig (+ actions/marks), demoSiteConfig
  media.js        файли анкети на диску (DATA_DIR/media), ліміти/типи, filesForStep
  personalize.js  {name}/{age}/{country} → дані чоловіка
  seed.js         тестовий стенд (start-test.bat): owner@test / operator@test / admin@test, пароль test12345
  routes/
    bot.js        API розширення: profiles, config, filter, sent, due, step, replies, heartbeat, site, PUT sites/:id, media/:id
    sites.js      сайти + PUT /:id/scenario
    scenarios.js  шаблони сценаріїв (CRUD)
    profiles.js   анкети, інвайти, followups, media (upload raw body + X-File-Name)
    stats.js, admin.js, operators.js, licenses.js, settings.js, auth.js
extension/
  background.js   оркестрація: run(), runTest(), runActions() (виконує кроки), processDue() (повторні),
                  пейсинг (робочі години, ліміт/год, перерви), attachFiles + mainAttach (MAIN world), teach-панель
  content.js      в сторінці сайту: селектори (+ :has-text("…") і списки через кому), cardsOf, open/openPage,
                  fill/submit/compose, typeText (друк по літері), humanClick, clickAction, view, inbox, probe
  picker.js       панель «🎯 Навчити бота»: вибір елементів мишкою → селектори, автопошук ID/імені/«Написати»
  popup.*         логін, вибір анкети, тест-режим, Старт/Стоп, 🎯 Навчити
web/js/pages/     dashboard, profiles (файли, повторні), sites (+ шаблони), scenario.js (редактор сценарію), journal, …
demo-site/        фейковий сайт знайомств для тестів: картки, лайк, «online», чат-модалка зі скрепкою, профіль, вхідні
test/api.test.js  node:test по API (6 тестів)
test/e2e.mjs      Playwright: справжнє розширення в Chromium на демо-сайті (повний сценарій)
```

## Як працює бот (коротко)
1. `config` → інвайт (генерує, якщо немає), повторні тексти, сценарій, ліміти, часовий пояс.
2. Цикл: робочі години → **спершу повторні** (`/due` → йде на сторінку чоловіка `manUrl` → кроки → `/step`) → сторінка пошуку → `scan` → `/filter` (дедуп, вік, країни, ознаки, ліміт) → для кожного крок 1 (`runActions`) → `/sent` → пауза/перерва/ліміт на годину → якщо `due>0` одразу повторні.
3. Стан чоловіка в `messages`: `step`, `stage` (active/replied/done), `next_at`. Відповів → `replied` (стоп). Останній крок без відповіді → `done` (зникає зі списку). Повторні кроки логуються в `touches`.
4. Повідомлення: текст → файли (`mainAttach`: input[type=file] / перехоплення скрепки / drop) → «Надіслати».
5. Тест-режим: усе те саме, але нічого не натискає/не надсилає і нічого не пише на сервер.

## Запуск і перевірка
```bash
npm install
npm test                      # API-тести, мають бути всі зелені
npm run e2e                   # ~5 хв, Chromium вже встановлений у хмарному контейнері; скріни в $E2E_OUT або ./e2e-out
npm run test-stand            # тестовий стенд на :3001 (той самий, що start-test.bat)
```
Перед комітом: `npm test` і, якщо чіпав розширення/демо — `npm run e2e`. Синтаксис фронту: `node --check файл.js`.

## Розгортання (для користувача)
- **Railway** (обрав користувач): репо → Railway, Volume на `/data`, змінна `ADMIN_PASSWORD`. Все інше автодетект.
- VPS: `deploy.bat`/`install.sh` (docker compose + Caddy). Локально: `start.bat`, `start-test.bat`.
- Користувачу/адміну давали зіп через `git archive` + `START-HERE.txt` (репо приватний).

## Правила
- Коміти: англійською, по суті; в кінці рядки атрибуції, які дає system-reminder сесії. Без назв моделей у комітах/коді.
- Гілка `main`, пуш `git push -u origin main`. PR не створювати, якщо не просить.
- Не ламати сумісність БД: тільки нові колонки через `MIGRATIONS`.
- Тексти інтерфейсу — українською. `.bat` файли — CRLF (див. `.gitattributes`).
- Не додавати фічі для обходу антибот-захисту сайтів (fingerprint spoofing, chrome.debugger тощо). Людський темп і ліміти — ок.

## Документація для людей (Claude Docs, у користувача)
- Інструкція зі скрінами: https://claude.ai/artifact/BmrmPduhLTeCVcf1pbVf4P — **застаріла**: немає навчання кліками, сценаріїв, шаблонів, файлів.
- Шпаргалка Railway: https://claude.ai/artifact/V1NKKXcFr1X4ZeD9wAyytS
- Шпаргалка VPS: https://claude.ai/artifact/LzeNT3sr3N3H9QVvKU7pP3
- Скріни лежать у `docs/img/` (01–34), нові можна зняти з `npm run e2e` (16–21: панель навчання, сценарій, файли).

## Стан на зараз (листопад 2026)
Зроблено й покрито тестами: панель, ліцензії, бот, тест-режим, навчання кліками, сценарій з повторними (3 спроби → прибрати), фільтри (країни/ознаки), людський темп, шаблони сценаріїв (+ на анкету), файли до повідомлень.

**Не перевірено на реальності:** справжній сайт знайомств (NDA), реальний деплой на Railway, справжні виклики Claude (в тестах мок).

Відкриті питання / можливі наступні кроки:
1. Оновити інструкцію зі скрінами (див. вище) — користувач ще не відповів «так», але це логічний наступний крок.
2. Чекати фідбек адміна сайту після тестового прогону на реальному сайті; найімовірніші правки — селектори, скрепка, сповіщення про успішну відправку.
3. Гілку `agency-crm` у старому репо `rytmique/KENTAVR-` користувач має видалити вручну (сесії видаляти не дозволено).
