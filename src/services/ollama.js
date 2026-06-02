import { ChatOllama } from '@langchain/ollama';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const MODEL  = process.env.OLLAMA_MODEL;
const TEMP   = parseFloat(process.env.MODEL_TEMPERATURE) || 0.4;
const TOKENS = parseInt(process.env.MODEL_MAX_TOKENS)    || 700;
const NUMCTX = parseInt(process.env.OLLAMA_NUM_CTX)      || 4096;

// ─── Modelo ───────────────────────────────────────────────────────────────────
const llmOptions = {
  baseUrl:     process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model:       MODEL,
  temperature: TEMP,
  numPredict:  TOKENS,
};
if (process.env.OLLAMA_NUM_CTX) {
  llmOptions.numCtx = NUMCTX;
}
const llm = new ChatOllama(llmOptions);

// MCER + Krashen
const LEVEL_PROFILES = {
  A1: {
    description: 'Complete beginner (Principiante)',
    vocabulary: 'Use only basic everyday words: greetings, numbers, colors, family, simple objects. Prefer 1–3 syllable words.',
    grammar: 'Present simple only. Very short sentences (5–7 words). Structure: Subject + Verb + Object.',
    iplus1: 'Introduce ONE new A2 word or expression per turn. Make its meaning clear from context or a brief example.',
    support: 'You may add a Spanish translation in parentheses for key new words — e.g., "dog (perro)". Keep this minimal.',
  },
  A2: {
    description: 'Elementary (Elemental)',
    vocabulary: 'Common everyday vocabulary on familiar topics: home, school, shopping, travel. Avoid complex idioms or phrasal verbs.',
    grammar: 'Present simple/continuous, simple past (regular verbs), "going to" future. Connectors: and, but, because, so.',
    iplus1: 'Introduce ONE new B1 element per turn: a modal verb (should, might), a simple phrasal verb, or present perfect — used naturally.',
    support: 'Use Spanish only to clarify genuinely abstract concepts. Prefer English explanations first.',
  },
  B1: {
    description: 'Intermediate (Intermedio)',
    vocabulary: 'Wide everyday vocabulary. Common idioms and phrasal verbs are appropriate. Both concrete and abstract topics.',
    grammar: 'Past/present perfect, conditionals (1st and 2nd), modal verbs, passive voice introduction.',
    iplus1: 'Introduce ONE B2 structure per turn: complex conditionals, reported speech, or passive constructions — woven naturally into your reply.',
    support: 'Respond only in English. Do not use Spanish at all.',
  },
  B2: {
    description: 'Upper-intermediate (Intermedio alto)',
    vocabulary: 'Academic and professional vocabulary, collocations, idiomatic expressions, nuanced synonyms.',
    grammar: 'Full tense range, complex conditionals, discourse markers, emphasis structures (cleft sentences, inversion).',
    iplus1: 'Expose the student to C1 features each turn: sophisticated vocabulary, complex syntax, or register awareness (formal vs. informal).',
    support: 'English only.',
  },
  C1: {
    description: 'Advanced (Avanzado)',
    vocabulary: 'Sophisticated, domain-specific vocabulary. Nuanced connotations and register distinctions.',
    grammar: 'Full grammar mastery. Focus on precision, style, and contextually appropriate register.',
    iplus1: 'Push toward C2 fluency: subtle vocabulary distinctions, advanced rhetoric, idiomatic depth, stylistic variation.',
    support: 'English only.',
  },
  C2: {
    description: 'Mastery (Maestría)',
    vocabulary: 'Native-level vocabulary including literary, technical, and cultural references.',
    grammar: 'Complete mastery. Focus on elegance, nuance, and stylistic sophistication.',
    iplus1: 'Engage at near-native level. Challenge with cultural nuance, sophisticated ideas, and subtle pragmatic distinctions.',
    support: 'English only.',
  },
};

function getLevelGuidance(level) {
  const p = LEVEL_PROFILES[level] || LEVEL_PROFILES.A1;
  return [
    `CEFR Level: ${level} — ${p.description}`,
    `Vocabulary target: ${p.vocabulary}`,
    `Grammar target: ${p.grammar}`,
    `i+1 goal (apply every turn): ${p.iplus1}`,
    `Language support rule: ${p.support}`,
  ].join('\n');
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `You are VLINGO, a friendly and encouraging English tutor for Spanish-speaking learners.

STUDENT PROFILE:
- Name: {userName}
- {levelGuidance}

TEACHING METHODOLOGY — COMPREHENSIBLE INPUT (Krashen i+1):
Always pitch your language just one step above the student's current CEFR level. Every response must be understandable with slight effort, introduce one new linguistic element naturally, and feel like genuine conversation — not a grammar lesson.

RESPONSE RULES:
1. Write primarily in English, calibrated to the student's level described above.
2. Correct errors indirectly: acknowledge their message positively first, then model the correct form — e.g., "Great! You could also say: '...'". Never say "You made an error."
3. Keep responses focused (4–8 sentences, expand to more when the student asks for an explanation or course content). End every turn with exactly ONE simple follow-up question to sustain conversation.
4. Address at most ONE grammar or vocabulary point per turn. Do not pile on corrections.
5. If the student writes in Spanish, acknowledge it warmly, then redirect: help them phrase it in English — e.g., "Try saying: '...'".
6. Do not engage in roleplay, off-topic discussions, or any inappropriate content.
7. CRITICAL — When a ">>> PRIMARY SOURCE" block is present in the context below, that is the SPECIFIC COURSE the student is asking about. Your reply MUST be grounded ONLY in the content between "=== START OF COURSE ===" and "=== END OF COURSE ===". Quote the actual section and lesson titles. Summarize and explain what the course literally contains. NEVER invent topics, sections, examples, or grammar points that are NOT explicitly written in that block. If the course block contains only a title/description or one short lesson title with little detail, acknowledge honestly that the course does not have much content yet, and base your explanation on the few elements that ARE there (e.g., its title, level, and the one lesson present). Do not pretend the course has more than it does.

{context}`;

const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM],
  new MessagesPlaceholder('history'),
  ['human', '{input}'],
]);

const chain = prompt.pipe(llm).pipe(new StringOutputParser());
const WINDOW_SIZE = parseInt(process.env.CONTEXT_WINDOW) || 10;

// Un store por sessionId — se reconstruye desde SQLite en cada request
const sessionStores = new Map();

async function buildHistory(sessionId, dbHistory) {
  const history = new InMemoryChatMessageHistory();

  for (const m of dbHistory) {
    if (m.role === 'user') {
      await history.addMessage(new HumanMessage(m.content));
    } else if (m.role === 'assistant') {
      await history.addMessage(new AIMessage(m.content));
    }
  }

  // Registrar en el map para que chainWithMemory lo encuentre por sessionId
  sessionStores.set(sessionId, history);
  return history;
}

function getSessionHistory(sessionId) {
  if (!sessionStores.has(sessionId)) {
    sessionStores.set(sessionId, new InMemoryChatMessageHistory());
  }
  return sessionStores.get(sessionId);
}

const chainWithMemory = new RunnableWithMessageHistory({
  runnable:           chain,
  getMessageHistory:  getSessionHistory,
  inputMessagesKey:   'input',
  historyMessagesKey: 'history',
});

export async function verifyOllama() {
  try {
    await llm.invoke([new HumanMessage('hi')]);
    return true;
  } catch (err) {
    console.error('Ollama no responde:', err.message);
    return false;
  }
}

/**
 * @param {string} currentMessage  - texto del mensaje actual del usuario
 * @param {Array}  dbHistory       - historial PREVIO de SQLite ya recortado a WINDOW_SIZE-1
 *                                   formato: [{role: 'user'|'assistant', content: string}]
 * @param {Object} options         - { level, context, userName, sessionId }
 */

export async function generateResponse(currentMessage, dbHistory, options = {}) {
  const {
    level     = 'A1',
    context   = '',
    userName  = 'Student',
    sessionId = 'default',
  } = options;

  await buildHistory(sessionId, dbHistory);

  const response = await chainWithMemory.invoke(
    {
      input:         currentMessage,
      userName,
      level,
      levelGuidance: getLevelGuidance(level),
      context:       context ? `RELEVANT LEARNING MATERIAL:\n---\n${context}\n---` : '',
    },
    {
      configurable: { sessionId },
      metadata:     { userName, level, sessionId, historySize: dbHistory.length },
      tags:         ['vlingo', 'chat', level],
    }
  );

  return response;
}

export async function generateResponseStream(currentMessage, dbHistory, options = {}, onChunk) {
  const {
    level     = 'A1',
    context   = '',
    userName  = 'Student',
    sessionId = 'default',
  } = options;

  await buildHistory(sessionId, dbHistory);

  const stream = await chainWithMemory.stream(
    {
      input:         currentMessage,
      userName,
      level,
      levelGuidance: getLevelGuidance(level),
      context:       context ? `RELEVANT LEARNING MATERIAL:\n---\n${context}\n---` : '',
    },
    {
      configurable: { sessionId },
      metadata:     { userName, level, sessionId, historySize: dbHistory.length },
      tags:         ['vlingo', 'stream', level],
    }
  );

  let fullResponse = '';
  for await (const chunk of stream) {
    fullResponse += chunk;
    if (onChunk) onChunk(chunk);
  }

  return fullResponse;
}

export async function evaluateText(studentText, exerciseContext, level = 'B1') {
  const evalPrompt = ChatPromptTemplate.fromMessages([
    ['system', `You are a strict but fair English grammar evaluator for a Spanish-speaking student at CEFR level {level}.

YOUR ONLY OUTPUT MUST BE A SINGLE VALID JSON OBJECT — no prose, no markdown, no code fences.

JSON SHAPE (all fields required):
{{
  "score": <integer 0-100>,
  "grammar_errors": [<string in English, one short error description per real mistake>],
  "corrections": [<string: the FULL sentence rewritten correctly; if input had no errors, copy the input verbatim>],
  "positive": <string in English, one short sentence praising something specific>,
  "tip": <string in Spanish, one short actionable tip; if the sentence is perfect, give a tip about how to vary or enrich it>
}}

SCORING RULES (apply strictly):
- 95–100: Sentence is grammatically perfect AND appropriate for level {level}. grammar_errors MUST be []. corrections MUST be the input copied verbatim.
- 80–94: Minor issues only (one missing article, one capitalization or punctuation slip). Meaning is fully clear.
- 60–79: One or two clear grammar errors (wrong tense, wrong verb form, wrong preposition) but meaning is recoverable.
- 40–59: Multiple errors that interfere with meaning.
- 0–39: Mostly ungrammatical or unintelligible.

HARD CONSTRAINTS:
1. NEVER invent errors. If the sentence is correct English, score it ≥ 95 and leave grammar_errors empty.
2. NEVER flag stylistic choices, regional variants (US vs UK), informal contractions, or word-order alternatives as errors.
3. Adapt severity to the student's CEFR level {level}: do NOT punish an A1 student for not using advanced structures; do NOT reward a B2 student for trivially simple correct sentences (cap at ~90 if the sentence is far below their level).
4. corrections[0] MUST be a single full sentence — never a list of fragments. It must preserve the student's intended meaning.
5. The "tip" field MUST be written in Spanish.
6. Output ONLY the JSON object. No preamble, no explanation, no trailing text.

EXAMPLES:

Input: "She go to school every day."
Output: {{"score": 70, "grammar_errors": ["Subject-verb agreement: 'She' requires 'goes' in present simple."], "corrections": ["She goes to school every day."], "positive": "Good use of the time expression 'every day'.", "tip": "Recuerda que en presente simple los verbos con he/she/it terminan en -s."}}

Input: "I have lived in Madrid for five years."
Output: {{"score": 98, "grammar_errors": [], "corrections": ["I have lived in Madrid for five years."], "positive": "Excellent use of the present perfect with 'for' to express duration.", "tip": "Para variar, prueba con 'I've been living in Madrid for five years' (presente perfecto continuo)."}}

Input: "Yesterday I go store and buy milk."
Output: {{"score": 45, "grammar_errors": ["'go' should be 'went' (past simple).", "Missing article 'the' before 'store'.", "Coordination: should use 'and bought' to keep past tense."], "corrections": ["Yesterday I went to the store and bought milk."], "positive": "Good attempt at telling a past event with two actions.", "tip": "Cuando hablas de algo que ya pasó usa el pasado simple en todos los verbos de la oración."}}`],
    ['human', `Exercise context: {exerciseContext}\nStudent wrote: "{studentText}"\n\nReturn ONLY the JSON object.`],
  ]);

  const evalChain = evalPrompt.pipe(llm).pipe(new StringOutputParser());

  const raw = await evalChain.invoke(
    { level, exerciseContext, studentText },
    { tags: ['vlingo', 'evaluate', level] }
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      Array.isArray(parsed.grammar_errors) &&
      parsed.grammar_errors.length === 0 &&
      typeof parsed.score === 'number' &&
      parsed.score < 90
    ) {
      parsed.score = 95;
    }
    return parsed;
  } catch {
    return {
      score:          70,
      grammar_errors: [],
      corrections:    [studentText],
      positive:       'Good effort!',
      tip:            'Sigue practicando.',
    };
  }
}

export function clearSessionMemory(sessionId) {
  sessionStores.delete(sessionId);
}

export async function getSessionStats(sessionId) {
  const history  = getSessionHistory(sessionId);
  const messages = await history.getMessages();
  return {
    sessionId,
    messageCount: messages.length,
    windowSize:   WINDOW_SIZE,
    messages:     messages.map(m => ({
      role:    m._getType(),
      preview: m.content.slice(0, 80) + (m.content.length > 80 ? '...' : ''),
    })),
  };
}

export function activeSessionCount() {
  return sessionStores.size;
}

export { MODEL };