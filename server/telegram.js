/** Minimal Telegram Bot API client used for reply notifications. */
/** Where the Bot API lives (tests point it at a local fake). */
let API = process.env.TELEGRAM_API || 'https://api.telegram.org';
export function setTelegramApi(url) { API = url || process.env.TELEGRAM_API || 'https://api.telegram.org'; }

/** Any Bot API method: { ok, result, error }. */
export async function tgCall(botToken, method, body = {}, timeoutMs = 10_000) {
  if (!botToken) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${API}/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const out = await res.json().catch(() => ({}));
    return { ok: Boolean(out.ok), result: out.result, error: out.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function sendTelegram(botToken, chatId, text, extra = {}) {
  if (!botToken || !chatId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: Boolean(body.ok), error: body.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
