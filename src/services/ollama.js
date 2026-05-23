import { ChatOllama } from '@langchain/ollama';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const MODEL  = process.env.OLLAMA_MODEL          || 'llama3.2:3b';
const TEMP   = parseFloat(process.env.MODEL_TEMPERATURE) || 0.7;
const TOKENS = parseInt(process.env.MODEL_MAX_TOKENS)    || 700;

// LangSmith: LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT en .env

// ─── Modelo ───────────────────────────────────────────────────────────────────
const llm = new ChatOllama({
  baseUrl:     process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model:       MODEL,
  temperature: TEMP,
  numPredict:  TOKENS,
  numGpu:      99,
  numThread:   4,
  numCtx:      1024,
  numBatch:    512,
  lowVram:     false,
});

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
    ['system', `You are an English teacher. Evaluate the student's writing and reply ONLY with valid JSON, no extra text.
JSON format:
{{
  "score": <0-100>,
  "grammar_errors": ["error description"],
  "corrections": ["corrected sentence"],
  "positive": "what they did well (in English)",
  "tip": "one improvement tip in Spanish"
}}`],
    ['human', `Level: {level}\nExercise context: {exerciseContext}\nStudent wrote: "{studentText}"`],
  ]);

  const evalChain = evalPrompt.pipe(llm).pipe(new StringOutputParser());

  const raw = await evalChain.invoke(
    { level, exerciseContext, studentText },
    { tags: ['vlingo', 'evaluate'] }
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      score:          70,
      grammar_errors: [],
      corrections:    [],
      positive:       'Good effort!',
      tip:            'Continua practicando.',
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