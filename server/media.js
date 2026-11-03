import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now } from './db.js';
import { bad } from './util.js';

/** Files a profile attaches to messages (her photos, a video…). Stored on disk next to the database. */
export const MAX_FILE = 15 * 1024 * 1024;
export const MAX_PER_PROFILE = 30;
const TYPES = /^(image\/(jpeg|png|gif|webp|heic|heif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/pdf)$/;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/webm': 'weba', 'application/pdf': 'pdf' };

const steps = (json) => { try { const a = JSON.parse(json); return Array.isArray(a) ? a.filter((n) => Number.isInteger(n) && n > 0 && n <= 50) : []; } catch { return []; } };
export const publicMedia = (m) => ({ id: m.id, name: m.name, type: m.type, size: m.size, steps: steps(m.steps), created_at: m.created_at });

export function listMedia(db, profileId) {
  return db.prepare('SELECT * FROM media WHERE profile_id = ? ORDER BY id').all(profileId).map(publicMedia);
}

export function readSteps(v) {
  if (!Array.isArray(v)) throw bad('Вкажіть кроки, напр. [1, 2]');
  return [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 50))].sort((a, b) => a - b);
}

export function saveMedia(db, cfg, { agencyId, profileId, name, type, buf, steps: st = [1] }) {
  const t = String(type || '').toLowerCase().split(';')[0].trim();
  if (!TYPES.test(t)) throw bad('Можна фото (jpg, png, gif, webp, heic), відео (mp4, mov, webm), аудіо або pdf');
  if (!buf?.length) throw bad('Порожній файл');
  if (buf.length > MAX_FILE) throw bad(`Файл завеликий (макс. ${MAX_FILE / 1024 / 1024} МБ)`);
  if (db.prepare('SELECT COUNT(*) AS n FROM media WHERE profile_id = ?').get(profileId).n >= MAX_PER_PROFILE) throw bad(`Максимум ${MAX_PER_PROFILE} файлів на анкету`);
  const clean = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(-120) || 'file';
  const rel = path.join(String(agencyId), `${crypto.randomBytes(12).toString('hex')}.${EXT[t]}`);
  const abs = path.join(cfg.mediaDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  const id = Number(db.prepare('INSERT INTO media (agency_id, profile_id, name, type, size, file, steps, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(agencyId, profileId, clean, t, buf.length, rel, JSON.stringify(st), now()).lastInsertRowid);
  return publicMedia(db.prepare('SELECT * FROM media WHERE id = ?').get(id));
}

export function mediaFile(cfg, row) {
  const abs = path.resolve(cfg.mediaDir, row.file);
  if (!abs.startsWith(path.resolve(cfg.mediaDir) + path.sep)) throw bad('Некоректний шлях');
  return abs;
}

export function removeMedia(db, cfg, rows) {
  for (const row of rows) {
    try { fs.unlinkSync(mediaFile(cfg, row)); } catch { /* already gone */ }
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  }
}

/** Files for scenario step `step` (1-based): all marked, one random, or none. */
export function filesForStep(db, profileId, step, mode) {
  if (mode === 'none') return [];
  const all = listMedia(db, profileId).filter((m) => m.steps.includes(step));
  if (mode === 'one' && all.length > 1) return [all[Math.floor(Math.random() * all.length)]];
  return all.map(({ id, name, type, size }) => ({ id, name, type, size }));
}
