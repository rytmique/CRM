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

const defaultFactory = (apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
let clientFactory = defaultFactory;

/** The team's own key; the platform's key only if the platform admin allows it for this team. */
export function keyFor(settings) {
  return settings.ai.apiKey || (settings.ai.platformKey !== false ? process.env.ANTHROPIC_API_KEY || '' : '');
}

/** Who used how much: the server records each AI call (per team, per person). */
let usageHook = null;
export function onAiUsage(fn) { usageHook = fn; }
function recordUsage(profile, settings, response) {
  if (!usageHook || !profile?.agency_id) return;
  try { usageHook({ agencyId: profile.agency_id, userId: profile.operator_id || 0, timezone: settings?.timezone, usage: response?.usage || {} }); } catch { /* never breaks a text */ }
}

/** Test hook: replace the Anthropic client factory (null = the real one). */
export function setAiClientFactory(fn) {
  clientFactory = fn || defaultFactory;
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
    p.site_about ? `From her profile on the site:\n${String(p.site_about).slice(0, 1500)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function cleanInvite(text, max = 1000) {
  let t = String(text || '').trim();
  t = t.replace(/^["'«“]+|["'»”]+$/g, '').trim();
  t = t.replace(/\{\s*name\s*\}/gi, '{name}');
  return t.slice(0, max);
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
export const DEFAULT_PROMPT = SYSTEM_PROMPT; // (the base invite of search sites; the night shift uses MASTER_PROMPT)

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

/** Which prompt applies: explicit override (preview) > the profile's own > her operator's own > the team's > built-in. */
export function resolvePrompt({ profile, settings, override }) {
  if (override && override.trim()) return { text: override, source: 'override' };
  if (profile.prompt && profile.prompt.trim()) return { text: profile.prompt, source: 'profile' };
  if (settings.ai.operatorPrompt && settings.ai.operatorPrompt.trim()) return { text: settings.ai.operatorPrompt, source: 'operator' };
  if (settings.ai.masterPrompt && settings.ai.masterPrompt.trim()) return { text: settings.ai.masterPrompt, source: 'agency' };
  return { text: DEFAULT_PROMPT, source: 'default' };
}

/** A plain request: system + one user message → text. Used for the platform lessons. */
export async function askClaude({ apiKey, model, system, user }) {
  const client = clientFactory(apiKey);
  let response;
  try {
    response = await client.beta.messages.create({
      model, max_tokens: 4000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low' },
      system, messages: [{ role: 'user', content: user }],
    });
  } catch (e) {
    throw mapError(e);
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'ШІ відмовився');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function callClaude({ apiKey, model, system, language, instructions, profile, previous, previousLabel, bestExample, memory, examples, settings, about = '', max = 1000 }) {
  const client = clientFactory(apiKey);
  const userParts = [
    `Her profile:\n${profileBrief(profile)}`,
    about ? `About him (the only facts you may use):\n${about}` : '',
    `Write the message in ${language}.`,
    instructions ? `Extra guidance from the agency: ${instructions}` : '',
    profile.notes ? `Notes about her: ${profile.notes}` : '',
    memory?.length ? `What works on this platform, learned from real replies (follow it unless the profile says otherwise):\n${memory.map((l) => `- ${l}`).join('\n')}` : '',
    examples?.length ? `Messages written by her operator that got replies. Match their style and tricks, but never copy them word for word:\n${examples.map((e) => `- ${e}`).join('\n')}` : '',
    bestExample ? `This message of hers gets the most replies so far. Keep what makes it work, but write a new one with a different opening and a different question:\n${bestExample}` : '',
    previous ? (previousLabel ? `${previousLabel}\n${previous}` : `Her current messages are below (separated by ---). Write a fresh one with a different opening and a different question:\n${previous}`) : '',
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

  recordUsage(profile, settings, response);
  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'ШІ відмовився писати текст для цієї анкети. Перевірте опис анкети та інструкції.');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new HttpError(502, 'ШІ повернув порожню відповідь. Спробуйте ще раз.');
  return { text: cleanInvite(text, max), model: response.model || model };
}

/**
 * Generates one invite for a profile.
 * Uses Claude when an API key is configured, otherwise a local template (so the system works out of the box).
 */
export async function generateInvite({ profile, settings, previous = '', promptOverride = '', bestExample = '', memory = [] }) {
  const apiKey = keyFor(settings);
  const language = profile.language || settings.ai.language || 'English';
  const prompt = resolvePrompt({ profile, settings, override: promptOverride });
  if (!apiKey) {
    return { text: templateInvite(profile, previous), source: 'template', model: null, promptSource: prompt.source };
  }
  const model = settings.ai.model || 'claude-opus-5-5';
  const system = fillPromptVars(prompt.text, profile, language);
  let out = await callClaude({ apiKey, model, system, language, instructions: settings.ai.instructions, profile, previous, bestExample, memory, examples: settings.ai.examples, settings });
  if (inviteProblems(out.text).length) {
    // One retry, telling the model what went wrong. Contacts/links are never allowed, whatever the prompt says:
    // dating sites ban profiles for them.
    out = await callClaude({
      apiKey, model, system, language, profile, previous, bestExample, memory, examples: settings.ai.examples, settings,
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
  const apiKey = keyFor(settings);
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) return templateFollowup(profile, step);
  const model = settings.ai.model || 'claude-opus-5-5';
  const prev = previous.filter(Boolean).map((t, i) => `Message ${i + 1}: ${t}`).join('\n');
  const ask = (extra = '') => callClaude({
    apiKey, model, system: FOLLOWUP_PROMPT, language, profile, settings,
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
  const apiKey = keyFor(settings);
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) return templateReengage();
  const model = settings.ai.model || 'claude-opus-5-5';
  const out = await callClaude({ apiKey, model, system: REENGAGE_PROMPT, language, profile, settings, instructions: settings.ai.instructions });
  const variants = out.text.split(/\n\s*-{3,}\s*\n/).map((t) => cleanInvite(t)).filter((t) => t.length >= 20 && !FORBIDDEN.some((re) => re.test(t)));
  if (!variants.length) return templateReengage();
  return { text: variants.slice(0, 5).join('\n---\n'), source: 'ai', model: out.model };
}

// ---------- a letter (the site's mail: longer than a chat message) ----------
const LETTER_PROMPT = `You write a first letter a woman sends through the mail (letters) section of an international dating site to a man she has not talked to yet. She reads and answers every reply herself, so it must sound like her, in the first person.

Write one letter that:
- tells a little about her life, character and what she is looking for, using concrete details from her profile;
- is warm, sincere and easy to answer, and ends with two or three simple, natural questions about him;
- works for any recipient: make no assumptions about his looks, job or country;
- is 700-1200 characters, 2-4 short paragraphs, plain text, with at most one emoji;
- opens with a greeting that uses the placeholder {name} exactly once (it is replaced with his first name before sending).

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content, promises to meet, or claims that she already knows him.

Reply with the letter text only: no subject line, no quotes, no explanation.`;

export function templateLetter(p) {
  const interests = String(p.interests || '').split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const place = [p.city, p.country].filter(Boolean).join(', ');
  return {
    text: [
      `Hello {name}!`,
      `My name is ${p.name}${p.age ? `, I am ${p.age}` : ''}${place ? ` and I live in ${place}` : ''}. I decided to write you a real letter, because I believe a few honest words can start something beautiful.`,
      interests.length ? `In my free time I love ${interests.slice(0, 3).join(', ')}. These little things make my days bright, and I would love to share them with a kind man.` : 'I am a warm and caring person, I love simple moments: a walk, a good talk, a cup of tea in the evening.',
      p.looking_for ? `I am looking for ${String(p.looking_for).replace(/\.$/, '')}.` : 'I am looking for a sincere man who knows what he wants.',
      'Tell me a little about yourself? What does your usual day look like, and what makes you happy?',
    ].join('\n\n'),
    source: 'template', model: null,
  };
}

/** A first letter for the site's mail section. */
export async function generateLetter({ profile, settings, memory = [] }) {
  const apiKey = keyFor(settings);
  const language = profile.language || settings.ai.language || 'English';
  if (!apiKey) return templateLetter(profile);
  const model = settings.ai.model || 'claude-opus-5-5';
  let out = await callClaude({ apiKey, model, system: LETTER_PROMPT, language, profile, settings, instructions: settings.ai.instructions, memory, max: 3000 });
  if (FORBIDDEN.some((re) => re.test(out.text))) {
    out = await callClaude({ apiKey, model, system: LETTER_PROMPT, language, profile, settings, memory, max: 3000, instructions: `${settings.ai.instructions || ''}\nThe previous draft contained contact details, links or messenger names. Never include any of them.`.trim() });
    if (FORBIDDEN.some((re) => re.test(out.text))) throw new HttpError(422, 'ШІ згенерував лист із контактами/посиланнями. Спробуйте ще раз.');
  }
  return { text: out.text.slice(0, 3000), source: 'ai', model: out.model };
}

// ---------- «Шанс»: a hook in the first characters, under each man ----------
// In his list he sees only the first ~5 characters of her letter: they have to make him open it.
const HOOK_PROMPT = `You write the very first words of a woman's first letter to a man on an international dating site. In his list of messages he sees only the first 5 characters, so those 5 characters must make him curious enough to open it.

Write 3 openings, one per category:
- "personal": about him — use only his first name and/or age if they are given;
- "city": about his city or country — only if it is given; otherwise write a second "personal" one;
- "flirt": light, playful and warm; never sexual.

Each opening:
- is one sentence of 30-110 characters that leads naturally into her letter;
- starts right away with a word or an emoji: no space, quote or dash first, and never "Hi", "Hello", "Hey" or "Dear";
- has first 5 characters that are intriguing on their own (an exclamation, his name, his city, a teasing word);
- uses only the facts given about him — never invents his job, hobbies, looks or anything else;
- never includes contact details, links, apps, money, gifts or promises to meet.

Reply with JSON only, no explanation: [{"category":"personal","text":"..."},{"category":"city","text":"..."},{"category":"flirt","text":"..."}]`;

const HOOK_TEMPLATES = {
  personal: ['{name}, you caught my eye today…', '{name}? I just had to write to you.', '{name}! I have a feeling we would get along.', '{name}, may I steal a minute of your evening?', '{name}… there is something warm about your profile.'],
  city: ['{place}! I have always dreamed of seeing it.', '{place}? Tell me, is it as beautiful as people say?', '{place} — now I am even more curious about you.', '{place}… I wonder what your evenings there look like.'],
  flirt: ['Oops… I smiled at your photo for too long 🙈', 'Psst… may I tell you a little secret?', 'Wow, a man with such kind eyes!', 'Shh… do not tell anyone I wrote first 😊', 'Okay, I will be brave and write first…', 'Hmm… you look like a man with stories to tell.', 'Wait — are you always this charming?', 'Guess who could not scroll past you?'],
};
const HOOK_BAD_START = /^(hi|hello|hey|hiya|dear|greetings|good (morning|evening|afternoon|day))\b/i;
export const hookKey = (t) => String(t || '').trim().slice(0, 5).toLowerCase();
const manFirst = (name) => String(name || '').split(/[\s,]+/)[0] || '';

/** A good hook: starts with a word or emoji, new first 5 characters for her, only his facts, nothing forbidden. */
export function hookOk(text, man = {}, recent = new Set()) {
  if (/^\s/.test(String(text || ''))) return false;
  const t = String(text || '').trim();
  if (t.length < 12 || t.length > 160) return false;
  if (/^[\s"'«»“”\-–—.,:;!?()]/.test(t) || HOOK_BAD_START.test(t)) return false;
  if (recent.has(hookKey(t))) return false;
  if (FORBIDDEN.some((re) => re.test(t))) return false;
  if ((t.match(/\d+/g) || []).some((n) => n !== String(man.age || ''))) return false; // no numbers but his age
  if (/\{|\}/.test(t)) return false;
  return true;
}

const tplRe = (t) => new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(name|place)\}/g, '.+?')}`, 'i');
/**
 * Without AI (or when it fails): the templates of the 3 categories, a different start for each man and never the
 * template of one of her last letters («lately» — their texts) with another name in it.
 */
export function templateHook(man = {}, recent = new Set(), seed = 0, lately = []) {
  const name = manFirst(man.name);
  const place = String(man.place || '').split(',')[0].trim();
  const cats = [place ? 'city' : '', name ? 'personal' : '', 'flirt'].filter(Boolean);
  const order = cats.map((_, i) => cats[(i + seed) % cats.length]);
  const used = (tpl) => lately.some((x) => tplRe(tpl).test(String(x || '').trim()));
  for (const strict of [true, false]) {
    for (const cat of order) {
      const list = HOOK_TEMPLATES[cat];
      for (let i = 0; i < list.length; i++) {
        const tpl = list[(i + seed) % list.length];
        if (strict && used(tpl)) continue;
        const text = tpl.replaceAll('{name}', name).replaceAll('{place}', place);
        if (hookOk(text, man, recent)) return { hook: text, category: cat, source: 'template', model: null };
      }
    }
  }
  const any = HOOK_TEMPLATES.flirt[seed % HOOK_TEMPLATES.flirt.length];
  return { hook: any, category: 'flirt', source: 'template', model: null };
}

/** The hook for this man: AI writes 3 (personal / city / flirt), the first that passes the checks is taken. */
export async function generateHook({ profile, settings, man = {}, recent = new Set(), seed = 0, lately = [] }) {
  const apiKey = keyFor(settings);
  if (!apiKey) return templateHook(man, recent, seed, lately);
  const language = profile.language || settings.ai.language || 'English';
  const about = [manFirst(man.name) && `First name: ${manFirst(man.name)}`, man.age && `Age: ${man.age}`, man.place && `City / country: ${man.place}`].filter(Boolean).join('\n') || 'Nothing is known about him.';
  const style = resolvePrompt({ profile, settings });
  const instructions = [settings.ai.instructions, style.source !== 'default' ? `Her style (from her operator) — follow its tone only, the rules above still apply:\n${style.text.slice(0, 1500)}` : '',
    recent.size ? `Do not start like these recent letters of hers: ${[...recent].slice(0, 15).map((x) => `"${x}"`).join(', ')}` : ''].filter(Boolean).join('\n');
  try {
    const out = await callClaude({ apiKey, model: settings.ai.model || 'claude-opus-5-5', system: HOOK_PROMPT, language, profile, settings, about, instructions, max: 2000 });
    const list = JSON.parse((out.text.match(/\[[\s\S]*\]/) || ['[]'])[0]);
    const pref = ['city', 'personal', 'flirt'];
    const order = pref.map((_, i) => pref[(i + seed) % pref.length]);
    const cands = Array.isArray(list) ? list.filter((x) => x && typeof x.text === 'string') : [];
    for (const cat of order) {
      for (const c of cands.filter((x) => x.category === cat)) {
        const text = c.text.trim();
        if (cat === 'city' && !man.place) continue; // a city he never gave
        if (hookOk(text, man, recent)) return { hook: text, category: cat, source: 'ai', model: out.model };
      }
    }
  } catch { /* AI down or a bad answer: the templates */ }
  return templateHook(man, recent, seed, lately);
}

/** Her letter with the hook in front: her own greeting line goes (the hook greets him). */
export function withHook(hook, letter) {
  const body = String(letter || '').trim().replace(/^(hi|hello|hey|dear|good (morning|evening|afternoon|day))\b[^.!?\n]*[.!?]*\s*/i, '');
  return `${String(hook || '').trim()} ${body}`.trim();
}

// ---------- «Шанс»: an invite with a hook, then a letter — both written for this man ----------
/**
 * The default master prompt (the style). Built from the agency's best invites and letters: a CAPS headline as the hook,
 * his own details, questions with a choice, playful flirt. The hard rules below are added to it and cannot be edited.
 */
export const MASTER_PROMPT = `You write for a woman on an international dating site. Her messages get replies because every one of them feels written for one man only.

THE HOOK — the first 5 characters decide everything: in his list he sees only them.
- Start with a short headline in CAPITAL LETTERS, 2-5 words, ending with "?", "!" or ".", built from something real about him: his name, his hobby, his town, a detail of his profile. The shape of good headlines (never copy them): "FISHING OR ME?", "RON, STILL BUSY?", "STARGAZING CAMPERS?", "ART OR PEOPLE?".
- Never start with "Hi", "Hello", "Dear", a space, an emoji or a punctuation mark.

THE INVITE (a chat message) — about 250 characters (200-300):
- the headline, then 2-3 short sentences: one concrete detail from his profile (a hobby, his work, a place near his town, his own words about himself) and why it caught her eye;
- one or two easy questions he can answer in one line: a choice between two things, or how far he is from a place he knows;
- playful, flirty, a little teasing; confident and warm, never needy.

THE LETTER (sent right after the invite) — 700-1100 characters, one flowing text:
- open with his name and a feeling, e.g. that something in his manner or his smile stayed with her;
- weave in 2-3 details from his profile (hobbies, what he cooks, art, nature, places around his town);
- one or two details about her from her profile, so he feels who writes;
- 2-3 questions with a choice in them ("painting or photography?", "breakfast or dinner?", "something cosy or a new recipe?"), one of them about the places around his town;
- a dreamy, romantic note — a slow walk, a cosy evening, his smile — tender and flirtatious;
- end with a soft call to answer, e.g. that even one sincere line from him would make her day.

Every invite and every letter is new: another headline, another opening, other questions. Specific compliments, curiosity about his life, light romantic tension.`;

const CHANCE_RULES = `You write two texts for a woman on an international dating site, for one man she has not talked to yet: an invite (a chat message) and a letter that is sent right after it. Follow her style guide below, and these rules always:
- Use only the facts given about him and about her. Never invent his job, hobbies, looks, city, family or anything else.
- Never say or hint that she is in his city or country, travelling to him or near him, or that they can meet today or soon; never propose a date or a meeting in person.
- Never claim that they talked before, that she has been waiting for his letters, or that she knows him.
- No sexual content, nothing about bed or bodies.
- No contact details, links, other apps or messengers, money or gifts.
- The invite starts with the CAPS headline (the hook) and is 200-300 characters; the letter is 700-1100 characters and does not repeat the invite.

Reply with JSON only, no explanation: {"invite": "...", "letter": "..."}`;

/** Texts that break the rules no matter what the style says (checked after the AI and on the templates). */
const CLAIMS = [
  /\b(i am|i'm|i will be|i'll be|i'm now|i am now)\s+(now\s+)?(in|near|around|visiting|coming to|travel+ing (to|in|around|through))\b[^.?!]{0,40}\b(your|you)\b/i,
  /\b(meet|see)\s+(you|me|each other|up)\b[^.?!]{0,30}\b(today|tonight|tomorrow|soon|this week|this weekend|in person)\b/i,
  /\blet'?s meet\b|\bmeet in person\b|\bpersonal meeting\b/i,
  /\b(in|into) (my |your )?bed\b|\bbedroom\b|\bnaked\b|\bsex(ual|y)?\b|\blingerie\b/i,
  /\b(waiting for|checking for) (your|his) (letters?|messages?|name)\b|\bwe talked (before|last)\b/i,
];
export const chanceProblems = (t) => [...FORBIDDEN, ...CLAIMS].some((re) => re.test(String(t || '')));
const capsHook = (t) => { const h = String(t || '').trim().slice(0, 5); return /\p{L}/u.test(h) && h === h.toUpperCase() && !/^[\s"'«»“”\-–—.,:;!?()]/.test(h); };

/** His details, as the bot read them from his profile page: «Header: value» lines and free texts. */
export function manFacts(man = {}) {
  const lines = String(man.about || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const pair = (re) => lines.map((l) => /^([^:]{2,40}):\s*(.+)$/.exec(l)).find((m) => m && re.test(m[1]))?.[2] || '';
  const hobbies = pair(/hobb|interest|leisure|free time|like to do|passion/i).split(/[,;/]|\band\b/).map((x) => x.trim().toLowerCase()).filter((x) => x && x.length < 30).slice(0, 4);
  const aboutMe = pair(/about me|myself|self.?summary|who am i|my self/i) || lines.find((l) => !l.includes(':') && l.length > 40) || '';
  const work = pair(/occupation|profession|work|job/i);
  return { name: String(man.name || '').split(/[\s,]+/)[0] || '', age: man.age || null, place: String(man.place || '').split(',')[0].trim(), hobbies, aboutMe: aboutMe.slice(0, 300), work: work.slice(0, 60) };
}
const herFacts = (p) => {
  const about = String(p.site_about || p.bio || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const self = about.find((l) => /^(about me|about myself|my self)/i.test(l))?.replace(/^[^:]+:\s*/, '') || about.find((l) => !l.includes(':') && l.length > 40) || '';
  const hob = (about.find((l) => /^(hobb|interest)/i.test(l)) || '').replace(/^[^:]+:\s*/, '');
  return { name: p.name, age: p.age, city: p.city, self: self.split(/(?<=[.!?])\s/)[0]?.slice(0, 200) || '', hobbies: hob || p.interests || '' };
};
const pickN = (list, n) => list[((n % list.length) + list.length) % list.length];

/** Without AI (or when it fails): an invite with a CAPS headline and a letter, both made of his details, different every time. */
export function templateChance(profile = {}, man = {}, seed = 0, recent = []) {
  const f = manFacts(man);
  const h = herFacts(profile);
  const hob = f.hobbies[0];
  const N = (f.name || 'YOU').toUpperCase();
  const heads = [
    hob && `${hob.toUpperCase()} OR ME?`, f.place && `${f.place.toUpperCase()}, REALLY?`, `${N}, CAUGHT YOU!`, hob && `MORE THAN ${hob.toUpperCase()}?`,
    `${N}, ONE QUESTION?`, 'CAN I BE BOLD?', 'GUILTY SMILE!', f.place && `WHY ${f.place.toUpperCase()}?`, 'TEA OR TROUBLE?', `${N}, ARE YOU REAL?`,
  ].filter(Boolean);
  const detail = hob ? `I saw that you love ${f.hobbies.slice(0, 2).join(' and ')}` : f.aboutMe ? `Your words "${f.aboutMe.split(/(?<=[.!?])\s/)[0].slice(0, 70)}" made me smile` : f.place ? `${f.place} sounds like a place with stories` : 'Your smile in the photo made me curious';
  const asks = [
    hob ? `Is ${hob} your way to relax, or your way to escape?` : 'Are you more of a morning person or a night owl?',
    f.place ? `What is your favourite spot around ${f.place}?` : 'Tea by the window or a walk in the rain — what would you choose?',
    'Tell me, what made you smile today?',
    hob ? `Would you teach me ${hob}, or would I only distract you? 😉` : 'Would you rather talk all night or say a lot with one look? 😉',
  ];
  let invite = '';
  for (let i = 0; i < heads.length && !invite; i++) {
    const head = pickN(heads, seed + i);
    const t = `${head} ${detail} — and I had to write. ${pickN(asks, seed + i)} ${pickN(asks, seed + i + 1)}`.replace(/\s+/g, ' ').trim();
    if (!recent.some((r) => String(r).slice(0, 5).toUpperCase() === t.slice(0, 5).toUpperCase())) invite = t;
  }
  if (!invite) invite = `${pickN(heads, seed)} ${detail} — and I had to write. ${pickN(asks, seed)}`;
  const openers = [
    `${f.name || 'Hey you'}, something in your profile stayed with me today, and I caught myself smiling for no reason.`,
    `${f.name || 'You'}, I promised myself to be brave today, so here is my letter.`,
    `${f.name || 'Hello'}, there is something calm and kind in your eyes, and I could not just scroll past.`,
    `${f.name || 'You'}, I read your profile twice, and the second time I was already smiling.`,
  ];
  const his = hob ? `You love ${f.hobbies.slice(0, 2).join(' and ')} — I can almost picture you there, focused and happy, and I like that picture a lot.`
    : f.aboutMe ? `When you wrote "${f.aboutMe.slice(0, 90)}", I felt a real person behind the words.`
    : f.place ? `I keep wondering what an ordinary evening in ${f.place} looks like for you.` : 'I keep wondering what an ordinary evening looks like for you.';
  const me = [`I am ${h.name}${h.age ? `, ${h.age}` : ''}${h.city ? `, from ${h.city}` : ''}.`, h.self, h.hobbies ? `I love ${String(h.hobbies).split(/[,;]/).slice(0, 2).join(' and ').trim()}.` : ''].filter(Boolean).join(' ');
  const dreams = [
    'I imagine a slow evening walk, the air a little cool, and you telling me something that makes me laugh.',
    'I like to imagine a cosy evening, a warm drink in my hands and a man who listens with his eyes.',
    'Maybe it is silly, but I already imagine your smile when you read this.',
  ];
  const qs = [
    f.place ? `What is the most beautiful place around ${f.place}, the one you would show first?` : 'Which place in your town would you show me first?',
    hob ? `When you are into ${hob}, do you prefer company or quiet?` : 'Do you prefer quiet evenings at home or going out?',
    'Breakfast or dinner — which would you rather cook for someone special?',
    'Are you more of a painter or a photographer of your memories?',
    'What made you decide to look for something real at this point of your life?',
  ];
  const closings = ['Even one sincere line from you would make my day.', 'Write me just a few words — I will be waiting with a smile.', 'One honest line from you will mean more than you think.'];
  const letter = [pickN(openers, seed), his, me, pickN(dreams, seed), `${pickN(qs, seed)} ${pickN(qs, seed + 2)} And ${pickN(qs, seed + 4).replace(/^\w/, (c) => c.toLowerCase())}`, pickN(closings, seed)]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return { invite, letter, source: 'template', model: null, hook: invite.slice(0, 5) };
}

/** The invite and the letter for this man: AI writes both by her style + the rules; checked, else the templates. */
export async function generateChance({ profile, settings, man = {}, seed = 0, recent = [] }) {
  const apiKey = keyFor(settings);
  if (!apiKey) return templateChance(profile, man, seed, recent);
  const language = profile.language || settings.ai.language || 'English';
  const f = manFacts(man);
  const about = [f.name && `First name: ${f.name}`, f.age && `Age: ${f.age}`, f.place && `Lives in: ${man.place}`, f.work && `Work: ${f.work}`,
    f.hobbies.length && `Hobbies: ${f.hobbies.join(', ')}`, man.about && `His profile on the site:\n${String(man.about).slice(0, 1400)}`].filter(Boolean).join('\n') || 'Only his first name is known.';
  const style = resolvePrompt({ profile, settings });
  const system = `${CHANCE_RULES}\n\nHer style guide:\n${style.text}`;
  const avoid = recent.length ? `Her recent invites started like this — start differently: ${recent.slice(0, 12).map((r) => `"${String(r).slice(0, 24)}"`).join(', ')}` : '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await callClaude({ apiKey, model: settings.ai.model || 'claude-opus-5-5', system, language, profile, settings, about,
        instructions: [settings.ai.instructions, avoid, attempt ? 'The previous answer broke a rule (a meeting, being near him, sexual content, contacts, or a wrong length). Write it again following every rule.' : ''].filter(Boolean).join('\n'), max: 4000 });
      const j = JSON.parse((out.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      const invite = String(j.invite || '').trim();
      const letter = String(j.letter || '').trim();
      const ok = capsHook(invite) && invite.length >= 150 && invite.length <= 360 && letter.length >= 500 && letter.length <= 1600
        && !chanceProblems(invite) && !chanceProblems(letter) && !recent.some((r) => String(r).slice(0, 5).toUpperCase() === invite.slice(0, 5).toUpperCase());
      if (ok) return { invite, letter, source: 'ai', model: out.model, hook: invite.slice(0, 5) };
    } catch { /* AI down or a bad answer */ }
  }
  return templateChance(profile, man, seed, recent);
}

// ---------- «Аллчат»: a message on the topic of a running talk ----------
const TOPIC_PROMPT = `You continue a running conversation of a woman with a man on an international dating site. She writes to him again because he has gone quiet. The last messages of their talk are given (oldest first; "Her:" is her, "Him:" is him). She reads and answers every reply herself.

Write one short message from her that:
- picks up the topic they last talked about: refer to something concrete from the talk in your own words, or take it one natural step further;
- is warm, light and personal — never pushy, never reproachful about his silence, never "why don't you answer";
- ends with one simple question that is easy to answer;
- is 120-350 characters, plain text, with at most one emoji;
- does not repeat her earlier messages and does not start with the same words as her last one.

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content or promises to meet.

Reply with the message text only: no quotes, no explanation.`;

const TOPIC_TEMPLATES = [
  'I was just thinking about what you told me last time 🙂 How did your day go today?',
  'You know, our last talk made me smile. Tell me, what are you up to this evening?',
  'I keep remembering our conversation. Did anything interesting happen since then?',
  'Hi again! I wanted to continue our talk — what would you do on a perfect day off?',
];
const historyText = (history) => history.slice(-12).map((m) => `${m.mine ? 'Her' : 'Him'}: ${String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)}`).filter((l) => l.length > 6).join('\n');

/** A template for when there is no AI key (or the AI is down): not the same as her last message. */
export function templateTopic(history = [], seed = 0) {
  const lastMine = [...history].reverse().find((m) => m.mine)?.text || '';
  const options = TOPIC_TEMPLATES.filter((t) => t !== lastMine);
  return { text: options[seed % options.length], source: 'template', model: null };
}

/** «Аллчат»: one message on the topic of their talk (history: [{mine, text}], oldest first). */
export async function generateTopic({ profile, settings, history = [], seed = 0 }) {
  const apiKey = keyFor(settings);
  const talk = historyText(history);
  if (!apiKey || !talk) return templateTopic(history, seed);
  const language = profile.language || settings.ai.language || 'English';
  const model = settings.ai.model || 'claude-opus-5-5';
  const ask = (extra = '') => callClaude({ apiKey, model, system: TOPIC_PROMPT, language, profile, settings, max: 600,
    instructions: `${settings.ai.instructions || ''}${extra}`.trim(), previous: talk, previousLabel: 'The last messages of their talk (oldest first):' });
  let out = await ask();
  if (FORBIDDEN.some((re) => re.test(out.text))) {
    out = await ask('\nThe previous draft contained contact details, links or messenger names. Never include any of them.');
    if (FORBIDDEN.some((re) => re.test(out.text))) return templateTopic(history, seed);
  }
  return { text: out.text.slice(0, 600), source: 'ai', model: out.model };
}

// ---------- 🔒 the bot answers his reply itself (locked: only when the platform admin opens it) ----------
const REPLY_PROMPT = `You write the next message of a woman in her conversation with a man on an international dating site. He has just answered her. The last messages of their talk are given (oldest first; "Her:" is her, "Him:" is him).

Write her answer to his last message: answer what he said or asked, add a small personal detail about her, and ask one natural question back. 150-450 characters, plain text, at most one emoji, the same language as the talk.

Never include contact details, links, other apps or messengers, requests for money or gifts, sexual content or promises to meet.

Reply with the message text only.`;

export async function generateReply({ profile, settings, history = [] }) {
  const apiKey = keyFor(settings);
  const talk = historyText(history);
  if (!apiKey || !talk) return null; // no template: without the AI a live person answers
  const language = profile.language || settings.ai.language || 'English';
  const out = await callClaude({ apiKey, model: settings.ai.model || 'claude-opus-5-5', system: REPLY_PROMPT, language, profile, settings, max: 800,
    instructions: settings.ai.instructions, previous: talk, previousLabel: 'The last messages of their talk (oldest first):' });
  if (FORBIDDEN.some((re) => re.test(out.text))) return null;
  return { text: out.text.slice(0, 800), source: 'ai', model: out.model };
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
