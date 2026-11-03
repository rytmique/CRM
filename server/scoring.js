/**
 * Which men are worth writing to first.
 *
 * Every first contact and every positive reply update a platform-wide table of "features" of the man as the
 * card showed them: country, age group, taught marks (online, premium…) and words from his card text.
 * No names or IDs are stored there — only these anonymous features with two counters.
 * A man's score = how much his features raise the chance of a reply above the average (log-lift, smoothed),
 * so new features count for little until there is data behind them.
 */
import { now } from './db.js';

const SMOOTH = 25; // pseudo-sends at the average rate: a feature needs real data to move the score
const READY_AFTER = 60; // first contacts on the platform before ranking is trusted
const MAX_FEATURES = 40;
const STOP = new Set(('about also always been being both cause come could does each even ever from good have here into just know like look looking love make more most much must need never only other over really same seek seeking some such sure take than that their them then there these they thing this those time very want well were what when where which while will with would your yours year years life live lives person people woman women lady ladies girl someone something '
  + 'меня мене тебе себе дуже очень есть буду хочу шукаю ищу люблю жінку женщину жизнь життя когда коли який какой которая').split(' '));

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Words from his card text, without his name, numbers and filler. */
function words(text, name) {
  const skip = new Set(norm(name).split(/[^\p{L}]+/u).filter(Boolean));
  const out = new Set();
  for (const w of norm(text).split(/[^\p{L}]+/u)) {
    if (w.length < 4 || w.length > 20 || STOP.has(w) || skip.has(w)) continue;
    out.add(w);
    if (out.size >= 25) break;
  }
  return [...out];
}

/** Anonymous features of a man as his card shows him. `host` scopes the taught marks to the dating site. */
export function manFeatures(man, host = '') {
  const f = new Set();
  const country = norm(man.country).replace(/[^\p{L} ]/gu, '').slice(0, 40);
  if (country) f.add(`c:${country}`);
  if (man.age) f.add(`a:${Math.floor(man.age / 5) * 5}`);
  for (const k of man.marks || []) f.add(`m:${host}:${String(k).slice(0, 24)}`);
  for (const w of words(man.info, man.name)) f.add(`w:${w}`);
  return [...f].slice(0, MAX_FEATURES);
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

const bump = (db, features, col) => {
  const t = now();
  const up = db.prepare(`INSERT INTO man_stats (feature, sent, replied, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(feature) DO UPDATE SET ${col} = ${col} + 1, updated_at = excluded.updated_at`);
  for (const f of ['*', ...features]) up.run(f, col === 'sent' ? 1 : 0, col === 'replied' ? 1 : 0, t);
};

/** A first message went out. */
export const learnSent = (db, features) => bump(db, features, 'sent');
/** He answered with interest (once per man). */
export const learnReply = (db, features) => bump(db, features, 'replied');

function statsFor(db, features) {
  const map = new Map();
  const list = [...new Set(features)];
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    for (const r of db.prepare(`SELECT feature, sent, replied FROM man_stats WHERE feature IN (${part.map(() => '?').join(',')})`).all(...part)) map.set(r.feature, r);
  }
  return map;
}

/** Is there enough data on the platform for the ranking to mean anything? */
export function rankingState(db) {
  const g = db.prepare("SELECT sent, replied FROM man_stats WHERE feature = '*'").get() || { sent: 0, replied: 0 };
  return { ready: g.sent >= READY_AFTER && g.replied > 0, sent: g.sent, replied: g.replied };
}

/**
 * Adds `score` (and `why`: the strongest positive features) to each man. Higher = write first.
 * Men keep their order when there is no data yet.
 */
export function scoreMen(db, men, host = '') {
  const feats = men.map((m) => manFeatures(m, host));
  const stats = statsFor(db, ['*', ...feats.flat()]);
  const g = stats.get('*') || { sent: 0, replied: 0 };
  const p0 = (g.replied + 1) / (g.sent + 20);
  return men.map((m, i) => {
    let score = 0;
    const why = [];
    for (const f of feats[i]) {
      const s = stats.get(f);
      if (!s) continue;
      const lift = Math.log(((s.replied + SMOOTH * p0) / (s.sent + SMOOTH)) / p0);
      score += lift;
      if (lift > 0.15) why.push([lift, f]);
    }
    why.sort((a, b) => b[0] - a[0]);
    return { ...m, features: feats[i], score: Math.round(score * 1000) / 1000, why: why.slice(0, 3).map(([, f]) => label(f)) };
  });
}

/** Human words for a feature: "USA", "45–49", "online", "engineer". */
function label(f) {
  if (f.startsWith('a:')) { const a = Number(f.slice(2)); return `${a}–${a + 4}`; }
  if (f.startsWith('m:')) return f.split(':').pop();
  return f.slice(2);
}
