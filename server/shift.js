// The shift: the team lead sets the hours (e.g. 20:00–08:00), each operator may narrow them for themselves but never go
// outside. With «auto» on, the bot starts by itself when the shift begins and switches off when it ends.
import { readPrefs } from './services.js';

const HOUR = 3600000;

/** Local hour and minute of a moment in a time zone. */
export function localTime(t, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
    const get = (k) => Number(parts.find((p) => p.type === k)?.value || 0);
    return { h: get('hour') % 24, m: get('minute') };
  } catch {
    const d = new Date(t);
    return { h: d.getUTCHours(), m: d.getUTCMinutes() };
  }
}

const hourOf = (v, d) => { const x = Math.round(Number(v)); return Number.isInteger(x) && x >= 0 && x <= 24 ? x % 24 : d; };
/** Length of a window in hours: 20→8 = 12; the same hour = around the clock (24). */
export const spanOf = ({ from, to }) => ((to - from + 24) % 24) || 24;

/** The team's shift as set by the team lead. */
export function teamShift(settings) {
  const s = settings?.shift || {};
  return { auto: s.auto !== false, from: hourOf(s.from, 20), to: hourOf(s.to, 8) };
}

/**
 * The hours of one person: their own (prefs.shiftFrom / shiftTo) when they lie inside the team's, else the team's.
 * An operator can only narrow the shift, never go outside it.
 */
export function personShift(settings, prefsJson) {
  const team = teamShift(settings);
  const p = readPrefs(prefsJson);
  if (p.shiftFrom == null || p.shiftTo == null) return { ...team, own: false };
  const own = { from: hourOf(p.shiftFrom, team.from), to: hourOf(p.shiftTo, team.to) };
  return insideTeam(team, own) ? { ...team, ...own, own: true } : { ...team, own: false };
}

/** Is the window `own` inside the team's window (both may cross midnight)? */
export function insideTeam(team, own) {
  const len = spanOf(team);
  if (len === 24) return true;
  const a = (own.from - team.from + 24) % 24;
  const b = a + spanOf(own);
  return a < len && b <= len;
}

/** Is the moment inside the window? */
export function inShift(t, tz, w) {
  if (spanOf(w) === 24) return true;
  const { h } = localTime(t, tz);
  return (h - w.from + 24) % 24 < spanOf(w);
}

/** When the current (or the last) window began — a manual ⏹ after it keeps the bot off until the next shift. */
export function shiftStart(t, tz, w) {
  const { h, m } = localTime(t, tz);
  const back = ((h - w.from + 24) % 24) * 60 + m; // minutes since the window opened today / last night
  return t - back * 60000 - (t % 60000);
}

/** Minutes until the window opens next (0 when it is open now). */
export function minutesToStart(t, tz, w) {
  if (inShift(t, tz, w)) return 0;
  const { h, m } = localTime(t, tz);
  return ((w.from - h + 24) % 24) * 60 - m;
}

export const hh = (x) => `${String(x).padStart(2, '0')}:00`;
export const shiftText = (w) => (spanOf(w) === 24 ? 'цілодобово' : `${hh(w.from)}–${hh(w.to)}`);

/** For the «night» a moment belongs to (reports, stats): the team's hours in the shape shiftKey() takes. */
export const shiftHuman = (settings) => { const w = teamShift(settings); return { hoursFrom: w.from, hoursTo: w.to }; };

export { HOUR };
