import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './util.js';

const SYSTEM_PROMPT = `You write the opening message a woman sends from her own profile on an international dating site to men she has not talked to yet. She reads and answers every reply herself, so the message must sound like her, written in the first person.

Write one message that:
- reflects her personality, interests and what she is looking for, using concrete details from her profile rather than generic compliments;
- is warm, light and easy to answer, ending with one simple, natural question;
- works for any recipient: you know nothing about him, so make no assumptions about his looks, job or country;
- is 250-450 characters, 2-4 sentences, plain text, with at most one emoji;
- opens with a greeting that uses the placeholder {name} exactly once (it is replaced with his first name before sending).

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content, promises to meet, or claims that she already knows him.

Reply with the message text only: no quotes, no preface, no explanation.`;

const FORBIDDEN = [
  /https?:\/\//i,
  /\bwww\./i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /\+?\d[\d\s().-]{7,}\d/,
  /\b(whats\s?app|telegram|viber|instagram|snapchat|skype|wechat|signal)\b/i,
];

let clientFactory = (apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });

/** Test hook: replace the Anthropic client factory. */
export function setAiClientFactory(fn) {
  clientFactory = fn;
}

function profileBrief(p) {
  const lines = [
    `Name: ${p.name}`,
    p.age ? `Age: ${p.age}` : '',
    p.city || p.country ? `Lives in: ${[p.city, p.country].filter(Boolean).join(', ')}` : '',
    p.bio ? `About her: ${p.bio}` : '',
    p.interests ? `Interests: ${p.interests}` : '',
    p.looking_for ? `Looking for: ${p.looking_for}` : '',
    p.tone ? `Tone of voice: ${p.tone}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function cleanInvite(text) {
  let t = String(text || '').trim();
  t = t.replace(/^["'«“]+|["'»”]+$/g, '').trim();
  t = t.replace(/\{\s*name\s*\}/gi, '{name}');
  return t.slice(0, 1000);
}

export function inviteProblems(text) {
  const issues = [];
  if (text.length < 40) issues.push('занадто коротке');
  for (const re of FORBIDDEN) if (re.test(text)) { issues.push('містить контакти/посилання'); break; }
  return issues;
}

function mapError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new HttpError(502, 'Claude API: невірний ключ. Перевірте Налаштування → ШІ.');
  if (e instanceof Anthropic.PermissionDeniedError) return new HttpError(502, 'Claude API: ключ не має доступу до цієї моделі.');
  if (e instanceof Anthropic.NotFoundError) return new HttpError(502, 'Claude API: модель не знайдено. Перевірте назву моделі в налаштуваннях.');
  if (e instanceof Anthropic.RateLimitError) return new HttpError(503, 'Claude API: ліміт запитів. Спробуйте за хвилину.');
  if (e instanceof Anthropic.BadRequestError) return new HttpError(502, `Claude API відхилив запит: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(503, 'Немає з’єднання з Claude API.');
  if (e instanceof Anthropic.APIError) return new HttpError(502, `Claude API помилка ${e.status ?? ''}: ${e.message}`);
  return e;
}

async function callClaude({ apiKey, model, language, instructions, profile, previous }) {
  const client = clientFactory(apiKey);
  const userParts = [
    `Her profile:\n${profileBrief(profile)}`,
    `Write the message in ${language}.`,
    instructions ? `Extra guidance from the agency: ${instructions}` : '',
    profile.notes ? `Notes about her: ${profile.notes}` : '',
    previous ? `Her current message is below. Write a fresh one with a different opening and a different question:\n${previous}` : '',
  ].filter(Boolean);

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
    });
  } catch (e) {
    throw mapError(e);
  }

  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'ШІ відмовився писати текст для цієї анкети. Перевірте опис анкети та інструкції.');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new HttpError(502, 'ШІ повернув порожню відповідь. Спробуйте ще раз.');
  return { text: cleanInvite(text), model: response.model || model };
}

/**
 * Generates one invite for a profile.
 * Uses Claude when an API key is configured, otherwise a local template (so the system works out of the box).
 */
export async function generateInvite({ profile, settings, previous = '' }) {
  const apiKey = settings.ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) {
    return { text: templateInvite(profile, previous), source: 'template', model: null };
  }
  const model = settings.ai.model || 'claude-opus-5-5';
  let out = await callClaude({ apiKey, model, language, instructions: settings.ai.instructions, profile, previous });
  if (inviteProblems(out.text).length) {
    // One retry, telling the model what went wrong.
    out = await callClaude({
      apiKey, model, language, profile, previous,
      instructions: `${settings.ai.instructions || ''}\nThe previous draft broke the rules (contacts, links or too short). Follow every rule strictly.`.trim(),
    });
    if (inviteProblems(out.text).length) throw new HttpError(422, 'ШІ двічі згенерував текст, що порушує правила. Спробуйте ще раз або напишіть вручну.');
  }
  return { text: out.text, source: 'ai', model: out.model };
}

// ---------- local template fallback (no API key) ----------
const OPENERS = ['Hi {name}!', 'Hello {name} :)', 'Hey {name}!', 'Good day, {name}!'];
const QUESTIONS = [
  'What makes you smile on an ordinary day?',
  'How do you like to spend a free weekend?',
  'What is the best trip you have ever taken?',
  'What are you passionate about lately?',
  'Are you more of a morning person or a night owl?',
];

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

export function templateInvite(p, previous = '') {
  let seed = Math.floor(Math.random() * 1000);
  const interests = String(p.interests || '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const place = [p.city, p.country].filter(Boolean).join(', ');
  const build = (s) => {
    const parts = [pick(OPENERS, s)];
    parts.push(`I'm ${p.name}${p.age ? `, ${p.age}` : ''}${place ? `, from ${place}` : ''}.`);
    if (interests.length) {
      const a = interests[s % interests.length];
      const b = interests.length > 1 ? interests[(s + 1) % interests.length] : '';
      parts.push(b && b !== a ? `I love ${a} and ${b}, and I'd enjoy sharing it with someone special.` : `I love ${a} and I'd enjoy sharing it with someone special.`);
    } else {
      parts.push('I believe the best stories start with a simple hello.');
    }
    if (p.looking_for) parts.push(`I'm looking for ${p.looking_for.replace(/\.$/, '')}.`);
    parts.push(pick(QUESTIONS, s + 2));
    return parts.join(' ');
  };
  let text = build(seed);
  for (let i = 0; i < 5 && text === previous; i++) text = build(++seed);
  return text;
}
