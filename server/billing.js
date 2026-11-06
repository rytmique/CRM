/**
 * Payment for the bot: a percentage of the operator's earnings, only for the time the bot really worked.
 *
 *   earnings  — what the operator enters at the end of the month; until then an estimate:
 *               positive replies to the bot × earnings per reply (learned from earlier months, else the agency setting)
 *   %         — steps set by the platform admin per agency, like tax brackets: each part of the sum at its own % (5 % up to
 *               $5 000, 7.5 % above by default), so there is no jump at a threshold ('whole' mode: the whole sum at its tier)
 *   share     — bot hours without idle / the working hours of its schedule in that month (capped at 100 %)
 *   fee       — by the steps × share
 *   referral  — whoever brought a team gets 10 % of what that team pays for its first 6 months: first as a discount on their own
 *               fee, the rest as a payout
 */
import { profileScenario } from './scenario.js';
import { dayKey } from './util.js';

export const DEFAULT_TIERS = Object.freeze([{ from: 0, pct: 5 }, { from: 5000, pct: 7.5 }]);
export const REF_PCT = 10;
export const REF_MONTHS = 6;

/** Up to 10 tiers, sorted, the first one from 0. */
export function sanitizeTiers(list) {
  const out = (Array.isArray(list) ? list : [])
    .map((t) => ({ from: Math.max(0, Math.round(Number(t?.from) || 0)), pct: Math.min(100, Math.max(0, Math.round((Number(t?.pct) || 0) * 100) / 100)) }))
    .sort((a, b) => a.from - b.from)
    .filter((t, i, arr) => i === 0 || t.from !== arr[i - 1].from)
    .slice(0, 10);
  if (!out.length) return DEFAULT_TIERS.map((t) => ({ ...t }));
  out[0].from = 0;
  return out;
}

/** % for this sum: the highest tier it reaches. */
export const pctFor = (tiers, amount) => sanitizeTiers(tiers).filter((t) => amount >= t.from).at(-1).pct;

/** The fee for a sum: by steps (each part at its own %), or 'whole' (all of it at the tier it reaches). */
export function feeFor(tiers, amount, mode = 'marginal') {
  const list = sanitizeTiers(tiers);
  if (mode === 'whole') return amount * (pctFor(list, amount) / 100);
  let fee = 0;
  list.forEach((t, i) => {
    const top = i + 1 < list.length ? list[i + 1].from : Infinity;
    if (amount > t.from) fee += (Math.min(amount, top) - t.from) * (t.pct / 100);
  });
  return fee;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Days of a month ('YYYY-MM-DD'), only up to today for the current month. */
export function monthDays(month, tz) {
  const today = dayKey(Date.now(), tz);
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1 || day > today) break;
    out.push(day);
  }
  return out;
}

/** Working hours of a scenario over these days (its days of the week × its windows). */
export function scheduledHours(scenario, days) {
  const hm = scenario.human;
  const wd = hm.days?.length ? hm.days : [1, 2, 3, 4, 5, 6, 7];
  const windows = hm.windows?.length ? hm.windows : [[hm.hoursFrom, hm.hoursTo]];
  const perDay = windows.reduce((s, [a, b]) => s + (a === b ? 24 : b > a ? b - a : 24 - a + b), 0);
  return days.filter((d) => wd.includes(new Date(`${d}T12:00:00Z`).getUTCDay() || 7)).length * Math.min(24, perDay);
}

export const currentMonth = (tz) => dayKey(Date.now(), tz).slice(0, 7);
export const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

/** One operator in one month. */
export function operatorMonth(db, { agencyId, userId, month, settings }) {
  const billing = settings.billing || {};
  const days = monthDays(month, settings.timezone);
  const replies = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE agency_id = ? AND operator_id = ? AND reply_day LIKE ?
    AND replied_at IS NOT NULL AND reply_mood != 'negative'`).get(agencyId, userId, `${month}-%`).n;
  const sent = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE agency_id = ? AND operator_id = ? AND day LIKE ? AND status = 'sent'").get(agencyId, userId, `${month}-%`).n;
  const activity = db.prepare(`SELECT profile_id, SUM(seconds) AS s FROM bot_activity WHERE agency_id = ? AND operator_id = ? AND day LIKE ?
    GROUP BY profile_id ORDER BY s DESC`).all(agencyId, userId, `${month}-%`);
  const activeHours = activity.reduce((a, r) => a + r.s, 0) / 3600;
  // the schedule of the profile the bot worked on most
  const main = activity[0] ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(activity[0].profile_id) : null;
  const site = main?.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(main.site_id) : null;
  const schedHours = main ? scheduledHours(profileScenario(db, main, site), days) : 0;
  const prorate = billing.prorate !== false;
  const share = !prorate ? 1 : schedHours > 0 ? Math.min(1, activeHours / schedHours) : activeHours > 0 ? 1 : 0;

  const actual = db.prepare('SELECT * FROM earnings WHERE operator_id = ? AND month = ?').get(userId, month);
  // Earnings per reply: learned from the last 3 months this operator entered, else the agency's number.
  const past = db.prepare('SELECT month, amount FROM earnings WHERE operator_id = ? AND month < ? ORDER BY month DESC LIMIT 3').all(userId, month);
  let perReply = Number(billing.perReply) || 0;
  let learned = false;
  if (past.length) {
    const pastReplies = past.reduce((a, e) => a + db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE agency_id = ? AND operator_id = ? AND reply_day LIKE ?
      AND replied_at IS NOT NULL AND reply_mood != 'negative'`).get(agencyId, userId, `${e.month}-%`).n, 0);
    if (pastReplies > 0) { perReply = past.reduce((a, e) => a + e.amount, 0) / pastReplies; learned = true; }
  }
  const earnings = actual ? actual.amount : replies * perReply;
  const gross = feeFor(billing.tiers || DEFAULT_TIERS, earnings, billing.mode || 'marginal');
  const pct = earnings > 0 ? Math.round((gross / earnings) * 10000) / 100 : pctFor(billing.tiers || DEFAULT_TIERS, 0); // effective %
  return {
    user_id: userId, month, sent, replies,
    activeHours: round2(activeHours), schedHours: round2(schedHours), share: Math.round(share * 10000) / 10000,
    earnings: round2(earnings), estimated: !actual, perReply: round2(perReply), perReplyLearned: learned,
    note: actual?.note || '', pct, fee: round2(gross * share),
  };
}

const monthIndex = (m) => { const [y, mm] = m.split('-').map(Number); return y * 12 + mm - 1; };

/**
 * Referral reward of one person for a month: 10 % of what each team they brought pays (its first 6 months from approval).
 * The team's fee counts before its own referral discounts (no chains).
 */
export function referralReward(db, userId, month, getSettings) {
  const teams = db.prepare(`SELECT a.id, a.name, a.solo, u.approved_at FROM agencies a
    JOIN users u ON u.agency_id = a.id AND u.role = 'owner' AND u.pending = 0
    WHERE a.referred_by = ? ORDER BY a.id`).all(userId);
  let total = 0;
  const list = teams.map((t) => {
    const settings = getSettings(db, t.id);
    const start = dayKey(t.approved_at || Date.now(), settings.timezone).slice(0, 7);
    const idx = monthIndex(month) - monthIndex(start);
    const active = idx >= 0 && idx < REF_MONTHS;
    const fee = active ? billingReport(db, { agencyId: t.id, month, settings, refs: false }).totals.fee : 0;
    const reward = round2(fee * (REF_PCT / 100));
    total += reward;
    return { id: t.id, name: t.name, solo: Boolean(t.solo), since: start, monthNo: idx + 1, active, monthsLeft: Math.max(0, REF_MONTHS - Math.max(0, idx)), fee, reward };
  });
  return { total: round2(total), teams: list };
}

/** Everyone of an agency who ran the bot or has profiles (operator: only themself). refs: add referral discounts / payouts. */
export function billingReport(db, { agencyId, month, settings, onlyUserId = null, refs = true, getSettings = null }) {
  const users = onlyUserId
    ? db.prepare('SELECT id, name, role FROM users WHERE id = ?').all(onlyUserId)
    : db.prepare(`SELECT u.id, u.name, u.role FROM users u WHERE u.agency_id = ? AND u.pending = 0 AND (u.role = 'operator'
        OR EXISTS (SELECT 1 FROM bot_activity b WHERE b.operator_id = u.id) OR EXISTS (SELECT 1 FROM messages m WHERE m.operator_id = u.id)
        OR EXISTS (SELECT 1 FROM earnings e WHERE e.operator_id = u.id) OR EXISTS (SELECT 1 FROM profiles p WHERE p.operator_id = u.id))
        ORDER BY u.role = 'owner', u.name COLLATE NOCASE`).all(agencyId);
  const rows = users.map((u) => {
    const row = { name: u.name, role: u.role, ...operatorMonth(db, { agencyId, userId: u.id, month, settings }) };
    // referral: first off their own fee, the rest is paid out
    const ref = refs && getSettings ? referralReward(db, u.id, month, getSettings) : { total: 0 };
    row.refReward = ref.total;
    row.refDiscount = round2(Math.min(ref.total, row.fee));
    row.refPayout = round2(ref.total - row.refDiscount);
    row.toPay = round2(row.fee - row.refDiscount);
    return row;
  });
  const total = (k) => round2(rows.reduce((a, r) => a + r[k], 0));
  return {
    month, rows,
    totals: {
      earnings: total('earnings'), fee: total('fee'), activeHours: total('activeHours'), replies: rows.reduce((a, r) => a + r.replies, 0),
      refDiscount: total('refDiscount'), refPayout: total('refPayout'), toPay: total('toPay'),
    },
    billing: {
      currency: settings.billing?.currency || '$', perReply: settings.billing?.perReply ?? 10, tiers: sanitizeTiers(settings.billing?.tiers),
      mode: settings.billing?.mode === 'whole' ? 'whole' : 'marginal', prorate: settings.billing?.prorate !== false,
    },
  };
}
