import { Router } from 'express';
import { now, tx, platformGet, cmpVersion } from '../db.js';
import { latestBotVersion } from '../version.js';
import { HttpError, bad, forbidden, notFound, str, int, oneOf, ah, dayKey } from '../util.js';
import {
  getSettings, profileSettings, planOf, accessFor, accessError, licenseState, profileScope, getVisibleProfile, profileLicense, activeInvite,
  limitsFor, sentToday, insertInvite, hourWindow, followupTexts, saveFollowup, canEditSite,
} from '../services.js';
import { generateInvite, generateFollowup, templateFollowup, generateReengage, templateReengage, classifyReply, generateLetter, templateLetter, generateTopic, templateTopic, generateReply, generateHook, withHook, hookKey } from '../ai.js';
import { reportPass, shiftKey } from '../reports.js';
import { personalize } from '../personalize.js';
import { sendTelegram, escapeHtml } from '../telegram.js';
import { SITE_FIELDS, sanitizeSiteConfig, fillUrl, siteReady } from '../sites.js';
import { profileScenario, followupSteps, filterReason, pickVariant, attempts, usesLetters } from '../scenario.js';
import { filesForStep, mediaFile, CHANCE_STEP } from '../media.js';
import { scoreMen, manFeatures, hostOf, learnSent, learnReply, rankingState } from '../scoring.js';
import { inviteStats, pickInvite, optimizeProfile, memoryLines } from '../learning.js';

const HOUR = 3600000;
const MAX_STEP_FAILS = 3;
/** followups.step that holds the "---"-separated reminders for men who replied and went quiet. */
export const REENGAGE_STEP = 100;
/** followups.step that holds the AI letter (the site's mail section). */
export const LETTER_STEP = 200;
const MAX_BONUS = 100;
const MODES = ['chance', 'hint', 'list', 'due', 'allchat'];

/** API used by the browser extension (the bot). */
export default function botRoutes(db, cfg) {
  const r = Router();

  const readMan = (m) => {
    if (!m || typeof m !== 'object') return null;
    const id = String(m.id ?? '').trim().slice(0, 120);
    if (!id) return null;
    const age = Number.parseInt(m.age, 10);
    const url = String(m.url ?? '').trim();
    return {
      id,
      name: String(m.name ?? '').trim().slice(0, 80),
      age: Number.isInteger(age) && age >= 18 && age < 100 ? age : null,
      country: String(m.country ?? '').trim().slice(0, 80),
      url: /^https?:\/\//i.test(url) ? url.slice(0, 500) : '',
      marks: Array.isArray(m.marks) ? m.marks.map(String).slice(0, 20) : [],
      text: String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      info: String(m.info ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      via: m.via === 'letter' ? 'letter' : m.via === 'chat' ? 'chat' : '',
      online: m.online === true ? true : m.online === false ? false : null,
      place: String(m.place ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), // his city / country (the chat header)
      hook: ['personal', 'city', 'flirt'].includes(m.hook) ? m.hook : '',
    };
  };
  const siteHost = (site, config) => hostOf(config?.searchUrl || site?.base_url || '');
  /** Taught mark keys → their names, for "why first" hints. */
  const markNames = (config, why) => why.map((w) => (config.marks || []).find((mk) => mk.key === w)?.name || w);

  const siteOf = (p) => (p.site_id ? db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id) : null);
  const configOf = (site) => { try { return JSON.parse(site?.config || '{}'); } catch { return {}; } };

  /** Everything needed to turn a scenario step into concrete actions for one man. */
  const stepContext = (p) => {
    const site = siteOf(p);
    const config = configOf(site);
    return {
      p, site, config, scenario: profileScenario(db, p, site),
      invite: activeInvite(db, p.id), variants: inviteStats(db, p.id), followups: followupTexts(db, p.id),
    };
  };

  const fillHer = (t, p) => String(t || '').replaceAll('{her_name}', p.name || '').replaceAll('{her_age}', p.age ? String(p.age) : '');

  /** Step index (0-based) → [{do:'message', text} | {do:'click', sel…} | {do:'view'…} | {do:'pause'…}] */
  const resolveStep = (ctx, idx, man) => {
    const step = ctx.scenario.steps[idx];
    const out = [];
    let inviteId = null;
    for (const raw of step?.actions || []) {
      // The site's own hint says how to write to him ("Please write him letter"): it wins over the scenario.
      const a = raw.do === 'message' && man.via ? { ...raw, via: man.via, text: man.via === 'letter' ? 'letter' : (raw.text === 'letter' ? 'invite' : raw.text) } : raw;
      if (a.do === 'message') {
        let t = '';
        // One of the live variants: the ones that get more replies are picked more often.
        if (a.text === 'invite') { const v = pickInvite(ctx.variants) || ctx.invite; t = v?.text || ''; inviteId = v?.id ?? null; }
        else if (a.text === 'followup') t = ctx.followups.get(idx + 1) || ctx.invite?.text || '';
        else if (a.text === 'letter') t = ctx.followups.get(LETTER_STEP) || templateLetter(ctx.p).text;
        else t = pickVariant(a.custom);
        t = personalize(fillHer(t, ctx.p), man);
        const files = filesForStep(db, ctx.p.id, idx + 1, a.files);
        if (t || files.length) out.push({ do: 'message', text: t, files, via: a.via || 'chat' });
      } else if (a.do === 'click') {
        const def = (ctx.config.actions || []).find((x) => x.key === a.action);
        if (def) out.push({ do: 'click', key: def.key, name: def.name, sel: def.sel, where: def.where, chance: a.chance ?? 100 });
      } else {
        out.push({ ...a });
      }
    }
    return { actions: out, inviteId, messages: out.filter((a) => a.do === 'message').length };
  };

  const manUrl = (ctx, id, stored) => fillUrl(ctx.config.manUrl, id) || stored || '';

  /** Next step time or "done" after the step with index `done` (0-based) has been completed at time t. */
  const WAITING = "status = 'sent' AND next_at IS NOT NULL AND ((stage = 'active' AND replied_at IS NULL) OR (stage = 'replied' AND bonus_left > 0))";
  const dueNow = (pid, t = now()) => db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND ${WAITING} AND next_at <= ?`).get(pid, t).n;
  const pendingOf = (pid) => db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND ${WAITING}`).get(pid).n;

  const after = (scenario, done, t) => {
    const next = scenario.steps[done + 1];
    return next ? { stage: 'active', next_at: t + Math.round(next.wait * HOUR) } : { stage: 'done', next_at: null };
  };

  /** Loads a profile and verifies it may run right now. */
  const runnable = (req) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const plan = planOf(db, p.agency_id);
    const lic = accessFor(plan, p);
    if (!lic.valid) throw new HttpError(402, accessError(lic, p, plan));
    // an old copy of the bot (the admin set a minimum version): tell how to update instead of working with old code
    const min = platformGet(db, 'minBotVersion', '');
    if (min && cmpVersion(req.user.botVersion, min) < 0) {
      throw new HttpError(426, `Бот застарів (версія ${req.user.botVersion || 'стара'}, потрібна ${min}). Оновіть: у вікні бота «🔄 Оновити» або в панелі «Завантажити бота».`);
    }
    if (p.status !== 'active') throw new HttpError(409, `Анкету «${p.name}» поставлено на паузу в панелі.`);
    const settings = profileSettings(db, p);
    const day = dayKey(now(), settings.timezone);
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    return { p, lic, settings, day, limits, remaining };
  };

  r.get('/profiles', (req, res) => {
    const scope = profileScope(req.user);
    const rows = db.prepare(`SELECT p.id, p.name, p.age, p.photo_url, p.status, p.site_profile_id, p.site_id, p.test_ok, s.name AS site_name, s.base_url, s.config AS site_config
      FROM profiles p LEFT JOIN sites s ON s.id = p.site_id WHERE ${scope.where} ORDER BY p.name COLLATE NOCASE`).all(...scope.params);
    const settings = getSettings(db, req.user.agencyId);
    const day = dayKey(now(), settings.timezone);
    const plan = planOf(db, req.user.agencyId);
    res.json({
      bot: { latest: latestBotVersion(), min: platformGet(db, 'minBotVersion', '') }, // for "a new version is out"
      profiles: rows.map((p) => {
        const full = db.prepare('SELECT * FROM profiles WHERE id = ?').get(p.id);
        const limits = limitsFor(full, settings);
        const { site_config: sc, test_ok: tested, ...rest } = p;
        let siteCfg = {};
        try { siteCfg = JSON.parse(sc || '{}'); } catch { /* none */ }
        return {
          ...rest,
          siteReady: Boolean(sc) && siteReady(siteCfg),
          searchUrl: siteCfg.searchUrl || '',
          tested: Boolean(tested),
          started: Boolean(db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND status = 'sent' LIMIT 1").get(p.id)),
          license: accessFor(plan, p), // (the team's plan; same shape as the old license)
          sentToday: sentToday(db, p.id, day),
          dailyLimit: limits.dailyLimit,
        };
      }),
    });
  });

  // ---------- one button for everything: the bot finds the women on the site itself and works for all of them ----------
  /** The site this person works on (the one their profiles use, else the team's newest) and their profiles there. */
  const workSite = (user, tabUrl = '') => {
    // the site open in the bot's tab, when it is one of the team's (the closest start page wins)
    let tab = null;
    try { tab = tabUrl ? new URL(tabUrl) : null; } catch { tab = null; }
    if (tab) {
      const score = (s) => {
        let u;
        try { u = new URL(configOf(s).searchUrl || s.base_url); } catch { return 0; }
        if (u.origin !== tab.origin) return 0;
        if (u.pathname === tab.pathname) return 3;
        return tab.pathname.startsWith(u.pathname.replace(/[^/]*$/, '')) ? 1 + (u.pathname.replace(/[^/]*$/, '').length / 1000) : 0.5;
      };
      const best = db.prepare('SELECT * FROM sites WHERE agency_id = ? ORDER BY id DESC').all(user.agencyId).map((s) => [score(s), s]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0])[0];
      if (best) return best[1];
    }
    const scope = profileScope(user);
    return db.prepare(`SELECT s.* FROM profiles p JOIN sites s ON s.id = p.site_id WHERE ${scope.where} ORDER BY p.bot_beat_at DESC NULLS LAST, p.id DESC LIMIT 1`).get(...scope.params)
      || db.prepare('SELECT * FROM sites WHERE agency_id = ? ORDER BY id DESC LIMIT 1').get(user.agencyId);
  };
  /** The women this person works as (the team lead too — only their own; the bot never works for someone else's). */
  const myProfiles = (user, siteId) => {
    const plan = planOf(db, user.agencyId);
    return db.prepare('SELECT p.id, p.name, p.age, p.status, p.site_profile_id, p.site_id FROM profiles p WHERE p.agency_id = ? AND p.operator_id = ? AND p.site_id = ? ORDER BY p.id')
      .all(user.agencyId, user.id, siteId).map((p) => ({ ...p, license: accessFor(plan, p) }));
  };
  r.get('/workspace', (req, res) => {
    const site = workSite(req.user, String(req.query.url || ''));
    if (!site) throw new HttpError(409, 'Сайт команди ще не підключено — напишіть постачальнику.');
    res.json({ site: { id: site.id, name: site.name, base_url: site.base_url, config: configOf(site) }, profiles: myProfiles(req.user, site.id) });
  });
  /** The women the bot sees on the site (ID, name, age): new ones become profiles of this person; others' are never taken. */
  r.post('/hers', (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND agency_id = ?').get(int(req.body?.site_id, { min: 1, field: 'site_id' }), req.user.agencyId);
    if (!site) throw notFound('Сайт не знайдено');
    const list = (Array.isArray(req.body?.hers) ? req.body.hers : []).slice(0, 100).map((h) => ({
      id: String(h?.id ?? '').replace(/\s+/g, '').slice(0, 40), name: String(h?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      age: Number.isInteger(Number(h?.age)) && Number(h.age) >= 18 && Number(h.age) < 100 ? Number(h.age) : null,
    })).filter((h) => h.name || h.id);
    const t = now();
    const added = [];
    for (const h of list) {
      const have = h.id
        ? db.prepare('SELECT * FROM profiles WHERE agency_id = ? AND site_id = ? AND site_profile_id = ?').get(req.user.agencyId, site.id, h.id)
        : db.prepare("SELECT * FROM profiles WHERE agency_id = ? AND site_id = ? AND site_profile_id = '' AND lower(name) = lower(?)").get(req.user.agencyId, site.id, h.name);
      if (have) {
        if (have.operator_id === req.user.id || req.user.role === 'owner') {
          db.prepare('UPDATE profiles SET name = ?, age = COALESCE(?, age) WHERE id = ?').run(h.name || have.name, h.age, have.id);
        }
        continue; // another operator's woman: never taken over
      }
      const plan = planOf(db, req.user.agencyId);
      const room = !plan.profiles || plan.used < plan.profiles;
      db.prepare('INSERT INTO profiles (agency_id, operator_id, site_id, name, age, site_profile_id, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.user.agencyId, req.user.id, site.id, h.name || `ID ${h.id}`, h.age, h.id, room ? 'active' : 'paused', t);
      added.push({ name: h.name, paused: !room });
    }
    res.json({ added, profiles: myProfiles(req.user, site.id) });
  });

  r.get('/profiles/:id/config', ah(async (req, res) => {
    const { p, lic, settings, limits, remaining } = runnable(req);
    if (!p.site_id) throw bad('Для анкети не вибрано сайт. Вкажіть сайт у панелі.');
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(p.site_id);
    let invite = activeInvite(db, p.id);
    if (!invite) {
      const gen = await generateInvite({ profile: p, settings, memory: memoryLines(db, settings) });
      invite = insertInvite(db, { profileId: p.id, text: gen.text, source: gen.source, model: gen.model, userId: req.user.id });
    }
    // A few variants live at once; weak ones are replaced by new ones (AI down must not stop the bot).
    await optimizeProfile(db, p, settings).catch(() => {});
    const variants = inviteStats(db, p.id);
    const scenario = profileScenario(db, p, site);
    // Follow-up texts are written once per profile and step, like the invite.
    const have = followupTexts(db, p.id);
    const previous = [invite.text];
    for (const step of followupSteps(scenario)) {
      if (!have.has(step)) {
        let gen;
        try { gen = await generateFollowup({ profile: p, settings, step, previous }); } catch { gen = templateFollowup(p, step); } // AI down must not stop the bot
        saveFollowup(db, { profileId: p.id, step, text: gen.text, source: gen.source, model: gen.model });
        have.set(step, gen.text);
      }
      previous.push(have.get(step));
    }
    if ((usesLetters(scenario) || JSON.parse(site.config || '{}').taskItem || settings.modes.chance.on) && !have.has(LETTER_STEP)) {
      let gen;
      try { gen = await generateLetter({ profile: p, settings, memory: memoryLines(db, settings) }); } catch { gen = templateLetter(p); }
      saveFollowup(db, { profileId: p.id, step: LETTER_STEP, text: gen.text, source: gen.source, model: gen.model });
    }
    if (scenario.afterReply.attempts > 0 && !have.has(REENGAGE_STEP)) {
      let gen;
      try { gen = await generateReengage({ profile: p, settings }); } catch { gen = templateReengage(); }
      saveFollowup(db, { profileId: p.id, step: REENGAGE_STEP, text: gen.text, source: gen.source, model: gen.model });
    }
    const pending = pendingOf(p.id);
    res.json({
      profile: { id: p.id, name: p.name, age: p.age, site_profile_id: p.site_profile_id },
      site: { id: site.id, name: site.name, base_url: site.base_url, config: JSON.parse(site.config || '{}') },
      invite: { id: invite.id, text: invite.text },
      variants: variants.length,
      // Pause between men: the profile's own > the scenario's > the agency default.
      limits: {
        ...limits, remaining,
        // (never below the platform admin's floor)
        minDelay: Math.max(p.min_delay ?? scenario.human.gapFrom ?? limits.minDelay, settings.caps.minDelayFloor || 0),
        maxDelay: Math.max(p.min_delay ?? scenario.human.gapFrom ?? limits.minDelay, settings.caps.minDelayFloor || 0, p.max_delay ?? scenario.human.gapTo ?? limits.maxDelay),
      },
      license: lic,
      inboxCheckEvery: settings.inboxCheckEvery,
      timezone: settings.timezone,
      scenario: {
        steps: scenario.steps.length, attempts: attempts(scenario), human: scenario.human, afterReply: scenario.afterReply,
        followups: scenario.steps.length > 1 || scenario.afterReply.attempts > 0,
      },
      pending,
      ranking: { ...rankingState(db), manUrl: Boolean(JSON.parse(site.config || '{}').manUrl) },
      modes: effectiveModes(settings),
    });
  }));

  /** A file to attach (her photo…): only files of profiles this user may run. */
  r.get('/media/:id', (req, res) => {
    const m = db.prepare('SELECT * FROM media WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!m) throw notFound('Файл не знайдено');
    getVisibleProfile(db, req.user, m.profile_id);
    res.set('Content-Type', m.type);
    res.set('X-File-Name', encodeURIComponent(m.name));
    res.sendFile(mediaFile(cfg, m));
  });

  /** Site adapter for the click-to-teach panel in the extension. */
  r.get('/profiles/:id/site', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const site = siteOf(p);
    if (!site) throw bad('Для анкети не вибрано сайт. Виберіть сайт у панелі (Анкети → Редагувати).');
    res.json({ site: { id: site.id, name: site.name, config: configOf(site) }, fields: SITE_FIELDS });
  });

  /** Saves what the operator taught by clicking. Owner: any site of the agency; operator: sites of own profiles. */
  r.put('/sites/:id', (req, res) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND agency_id = ?').get(Number(req.params.id), req.user.agencyId);
    if (!site) throw notFound('Сайт не знайдено');
    if (!canEditSite(db, req.user, site)) throw forbidden('Цей сайт не прив’язаний до ваших анкет');
    const config = sanitizeSiteConfig(req.body?.config || {});
    db.prepare('UPDATE sites SET config = ? WHERE id = ?').run(JSON.stringify(config), site.id);
    res.json({ ok: true, config });
  });

  /** Men who may get a first message: never contacted, right age, pass the filters. Best first. */
  const eligible = (p, ctx, settings, list) => {
    const men = [];
    const seen = new Set();
    for (const raw of list) {
      const m = readMan(raw);
      if (m && !seen.has(m.id)) { seen.add(m.id); men.push(m); }
    }
    const contacted = db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'");
    const contactedByAgency = db.prepare("SELECT 1 FROM messages WHERE agency_id = ? AND site_id IS ? AND man_id = ? AND status = 'sent' LIMIT 1");
    const skipped = { contacted: 0, age: 0, filter: 0, limit: 0 };
    const ok = [];
    for (const m of men) {
      if (contacted.get(p.id, m.id) || (settings.dedupeAcrossAgency && contactedByAgency.get(p.agency_id, p.site_id, m.id))) { skipped.contacted++; continue; }
      if (m.age && ((p.target_age_min && m.age < p.target_age_min) || (p.target_age_max && m.age > p.target_age_max))) { skipped.age++; continue; }
      if (filterReason(m, ctx.scenario.filters)) { skipped.filter++; continue; }
      ok.push(m);
    }
    // Best first once the platform has enough data; until then the site's own order (scores would be noise).
    const scored = scoreMen(db, ok, siteHost(ctx.site, ctx.config)).map((m) => ({ ...m, why: markNames(ctx.config, m.why) }));
    const ranked = rankingState(db).ready
      ? scored.map((m, i) => ({ m, i })).sort((a, b) => b.m.score - a.m.score || a.i - b.i).map(({ m }) => m)
      : scored;
    return { ranked, skipped };
  };

  /**
   * «Шанс»: her letter with a hook in front written for this man (he sees only the first ~5 characters in his list:
   * personal / his city / flirt, never the same start as her recent letters), and the photos chosen for «Шанс» (none → step 1).
   */
  const chanceStep = async (ctx, m, settings) => {
    const { features, ...man } = m;
    const last = db.prepare("SELECT text FROM messages WHERE profile_id = ? AND mode = 'chance' AND status = 'sent' ORDER BY id DESC LIMIT 40").all(ctx.p.id).map((r) => r.text);
    const recent = new Set(last.map(hookKey));
    const seed = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE profile_id = ? AND mode = 'chance' AND status = 'sent'").get(ctx.p.id).n;
    const h = await generateHook({ profile: ctx.p, settings, man, recent, seed, lately: last.slice(0, 8) });
    const text = personalize(fillHer(withHook(h.hook, ctx.followups.get(LETTER_STEP) || templateLetter(ctx.p).text), ctx.p), m);
    let files = filesForStep(db, ctx.p.id, CHANCE_STEP);
    if (!files.length) files = filesForStep(db, ctx.p.id, 1);
    return { ...man, hook: h.category, url: manUrl(ctx, m.id, m.url), step: 1, mode: 'chance', via: 'letter', text, invite_id: null,
      actions: [{ do: 'message', via: 'letter', text, files }] };
  };

  const firstStep = (ctx, m) => {
    const step = resolveStep(ctx, 0, m);
    const first = step.actions.find((a) => a.do === 'message');
    const { features, ...man } = m;
    return { ...man, url: manUrl(ctx, m.id, m.url), step: 1, actions: step.actions, text: first?.text || '', invite_id: step.inviteId };
  };

  r.post('/profiles/:id/filter', ah(async (req, res) => {
    const { p, settings, remaining } = runnable(req);
    const ctx = stepContext(p);
    if (!ctx.invite) throw new HttpError(409, 'У анкети немає активного інвайту');
    const list = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 300) : [];
    const chance = req.body?.mode === 'chance';
    const { ranked: all, skipped } = eligible(p, ctx, settings, list);
    // «Шанс» writes only to men who are online right now (if the team wants it so)
    const ranked = chance && settings.modes.chance.onlineOnly ? all.filter((m) => m.online !== false) : all;
    if (chance) skipped.offline = all.length - ranked.length;
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour);
    // Test mode in the extension never sends, so it is not bound by the daily limit.
    const cap = req.body?.test ? 5 : remaining;
    skipped.limit = Math.max(0, ranked.length - cap);
    const take = ranked.slice(0, cap);
    const allowed = [];
    for (const m of take) allowed.push(chance ? await chanceStep(ctx, m, settings) : firstStep(ctx, m)); // (one man at a time in «Шанс»)
    res.json({ allowed, remaining, skipped, hourLeft: hour.left, hourResetAt: hour.resetAt });
  }));

  // ---------- scanning ahead: the best men of several pages first ----------
  const POOL_TTL = 6 * HOUR; // "online" and the like go stale

  /** Men seen while scanning ahead (no messages yet). */
  r.post('/profiles/:id/pool', (req, res) => {
    const { p, settings } = runnable(req);
    const ctx = stepContext(p);
    const list = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 600) : [];
    const { ranked } = eligible(p, ctx, settings, list);
    const t = now();
    db.prepare('DELETE FROM pool WHERE profile_id = ? AND seen_at < ?').run(p.id, t - POOL_TTL);
    const put = db.prepare(`INSERT INTO pool (profile_id, man_id, man, score, seen_at) VALUES (?,?,?,?,?)
      ON CONFLICT(profile_id, man_id) DO UPDATE SET man = excluded.man, score = excluded.score, seen_at = excluded.seen_at`);
    tx(db, () => { for (const m of ranked) put.run(p.id, m.id, JSON.stringify(m), m.score, t); });
    const total = db.prepare('SELECT COUNT(*) AS n FROM pool WHERE profile_id = ? AND taken_at IS NULL').get(p.id).n;
    res.json({ ok: true, added: ranked.length, total, ranking: rankingState(db) });
  });

  /** The best not-yet-contacted men from the scan: written to on their own pages, before the usual walk. */
  r.get('/profiles/:id/pool/next', (req, res) => {
    const { p, remaining } = runnable(req);
    const ctx = stepContext(p);
    const limit = Math.min(int(req.query.limit, { min: 1, max: 50, field: 'limit' }) || 10, remaining);
    const t = now();
    const out = [];
    if (limit > 0 && rankingState(db).ready && ctx.config.manUrl) {
      // Only the top part of what was seen: the rest is reached by the usual page walk anyway.
      const all = db.prepare('SELECT * FROM pool WHERE profile_id = ? AND seen_at > ? ORDER BY score DESC').all(p.id, t - POOL_TTL);
      const top = all.slice(0, Math.max(1, Math.ceil(all.length * 0.3))).filter((r2) => r2.score > 0.05 && !r2.taken_at);
      const contacted = db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'");
      const take = db.prepare('UPDATE pool SET taken_at = ? WHERE profile_id = ? AND man_id = ?');
      for (const row of top) {
        if (out.length >= limit) break;
        take.run(t, p.id, row.man_id);
        if (contacted.get(p.id, row.man_id)) continue;
        const m = JSON.parse(row.man);
        out.push(firstStep(ctx, m));
      }
    }
    res.json({ men: out, remaining });
  });

  /** Men due for the bot: reminders to men who replied and went quiet (warmest) first, then scenario follow-ups. */
  r.get('/profiles/:id/due', (req, res) => {
    const { p, remaining } = runnable(req);
    const ctx = stepContext(p);
    const limit = int(req.query.limit, { min: 1, max: 20, field: 'limit' }) || 5;
    const t = now();
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour, t);
    const out = [];
    if (remaining > 0) {
      const rows = db.prepare(`SELECT * FROM messages WHERE profile_id = ? AND ${WAITING} AND next_at <= ?
        ORDER BY stage = 'replied' DESC, next_at LIMIT ?`).all(p.id, t, limit * 2);
      const finish = db.prepare("UPDATE messages SET stage = 'done', next_at = NULL WHERE id = ?");
      const later = db.prepare('UPDATE messages SET next_at = ? WHERE id = ?');
      const stopReminders = db.prepare('UPDATE messages SET bonus_left = 0, next_at = NULL WHERE id = ?');
      for (const m of rows) {
        if (out.length >= limit) break;
        const man = { id: m.man_id, name: m.man_name, age: m.man_age, country: m.man_country };
        const url = manUrl(ctx, m.man_id, m.man_url);
        if (m.stage === 'replied') {
          if (!ctx.scenario.afterReply.attempts) { stopReminders.run(m.id); continue; } // switched off in the scenario
          if (!url && !ctx.config.findInput) { later.run(t + 6 * HOUR, m.id); continue; }
          const text = personalize(fillHer(pickVariant(ctx.followups.get(REENGAGE_STEP) || templateReengage().text), p), man);
          out.push({ ...man, url, kind: 'reengage', step: m.step, left: m.bonus_left, actions: [{ do: 'message', text, files: [] }] });
          continue;
        }
        if (m.step >= ctx.scenario.steps.length) { finish.run(m.id); continue; } // the scenario got shorter
        if (!url && !ctx.config.findInput) { later.run(t + 6 * HOUR, m.id); continue; } // nowhere to go until "URL профілю чоловіка" or "Пошук за ID" is set
        const step = resolveStep(ctx, m.step, man);
        out.push({ ...man, url, kind: 'followup', step: m.step + 1, of: ctx.scenario.steps.length, actions: step.actions });
      }
    }
    const nextAt = db.prepare(`SELECT MIN(next_at) AS t FROM messages WHERE profile_id = ? AND ${WAITING}`).get(p.id).t;
    res.json({ men: out, remaining, pending: pendingOf(p.id), nextAt, hourLeft: hour.left, hourResetAt: hour.resetAt, noManUrl: !ctx.config.manUrl && !ctx.config.findInput });
  });

  /** Result of a follow-up step (2, 3…) for one man. */
  r.post('/profiles/:id/step', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const ctx = stepContext(p);
    const manId = String(req.body?.man?.id ?? req.body?.man_id ?? '').trim();
    const reminder = req.body?.kind === 'reengage';
    const stepNo = reminder ? REENGAGE_STEP : int(req.body?.step, { min: 2, max: 50, field: 'step' });
    if (!manId || !stepNo) throw bad('Немає даних кроку');
    const m = db.prepare("SELECT * FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'").get(p.id, manId);
    if (!m) throw notFound('Цьому чоловіку анкета ще не писала');
    const ok = Boolean(req.body?.ok);
    const t = now();
    const day = dayKey(t, settings.timezone);
    const messages = ok ? Math.min(10, int(req.body?.messages, { min: 0, max: 10, field: 'messages' }) ?? 0) : 0;
    let state = { stage: m.stage, next_at: m.next_at };
    const touch = () => db.prepare('INSERT INTO touches (agency_id, profile_id, operator_id, man_id, step, ok, messages, text, error, day, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.agency_id, p.id, req.user.id, manId, stepNo, ok ? 1 : 0, messages, str(req.body?.text, { max: 2000 }) || '', ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), day, t);
    if (reminder && m.stage === 'replied' && m.bonus_left > 0) {
      tx(db, () => {
        touch();
        if (ok) {
          // He stays silent through all of them → he is dropped, like after the first 3 attempts.
          const left = m.bonus_left - 1;
          state = left > 0 ? { stage: 'replied', next_at: t + ctx.scenario.afterReply.everyHours * HOUR } : { stage: 'done', next_at: null };
          db.prepare('UPDATE messages SET bonus_left = ?, stage = ?, next_at = ?, last_at = ?, fails = 0 WHERE id = ?').run(left, state.stage, state.next_at, t, m.id);
        } else {
          const fails = m.fails + 1;
          state = { stage: 'replied', next_at: fails >= MAX_STEP_FAILS ? null : t + HOUR };
          db.prepare('UPDATE messages SET next_at = ?, fails = ?, bonus_left = ?, error = ? WHERE id = ?')
            .run(state.next_at, fails, fails >= MAX_STEP_FAILS ? 0 : m.bonus_left, str(req.body?.error, { max: 300 }) || 'помилка', m.id);
        }
      });
    } else if (!reminder && m.step === stepNo - 1 && m.stage === 'active') {
      tx(db, () => {
        touch();
        if (!ok && req.body?.exhausted) {
          state = { stage: 'done', next_at: null }; // the site itself allows no more messages to him
          db.prepare('UPDATE messages SET stage = ?, next_at = NULL, error = ? WHERE id = ?').run('done', str(req.body?.error, { max: 300 }) || 'повідомлень не лишилось', m.id);
        } else if (ok) {
          state = after(ctx.scenario, stepNo - 1, t);
          db.prepare('UPDATE messages SET step = ?, stage = ?, next_at = ?, last_at = ?, fails = 0 WHERE id = ?').run(stepNo, state.stage, state.next_at, t, m.id);
        } else {
          const fails = m.fails + 1;
          state = fails >= MAX_STEP_FAILS ? { stage: 'done', next_at: null } : { stage: 'active', next_at: t + HOUR };
          db.prepare('UPDATE messages SET stage = ?, next_at = ?, fails = ?, error = ? WHERE id = ?')
            .run(state.stage, state.next_at, fails, str(req.body?.error, { max: 300 }) || 'помилка', m.id);
        }
      });
    }
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    const hour = hourWindow(db, p.id, ctx.scenario.human.perHour, t);
    const left = db.prepare('SELECT bonus_left FROM messages WHERE id = ?').get(m.id).bonus_left;
    res.json({ ok: true, stage: state.stage, left, remaining, stop: remaining === 0, hourLeft: hour.left, hourResetAt: hour.resetAt, due: dueNow(p.id, t) });
  });

  r.post('/profiles/:id/sent', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const man = readMan(req.body?.man);
    if (!man) throw bad('Немає даних чоловіка');
    const ok = Boolean(req.body?.ok);
    const t = now();
    const day = dayKey(t, settings.timezone);
    const inviteId = int(req.body?.invite_id, { min: 1, field: 'invite_id' }) ?? null;
    const validInvite = inviteId && db.prepare('SELECT 1 FROM invites WHERE id = ? AND profile_id = ?').get(inviteId, p.id) ? inviteId : null;
    const site = siteOf(p);
    const scenario = profileScenario(db, p, site);
    const mode = MODES.includes(req.body?.mode) ? req.body.mode : '';
    // a «Шанс» letter has no scenario follow-ups: quiet dialogs are picked up by «Аллчат» (never both)
    const next = !ok ? { stage: 'active', next_at: null } : mode === 'chance' ? { stage: 'done', next_at: null } : after(scenario, 0, t);
    const features = manFeatures(man, siteHost(site, configOf(site)));
    const written = db.prepare(`INSERT INTO messages (agency_id, profile_id, operator_id, site_id, man_id, man_name, man_age, man_country, invite_id, text, status, error, day, sent_at,
        step, stage, next_at, man_url, last_at, man_info, features, mode, night, hook)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id, man_id) DO UPDATE SET
        status = excluded.status, error = excluded.error, day = excluded.day, sent_at = excluded.sent_at,
        text = excluded.text, invite_id = excluded.invite_id, operator_id = excluded.operator_id,
        man_name = excluded.man_name, man_age = excluded.man_age, man_country = excluded.man_country,
        step = 1, stage = excluded.stage, next_at = excluded.next_at, man_url = excluded.man_url, last_at = excluded.last_at,
        man_info = excluded.man_info, features = excluded.features, mode = excluded.mode, night = excluded.night, hook = excluded.hook
      WHERE messages.status = 'failed'`)
      .run(p.agency_id, p.id, req.user.id, p.site_id, man.id, man.name, man.age, man.country, validInvite,
        str(req.body?.text, { max: 3000 }) || '', ok ? 'sent' : 'failed', ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), day, t,
        next.stage, next.next_at, man.url, t, man.info, JSON.stringify(features), mode, shiftKey(t, settings.timezone, scenario.human), man.hook);
    if (ok && written.changes) learnSent(db, features);
    db.prepare('DELETE FROM pool WHERE profile_id = ? AND man_id = ?').run(p.id, man.id);
    const limits = limitsFor(p, settings);
    const remaining = Math.max(0, limits.dailyLimit - sentToday(db, p.id, day));
    const hour = hourWindow(db, p.id, scenario.human.perHour, t);
    res.json({ ok: true, remaining, stop: remaining === 0, hourLeft: hour.left, hourResetAt: hour.resetAt, due: dueNow(p.id, t) });
  });

  /**
   * Unread dialogs from the inbox. A reply stops his scenario: from here on a live person writes to him.
   * A positive reply adds `afterReply.attempts` reminders for the case he goes quiet again; "not interested" ends it.
   * The same unread dialog is reported on every inbox check: it only postpones the reminders (the talk is alive).
   */
  r.post('/profiles/:id/replies', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const { afterReply } = profileScenario(db, p, siteOf(p));
    const list = Array.isArray(req.body?.men) ? req.body.men.slice(0, 300) : [];
    const t = now();
    const day = dayKey(t, settings.timezone);
    const find = db.prepare("SELECT * FROM messages WHERE profile_id = ? AND man_id = ? AND status = 'sent'");
    // Chat lists without IDs: the dialog is matched by his name ("Gene, 65" → "Gene").
    const byName = db.prepare("SELECT man_id FROM messages WHERE profile_id = ? AND status = 'sent' AND lower(man_name) = lower(?) ORDER BY COALESCE(last_at, sent_at) DESC LIMIT 1");
    const fresh = [];
    let negative = 0;
    for (const raw of list) {
      let man = readMan(raw);
      if (!man && raw && typeof raw === 'object' && raw.name) {
        const row = byName.get(p.id, String(raw.name).split(',')[0].trim().slice(0, 80));
        if (row) man = readMan({ ...raw, id: row.man_id });
      }
      if (!man) continue;
      const m = find.get(p.id, man.id);
      if (!m) continue;
      const lastReply = m.last_reply_at ?? m.replied_at;
      const isNew = m.replied_at == null || (m.last_at != null && lastReply != null && m.last_at > lastReply);
      if (!isNew) {
        if (m.stage === 'replied' && m.bonus_left > 0) {
          db.prepare('UPDATE messages SET next_at = MAX(COALESCE(next_at, 0), ?) WHERE id = ?').run(t + afterReply.silenceHours * HOUR, m.id);
        }
        continue;
      }
      const mood = classifyReply(man.text);
      if (mood === 'negative') negative++;
      else if (m.replied_at == null) { try { learnReply(db, JSON.parse(m.features || '[]')); } catch { /* old row */ } }
      // after a «Шанс» letter a live person answers, and «Аллчат» wakes the talk up if he goes quiet — no scenario reminders on top
      const bonus = mood === 'negative' || m.mode === 'chance' ? 0 : Math.min(MAX_BONUS, m.bonus_left + afterReply.attempts);
      db.prepare(`UPDATE messages SET replied_at = COALESCE(replied_at, ?), reply_day = COALESCE(reply_day, ?), replies = replies + 1, last_reply_at = ?,
          reply_text = ?, reply_mood = ?, stage = 'replied', bonus_left = ?, next_at = ?, fails = 0 WHERE id = ?`)
        .run(t, day, t, man.text, mood, bonus, bonus > 0 ? t + afterReply.silenceHours * HOUR : null, m.id);
      fresh.push(find.get(p.id, man.id));
    }
    // he answered after an «Аллчат» message: counted for that message too
    // (a dialog list without IDs: matched by his name, like the letters above)
    const acByName = db.prepare('SELECT man_id FROM allchat_log WHERE profile_id = ? AND ok = 1 AND lower(man_name) = lower(?) ORDER BY at DESC LIMIT 1');
    for (const raw of list) {
      const man = readMan(raw);
      const id = man?.id || (raw?.name ? acByName.get(p.id, String(raw.name).split(',')[0].trim().slice(0, 80))?.man_id : null);
      if (id) markAllchatReply(p.id, id, t);
    }
    if (fresh.length) notifyReplies(db, p, settings, fresh, req.user);
    res.json({ ok: true, new: fresh.length, negative, men: fresh.map((m) => ({ id: m.man_id, name: m.man_name, mood: m.reply_mood })) });
  });

  /** Result of a 🧪 test run (nothing else of the test is stored). */
  r.post('/profiles/:id/test', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const problems = Array.isArray(req.body?.problems) ? req.body.problems.map((x) => String(x).slice(0, 200)).slice(0, 10) : [];
    const ok = Boolean(req.body?.ok) && !problems.length;
    db.prepare('UPDATE profiles SET test_at = ?, test_ok = ?, test_info = ? WHERE id = ?').run(now(), ok ? 1 : 0, problems.join('\n'), p.id);
    res.json({ ok: true });
  });

  /** Captcha / block: a person is needed now — Telegram to the operator, the woman and the agency (once per 10 min). */
  const lastAlert = new Map();
  r.post('/profiles/:id/alert', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = getSettings(db, req.user.agencyId);
    const t = now();
    if (t - (lastAlert.get(p.id) || 0) < 10 * 60000) return res.json({ ok: true, sent: false });
    lastAlert.set(p.id, t);
    const text = str(req.body?.text, { max: 200 }) || 'Сайт показав капчу';
    const token = settings.telegram.botToken;
    if (token) {
      const operator = p.operator_id ? db.prepare('SELECT tg_chat_id FROM users WHERE id = ?').get(p.operator_id) : null;
      const targets = new Set([operator?.tg_chat_id, settings.telegram.chatId, req.user.tgChatId].filter(Boolean));
      const msg = `🛑 Анкета <b>${escapeHtml(p.name)}</b>: ${escapeHtml(text)}.\nБот на паузі — відкрийте вкладку сайту й розв’яжіть, далі він продовжить сам.`;
      for (const chatId of targets) sendTelegram(token, chatId, msg).catch(() => {});
    }
    res.json({ ok: true, sent: Boolean(token) });
  });

  r.post('/profiles/:id/heartbeat', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const state = oneOf(req.body?.state || 'running', ['running', 'paused', 'idle', 'error', 'limit', 'done', 'waiting'], 'state');
    const t = now();
    // Payment counts only real work: time between two "working" beats (no sleeping, waiting for hints, captcha, limit).
    const active = req.body?.active === undefined ? state === 'running' : Boolean(req.body.active) && state === 'running';
    if (active && p.bot_beat_active && p.bot_beat_at && t - p.bot_beat_at <= 150000 && t > p.bot_beat_at) {
      const settings = getSettings(db, req.user.agencyId);
      db.prepare(`INSERT INTO bot_activity (profile_id, operator_id, agency_id, day, seconds) VALUES (?,?,?,?,?)
        ON CONFLICT(profile_id, operator_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`)
        .run(p.id, req.user.id, p.agency_id, dayKey(t, settings.timezone), Math.round((t - p.bot_beat_at) / 1000));
    }
    db.prepare('UPDATE profiles SET bot_state = ?, bot_info = ?, bot_last_seen = ?, bot_beat_at = ?, bot_beat_active = ? WHERE id = ?')
      .run(state, str(req.body?.info, { max: 300 }) || '', state === 'idle' ? null : t, t, active ? 1 : 0, p.id);
    const fresh = db.prepare('SELECT status, stop_at FROM profiles WHERE id = ?').get(p.id);
    // "Stop the bots" in the panel: a bot started before that moment stops now (a new start works again)
    // (the start time is the browser's clock: shifted by the difference between the two clocks)
    const startedAt = (Number(req.body?.startedAt) || 0) + (Number(req.body?.now) ? t - Number(req.body.now) : 0);
    const stop = Boolean(fresh.stop_at && startedAt && fresh.stop_at > startedAt);
    res.json({ ok: true, paused: fresh.status !== 'active', stop });
  });

  // ---------- «Аллчат»: a few messages a night on the topic of running talks ----------
  /** He answered: the latest «Аллчат» message to him before that gets the reply (one reply counts once). */
  const markAllchatReply = (pid, manId, t) => db.prepare(`UPDATE allchat_log SET replied_at = ? WHERE id = (SELECT id FROM allchat_log
    WHERE profile_id = ? AND man_id = ? AND ok = 1 AND at < ? ORDER BY at DESC LIMIT 1) AND replied_at IS NULL`).run(t, pid, manId, t);
  const fpOf = (history) => { const last = history[history.length - 1]; return last ? `${last.mine ? 'h' : 'm'}:${String(last.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''; };
  const readHistory = (h) => (Array.isArray(h) ? h.slice(-20) : []).map((m) => ({ mine: Boolean(m?.mine), text: String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) })).filter((m) => m.text);

  /** May the bot write into this dialog now? (he must not be waiting for an answer; limits per night; quiet long enough) */
  r.post('/profiles/:id/allchat/check', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = profileSettings(db, p);
    const modes = effectiveModes(settings);
    const ac = modes.allchat;
    const man = readMan(req.body?.man);
    if (!man) throw bad('Немає даних чоловіка');
    const history = readHistory(req.body?.history);
    const t = now();
    const human = profileScenario(db, p, siteOf(p)).human;
    const night = shiftKey(t, settings.timezone, human);
    // the last message as seen now; "quiet since" = when it was first seen unchanged
    const fp = fpOf(history);
    const row = db.prepare('SELECT * FROM dialogs WHERE profile_id = ? AND man_id = ?').get(p.id, man.id);
    let since = t;
    if (!row) db.prepare('INSERT INTO dialogs (profile_id, man_id, fp, fp_at) VALUES (?,?,?,?)').run(p.id, man.id, fp, t);
    else if (!row.fp) { db.prepare('UPDATE dialogs SET fp = ? WHERE profile_id = ? AND man_id = ?').run(fp, p.id, man.id); since = row.fp_at; } // right after our own message
    else if (row.fp !== fp) db.prepare('UPDATE dialogs SET fp = ?, fp_at = ? WHERE profile_id = ? AND man_id = ?').run(fp, t, p.id, man.id);
    else since = row.fp_at;
    const no = (reason) => res.json({ write: false, reason });
    if (!ac.on) return no('off');
    const last = history[history.length - 1];
    if (!last) return no('empty');
    if (!last.mine) {
      // his message is the last one: he waits for an answer — a live person answers (the bot only if the admin opened «auto reply»)
      markAllchatReply(p.id, man.id, t);
      return modes.autoReply.on ? res.json({ write: true, reply: true }) : no('waits');
    }
    if (ac.who === 'replied' && !history.some((m) => !m.mine)
      && !db.prepare("SELECT 1 FROM messages WHERE profile_id = ? AND man_id = ? AND replied_at IS NOT NULL").get(p.id, man.id)) return no('never-replied');
    const tonight = db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last FROM allchat_log WHERE profile_id = ? AND man_id = ? AND night = ? AND ok = 1').get(p.id, man.id, night);
    if (tonight.n >= ac.perNight) return no('night-limit');
    if (tonight.last && t - tonight.last < ac.gapHours * HOUR) return no('too-soon');
    const quiet = (ac.who === 'silent' ? ac.silentHours : 1) * HOUR;
    if (t - since < quiet) return no('not-quiet');
    res.json({ write: true, night, count: tonight.n });
  });

  /** The message itself: on the topic of their talk (AI), or a template without a key. */
  r.post('/profiles/:id/allchat/compose', ah(async (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = profileSettings(db, p);
    const man = readMan(req.body?.man);
    if (!man) throw bad('Немає даних чоловіка');
    const history = readHistory(req.body?.history);
    const modes = effectiveModes(settings);
    if (req.body?.reply) {
      if (!modes.autoReply.on) throw forbidden('Відповіді бота закриті');
      const out = await generateReply({ profile: p, settings, history }).catch(() => null);
      return res.json(out ? { text: personalize(out.text, man), source: out.source } : { text: '', source: 'none' });
    }
    const seed = db.prepare('SELECT COUNT(*) AS n FROM allchat_log WHERE profile_id = ? AND man_id = ?').get(p.id, man.id).n + p.id;
    let out;
    try { out = await generateTopic({ profile: p, settings, history, seed }); } catch { out = templateTopic(history, seed); } // AI down must not stop the bot
    res.json({ text: personalize(fillHer(out.text, p), man), source: out.source });
  }));

  r.post('/profiles/:id/allchat/sent', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = profileSettings(db, p);
    const man = readMan(req.body?.man);
    if (!man) throw bad('Немає даних чоловіка');
    const t = now();
    const ok = Boolean(req.body?.ok);
    const night = shiftKey(t, settings.timezone, profileScenario(db, p, siteOf(p)).human);
    db.prepare('INSERT INTO allchat_log (agency_id, profile_id, operator_id, man_id, man_name, kind, night, text, ok, error, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.agency_id, p.id, req.user.id, man.id, man.name, req.body?.reply ? 'reply' : 'allchat', night, str(req.body?.text, { max: 1000 }) || '', ok ? 1 : 0,
        ok ? '' : (str(req.body?.error, { max: 300 }) || 'помилка'), t);
    // our message is the last one now: the quiet time counts from here (the page may show it translated — the next look adopts it)
    if (ok) db.prepare(`INSERT INTO dialogs (profile_id, man_id, fp, fp_at) VALUES (?,?,'',?) ON CONFLICT(profile_id, man_id) DO UPDATE SET fp = '', fp_at = excluded.fp_at`).run(p.id, man.id, t);
    res.json({ ok: true });
  });

  /** One pass of a mode is over: stored for the stats, and a mini report goes to Telegram. */
  r.post('/profiles/:id/pass', (req, res) => {
    const p = getVisibleProfile(db, req.user, req.params.id);
    const settings = profileSettings(db, p);
    const mode = oneOf(req.body?.mode, ['chance', 'allchat', 'hint', 'list', 'due'], 'mode');
    const n = (k) => Math.max(0, Math.min(100000, Number.parseInt(req.body?.[k], 10) || 0));
    const t = now();
    const started = Math.min(t, Number(req.body?.startedAt) || t);
    const info = req.body?.info && typeof req.body.info === 'object' ? JSON.stringify(req.body.info).slice(0, 2000) : '';
    const night = shiftKey(t, settings.timezone, profileScenario(db, p, siteOf(p)).human);
    const id = db.prepare('INSERT INTO passes (agency_id, profile_id, operator_id, mode, night, started_at, ended_at, seen, sent, failed, skipped, info) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.agency_id, p.id, req.user.id, mode, night, started, t, n('seen'), n('sent'), n('failed'), n('skipped'), info).lastInsertRowid;
    if (settings.reports.eachPass) reportPass(db, Number(id)).catch(() => {});
    res.json({ ok: true, id: Number(id) });
  });

  /** Started from the panel or Telegram: which of my profiles should start now (the extension asks every minute). */
  r.get('/control', (req, res) => {
    // only the women of this person: their browser works only as them
    const rows = db.prepare(`SELECT p.id, p.name, p.site_id FROM profiles p WHERE p.agency_id = ? AND p.operator_id = ? AND p.status = 'active' AND p.start_at IS NOT NULL
      AND p.start_at > COALESCE(p.bot_beat_at, 0) AND p.start_at > COALESCE(p.stop_at, 0) AND p.start_at > ? ORDER BY p.start_at`).all(req.user.agencyId, req.user.id, now() - 30 * 60000);
    res.json({ start: rows });
  });

  return r;
}

/** The team's modes as the bot uses them: «auto reply» only when the platform admin opened it. */
export function effectiveModes(settings, unlocked = autoReplyUnlocked) {
  const m = settings.modes;
  const clamp = (v, a, b, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
  return {
    chance: { on: Boolean(m.chance.on), everyMin: clamp(m.chance.everyMin, 10, 240, 30), onlineOnly: m.chance.onlineOnly !== false },
    allchat: {
      on: Boolean(m.allchat.on), perNight: clamp(m.allchat.perNight, 1, 6, 2), who: ['silent', 'replied', 'all'].includes(m.allchat.who) ? m.allchat.who : 'silent',
      silentHours: clamp(m.allchat.silentHours, 1, 72, 6), gapHours: clamp(m.allchat.gapHours, 1, 12, 3), maxPerPass: clamp(m.allchat.maxPerPass, 1, 200, 40),
    },
    autoReply: { on: Boolean(unlocked() && m.autoReply.on), locked: !unlocked() },
  };
}
let autoReplyUnlocked = () => false;
/** Set once at start: reads the platform switch «auto reply opened». */
export function setAutoReplyGate(fn) { autoReplyUnlocked = fn; }

function notifyReplies(db, profile, settings, msgs, user) {
  const token = settings.telegram.botToken;
  if (!token) return;
  const site = profile.site_id ? db.prepare('SELECT config FROM sites WHERE id = ?').get(profile.site_id) : null;
  let chatTpl = '';
  try { chatTpl = JSON.parse(site?.config || '{}').chatUrl || ''; } catch { /* ignore */ }
  const lines = msgs.map((m) => {
    const who = [m.man_name || `ID ${m.man_id}`, m.man_age, m.man_country].filter(Boolean).map(escapeHtml).join(', ');
    const link = chatTpl ? ` — <a href="${escapeHtml(chatTpl.replace('{id}', encodeURIComponent(m.man_id)))}">відкрити чат</a>` : '';
    return `• <b>${who}</b>${link}`;
  });
  const text = `💌 Нові відповіді для анкети <b>${escapeHtml(profile.name)}</b> (${msgs.length}):\n${lines.join('\n')}\n\nЧас відповідати особисто 🙂`;
  const operator = profile.operator_id ? db.prepare('SELECT tg_chat_id FROM users WHERE id = ?').get(profile.operator_id) : null;
  const targets = new Set([profile.tg_chat_id, operator?.tg_chat_id, settings.telegram.chatId, user.tgChatId].filter(Boolean));
  for (const chatId of targets) sendTelegram(token, chatId, text).catch(() => {});
}
