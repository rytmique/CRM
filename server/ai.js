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

/** The built-in base prompt; agencies can replace it with their own master prompt. */
export const DEFAULT_PROMPT = SYSTEM_PROMPT;

/** Placeholders a master prompt may use. {name} {age} {country} are NOT here: they stay in the invite for the man's data. */
export const PROMPT_VARS = [
  ['{her_name}', 'ім’я жінки'],
  ['{her_age}', 'її вік'],
  ['{her_city}', 'місто'],
  ['{her_country}', 'країна'],
  ['{about}', 'про себе'],
  ['{interests}', 'інтереси'],
  ['{looking_for}', 'кого шукає'],
  ['{tone}', 'тон'],
  ['{notes}', 'нотатки для ШІ'],
  ['{language}', 'мова інвайту'],
  ['{profile}', 'уся анкета одним блоком'],
];

export function fillPromptVars(template, profile, language) {
  const vars = {
    her_name: profile.name || '', her_age: profile.age ? String(profile.age) : '', her_city: profile.city || '',
    her_country: profile.country || '', about: profile.bio || '', interests: profile.interests || '',
    looking_for: profile.looking_for || '', tone: profile.tone || '', notes: profile.notes || '',
    language, profile: profileBrief(profile),
  };
  return String(template).replace(/\{(her_name|her_age|her_city|her_country|about|interests|looking_for|tone|notes|language|profile)\}/g, (_, k) => vars[k]);
}

/** Which prompt applies: explicit override (preview) > the profile's own > the agency master prompt > built-in. */
export function resolvePrompt({ profile, settings, override }) {
  if (override && override.trim()) return { text: override, source: 'override' };
  if (profile.prompt && profile.prompt.trim()) return { text: profile.prompt, source: 'profile' };
  if (settings.ai.masterPrompt && settings.ai.masterPrompt.trim()) return { text: settings.ai.masterPrompt, source: 'agency' };
  return { text: DEFAULT_PROMPT, source: 'default' };
}

async function callClaude({ apiKey, model, system, language, instructions, profile, previous, previousLabel }) {
  const client = clientFactory(apiKey);
  const userParts = [
    `Her profile:\n${profileBrief(profile)}`,
    `Write the message in ${language}.`,
    instructions ? `Extra guidance from the agency: ${instructions}` : '',
    profile.notes ? `Notes about her: ${profile.notes}` : '',
    previous ? (previousLabel ? `${previousLabel}\n${previous}` : `Her current message is below. Write a fresh one with a different opening and a different question:\n${previous}`) : '',
  ].filter(Boolean);

  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
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
export async function generateInvite({ profile, settings, previous = '', promptOverride = '' }) {
  const apiKey = settings.ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const language = profile.language || settings.ai.language || 'English';
  const prompt = resolvePrompt({ profile, settings, override: promptOverride });
  if (!apiKey) {
    return { text: templateInvite(profile, previous), source: 'template', model: null, promptSource: prompt.source };
  }
  const model = settings.ai.model || 'claude-opus-5-5';
  const system = fillPromptVars(prompt.text, profile, language);
  let out = await callClaude({ apiKey, model, system, language, instructions: settings.ai.instructions, profile, previous });
  if (inviteProblems(out.text).length) {
    // One retry, telling the model what went wrong. Contacts/links are never allowed, whatever the prompt says:
    // dating sites ban profiles for them.
    out = await callClaude({
      apiKey, model, system, language, profile, previous,
      instructions: `${settings.ai.instructions || ''}\nThe previous draft was rejected: it contained contact details, links or messenger names, or was too short. Never include any of them.`.trim(),
    });
    if (inviteProblems(out.text).length) throw new HttpError(422, 'ШІ двічі згенерував текст із контактами/посиланнями або занадто короткий. Спробуйте ще раз або змініть промт.');
  }
  return { text: out.text, source: 'ai', model: out.model, promptSource: prompt.source };
}

// ---------- follow-ups (2nd, 3rd… attempt when he has not replied) ----------
const FOLLOWUP_PROMPT = `You write a short follow-up message a woman sends from her own profile on an international dating site to a man who has not answered her earlier message yet. She reads and answers every reply herself, so it must sound like her, in the first person.

Write one message that:
- is light, friendly and confident: no guilt, no pressure, never asks why he did not answer;
- brings a new angle: a small detail from her day or her interests and one easy question;
- does not repeat the wording of her earlier messages;
- is 120-300 characters, 1-3 sentences, plain text, with at most one emoji;
- may use the placeholder {name} once (it is replaced with his first name before sending).

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content, promises to meet, or claims that she already knows him.

Reply with the message text only: no quotes, no preface, no explanation.`;

const FOLLOWUP_TEMPLATES = [
  'Hi {name}, just me again :) I made the best coffee this morning and thought of saying hello. How is your week going?',
  'Hello again, {name}! I am curious what makes you laugh the most. Maybe you will tell me?',
  '{name}, I hope your day is going well. I just came back from a long walk. What do you like to do to relax?',
  'Hi {name} :) I will not give up so easily. Tell me one thing that made you smile today?',
];

export const templateFollowup = (profile, step) => ({ text: FOLLOWUP_TEMPLATES[(step + (profile.id || 0)) % FOLLOWUP_TEMPLATES.length], source: 'template', model: null });

/** One follow-up text for the given scenario step (2, 3…). */
export async function generateFollowup({ profile, settings, step, previous = [] }) {
  const apiKey = settings.ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) return templateFollowup(profile, step);
  const model = settings.ai.model || 'claude-opus-5-5';
  const prev = previous.filter(Boolean).map((t, i) => `Message ${i + 1}: ${t}`).join('\n');
  const ask = (extra = '') => callClaude({
    apiKey, model, system: FOLLOWUP_PROMPT, language, profile,
    instructions: [settings.ai.instructions, `This is attempt number ${step}.`, extra].filter(Boolean).join('\n'),
    previous: prev ? `${prev}\n(These were sent before and got no answer. Write the next one, different from them.)` : '',
    previousLabel: 'Her earlier messages:',
  });
  const hasContacts = (t) => FORBIDDEN.some((re) => re.test(t));
  let out = await ask();
  if (hasContacts(out.text)) {
    out = await ask('The previous draft was rejected: it contained contact details, links or messenger names. Never include any of them.');
  }
  if (hasContacts(out.text)) throw new HttpError(422, 'ШІ згенерував повторне повідомлення з контактами/посиланнями. Спробуйте ще раз.');
  return { text: out.text, source: 'ai', model: out.model };
}

// ---------- reminders after a conversation went quiet (he replied before) ----------
const REENGAGE_PROMPT = `You write short messages a woman sends on an international dating site to a man she has already been chatting with, after he went quiet for a couple of days. She reads and answers every reply herself, so it must sound like her, in the first person.

Write three different messages. Each one:
- is warm and easy-going, like picking up a pleasant conversation again: no guilt, no pressure, never asks why he went quiet;
- works without knowing what they talked about: no references to specific earlier topics;
- shares one small fresh detail from her day and ends with one easy question;
- is 80-220 characters, 1-2 sentences, plain text, with at most one emoji;
- may use the placeholder {name} once (it is replaced with his first name before sending).

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content, or promises to meet.

Reply with the three messages only, separated by a line containing just ---. No numbering, no quotes, no explanation.`;

const REENGAGE_TEMPLATES = [
  'Hi {name} :) I was just thinking about our chat. How has your week been so far?',
  'Hey {name}! I had such a lazy, cozy evening today. What are you up to these days?',
  '{name}, I hope everything is fine with you. I missed our little talks :) How is your day?',
];

export const templateReengage = () => ({ text: REENGAGE_TEMPLATES.join('\n---\n'), source: 'template', model: null });

/** Three reminder variants ("---"-separated) for men who replied and then went quiet. */
export async function generateReengage({ profile, settings }) {
  const apiKey = settings.ai.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) return templateReengage();
  const model = settings.ai.model || 'claude-opus-5-5';
  const out = await callClaude({ apiKey, model, system: REENGAGE_PROMPT, language, profile, instructions: settings.ai.instructions });
  const variants = out.text.split(/\n\s*-{3,}\s*\n/).map((t) => cleanInvite(t)).filter((t) => t.length >= 20 && !FORBIDDEN.some((re) => re.test(t)));
  if (!variants.length) return templateReengage();
  return { text: variants.slice(0, 5).join('\n---\n'), source: 'ai', model: out.model };
}

// ---------- his reply: keep going or leave him alone ----------
const NEGATIVE = [
  /\bnot\s+(really\s+)?interested\b/i, /\bno\s+thanks?\b/i, /\bno,?\s+thank\s+you\b/i, /\b(stop|quit)\s+(writing|messaging|texting|sending)\b/i,
  /\b(don'?t|do\s+not|pls\s+don'?t)\s+(write|message|text|contact)\b/i, /\bleave\s+me\s+alone\b/i, /\bunsubscribe\b/i, /\bremove\s+me\b/i,
  /\b(scam|scammer|fake|catfish|bot)\b/i, /\bgo\s+away\b/i, /\bnot\s+for\s+me\b/i, /\bi'?m\s+(married|taken|in\s+a\s+relationship)\b/i,
  /\bblock(ed)?\s+you\b/i, /\bfuck\s+off\b/i,
  /не\s+(пиши|пишіть|пишите|цікаво|интересно)/i, /відчепись|отстань|отвали|не\s+беспокойте|не\s+турбуйте/i, /(?<![а-яёіїєґ])(шахра|мошенни|фейк(?![а-яёіїєґ])|бот(?![а-яёіїєґ]))/i,
];

/** 'negative' when he clearly asks to stop; otherwise 'positive' (no text = any reply counts as interest). */
export function classifyReply(text) {
  const t = String(text || '').trim();
  if (!t) return 'positive';
  return NEGATIVE.some((re) => re.test(t)) ? 'negative' : 'positive';
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
