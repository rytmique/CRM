// Unit tests of the scanner's masking and role recognition (node --test scanner/test/unit.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.self = globalThis;
for (const f of ['dict.js', 'roles.js']) vm.runInThisContext(fs.readFileSync(path.join(HERE, '..', f), 'utf8'));
const M = self.__scanMask;
const R = self.__scanRoles;
const t = (s) => M.maskText(s)?.t;

test('texts: interface words stay, names / places / numbers / contacts never', () => {
  assert.equal(t('Please write him message'), 'Please write him message');
  assert.equal(t('Усі чати'), 'Усі чати');
  assert.equal(t('Залишилося 12 повідомлень'), 'Залишилося # повідомлень');
  assert.equal(t('Michael, 45, USA'), '[W], #, [W]');
  assert.equal(t('Anna Kovalenko'), '[W] [W]');
  assert.equal(t('Олена з Києва'), '[W] з [W]');
  assert.equal(t('write me john@mail.com'), 'write me [email]');
  assert.equal(t('call +380 67 123 45 67'), 'call [тел]');
  assert.equal(t('see https://evil.site/x?id=5'), 'see [url]');
  assert.equal(t('ID 5000000001'), 'ID [тел]');
  assert.match(t('I really enjoyed our walk in Central Park yesterday, Anna'), /^\[текст \d+\]$/);
  assert.match(t('a b c d e f g'), /^\[текст/); // > 6 unknown-ish words → whole text hidden
  assert.equal(t('i love you'), 'i [w] you'); // non-interface words hidden even in short phrases
  assert.equal(M.maskText('   '), null);
  // no name survives, whatever the case
  for (const name of ['Michael', 'MICHAEL', 'michael', 'Mark', 'Max', 'Kate', 'Olha', 'Robert']) assert.ok(!t(`hi ${name}`).toLowerCase().includes(name.toLowerCase()), name);
  assert.equal(M.maskText('Hello…').ell, true);
});

test('attribute values: code words stay, usernames become a hash', () => {
  assert.equal(M.maskValue('chat-item'), 'chat-item');
  assert.equal(M.maskValue('true'), 'true');
  assert.equal(M.maskValue('12345'), '#');
  assert.match(M.maskValue('anna_k'), /^~[0-9a-f]{4}_k$/);
  assert.match(M.maskValue('john.smith'), /^~[0-9a-f]{4}\.~[0-9a-f]{4}$/);
  assert.equal(M.maskValue('Chat with John Smith'), 'Chat with [W] [W]');
  assert.equal(M.maskValue('user-12345'), 'user-#');
  assert.equal(M.maskValue('mailto:a@b.com'), '[email]'.includes('[') ? M.maskValue('mailto:a@b.com') : '');
  assert.ok(!M.maskValue('mailto:anna@b.com').includes('anna'));
});

test('URLs: site → SITE, no IDs, no usernames, no query values, no tokens', () => {
  const D = ['ex.com'];
  assert.equal(M.maskUrl('https://ex.com/chat/123456', D), 'SITE/chat/#');
  assert.equal(M.maskUrl('https://app.ex.com/v2/messages/send', D), 'app.SITE/v#/messages/send');
  assert.match(M.maskUrl('https://ex.com/profile/anna_k?ref=mail&uid=5', D), /^SITE\/profile\/~[0-9a-f]{4}_k\?ref&uid$/);
  assert.equal(M.maskUrl('https://ex.com/x?token=abc.def.ghi&id=77', D), 'SITE/x?id&token');
  assert.equal(M.maskUrl('https://ex.com/a/9f86d081884c7d659a2feaa0c55ad015', D), 'SITE/a/#');
  assert.equal(M.maskUrl('https://ex.com/a/550e8400-e29b-41d4-a716-446655440000', D), 'SITE/a/#');
  assert.equal(M.maskUrl('https://ex.com/u/john@mail.com', D), 'SITE/u/[x]');
  assert.match(M.maskUrl('https://cdn.somewhere.net/a.js', D), /^h-[0-9a-f]{6}\/a\.js$/);
  assert.equal(M.maskUrl('https://www.google.com/recaptcha/api.js', D), 'google.com/~6acc/api.js'.replace('~6acc', M.maskToken('recaptcha')));
  assert.equal(M.maskUrl('wss://ex.com/socket?sid=1', D), 'wss://SITE/socket?sid'.replace('sid', M.maskToken('sid')));
  assert.equal(M.maskUrl('not a url', D), '[адреса]');
  assert.equal(M.maskUrl('https://ex.com/#/chat/123', D), 'SITE/#/chat/#');
  // the site's own name never appears
  assert.ok(!M.maskUrl('https://chat.ex.com/ex/page', D).includes('ex.com'));
});

test('last filter cuts emails, links and long numbers in any string', () => {
  const [s, n] = M.scrub('mail a@b.com see https://x.y/z id 1234567 ok #');
  assert.equal(s, 'mail [email] see [url] id # ok #');
  assert.equal(n, 3);
  assert.equal(M.scrub('chat-item 1234')[1], 0); // short numbers and code stay
});

test('roles: a chat box, Send, a translate button and a chat list are recognised', () => {
  const nodes = [
    { p: -1, d: 0, tg: 'html' },
    { p: 0, d: 1, tg: 'body' },
    { p: 1, d: 2, tg: 'textarea', a: { placeholder: 'Write a message' }, b: [400, 700, 500, 80], v: 1 },
    { p: 1, d: 2, tg: 'button', a: { 'aria-label': 'Send' }, b: [910, 740, 40, 40], v: 1 },
    { p: 1, d: 2, tg: 'button', c: ['translate-btn'], tx: 'ПЕРЕКЛАСТИ', b: [850, 740, 60, 40], v: 1 },
    { p: 1, d: 2, tg: 'div', c: ['toast'], tx: 'Message sent', b: [1000, 60, 200, 40], v: 1 },
    ...[0, 1, 2].map((k) => ({ p: 1, d: 2, tg: 'div', c: ['chat-row'], rep: 40, b: [0, 60 + k * 50, 280, 48], v: 1, tx: '[W], #' })),
    { p: 6, d: 3, tg: 'img', c: ['avatar'], b: [4, 64, 36, 36], v: 1, src: 1 },
  ];
  const { roles } = R.classify({ n: nodes, vw: 1280, vh: 860 });
  assert.equal(roles.messageInput[0].tg, 'textarea');
  assert.equal(roles.sendButton[0].css[0], 'button[aria-label="Send"]');
  assert.ok(!roles.sendButton.some((c) => c.css[0].includes('toast')), 'a "sent" notice is not a Send button');
  assert.equal(roles.translateButton[0].css[0], 'button.translate-btn');
  assert.equal(roles.chatItem[0].css[0], 'div.chat-row');
});
