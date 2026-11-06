// Starting and stopping bots from the panel and from Telegram: each person only their own (operator — their profiles,
// team lead — the team, platform admin — any team). The bot in the browser picks it up within a minute.
import { now } from './db.js';

/** Which profiles this person may start/stop. Alias p. */
export function controlScope(user) {
  if (user.role === 'admin') return { where: '1 = 1', params: [] };
  const agency = user.agencyId ?? user.agency_id;
  if (user.role === 'operator') return { where: 'p.agency_id = ? AND p.operator_id = ?', params: [agency, user.id] };
  return { where: 'p.agency_id = ?', params: [agency] };
}

const idsPart = (ids) => (ids?.length ? ` AND p.id IN (${ids.map(() => '?').join(',')})` : '');

/** Start: the bots of these profiles (all of mine when ids are empty) start at their next check. */
export function startBots(db, user, ids = []) {
  const s = controlScope(user);
  const rows = db.prepare(`SELECT p.id, p.name FROM profiles p WHERE ${s.where} AND p.status = 'active'${idsPart(ids)}`).all(...s.params, ...ids);
  const t = now();
  for (const r of rows) db.prepare('UPDATE profiles SET start_at = ? WHERE id = ?').run(t, r.id);
  return rows;
}

/** Stop: running bots of these profiles stop at their next heartbeat (all of mine when ids are empty). */
export function stopBotsFor(db, user, ids = []) {
  const s = controlScope(user);
  const rows = db.prepare(`SELECT p.id, p.name FROM profiles p WHERE ${s.where}${idsPart(ids)}`).all(...s.params, ...ids);
  const t = now();
  for (const r of rows) db.prepare('UPDATE profiles SET stop_at = ?, start_at = NULL WHERE id = ?').run(t, r.id);
  return rows;
}

/** What the bots of my profiles are doing now. */
export function botStatus(db, user) {
  const s = controlScope(user);
  return db.prepare(`SELECT p.id, p.name, p.bot_state, p.bot_info, p.bot_last_seen, p.status, p.start_at, p.stop_at FROM profiles p WHERE ${s.where} ORDER BY p.name LIMIT 200`)
    .all(...s.params).map((p) => ({
      id: p.id, name: p.name, paused: p.status !== 'active', info: p.bot_info,
      // a bot is "on" only while its heartbeats keep coming
      state: p.bot_last_seen && now() - p.bot_last_seen < 5 * 60000 ? p.bot_state : (p.start_at && p.start_at > (p.stop_at || 0) && now() - p.start_at < 30 * 60000 ? 'starting' : 'off'),
    }));
}
