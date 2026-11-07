// A tiny SMTP client (no extra packages) for «forgot password» letters.
// SMTP_URL=smtps://login:app-password@smtp.gmail.com:465  (or smtp://…:587 — STARTTLS when the server offers it)
// MAIL_FROM="Agency CRM <login@gmail.com>"  (optional; the login by default)
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const mailReady = () => Boolean(process.env.SMTP_URL);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

/** Reads SMTP replies (a reply ends with "NNN text"; "NNN-text" lines continue it) from whatever socket is current. */
function replies() {
  let buf = '';
  const waiting = [];
  const ready = [];
  let lines = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const r = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        if (waiting.length) waiting.shift().resolve(r); else ready.push(r);
      }
    }
  };
  let failWith = null;
  const fail = (e) => { failWith = e; while (waiting.length) waiting.shift().reject(e); };
  return {
    attach(sock) { sock.on('data', onData); sock.on('error', fail); sock.on('close', () => fail(new Error('SMTP: з’єднання закрито'))); },
    detach(sock) { sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.removeAllListeners('close'); },
    next() {
      if (ready.length) return Promise.resolve(ready.shift());
      if (failWith) return Promise.reject(failWith);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

/** Sends one plain-text letter. Throws with a short reason when the server refuses. */
export async function sendMail({ to, subject, text }, url = process.env.SMTP_URL) {
  if (!url) throw new Error('Пошту не налаштовано (SMTP_URL)');
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  const host = u.hostname;
  const port = Number(u.port) || (secure ? 465 : 587);
  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');
  const fromHeader = clean(process.env.MAIL_FROM || user || `noreply@${host}`);
  const fromAddr = (/<([^>]+)>/.exec(fromHeader)?.[1] || fromHeader).trim();
  const rcpt = clean(to);
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(rcpt)) throw new Error('Некоректна адреса');

  const r = replies();
  let sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  sock.setTimeout(20000, () => sock.destroy(new Error('SMTP: немає відповіді')));
  r.attach(sock);
  const say = (line) => sock.write(`${line}\r\n`);
  const expect = async (ok, what) => {
    const res = await r.next();
    if (!ok.includes(res.code)) throw new Error(`SMTP ${what}: ${res.text.slice(0, 160)}`);
    return res;
  };
  try {
    await expect([220], 'вітання');
    say(`EHLO ${clean(process.env.MAIL_HELO || 'agency-crm')}`);
    let ehlo = await expect([250], 'EHLO');
    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      say('STARTTLS');
      await expect([220], 'STARTTLS');
      r.detach(sock);
      sock = tls.connect({ socket: sock, servername: host });
      r.attach(sock);
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      say(`EHLO ${clean(process.env.MAIL_HELO || 'agency-crm')}`);
      ehlo = await expect([250], 'EHLO');
    }
    if (user) {
      say(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')}`);
      await expect([235], 'вхід (логін / пароль застосунку)');
    }
    say(`MAIL FROM:<${fromAddr}>`);
    await expect([250], 'відправник');
    say(`RCPT TO:<${rcpt}>`);
    await expect([250, 251], 'одержувач');
    say('DATA');
    await expect([354], 'DATA');
    const msg = [
      `From: ${fromHeader}`,
      `To: <${rcpt}>`,
      `Subject: =?UTF-8?B?${b64(clean(subject))}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${fromAddr.split('@')[1] || host}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(b64(String(text))),
    ].join('\r\n');
    sock.write(`${msg}\r\n.\r\n`);
    await expect([250], 'лист');
    say('QUIT');
  } finally {
    setTimeout(() => sock.destroy(), 500).unref?.();
  }
  return { ok: true };
}
