// Masking: nothing personal leaves the operator's browser.
// Kept: words of an interface (buttons, tabs, hints) from the dictionary below. Everything else becomes [w] / [W],
// numbers become #, long texts become [текст N]. Used by the page recorder, the background and the report.
(() => {
  if (self.__scanMask) return;

  const WORDS = `
a about account add id after again ago all also am an and answer answers any app apply are as at attach attachment attachments audio available away
back balance be before block blocked bonus box but button buy by call camera cancel change chat chats check choose clear click close closed
code coins come comment comments confirm contact contacts continue copy count create credit credits current dashboard date day days decline delete
delivered dialog dialogs dialogue dialogues did do done down draft drafts edit email emoji empty end english enter error every expired failed favorite
favorites favourite favourites file files filter find first for forward free from full get gift gifts go got has have he hello help her here hey
hi hide him his history home hour hours how i if image images in inbox info is it item items its just keep language last later leave left let
letter letters like liked likes limit list live load loading log login logout mail main make man me media men menu message messages min
minute minutes mode month more most my name new next no none not note nothing notification notifications now of off offer offline ok on once one
online only open or other our out outbox page paid password pay payment pending people per photo photos please premium prev previous privacy
profile profiles purchase read ready receive received recent refresh reject remaining remove reply report request required reset result results
save search second seconds see select send sent session set settings share she show sign smile so some sorry start status sticker stickers stop
subject submit success support switch tab tabs tap text than thank thanks that the their them then there these they this time to today top
total translate translation translator try type typing unread up update upload us use user users verify via video videos view vip voice wait
want was we week welcome what when which who wink winks with woman women write writing yes yesterday you your
усі всі все чат чати чатів без відповіді відповідь відповідей улюблені обране обрані діалоги діалог листи лист листа листів літери літер літера
повідомлення повідомлень повідомленням написати напишіть напиши надіслати надіслано відправити відправлено перекласти переклад перекладач
залишилося залишилось лишилось фото відео аудіо голосове подарунок подарунки лайк лайки вподобати підморгнути заблокувати видалити поскаржитись
профіль анкета анкети анкету онлайн офлайн пошук знайти налаштування вийти увійти вхід скасувати закрити так ні далі назад більше відкрити
прочитано прочитати нове нові новий сьогодні вчора хв год хвилин годин день днів тема текст вхідні вихідні чернетки сповіщення допомога додати
редагувати зберегти завантажити файл файли вибрати змінити жінка жінки чоловік чоловіки його її йому їй будь ласка мене мені ваш ваше ваші
кредити баланс оплатити купити преміум помилка завантаження друкує зараз тут немає є і й та або чи на в у з із до від для по про як що це
все чаты чат без ответа ответ ответов избранные избранное диалоги диалог письма письмо писем сообщение сообщения сообщений написать напишите
отправить отправлено перевести перевод переводчик осталось видео аудио голосовое подарок подарки лайк лайки подмигнуть заблокировать удалить
пожаловаться профиль анкета анкеты онлайн офлайн поиск найти настройки выйти войти отмена закрыть да нет далее назад ещё еще открыть прочитано
новое новые сегодня вчера мин час минут часов день дней тема текст входящие исходящие черновики уведомления помощь добавить редактировать
сохранить загрузить файл файлы выбрать изменить женщина женщины мужчина мужчины его ее её ему ей пожалуйста меня мне ваш ваше кредиты баланс
оплатить купить премиум ошибка загрузка печатает сейчас здесь нет есть и или на в с со до от для по про как что это
`;
  const DICT = new Set(WORDS.split(/\s+/).filter(Boolean));

  // technical words of sites (routes, class-like values, file names): safe to keep, they say how the site is built
  const TECH = new Set(`
api v rest graphql gql ajax json xml html htm php asp aspx jsp js mjs css map svg png jpg jpeg gif webp ico woff woff2 ttf static assets asset public dist build
bundle bundles chunk chunks vendor vendors main app apps web www m mobile desktop index home default page pages view views list lists item items detail details
info data cdn media img image images photos photo pic pics upload uploads files file download downloads ws wss socket sockets io realtime live stream events
event push sse poll polling notify notifications notification user users me my account accounts profile profiles member members man men woman women lady ladies
girl girls operator operators agent agents agency desk dashboard panel admin cabinet office workspace inbox outbox mail mails mailbox letter letters message
messages msg msgs chat chats dialog dialogs dialogue conversation conversations thread threads contact contacts room rooms search find filter filters sort feed
feeds online new hot top recent favorites favourite favourites favorite likes like wink winks gift gifts present presents send sent read unread history translate
translator translation lang language en uk ua ru de fr es it pl auth login logout signin signup register session oauth captcha verify settings config options
prefs status state health ping metrics log logs track tracking analytics stats count counter counters balance credits credit pay payment payments billing shop
store buy premium vip offer offers bonus id ids uid key keys type types kind mode tab tabs site demo test src lib libs node modules polyfill polyfills runtime
webpack next nuxt react vue angular svelte jquery bootstrap tailwind material ui ux icon icons sprite sprites font fonts theme themes dark light small medium
large xl xs sm md lg btn button buttons link links nav navbar menu menus header footer sidebar aside container wrapper wrap inner outer content body row rows
col cols column columns grid flex box card cards modal modals popup popups overlay backdrop toast toasts alert alerts badge badges avatar avatars thumb thumbnail
preview previews editor composer input inputs textarea field fields form forms label labels placeholder select option dropdown toggle switch active inactive
selected disabled enabled visible hidden open closed show hide true false null undefined none auto left right center top bottom start end first last prev next
primary secondary success warning danger error info muted text title subtitle name names date time ago min sec hour day week month year total number num
online offline away busy typing attach attachment attachments video audio voice sticker stickers emoji smile camera gallery album albums story stories
token tokens cursor offset limit order query since after before version session sessions callback redirect return target source medium campaign utm term
root frame frames iframe host widget widgets embed popup overlay portal chunk sw worker manifest robots sitemap favicon
`.split(/\s+/).filter(Boolean));

  /** One part of a value / URL segment: interface and technical words stay, numbers → #, anything else → ~hash (a username stays hidden but repeats are visible). */
  const maskPart = (p) => {
    if (!p) return p;
    if (/^\d+$/.test(p)) return '#';
    const l = p.toLowerCase();
    if (DICT.has(l) || TECH.has(l) || (/^[a-z]{1,3}$/.test(l))) return p.replace(/\d+/g, '#');
    if (/^[a-z]+\d+$/i.test(p) && TECH.has(p.replace(/\d+$/, '').toLowerCase())) return p.replace(/\d+/g, '#'); // v2, h1, col3
    return `~${fnv(l).slice(0, 4)}`;
  };
  /** A token like "chat-item", "anna_k", "desk.html": split on - _ . : and mask each part. */
  const maskToken = (s) => String(s).split(/([-_.:]+)/).map((p, i) => (i % 2 ? p : maskPart(p))).join('').slice(0, 80);

  const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
  const URLRE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
  const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
  const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

  const len = (s) => [...s].length;

  /** One word: a dictionary word stays, anything else hides (capital letter kept as a hint: [W] — likely a name). */
  const maskWord = (w) => (DICT.has(w.toLowerCase()) ? w : /^\p{Lu}/u.test(w) ? '[W]' : '[w]');

  /**
   * Any visible text → safe text.
   * { t: masked, n: length (characters), ell: ends with an ellipsis, ui: true when every word is an interface word }
   */
  function maskText(raw) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const n = len(s);
    const ell = /(…|\.\.\.)$/.test(s);
    const words = s.match(WORD) || [];
    const ui = words.length > 0 && words.every((w) => DICT.has(w.toLowerCase()));
    if (n > 80 || (!ui && words.length > 6)) return { t: `[текст ${n}]`, n, ell, ui: false };
    // placeholders first (as control chars, so the word masking below cannot touch them), restored at the end
    let t = s.replace(EMAIL, '\u0001').replace(URLRE, '\u0002').replace(PHONE, '\u0003');
    t = t.replace(WORD, maskWord).replace(/\d+/g, '#');
    t = t.replace(/\u0001/g, '[email]').replace(/\u0002/g, '[url]').replace(/\u0003/g, '[тел]');
    return { t, n, ell, ui };
  }

  /** Attribute values: one token ("chat-item", "true", "anna_k") part by part; sentences like text. */
  function maskValue(v) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    if (/^\d+$/.test(s)) return '#';
    if (/^[\p{L}\d][\p{L}\d_.:-]{0,60}$/u.test(s)) return maskToken(s);
    const m = maskText(s);
    return m ? m.t : '';
  }

  /** Class names / ids: site code, but numbers inside can be user IDs. */
  const maskName = (c) => String(c).replace(/\d{2,}/g, '#').slice(0, 60);

  const KNOWN_HOSTS = /(^|\.)(google|gstatic|googleapis|googletagmanager|google-analytics|doubleclick|recaptcha|hcaptcha|cloudflare|cloudflareinsights|jsdelivr|unpkg|cdnjs|sentry|sentry-cdn|intercom|facebook|fbcdn|yandex|hotjar|clarity|stripe|paypal|onesignal|pusher|firebaseio|firebase|amplitude|mixpanel|segment|zendesk|tawk|jivosite)\.[a-z.]+$/i;

  function regDomain(host) {
    const h = String(host || '').toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h; // an IP address is the site itself, never "its last two numbers"
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const two = parts.slice(-2).join('.');
    return /^(co|com|net|org|gov|ac)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
  }

  /**
   * Host → label: the operator's site becomes SITE (sub.SITE for its subdomains), well-known services keep their name,
   * every other host becomes h-xxxxxx (a short hash: the same host gets the same label everywhere).
   */
  const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
  function maskHost(host, siteDomains) {
    const h = String(host || '').toLowerCase();
    if (!h) return '';
    for (const d of siteDomains || []) {
      if (h === d) return 'SITE';
      if (h.endsWith(`.${d}`)) return `${h.slice(0, -d.length - 1).replace(/\d+/g, '#')}.SITE`;
    }
    if (KNOWN_HOSTS.test(h)) return regDomain(h);
    return `h-${fnv(h).slice(0, 6)}`;
  }

  /** A path / hash part: tokens and long IDs become #, digits inside words become # too (man-123 → man-#). */
  const token = (p) => /^[0-9a-f]{12,}$/i.test(p) || /^[0-9a-f-]{32,36}$/i.test(p) || (/^[A-Za-z0-9_-]{20,}$/.test(p) && /\d/.test(p));
  const maskSeg = (p) => {
    if (!p) return p;
    let d = p;
    try { d = decodeURIComponent(p); } catch { /* keep */ }
    if (token(d)) return '#';
    if (/[@\s]/.test(d) || d.length > 60) return '[x]';
    return maskToken(d);
  };

  /** URL → template: SITE/chat/#?tab — no IDs, no query values, no tokens. */
  function maskUrl(u, siteDomains) {
    let x;
    try { x = new URL(u); } catch { return '[адреса]'; }
    if (!/^(https?|wss?):$/.test(x.protocol)) return `${x.protocol}…`;
    const path = x.pathname.split('/').map(maskSeg).join('/');
    const keys = [...new Set([...x.searchParams.keys()])].map(maskSeg).sort();
    const hash = x.hash ? `#${x.hash.slice(1).split(/([/?&=])/).map((p) => (/^[/?&=]$/.test(p) ? p : maskSeg(p))).join('').slice(0, 60)}` : '';
    return `${x.protocol.startsWith('ws') ? `${x.protocol}//` : ''}${maskHost(x.hostname, siteDomains)}${path}${keys.length ? `?${keys.join('&')}` : ''}${hash}`;
  }

  /** Last line of defence for the report: anything that still looks personal is cut. Returns [clean, fixes]. */
  function scrub(str) {
    let fixes = 0;
    const out = String(str)
      .replace(EMAIL, () => { fixes++; return '[email]'; })
      .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, () => { fixes++; return '[url]'; })
      .replace(/(?<![\w#-])\d{5,}(?![\w-])/g, () => { fixes++; return '#'; });
    return [out, fixes];
  }

  self.__scanMask = { DICT, TECH, maskText, maskValue, maskName, maskHost, maskUrl, maskToken, regDomain, scrub, len, fnv };
})();
