import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'manifest.json');

/** The newest version of the bot = the one this server hands out (its manifest). */
export function latestBotVersion() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version || ''; } catch { return ''; }
}
