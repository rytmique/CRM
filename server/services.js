import { now } from './db.js';
import { parseSettings, dayKey, notFound } from './util.js';

export const BOT_ONLINE_MS = 2 * 60 * 1000;
const DAY = 86400000;

export function getSettings(db, agencyId) {
  const row = db.prepare('SELECT settings FROM agencies WHERE id = ?').get(agencyId);
  return parseSettings(row?.settings);
}

/** The team's settings for one profile's texts: + its operator's own prompt and "what works for me" examples. */
/** {invites:[…], letters:[…]} from a stored JSON: only texts, a few of each (the operator's or the team's samples). */
export function readSamples(v) {
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v || '{}'); } catch { o = {}; } }
  const list = (x, n, max) => (Array.isArray(x) ? x : []).map((t) => String(t ?? '').replace(/\r\n/g, '\n').trim().slice(0, max)).filter((t) => t.length >= 20).slice(0, n);
  return { invites: list(o?.invites, 12, 1500), letters: list(o?.letters, 8, 3000) };
}

/** users.prefs → { chanceEveryMin, allchatPerNight } (only sane numbers; missing = the team's). */
export function readPrefs(json) {
  let p = {};
  try { p = JSON.parse(json || '{}') || {}; } catch { p = {}; }
  const n = (v, a, b) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= a && x <= b ? x : undefined; };
  return { chanceEveryMin: n(p.chanceEveryMin, 10, 240), allchatPerNight: n(p.allchatPerNight, 1, 6), shiftFrom: n(p.shiftFrom, 0, 23), shiftTo: n(p.shiftTo, 0, 23) };
}

export function profileSettings(db, profile) {
  const s = getSettings(db, profile.agency_id);
  const op = profile.operator_id ? db.prepare('SELECT id, prompt, prompt_examples, prefs, samples, ai_off FROM users WHERE id = ?').get(profile.operator_id) : null;
  if (op?.prompt?.trim()) s.ai.operatorPrompt = op.prompt;
  // the team lead switched the AI key off for this operator: no key at all (neither the team's nor the platform's) — templates
  if (op?.ai_off) { s.ai.apiKey = ''; s.ai.platformKey = false; s.ai.off = true; }
  // the samples the AI learns the style from: the operator's own > the team's > the built-in (the agency's approved ones)
  const mine = readSamples(op?.samples);
  const team = readSamples(s.ai.samples);
  s.ai.samples = mine.invites.length || mine.letters.length ? mine : team.invites.length || team.letters.length ? team : undefined;
  // the operator's own «Шанс» interval and «Аллчат» passes a night win over the team's
  const pref = readPrefs(op?.prefs);
  if (pref.chanceEveryMin) s.modes.chance.everyMin = pref.chanceEveryMin;
  if (pref.allchatPerNight) s.modes.allchat.perNight = pref.allchatPerNight;
  try {
    const ex = JSON.parse(op?.prompt_examples || '[]');
    if (Array.isArray(ex) && ex.length) s.ai.examples = ex.map((e) => String(e.text || e)).filter(Boolean).slice(0, 10);
  } catch { /* none */ }
  return s;
}

export function today(db, agencyId) {
  return dayKey(now(), getSettings(db, agencyId).timezone);
}

/** Human status for a license row. */
export function licenseState(l, t = now()) {
  if (!l) return { state: 'none', valid: false, daysLeft: 0 };
  if (l.status === 'revoked') return { state: 'revoked', valid: false, daysLeft: 0 };
  if (!l.activated_at) return { state: l.profile_id ? 'active' : 'free', valid: Boolean(l.profile_id), daysLeft: l.days };
  const daysLeft = Math.max(0, Math.ceil((l.expires_at - t) / DAY));
  if (l.expires_at <= t) return { state: 'expired', valid: false, daysLeft: 0 };
  return { state: l.profile_id ? 'active' : 'free', valid: Boolean(l.profile_id), daysLeft };
}

/**
 * The team's plan: up to N active profiles, with or without an end date. The first N active profiles (oldest first)
 * are in the plan — nobody has to hand out anything.
 */
export function planOf(db, agencyId) {
  const plan = getSettings(db, agencyId).plan || {};
  const active = db.prepare("SELECT id FROM profiles WHERE agency_id = ? AND status = 'active' ORDER BY id").all(agencyId).map((r) => r.id);
  const profiles = Number(plan.profiles) || 0;
  return { profiles, until: plan.until || null, used: active.length, inPlan: new Set(active.slice(0, profiles)) };
}

/** May the bot work for this profile? Same shape as the old license state: { valid, state, daysLeft }. */
export function accessFor(plan, profile, t = now()) {
  const daysLeft = plan.until ? Math.max(0, Math.ceil((plan.until - t) / DAY)) : 9999;
  if (!plan.profiles) return { valid: false, state: 'none', daysLeft: 0 };
  if (plan.until && plan.until <= t) return { valid: false, state: 'expired', daysLeft: 0 };
  if (profile.status === 'active' && !plan.inPlan.has(profile.id)) return { valid: false, state: 'over', daysLeft };
  return { valid: true, state: 'active', daysLeft, unlimited: !plan.until };
}
export const profileAccess = (db, profile) => accessFor(planOf(db, profile.agency_id), profile);

/** Why the bot may not work for a profile, in plain words. */
export function accessError(access, profile, plan) {
  if (access.state === 'none') return 'У команди ще немає плану анкет. Зверніться до постачальника.';
  if (access.state === 'expired') return 'План команди закінчився. Зверніться до постачальника.';
  return `Анкета «${profile.name}» понад план команди (${plan.profiles} анкет). Поставте непотрібну анкету на паузу або попросіть більше в постачальника.`;
}

/** SQL fragment + params limiting profiles to what the user may see. Alias: p */
export function profileScope(user) {
  if (user.role === 'operator') return { where: 'p.agency_id = ? AND p.operator_id = ?', params: [user.agencyId, user.id] };
  return { where: 'p.agency_id = ?', params: [user.agencyId] };
}

export function getVisibleProfile(db, user, id) {
  const scope = profileScope(user);
  const p = db.prepare(`SELECT p.* FROM profiles p WHERE p.id = ? AND ${scope.where}`).get(Number(id), ...scope.params);
  if (!p) throw notFound('Анкету не знайдено');
  return p;
}

/** Owner: any site of the agency. Operator: sites they added or that their profiles use. */
export function canEditSite(db, user, site) {
  if (!site || site.agency_id !== user.agencyId) return false;
  if (user.role === 'owner') return true;
  if (user.role !== 'operator') return false;
  if (site.created_by === user.id) return true;
  return Boolean(db.prepare('SELECT 1 FROM profiles WHERE site_id = ? AND operator_id = ? LIMIT 1').get(site.id, user.id));
}

/** Binds the oldest free, still valid license of the agency to the profile. Returns the license id or null. */
export function autoLicense(db, agencyId, profileId, t = now()) {
  if (db.prepare('SELECT 1 FROM licenses WHERE profile_id = ?').get(profileId)) return null;
  const l = db.prepare(`SELECT * FROM licenses WHERE agency_id = ? AND profile_id IS NULL AND status = 'active'
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY expires_at IS NULL, expires_at, id LIMIT 1`).get(agencyId, t);
  if (!l) return null;
  if (!l.activated_at) db.prepare('UPDATE licenses SET profile_id = ?, activated_at = ?, expires_at = ? WHERE id = ?').run(profileId, t, t + l.days * DAY, l.id);
  else db.prepare('UPDATE licenses SET profile_id = ? WHERE id = ?').run(profileId, l.id);
  return l.id;
}

export function profileLicense(db, profileId) {
  return db.prepare('SELECT * FROM licenses WHERE profile_id = ?').get(profileId) || null;
}

export function activeInvite(db, profileId) {
  return db.prepare('SELECT * FROM invites WHERE profile_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(profileId) || null;
}

export function limitsFor(profile, settings) {
  const d = settings.defaults;
  const caps = settings.caps || {};
  // the platform admin's caps win over the team's numbers
  const minDelay = Math.max(profile.min_delay ?? d.minDelay, caps.minDelayFloor || 0);
  const maxDelay = Math.max(minDelay, profile.max_delay ?? d.maxDelay);
  let dailyLimit = profile.daily_limit ?? d.dailyLimit;
  if (caps.dailyMax) dailyLimit = Math.min(dailyLimit, caps.dailyMax);
  return { dailyLimit, minDelay, maxDelay };
}

/** Messages sent today: first contacts + follow-up messages. */
export function sentToday(db, profileId, day) {
  const first = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND day = ? AND status = 'sent'").get(profileId, day).n;
  const more = db.prepare('SELECT COALESCE(SUM(messages), 0) AS n FROM touches WHERE profile_id = ? AND day = ? AND ok = 1').get(profileId, day).n;
  return first + more;
}

const HOUR = 3600000;

/** Per-hour cap: how many more messages fit into the last 60 minutes, and when the window frees up. */
export function hourWindow(db, profileId, perHour, t = now()) {
  if (!perHour) return { left: null, resetAt: null };
  const from = t - HOUR;
  const times = [
    ...db.prepare("SELECT sent_at AS at FROM messages WHERE profile_id = ? AND status = 'sent' AND sent_at > ?").all(profileId, from),
    ...db.prepare('SELECT at FROM touches WHERE profile_id = ? AND ok = 1 AND messages > 0 AND at > ?').all(profileId, from),
  ].map((r) => r.at).sort((a, b) => a - b);
  const left = Math.max(0, perHour - times.length);
  return { left, resetAt: left > 0 ? null : times[times.length - perHour] + HOUR };
}

export function followupTexts(db, profileId) {
  return new Map(db.prepare('SELECT step, text FROM followups WHERE profile_id = ?').all(profileId).map((r) => [r.step, r.text]));
}

export function saveFollowup(db, { profileId, step, text, source, model }) {
  db.prepare(`INSERT INTO followups (profile_id, step, text, source, model, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(profile_id, step) DO UPDATE SET text = excluded.text, source = excluded.source, model = excluded.model, created_at = excluded.created_at`)
    .run(profileId, step, text, source, model ?? null, now());
  return db.prepare('SELECT * FROM followups WHERE profile_id = ? AND step = ?').get(profileId, step);
}

/** New invite. `keepOthers`: added as one more live variant (A/B test) instead of replacing them. */
export function insertInvite(db, { profileId, text, source, model, userId, keepOthers = false }) {
  if (!keepOthers) db.prepare('UPDATE invites SET active = 0 WHERE profile_id = ?').run(profileId);
  const r = db.prepare('INSERT INTO invites (profile_id, text, source, model, active, created_by, created_at) VALUES (?,?,?,?,1,?,?)')
    .run(profileId, text, source, model ?? null, userId ?? null, now());
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(r.lastInsertRowid);
}
