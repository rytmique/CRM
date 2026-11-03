/**
 * Invites that learn.
 *
 * 1. Each profile keeps a few invite variants live at once (A/B/C). For every new man the bot picks one by
 *    Thompson sampling: variants that get more positive replies are sent more often, new ones still get a chance.
 * 2. The optimizer retires a variant that is clearly worse than the best one (enough sends, ≥ 90 % sure) and writes
 *    a fresh one that keeps what works in the best one.
 * 3. Shared memory of the platform: short lessons learned from real replies across all agencies (anonymous — no
 *    names, no texts of a particular profile). They are added to every invite/follow-up prompt.
 */
import { now, tx } from './db.js';
import { getSettings } from './services.js';
import { generateInvite, askClaude } from './ai.js';

const MIN_SENT_TO_JUDGE = 40; // sends before a variant may be retired
const MIN_SENT_FOR_MEMORY = 30; // sends before an invite counts for platform lessons
const MEMORY_EVERY = 6 * 3600000;

// ---------- Beta sampling (Thompson) ----------
function gaussian() {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gamma(k) {
  if (k < 1) return gamma(k + 1) * Math.random() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a, b) => { const x = gamma(a); return x / (x + gamma(b)); };

/** Live variants of a profile with their numbers. replies = positive replies only. */
export function inviteStats(db, profileId, { all = false } = {}) {
  return db.prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM messages m WHERE m.invite_id = i.id AND m.status = 'sent') AS sent,
      (SELECT COUNT(*) FROM messages m WHERE m.invite_id = i.id AND m.replied_at IS NOT NULL AND m.reply_mood != 'negative') AS replies
    FROM invites i WHERE i.profile_id = ? ${all ? '' : 'AND i.active = 1'} ORDER BY i.id`).all(profileId)
    .map((i) => ({ ...i, rate: i.sent ? i.replies / i.sent : null }));
}

/** Which live variant this man gets. */
export function pickInvite(variants) {
  if (!variants.length) return null;
  if (variants.length === 1) return variants[0];
  let best = null;
  let bestDraw = -1;
  for (const v of variants) {
    const draw = beta(1 + v.replies, 1 + Math.max(0, v.sent - v.replies));
    if (draw > bestDraw) { bestDraw = draw; best = v; }
  }
  return best;
}

/** Chance that variant `a` really has a higher reply rate than `b` (Monte Carlo over the Beta posteriors). */
export function chanceBetter(a, b, draws = 2000) {
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    if (beta(1 + a.replies, 1 + a.sent - a.replies) > beta(1 + b.replies, 1 + b.sent - b.replies)) wins++;
  }
  return wins / draws;
}

/** The best live variant by what is known so far (for the panel and as a model for new ones). */
export function bestOf(variants) {
  const judged = variants.filter((v) => v.sent >= 10);
  if (!judged.length) return null;
  return judged.reduce((a, b) => ((b.replies + 1) / (b.sent + 2) > (a.replies + 1) / (a.sent + 2) ? b : a));
}

/**
 * Keeps `settings.ai.variants` live variants: retires the clearly worse ones, writes new ones.
 * Returns what changed, for the log.
 */
export async function optimizeProfile(db, profile, settings) {
  const want = Math.max(1, Math.min(5, Number(settings.ai.variants) || 1));
  const live = inviteStats(db, profile.id);
  const out = { retired: [], added: [] };
  if (!live.length) return out; // the first invite is written when the bot starts
  const best = bestOf(live);
  if (best && settings.ai.autoOptimize !== false) {
    for (const v of live) {
      if (v.id === best.id || v.sent < MIN_SENT_TO_JUDGE) continue;
      if (chanceBetter(best, v) >= 0.9) {
        db.prepare('UPDATE invites SET active = 0, retired_at = ? WHERE id = ?').run(now(), v.id);
        out.retired.push(v.id);
      }
    }
  }
  const still = live.length - out.retired.length;
  if (settings.ai.autoOptimize === false && still >= 1) return out;
  for (let n = still; n < want; n++) {
    const texts = inviteStats(db, profile.id).map((v) => v.text);
    const gen = await generateInvite({
      profile, settings, previous: texts.join('\n---\n'),
      bestExample: best && best.replies > 0 ? best.text : '',
      memory: memoryLines(db, settings),
    });
    const r = db.prepare('INSERT INTO invites (profile_id, text, source, model, active, created_by, created_at) VALUES (?,?,?,?,1,NULL,?)')
      .run(profile.id, gen.text, gen.source, gen.model ?? null, now());
    out.added.push(Number(r.lastInsertRowid));
  }
  return out;
}

// ---------- shared memory of the platform ----------
const LENGTHS = [[0, 200, 'до 200 символів'], [200, 300, '200–300 символів'], [300, 400, '300–400 символів'], [400, 10000, 'понад 400 символів']];
const EMOJI = /\p{Extended_Pictographic}/u;

/** Platform invites with enough sends, their texts made anonymous (no her name, no city). */
function platformInvites(db) {
  return db.prepare(`SELECT i.id, i.text, p.name, p.city, p.country,
      COUNT(m.id) AS sent, SUM(m.replied_at IS NOT NULL AND m.reply_mood != 'negative') AS replies
    FROM invites i JOIN profiles p ON p.id = i.profile_id JOIN messages m ON m.invite_id = i.id AND m.status = 'sent'
    GROUP BY i.id HAVING COUNT(m.id) >= ?`).all(MIN_SENT_FOR_MEMORY).map((r) => {
    let t = r.text;
    for (const w of [r.name, r.city, r.country]) if (w && w.length > 1) t = t.split(w).join('[…]');
    return { text: t, sent: r.sent, replies: r.replies || 0, rate: (r.replies || 0) / r.sent };
  });
}

/** Lessons that need no AI: compare reply rates by simple traits of the text. */
function statLessons(list) {
  const out = [];
  const group = (pred) => list.filter(pred).reduce((a, r) => ({ sent: a.sent + r.sent, replies: a.replies + r.replies }), { sent: 0, replies: 0 });
  const rate = (g) => (g.sent ? g.replies / g.sent : 0);
  const base = rate(group(() => true));
  if (!base) return out;
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  const lens = LENGTHS.map(([a, b, label]) => ({ label, ...group((r) => r.text.length >= a && r.text.length < b) })).filter((g) => g.sent >= 100);
  if (lens.length >= 2) {
    const top = lens.reduce((a, b) => (rate(b) > rate(a) ? b : a));
    if (rate(top) > base * 1.15) out.push(`Invites of ${top.label.replace('до', 'up to').replace('понад', 'over').replace('символів', 'characters')} get the most replies (${pct(rate(top))} vs ${pct(base)} on average).`);
  }
  const traits = [
    ['end with a question', (r) => /\?\s*\S{0,3}\s*$/.test(r.text)],
    ['greet him by name', (r) => /\{name\}/.test(r.text)],
    ['contain an emoji', (r) => EMOJI.test(r.text)],
  ];
  for (const [label, pred] of traits) {
    const yes = group(pred);
    const no = group((r) => !pred(r));
    if (yes.sent < 100 || no.sent < 100) continue;
    if (rate(yes) > rate(no) * 1.15) out.push(`Invites that ${label} get more replies (${pct(rate(yes))} vs ${pct(rate(no))}).`);
    else if (rate(no) > rate(yes) * 1.15) out.push(`Invites that do not ${label} get more replies (${pct(rate(no))} vs ${pct(rate(yes))}).`);
  }
  return out;
}

const MEMORY_PROMPT = `You study opening messages that women sent from their profiles on international dating sites, with the share of men who answered each one with interest. Find what separates the messages that get answers from those that do not.

Write 3 to 7 short, practical lessons for writing new opening messages. Each lesson:
- is one sentence in English, at most 160 characters;
- is general: no names, places, or details of a particular woman;
- is backed by the examples (tone, length, structure, kind of question, what to mention or avoid).

Reply with the lessons only, one per line, no numbering.`;

/** Rebuilds the platform lessons: always the numbers-based ones; AI ones when the platform has an API key. */
export async function refreshMemory(db, { force = false } = {}) {
  const last = db.prepare("SELECT MAX(created_at) AS t FROM ai_memory WHERE source != 'admin'").get().t || 0;
  if (!force && now() - last < MEMORY_EVERY) return { skipped: true };
  const list = platformInvites(db);
  const lessons = statLessons(list).map((text) => ({ text, source: 'stats' }));
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (apiKey && list.length >= 6) {
    const sorted = [...list].sort((a, b) => b.rate - a.rate);
    const pick = [...sorted.slice(0, 8), ...sorted.slice(-8)].filter((x, i, arr) => arr.indexOf(x) === i);
    const examples = pick.map((r) => `[${Math.round(r.rate * 1000) / 10}% answered, ${r.sent} sent] ${r.text}`).join('\n\n');
    try {
      const text = await askClaude({ apiKey, model: 'claude-opus-5-5', system: MEMORY_PROMPT, user: examples });
      for (const line of text.split('\n').map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim()).filter((l) => l.length >= 15 && l.length <= 220).slice(0, 7)) {
        lessons.push({ text: line, source: 'ai' });
      }
    } catch { /* numbers-based lessons still apply */ }
  }
  const t = now();
  tx(db, () => {
    db.prepare("DELETE FROM ai_memory WHERE source != 'admin'").run();
    const ins = db.prepare('INSERT INTO ai_memory (text, source, active, created_at) VALUES (?,?,1,?)');
    for (const l of lessons) ins.run(l.text, l.source, t);
    if (!lessons.length) ins.run('', 'stats', t); // remembers when it ran; empty lines are never shown
  });
  return { lessons: lessons.length, invites: list.length };
}

/** Lessons to put into prompts (empty when the agency switched shared memory off). */
export function memoryLines(db, settings) {
  if (settings?.ai?.sharedMemory === false) return [];
  return db.prepare("SELECT text FROM ai_memory WHERE active = 1 AND text != '' ORDER BY source = 'admin' DESC, id LIMIT 12").all().map((r) => r.text);
}

/** One pass over the whole platform: called on a timer by the server. */
export async function runLearning(db, log = console) {
  await refreshMemory(db).catch((e) => log.error?.('memory', e));
  const profiles = db.prepare(`SELECT p.* FROM profiles p JOIN agencies a ON a.id = p.agency_id
    WHERE p.status = 'active' AND a.active = 1 AND EXISTS (SELECT 1 FROM invites i WHERE i.profile_id = p.id AND i.active = 1)`).all();
  for (const p of profiles) {
    try { await optimizeProfile(db, p, getSettings(db, p.agency_id)); } catch (e) { log.error?.('optimize', p.id, e.message); }
  }
}
