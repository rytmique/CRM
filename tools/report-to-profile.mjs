#!/usr/bin/env node
// Stage 2 helper: scanner report → a draft of the bot's site settings (SITE_FIELDS keys) + what to check by hand.
// Usage: node tools/report-to-profile.mjs <report.zip | unzipped dir> [out.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/report-to-profile.mjs <report.zip | dir> [out.json]'); process.exit(1); }
let dir = src;
if (src.endsWith('.zip')) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-rep-'));
  execFileSync('unzip', ['-q', '-o', src, '-d', dir]);
}
const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));

// recognise the screens again with the current scanner code: a report from an older scanner still gets today's (better) addresses
globalThis.self = globalThis;
const SCANNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scanner');
for (const f of ['dict.js', 'roles.js']) vm.runInThisContext(fs.readFileSync(path.join(SCANNER, f), 'utf8'));
const stDir = path.join(dir, 'states');
if (fs.existsSync(stDir)) {
  const out = [];
  for (const f of fs.readdirSync(stDir).sort()) for (const line of fs.readFileSync(path.join(stDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const st = JSON.parse(line);
    if (st.state?.n?.length) out.push({ roles: self.__scanRoles.classify(st.state).roles, route: st.route, count: st.count });
    else if (st.state?.light) {
      // a screen kept without its elements (the space for full screens was used up): what was recognised on it while recording
      const { flags, ...best } = st.state.best || {}; void flags;
      out.push({ roles: Object.fromEntries(Object.entries(best).map(([k, v]) => [k, [{ ...v, tg: '?', why: [] }]])), route: st.route, count: st.count });
    }
  }
  if (out.length) sum.roles = self.__scanRoles.aggregate(out);
}

// scanner role → bot setting
const MAP = {
  messageInput: 'messageInput', sendButton: 'sendButton', translateButton: 'translateButton', attach: 'attachButton', fileInput: 'fileInput',
  letterButton: 'letterOpen', hintItem: 'taskItem', counter: 'chatLeft', herCurrent: 'herCurrent', herSwitch: 'herSwitch', searchInput: 'findInput',
  chatHeader: 'chatName', chatItem: 'inboxItem', unreadMark: 'inboxUnread',
};
const config = {};
const check = [];
const conf = {};
for (const [role, key] of Object.entries(MAP)) {
  const list = sum.roles?.[role] || [];
  const best = list[0];
  if (!best) { check.push(`✗ ${key}: сканер не знайшов (${role})`); continue; }
  // several candidates that are all good → join them (the bot takes the first visible)
  const good = list.filter((c) => c.confidence >= Math.max(0.5, best.confidence - 0.15)).slice(0, 3).map((c) => c.css?.[0]).filter(Boolean);
  conf[key] = best.confidence;
  // not sure enough: no address at all (an empty one would look "set" to the bot) — the best guess goes to the check list
  if (!good.length) { check.push(`✗ ${key}: не впевнений (${Math.round(best.confidence * 100)}%) — найкращий кандидат ${best.css?.[0] || '?'}, перевірити вручну`); continue; }
  config[key] = [...new Set(good)].join(', ');
  if (best.confidence < 0.7) check.push(`? ${key} = ${config[key]} — впевненість ${Math.round(best.confidence * 100)}%`);
}
// buttons the bot may press in scenarios
config.actions = ['likeButton', 'favoriteButton', 'winkButton'].filter((r) => sum.roles?.[r]?.[0]?.confidence >= 0.5)
  .map((r) => ({ key: r.replace('Button', ''), name: { likeButton: 'Лайк', favoriteButton: 'Обране', winkButton: 'Підморгнути' }[r], sel: sum.roles[r][0].css[0], where: 'page' }));
// what the site shows after Send — candidate "sent" confirmations from the effects of clicks on the send button
// the send button's marks as the report writes actions: [testid=…], [label=…], or its own class when it has nothing better
const marks = [];
for (const c of sum.roles?.sendButton?.[0]?.css || []) {
  let m;
  if ((m = c.match(/\[data-(?:testid|test|qa)="([^"]+)"\]/))) marks.push(`[testid=${m[1]}]`);
  else if ((m = c.match(/\[aria-label="([^"]+)"\]/))) marks.push(`[label=${m[1]}]`);
}
if (!marks.length) { const m = (sum.roles?.sendButton?.[0]?.css?.[0] || '').match(/^[a-z]+\.([\w-]+)$/i); if (m) marks.push(`.${m[1]} `, `.${m[1]}[`, `.${m[1]}.`); }
const afterSend = (sum.actions || []).filter((a) => !a.action.includes('[ext]'))
  .filter((a) => /\bsend\b|надісл|відправ|отправ|➤/i.test(a.action) || marks.some((k) => `${a.action} `.includes(k)));
const toasts = afterSend.flatMap((a) => a.effects.filter(([k]) => k.startsWith('«')).map(([k, n]) => [k, n]));
if (toasts.length) check.push(`ℹ після «Надіслати» з’являється: ${toasts.slice(0, 5).map(([k]) => k).join(', ')} → кандидат для sentConfirm`);
const sendReq = afterSend.flatMap((a) => a.requests).slice(0, 5);
if (sendReq.length) check.push(`ℹ запити після «Надіслати»: ${sendReq.map(([r]) => r).join(' | ')}`);
const counters = sum.texts?.counters || [];
if (counters.length) check.push(`ℹ лічильники: ${counters.map(([t]) => t).join(' · ')}`);
const prev = sum.texts?.ellipsisLengths || [];
if (prev.length) check.push(`ℹ довжини обрізаних прев’ю: ${prev.slice(0, 10).map(([l, n]) => `${l}×${n}`).join(' ')}`);
if (sum.flags?.captcha) check.push(`⚠ капча траплялась на ${sum.flags.captcha} екранах`);
if (sum.bot?.syntheticClicks) check.push(`ℹ інший бот: ${sum.bot.syntheticClicks} програмних кліків; часті цілі: ${(sum.bot.topSyntheticTargets || []).slice(0, 3).map(([t]) => t).join(' | ')}`);

const out = { from: path.basename(src), recorded: sum.scan, config, confidence: conf, check };
const file = process.argv[3] || path.join(path.dirname(path.resolve(src)), 'site-profile.draft.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`draft → ${file}\n`);
for (const [k, v] of Object.entries(config)) if (k !== 'actions') console.log(`  ${k.padEnd(16)} ${v}`);
console.log(`  actions          ${config.actions.map((a) => `${a.name}=${a.sel}`).join(', ') || '—'}`);
console.log(`\n${check.join('\n')}`);
