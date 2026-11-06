import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Не знайдено') => new HttpError(404, msg);
export const forbidden = (msg = 'Немає доступу') => new HttpError(403, msg);

/** Wraps async route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const DEFAULT_SETTINGS = Object.freeze({
  timezone: 'Europe/Kyiv',
  ai: {
    apiKey: '',
    model: 'claude-opus-5-5',
    language: 'English',
    instructions: '',
    masterPrompt: '',
    variants: 3, // invite variants live at once per profile (A/B/C test)
    autoOptimize: true, // retire weak variants, write new ones
    sharedMemory: true, // use the platform lessons in prompts
    platformKey: true, // the platform's own key may be used when the team has none (set by the platform admin)
  },
  telegram: { botToken: '', chatId: '' },
  defaults: { dailyLimit: 150, minDelay: 40, maxDelay: 90 },
  inboxCheckEvery: 10,
  dedupeAcrossAgency: false,
  // payment for the bot: tiers are set by the platform admin, the rest by the agency
  // steps: the first $5 000 at 5 %, what is above at 7.5 % (like tax brackets, no jump at the threshold)
  billing: { currency: '$', perReply: 10, tiers: [{ from: 0, pct: 5 }, { from: 5000, pct: 7.5 }], mode: 'marginal', prorate: true },
  // caps set by the platform admin (0 = no cap): the team cannot go above them
  caps: { dailyMax: 0, minDelayFloor: 0, maxOperators: 0, maxProfiles: 0 },
  // the team's plan (instead of a license per profile): up to N active profiles; until = end date or null (no end)
  plan: { profiles: 0, until: null },
  // what the bot does in a shift
  modes: {
    // «Шанс»: every N minutes an invite letter with her photo to every online man there it has not written to yet
    chance: { on: true, everyMin: 30, onlineOnly: true },
    // «Аллчат»: a few times a night a message on the topic of the talk into running dialogs (never when he waits for an answer)
    // who: 'silent' — he is quiet for silentHours+; 'replied' — only men who have written at least once; 'all' — every dialog
    allchat: { on: true, perNight: 2, who: 'silent', silentHours: 6, gapHours: 3, maxPerPass: 40 },
    // the bot answers his reply itself — locked until the platform admin opens it
    autoReply: { on: false },
  },
  // mini reports in Telegram after each pass (each person gets the reports of what they run)
  reports: { eachPass: true },
});

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (k in base) {
      out[k] = v;
    }
  }
  return out;
}

export function parseSettings(json) {
  let raw = {};
  try { raw = JSON.parse(json || '{}'); } catch { raw = {}; }
  return deepMerge(DEFAULT_SETTINGS, raw);
}

export function mergeSettings(current, patch) {
  return deepMerge(current, patch);
}

/** YYYY-MM-DD for a timestamp in the given IANA timezone. */
export function dayKey(ts = Date.now(), tz = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** List of N day keys ending today (inclusive), oldest first. */
export function lastDays(n, tz) {
  const out = [];
  const today = dayKey(Date.now(), tz);
  const base = Date.parse(today + 'T12:00:00Z');
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export function licenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[bytes[i] % alphabet.length];
  return `AGC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

// ---- tiny validation helpers ----
export function str(v, { max = 2000, required = false, field = 'поле' } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`Заповніть: ${field}`);
    return undefined;
  }
  const s = String(v).trim();
  if (required && !s) throw bad(`Заповніть: ${field}`);
  if (s.length > max) throw bad(`Задовге значення: ${field} (макс. ${max})`);
  return s;
}

export function int(v, { min = -Infinity, max = Infinity, field = 'поле', nullable = true } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') {
    if (nullable) return null;
    throw bad(`Вкажіть число: ${field}`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`Некоректне число: ${field} (${min}…${max})`);
  return n;
}

export function oneOf(v, values, field = 'поле') {
  if (v === undefined) return undefined;
  if (!values.includes(v)) throw bad(`Некоректне значення: ${field}`);
  return v;
}

/** Builds "SET a=?, b=?" for the defined keys of obj. */
export function updateSql(obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => obj[k]), empty: keys.length === 0 };
}

export function mask(secret) {
  if (!secret) return '';
  return secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
