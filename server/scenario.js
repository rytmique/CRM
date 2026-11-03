/**
 * Scenario = what the bot does with every man, step by step, until he replies.
 *
 *   steps[0]            — runs when the bot finds a new man in the search list;
 *   steps[1..]          — run `wait` hours after the previous step, only if he still has not replied;
 *   after the last step — no reply → he is dropped from the bot's list ("вичерпано").
 *
 * A step is a list of actions:
 *   { do: 'message', text: 'invite' | 'followup' | 'custom', custom?: 'variant 1\n---\nvariant 2' }
 *   { do: 'click', action: '<key of a taught button>' }   e.g. like, wink, add to favourites
 *   { do: 'view', chance: 0..100, seconds }               open his profile and look through it like a person would
 *   { do: 'pause', seconds }
 */

export const DEFAULT_SCENARIO = Object.freeze({
  steps: [
    { wait: 0, actions: [{ do: 'message', text: 'invite' }] },
    { wait: 24, actions: [{ do: 'message', text: 'followup' }] },
    { wait: 48, actions: [{ do: 'message', text: 'followup' }] },
  ],
  filters: { countries: '', excludeCountries: '', needMarks: [], skipMarks: [] },
  human: { hoursFrom: 9, hoursTo: 23, perHour: 40, breakEvery: 20, breakMinutes: 10, typing: true },
});

const MAX_STEPS = 10;
const MAX_ACTIONS = 8;
const KEY_RE = /^[a-z0-9_-]{1,24}$/i;

const num = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const keys = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((k) => KEY_RE.test(k)))].slice(0, 20) : []);

function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return null;
  switch (a.do) {
    case 'message': {
      const src = ['invite', 'followup', 'custom'].includes(a.text) ? a.text : 'invite';
      const out = { do: 'message', text: src };
      if (src === 'custom') {
        out.custom = text(a.custom, 6000);
        if (!out.custom) return null;
      }
      return out;
    }
    case 'click':
      return KEY_RE.test(String(a.action || '')) ? { do: 'click', action: String(a.action) } : null;
    case 'view':
      return { do: 'view', chance: Math.round(num(a.chance, 0, 100, 100)), seconds: Math.round(num(a.seconds, 2, 120, 8)) };
    case 'pause':
      return { do: 'pause', seconds: Math.round(num(a.seconds, 1, 600, 5)) };
    default:
      return null;
  }
}

export function sanitizeScenario(input) {
  const src = input && typeof input === 'object' ? input : {};
  const steps = (Array.isArray(src.steps) ? src.steps : []).slice(0, MAX_STEPS).map((s, i) => ({
    wait: i === 0 ? 0 : Math.round(num(s?.wait, 0, 24 * 60, 24) * 100) / 100,
    actions: (Array.isArray(s?.actions) ? s.actions : []).map(sanitizeAction).filter(Boolean).slice(0, MAX_ACTIONS),
  })).filter((s) => s.actions.length);
  const f = src.filters || {};
  const hm = src.human || {};
  const d = DEFAULT_SCENARIO.human;
  return {
    steps: steps.length ? steps : structuredClone(DEFAULT_SCENARIO.steps),
    filters: {
      countries: text(f.countries, 500),
      excludeCountries: text(f.excludeCountries, 500),
      needMarks: keys(f.needMarks),
      skipMarks: keys(f.skipMarks),
    },
    human: {
      hoursFrom: Math.round(num(hm.hoursFrom, 0, 24, d.hoursFrom)),
      hoursTo: Math.round(num(hm.hoursTo, 0, 24, d.hoursTo)),
      perHour: Math.round(num(hm.perHour, 0, 500, d.perHour)),
      breakEvery: Math.round(num(hm.breakEvery, 0, 500, d.breakEvery)),
      breakMinutes: Math.round(num(hm.breakMinutes, 1, 180, d.breakMinutes)),
      typing: hm.typing === undefined ? d.typing : Boolean(hm.typing),
    },
  };
}

/** Scenario stored for a site ('' = default). */
export function siteScenario(site) {
  if (!site?.scenario) return sanitizeScenario(DEFAULT_SCENARIO);
  try { return sanitizeScenario(JSON.parse(site.scenario)); } catch { return sanitizeScenario(DEFAULT_SCENARIO); }
}

/** How many of the steps send a message ("спроби"). */
export const attempts = (scenario) => scenario.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length;

/** Step numbers (1-based) whose messages are AI follow-ups. */
export const followupSteps = (scenario) => scenario.steps
  .map((s, i) => (s.actions.some((a) => a.do === 'message' && a.text === 'followup') ? i + 1 : 0))
  .filter(Boolean);

const splitList = (s) => String(s || '').split(/[,;\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** null = the man passes; otherwise a short reason key. */
export function filterReason(man, filters) {
  const country = String(man.country || '').toLowerCase();
  const only = splitList(filters.countries);
  if (only.length && !(country && only.some((c) => country.includes(c)))) return 'country';
  const not = splitList(filters.excludeCountries);
  if (country && not.some((c) => country.includes(c))) return 'country';
  const marks = new Set(Array.isArray(man.marks) ? man.marks : []);
  if (filters.needMarks.some((k) => !marks.has(k))) return 'marks';
  if (filters.skipMarks.some((k) => marks.has(k))) return 'marks';
  return null;
}

/** Picks one of the "---"-separated variants of a custom text. */
export function pickVariant(custom) {
  const list = String(custom || '').split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list[Math.floor(Math.random() * list.length)] : '';
}
