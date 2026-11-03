/**
 * Scenario = what the bot does with every man, step by step, until he replies.
 *
 *   steps[0]            — runs when the bot finds a new man in the search list;
 *   steps[1..]          — run `wait` hours after the previous step, only if he still has not replied;
 *   after the last step — no reply → he is dropped from the bot's list ("вичерпано").
 *   he replied           — a live person writes; if he goes quiet for `afterReply.silenceHours`, the bot sends
 *                          a short reminder every `everyHours`, up to `afterReply.attempts` (+N per positive reply).
 *
 * A step is a list of actions:
 *   { do: 'message', text: 'invite' | 'followup' | 'letter' | 'custom', custom?: 'variant 1\n---\nvariant 2',
 *     via: 'chat' | 'letter',                              chat message or the site's letter (mail) form
 *     files: 'all' | 'one' | 'none' }                     the profile's files marked for this step (all / one random)
 *   { do: 'click', action: '<key of a taught button>', chance }   e.g. like, wink, add to favourites
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
  human: {
    hoursFrom: 9, hoursTo: 23, windows: [[9, 23]], days: [1, 2, 3, 4, 5, 6, 7], perHour: 40, breakEvery: 20, breakMinutes: 10, breakMinutesTo: 20,
    typing: true, typeSpeed: 600, spread: true,
    // pauses in seconds, each a random value between "from" and "to"
    gapFrom: null, gapTo: null, // between men (empty = from the profile / agency settings)
    thinkFrom: 2, thinkTo: 6, // after his chat opened, before typing
    actionGapFrom: 2, actionGapTo: 6, // between actions of a step (like → message)
    pageGapFrom: 3, pageGapTo: 8, // before the next page of the list
    reactFrom: 20, reactTo: 90, // the site hinted "write him": a person does not jump at it in a second
    idleChance: 30, // % — between men sometimes just scroll the list and look around, like a person
  },
  afterReply: { attempts: 10, silenceHours: 48, everyHours: 48 },
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

/** A "from–to" pause: both numbers, to ≥ from. `def` null = may stay empty. */
function pair(src, name, min, max, def) {
  const f = `${name}From`;
  const t = `${name}To`;
  const empty = (v) => v === null || v === undefined || v === '';
  if (def === null && empty(src[f]) && empty(src[t])) return { [f]: null, [t]: null };
  const a = Math.round(num(src[f], min, max, def ? def[f] : min));
  const b = Math.round(num(src[t], min, max, def ? def[t] : a));
  return { [f]: Math.min(a, b), [t]: Math.max(a, b) };
}

/** "9-13, 15-23" or [[9,13],[15,23]] → [[9,13],[15,23]]; nothing valid → one window from–to. */
export function readWindows(v, from, to) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/[,;]+/).map((x) => x.split(/[-–—]/)))
    .map((w) => (Array.isArray(w) ? w.map((x) => Number(String(x).trim().replace(/:00$/, ''))) : []))
    .filter((w) => w.length === 2 && w.every((x) => Number.isInteger(x) && x >= 0 && x <= 24) && w[0] !== w[1])
    .slice(0, 6);
  if (list.length) return list.sort((a, b) => a[0] - b[0]);
  const f = Math.round(num(from, 0, 24, 9));
  const t = Math.round(num(to, 0, 24, 23));
  return [[f, t]];
}

function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return null;
  switch (a.do) {
    case 'message': {
      const src = ['invite', 'followup', 'letter', 'custom'].includes(a.text) ? a.text : 'invite';
      const out = { do: 'message', text: src, via: a.via === 'letter' ? 'letter' : 'chat', files: ['all', 'one', 'none'].includes(a.files) ? a.files : 'all' };
      if (src === 'custom') {
        out.custom = text(a.custom, 6000);
        if (!out.custom) return null;
      }
      return out;
    }
    case 'click':
      return KEY_RE.test(String(a.action || '')) ? { do: 'click', action: String(a.action), chance: Math.round(num(a.chance, 0, 100, 100)) } : null;
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
  const ar = src.afterReply || {};
  const d = DEFAULT_SCENARIO.human;
  const da = DEFAULT_SCENARIO.afterReply;
  const out = {
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
      // several working windows a day ("9-13, 15-23"); hoursFrom/hoursTo stay as the first start / last end
      windows: readWindows(hm.windows, hm.hoursFrom ?? d.hoursFrom, hm.hoursTo ?? d.hoursTo),
      perHour: Math.round(num(hm.perHour, 0, 500, d.perHour)),
      breakEvery: Math.round(num(hm.breakEvery, 0, 500, d.breakEvery)),
      breakMinutes: Math.round(num(hm.breakMinutes, 1, 180, d.breakMinutes)),
      breakMinutesTo: Math.round(num(hm.breakMinutesTo ?? hm.breakMinutes ?? d.breakMinutesTo, 1, 240, d.breakMinutesTo)),
      typeSpeed: Math.round(num(hm.typeSpeed, 60, 1500, d.typeSpeed)),
      ...pair(hm, 'gap', 5, 7200, null),
      ...pair(hm, 'think', 0, 120, d),
      ...pair(hm, 'actionGap', 0, 300, d),
      ...pair(hm, 'pageGap', 0, 600, d),
      ...pair(hm, 'react', 0, 1800, d),
      idleChance: Math.round(num(hm.idleChance, 0, 100, d.idleChance)),
      typing: hm.typing === undefined ? d.typing : Boolean(hm.typing),
      // working days, 1 = Monday … 7 = Sunday (agency time zone); none picked = every day
      days: (() => {
        const list = Array.isArray(hm.days) ? [...new Set(hm.days.map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 7))].sort() : [];
        return list.length ? list : [...d.days];
      })(),
      // spread the daily limit evenly over the working hours instead of sending it all at once
      spread: hm.spread === undefined ? d.spread : Boolean(hm.spread),
    },
    afterReply: {
      attempts: Math.round(num(ar.attempts, 0, 50, da.attempts)),
      silenceHours: Math.round(num(ar.silenceHours, 1, 720, da.silenceHours)),
      everyHours: Math.round(num(ar.everyHours, 1, 720, da.everyHours)),
    },
  };
  const w = out.human.windows;
  if (w.length > 1 || (Array.isArray(hm.windows) || typeof hm.windows === 'string')) {
    out.human.hoursFrom = w[0][0];
    out.human.hoursTo = w.at(-1)[1];
  }
  // "Round the clock" (from = to) stays one window
  if (hm.windows === undefined && out.human.hoursFrom === out.human.hoursTo) out.human.windows = [[out.human.hoursFrom, out.human.hoursTo]];
  return out;
}

/** Ready-made templates everyone has; agencies save their own on top. */
export const PRESETS = [
  { id: 'preset:standard', name: 'Стандарт: інвайт + 2 повторні', scenario: DEFAULT_SCENARIO },
  { id: 'preset:soft', name: 'М’який: інвайт + 1 повторне через 2 дні', scenario: {
    steps: [
      { wait: 0, actions: [{ do: 'message', text: 'invite' }] },
      { wait: 48, actions: [{ do: 'message', text: 'followup' }] },
    ],
    human: { hoursFrom: 10, hoursTo: 22, perHour: 25, breakEvery: 15, breakMinutes: 15, typing: true },
  } },
  { id: 'preset:active', name: 'Активний: лайк + перегляд + 3 спроби', scenario: {
    steps: [
      { wait: 0, actions: [{ do: 'view', chance: 40, seconds: 10 }, { do: 'click', action: 'like', chance: 100 }, { do: 'message', text: 'invite' }] },
      { wait: 12, actions: [{ do: 'message', text: 'followup', files: 'one' }] },
      { wait: 36, actions: [{ do: 'view', chance: 60, seconds: 8 }, { do: 'message', text: 'followup' }] },
    ],
    human: { hoursFrom: 8, hoursTo: 24, perHour: 45, breakEvery: 25, breakMinutes: 8, typing: true },
  } },
];

const parse = (json) => { try { return sanitizeScenario(JSON.parse(json)); } catch { return null; } };

/** Scenario stored for a site ('' = default). */
export function siteScenario(site) {
  if (!site?.scenario) return sanitizeScenario(DEFAULT_SCENARIO);
  return parse(site.scenario) || sanitizeScenario(DEFAULT_SCENARIO);
}

/** What a profile runs: its own template if one is chosen, else the site's scenario. */
export function profileScenario(db, profile, site) {
  if (profile?.scenario_id) {
    const t = db.prepare('SELECT scenario FROM scenario_templates WHERE id = ? AND agency_id = ?').get(profile.scenario_id, profile.agency_id);
    const sc = t && parse(t.scenario);
    if (sc) return sc;
  }
  return siteScenario(site);
}

/** How many of the steps send a message ("спроби"). */
export const attempts = (scenario) => scenario.steps.filter((s) => s.actions.some((a) => a.do === 'message')).length;

/** Does any step send the AI letter? */
export const usesLetters = (scenario) => scenario.steps.some((s) => s.actions.some((a) => a.do === 'message' && a.text === 'letter'));

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
