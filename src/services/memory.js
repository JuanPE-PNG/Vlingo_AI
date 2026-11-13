import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getDB } from './database.js';
import { isMostlyEnglish } from './prompts.js';

export const KEEP_RECENT     = parseInt(process.env.MEMORY_KEEP_RECENT)     || 6;
export const COMPACT_TRIGGER = parseInt(process.env.MEMORY_COMPACT_TRIGGER) || 12;
const MAX_FACTS        = 20;
const MAX_ERRORS_SHOWN = 4;
const MAX_FACT_LEN     = 80;
const MAX_SUMMARY_LEN  = 1000;
const MAX_ERROR_WORDS  = 5;

const baseOptions = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model:   process.env.OLLAMA_MODEL,
  numCtx:  parseInt(process.env.OLLAMA_NUM_CTX) || 4096,
};

const jsonLlm    = new ChatOllama({ ...baseOptions, temperature: 0, numPredict: 250, format: 'json' });
const summaryLlm = new ChatOllama({ ...baseOptions, temperature: 0.2, numPredict: 250 });

const ERROR_CATEGORIES = [
  'subject-verb agreement', 'verb tense', 'irregular verbs', 'verb to be', 'auxiliary verbs',
  'verb form', 'articles', 'prepositions', 'word order', 'plurals', 'pronouns',
  'comparatives', 'spelling', 'vocabulary',
];

function words(text) {
  return (text || '').toLowerCase().match(/[a-záéíóúüñ']+/g) || [];
}

function normalizeSentence(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SELF_REFERENCE = /\b(i|i'm|im|my|me|mine|i've|i'd|soy|estoy|tengo|vivo|trabajo|estudio|mi|mis|me llamo|me gusta|me encanta|prefiero|llámame|llamame)\b/i;

const SENSITIVE = /(password|contrase|clave|address|direcci|phone|tel[eé]fono|email|correo|@|document|c[eé]dula|bank account|cuenta bancaria|tarjeta|credit card|salud|health|disease|enfermedad|religi|politic|sexual)/i;

function normalizeKey(key) {
  return String(key || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/favourite/g, 'favorite')
    .replace(/^(name|first_name|nombre)$/, 'preferred_name')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function parseJson(raw) {
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

async function askJson(system, user, tag) {
  const res = await jsonLlm.invoke(
    [new SystemMessage(system), new HumanMessage(user)],
    { tags: ['vlingo', 'memory', tag] },
  );
  return parseJson(res.content);
}

export function getUserFacts(userId) {
  return getDB()
    .prepare('SELECT key, value FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(userId, MAX_FACTS);
}

export function getFrequentErrors(userId, limit = MAX_ERRORS_SHOWN) {
  return getDB().prepare(`
    SELECT e.category, e.wrong, e.correct, t.total AS count
    FROM user_errors e
    JOIN (
      SELECT category, SUM(count) AS total, MAX(last_seen) AS last
      FROM user_errors WHERE user_id = ? GROUP BY category
    ) t ON t.category = e.category AND t.last = e.last_seen
    WHERE e.user_id = ?
    GROUP BY e.category
    ORDER BY t.total DESC, t.last DESC
    LIMIT ?
  `).all(userId, userId, limit);
}

export function getSessionContext(sessionId) {
  const db = getDB();
  const session = db.prepare('SELECT summary, summarized_until FROM sessions WHERE id = ?').get(sessionId);
  const recent = db.prepare(`
    SELECT role, content FROM (
      SELECT id, role, content FROM messages
      WHERE session_id = ? AND id > ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `).all(sessionId, session?.summarized_until || 0, COMPACT_TRIGGER + 2);

  return { summary: session?.summary || '', recent };
}

const queues = new Map();

function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev
    .then(task)
    .catch(err => console.error('[memory]', err.message))
    .finally(() => { if (queues.get(key) === next) queues.delete(key); });
  queues.set(key, next);
  return next;
}

export function scheduleMemoryUpdate({ userId, sessionId, message, teacher }) {
  return enqueue(userId, async () => {
    await extractFacts(userId, message);
    if (!teacher) await trackErrors(userId, message);
    await compactSession(sessionId);
  });
}

export function scheduleErrorTracking({ userId, text }) {
  return enqueue(userId, () => trackErrors(userId, text));
}

const FACTS_SYSTEM = `Extract personal facts that the user states about THEMSELVES in the message.
Return JSON: {"facts": {"key": "value"}}
Keys in snake_case English, for example: preferred_name, age, city, country, job, studies, hobbies, favorite_color, favorite_number, favorite_food, favorite_sport, favorite_music, pets, family, english_goal.
Values short, in English. Only facts that are explicitly stated. Never include passwords, addresses, phone numbers, emails, documents, money, health, religion or politics.

Examples:
"Hi, I'm Juan and I live in Bogota." -> {"facts": {"preferred_name": "Juan", "city": "Bogota"}}
"Me gusta el fútbol y tengo dos gatos." -> {"facts": {"hobbies": "football", "pets": "two cats"}}
"I want to learn English for my job, I am a nurse." -> {"facts": {"english_goal": "for work", "job": "nurse"}}
"What does awkward mean?" -> {"facts": {}}`;

async function extractFacts(userId, message) {
  const text = (message || '').trim();
  if (words(text).length < 3 || !SELF_REFERENCE.test(text)) return;

  const data = await askJson(FACTS_SYSTEM, `Message: "${text.slice(0, 600)}"`, 'facts');
  const facts = data?.facts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return;

  const db = getDB();
  const upsert = db.prepare(`
    INSERT INTO user_memory (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const lowerText = text.toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(facts)) {
    const key = normalizeKey(rawKey);
    const value = (Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '')).trim();
    if (!key || !value || SENSITIVE.test(key) || SENSITIVE.test(value)) continue;
    if (/^(none|null|unknown|n\/a|-|true|false)$/i.test(value)) continue;
    // Nombres y números deben aparecer literalmente en el mensaje (evita inventos).
    if ((key === 'preferred_name' || /^\d+$/.test(value)) && !lowerText.includes(value.toLowerCase())) continue;
    upsert.run(userId, key, value.slice(0, MAX_FACT_LEN));
  }

  db.prepare(`
    DELETE FROM user_memory WHERE user_id = ? AND key NOT IN (
      SELECT key FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
    )
  `).run(userId, userId, MAX_FACTS);
}

const CORRECT_SYSTEM = `You are an English teacher. Fix ONLY the real mistakes in the student's text: grammar, verb forms, articles, prepositions, wrong or misspelled words.
Change as few words as possible. Do not improve style, do not add information, do not change correct parts. Ignore punctuation and capital letters.
Return JSON: {"corrected": "..."}

Examples:
"She like pizza." -> {"corrected": "She likes pizza."}
"Yesterday I go to the park and buyed a ice cream." -> {"corrected": "Yesterday I went to the park and bought an ice cream."}
"Do you can help me?" -> {"corrected": "Can you help me?"}
"I work in a bank." -> {"corrected": "I work in a bank."}`;

const CLASSIFY_SYSTEM = `A Spanish-speaking student wrote a sentence and a teacher changed some words.
Decide if the student's original words were a REAL mistake (incorrect English) or only a style choice (the original was also correct English).
Return JSON: {"real_mistake": true or false, "category": "..."}
category is one of: ${ERROR_CATEGORIES.join(', ')}, none.

Examples:
Sentence: "She like pizza." Change: "like" -> "likes" => {"real_mistake": true, "category": "subject-verb agreement"}
Sentence: "Yesterday I go to the park." Change: "go" -> "went" => {"real_mistake": true, "category": "verb tense"}
Sentence: "I buyed a phone." Change: "buyed" -> "bought" => {"real_mistake": true, "category": "irregular verbs"}
Sentence: "I want learn English." Change: "want learn" -> "want to learn" => {"real_mistake": true, "category": "verb form"}
Sentence: "I have a orange." Change: "a orange" -> "an orange" => {"real_mistake": true, "category": "articles"}
Sentence: "How much it costs?" Change: "it costs" -> "does it cost" => {"real_mistake": true, "category": "auxiliary verbs"}
Sentence: "I am agree." Change: "am agree" -> "agree" => {"real_mistake": true, "category": "verb to be"}
Sentence: "I would like a juice." Change: "a juice" -> "a glass of juice" => {"real_mistake": false, "category": "none"}
Sentence: "I work in a bank." Change: "in" -> "at" => {"real_mistake": false, "category": "none"}
Sentence: "Help me with the homework." Change: "the homework" -> "my homework" => {"real_mistake": false, "category": "none"}
Sentence: "I work in a bank, I am a cashier." Change: "bank" -> "bank and" => {"real_mistake": false, "category": "none"}`;

function diffWords(original, corrected) {
  const a = original.split(' ');
  const b = corrected.split(' ');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const spans = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; continue; }
    const si = i;
    const sj = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) i++;
      else j++;
    }
    let wrong = a.slice(si, i);
    let correct = b.slice(sj, j);
    if (!wrong.length || !correct.length) {
      if (si > 0) {
        wrong = [a[si - 1], ...wrong];
        correct = [b[sj - 1], ...correct];
      } else if (i < n) {
        wrong = [...wrong, a[i]];
        correct = [...correct, b[j]];
      }
    }
    spans.push({ wrong: wrong.join(' '), correct: correct.join(' ') });
  }
  return spans;
}

async function trackErrors(userId, message) {
  const text = (message || '').trim();
  if (!isMostlyEnglish(text)) return;

  const data = await askJson(CORRECT_SYSTEM, `Text: "${text.slice(0, 600)}"`, 'correct');
  if (typeof data?.corrected !== 'string') return;

  const original  = normalizeSentence(text);
  const corrected = normalizeSentence(data.corrected);
  if (!corrected || corrected === original) return;

  const allSpans = diffWords(original, corrected);
  if (allSpans.length > 4) return;

  const spans = allSpans
    .filter(s => s.wrong && s.correct && s.wrong !== s.correct)
    .filter(s => s.wrong.split(' ').length <= MAX_ERROR_WORDS && s.correct.split(' ').length <= MAX_ERROR_WORDS)
    .filter(s => !/^(and|but|so|then)$/.test(s.correct.replace(s.wrong, '').trim()))
    .slice(0, 3);
  if (!spans.length) return;

  const upsert = getDB().prepare(`
    INSERT INTO user_errors (user_id, category, wrong, correct) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, category, wrong) DO UPDATE SET
      correct = excluded.correct, count = count + 1, last_seen = datetime('now')
  `);

  for (const span of spans) {
    const verdict = await askJson(
      CLASSIFY_SYSTEM,
      `Sentence: "${text.slice(0, 300)}" Change: "${span.wrong}" -> "${span.correct}" =>`,
      'classify',
    );
    const category = String(verdict?.category || '').toLowerCase().trim();
    if (verdict?.real_mistake !== true || !ERROR_CATEGORIES.includes(category)) continue;
    upsert.run(userId, category, span.wrong.slice(0, 60), span.correct.slice(0, 60));
  }
}

const SUMMARY_SYSTEM = `You write short notes about a chat between an English tutor and a student, so the tutor can continue it later.
Merge the previous notes with the new messages into ONE updated set of notes.
- English, third person ("The student...", "The tutor..."), plain text, at most 100 words.
- Keep: topics practiced, questions the student asked, corrections or explanations given, any roleplay in progress (situation and roles), and anything pending.
- Do not copy messages word for word. Leave out greetings. Do not invent anything.

Example notes: "The student talked about a trip to the cinema with her sister and practiced the past simple (go -> went, eat -> ate). She asked how to use the past simple; the tutor explained it with examples. They started a restaurant roleplay: the tutor is the waiter and the student ordered pizza."
Output only the notes.`;

async function compactSession(sessionId) {
  const db = getDB();
  const session = db.prepare('SELECT summary, summarized_until FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return;

  const pending = db.prepare(
    'SELECT id, role, content FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC',
  ).all(sessionId, session.summarized_until);
  if (pending.length <= COMPACT_TRIGGER) return;

  const toSummarize = pending.slice(0, pending.length - KEEP_RECENT);
  const transcript = toSummarize
    .map(m => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content.slice(0, 500)}`)
    .join('\n');

  const res = await summaryLlm.invoke(
    [
      new SystemMessage(SUMMARY_SYSTEM),
      new HumanMessage(`Previous notes: ${session.summary || 'none'}\n\nNew messages:\n${transcript}\n\nUpdated notes:`),
    ],
    { tags: ['vlingo', 'memory', 'summary'] },
  );
  const summary = String(res.content || '').trim().slice(0, MAX_SUMMARY_LEN);
  if (!summary) return;

  db.prepare('UPDATE sessions SET summary = ?, summarized_until = ? WHERE id = ?')
    .run(summary, toSummarize[toSummarize.length - 1].id, sessionId);
  console.log(`[memory] sesión ${sessionId.slice(0, 8)} compactada: ${toSummarize.length} mensajes resumidos`);
}

export function buildMemoryBlock({ userId, summary, teacher }) {
  const parts = [];

  const facts = userId ? getUserFacts(userId) : [];
  if (facts.length) {
    parts.push(
      'BACKGROUND: WHAT YOU KNOW ABOUT THE USER (from past chats). Mention it only when it fits naturally. If asked about something not listed here, say you do not know it yet; never guess:\n' +
      facts.map(f => `- ${f.key.replace(/_/g, ' ')}: ${f.value}`).join('\n'),
    );
  }

  const errors = userId && !teacher ? getFrequentErrors(userId) : [];
  if (errors.length) {
    parts.push(
      'BACKGROUND: ERRORS THIS STUDENT MADE BEFORE. If they make one of them again, that is the one error to correct. Do not mention this list:\n' +
      errors.map(e => `- ${e.category}: "${e.wrong}" -> "${e.correct}" (${e.count}x)`).join('\n'),
    );
  }

  if (summary) {
    parts.push(`BACKGROUND: NOTES ABOUT THE EARLIER PART OF THIS CONVERSATION:\n${summary}`);
  }

  return parts.length ? `\n${parts.join('\n\n')}\n` : '';
}
