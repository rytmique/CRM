import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','owner','operator')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  tg_chat_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'web',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  age INTEGER,
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  site_profile_id TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  interests TEXT NOT NULL DEFAULT '',
  looking_for TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'warm',
  language TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  daily_limit INTEGER,
  min_delay INTEGER,
  max_delay INTEGER,
  target_age_min INTEGER,
  target_age_max INTEGER,
  tg_chat_id TEXT,
  bot_state TEXT NOT NULL DEFAULT 'idle',
  bot_info TEXT NOT NULL DEFAULT '',
  bot_last_seen INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  model TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  profile_id INTEGER UNIQUE REFERENCES profiles(id) ON DELETE SET NULL,
  days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  note TEXT NOT NULL DEFAULT '',
  issued_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  site_id INTEGER,
  man_id TEXT NOT NULL,
  man_name TEXT NOT NULL DEFAULT '',
  man_age INTEGER,
  man_country TEXT NOT NULL DEFAULT '',
  invite_id INTEGER REFERENCES invites(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  replied_at INTEGER,
  reply_day TEXT,
  UNIQUE (profile_id, man_id)
);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  man_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  model TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (profile_id, step)
);

CREATE INDEX IF NOT EXISTS idx_touches_profile_day ON touches(profile_id, day);
CREATE INDEX IF NOT EXISTS idx_messages_agency_day ON messages(agency_id, day);
CREATE INDEX IF NOT EXISTS idx_messages_profile_day ON messages(profile_id, day);
CREATE INDEX IF NOT EXISTS idx_messages_site_man ON messages(agency_id, site_id, man_id);
CREATE INDEX IF NOT EXISTS idx_messages_replied ON messages(agency_id, reply_day);
CREATE INDEX IF NOT EXISTS idx_invites_profile ON invites(profile_id, active);
CREATE INDEX IF NOT EXISTS idx_profiles_agency ON profiles(agency_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

/** Columns added after the first release: [table, column, definition]. */
const MIGRATIONS = [
  ['profiles', 'prompt', "TEXT NOT NULL DEFAULT ''"],
  // scenario: follow-up steps per man
  ['sites', 'scenario', "TEXT NOT NULL DEFAULT ''"],
  ['messages', 'step', 'INTEGER NOT NULL DEFAULT 1'],
  ['messages', 'next_at', 'INTEGER'],
  ['messages', 'stage', "TEXT NOT NULL DEFAULT 'active'", "UPDATE messages SET stage = 'replied' WHERE replied_at IS NOT NULL"],
  ['messages', 'man_url', "TEXT NOT NULL DEFAULT ''"],
  ['messages', 'fails', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'last_at', 'INTEGER'],
];

/** Indexes on migrated columns (created after the columns exist). */
const LATE_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(profile_id, stage, next_at);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, column, def, after] of MIGRATIONS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      if (after) db.exec(after);
    }
  }
  db.exec(LATE_SQL);
  return db;
}

/** Runs fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();
