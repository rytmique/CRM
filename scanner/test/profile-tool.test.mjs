// The stage-2 helper (tools/report-to-profile.mjs) on a tiny made-up report: screens kept without elements still count,
// and an address it is not sure of is left out (never an empty one). Run: node --test scanner/test/profile-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('report → bot settings: light screens are used, unsure roles get no address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
  fs.mkdirSync(path.join(dir, 'states'));
  const full = { sig: 's1', route: 'SITE/desk', top: true, count: 3, state: { vw: 1280, vh: 860, n: [
    { p: -1, d: 0, tg: 'html' }, { p: 0, d: 1, tg: 'body' },
    { p: 1, d: 2, tg: 'textarea', a: { placeholder: 'Write a message' }, b: [400, 700, 500, 80], v: 1 },
    { p: 1, d: 2, tg: 'span', c: ['badge-x'], b: [10, 10, 20, 20], v: 1 },
  ] } };
  // a screen kept only with what was recognised on it (the letter button exists only there)
  const light = { sig: 's2', route: 'SITE/desk', top: true, count: 2, state: { n: [], light: 1, best: { letterButton: { score: 0.9, css: ['button.btn-letter'], xp: '/html/body' }, flags: {} } } };
  fs.writeFileSync(path.join(dir, 'states', 'part-01.jsonl'), `${JSON.stringify(full)}\n${JSON.stringify(light)}\n`);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ scan: {}, roles: {}, actions: [], texts: {}, flags: {} }));
  const out = path.join(dir, 'draft.json');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'report-to-profile.mjs'), dir, out], { encoding: 'utf8' });
  const d = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(d.config.messageInput, 'textarea[placeholder="Write a message"]');
  assert.equal(d.config.letterOpen, 'button.btn-letter', 'a button seen only on a light screen is kept');
  for (const [k, v] of Object.entries(d.config)) if (k !== 'actions') assert.ok(typeof v === 'string' && v.trim(), `empty address for ${k}`);
  assert.ok(d.check.some((c) => c.startsWith('✗ sendButton')), 'what was not found is listed for a manual check');
});
