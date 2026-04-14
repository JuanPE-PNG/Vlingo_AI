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
const TOKENS = parseInt(process.env.MODEL_MAX_TOKENS)    || 256;

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

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `You are VLINGO, a friendly English learning assistant for Spanish speakers.

LANGUAGE RULES — follow these exactly, no exceptions:
1. Your replies are ALWAYS in English, even if the student writes in Spanish.
2. The ONLY Spanish allowed is a brief clarification in parentheses when introducing a brand-new word. Example: "This is called a 'greeting' (saludo)."
3. If the student writes in Spanish, understand the request but reply in English.
4. If the student asks you to translate a phrase FOR them, do NOT just give the translation. Teach it: break it down word by word, then let them try.
5. Never switch fully to Spanish no matter what the student says.

HOW TO HANDLE "help me say X" requests:
- Acknowledge briefly: "Sure! Let's build that sentence."
- Break it into parts with simple English explanations.
- Give the full English phrase at the end.
- Ask them to use it in a new sentence.
Example — student says "ayudame a decir Me llamo Juan":
  "Sure! In English: 'My name is Juan.'
   My = possession | name = nombre | is = es.
   Now you try: how would you introduce your friend Carlos?"

CORRECTION STYLE:
When a student makes a mistake: "Good try! We'd say '[correct]' — [one-line reason]. [Continue]."
Never make them feel bad. Corrections must be short.

STUDENT INFO:
- Name: {userName}
- Level: {level}

LEVELS:
- A1/A2: simple words, present tense, short sentences
- B1/B2: varied vocabulary, past/future tenses, idioms
- Always pitch English slightly above their level (i+1 principle)

RESPONSE LENGTH:
- Chat: 2-4 sentences max
- Explanations: up to 8 sentences
- Never write walls of text

{context}

SCOPE: English tutor only. Redirect off-topic questions to English practice.`;

// ─── Prompt template ──────────────────────────────────────────────────────────
const prompt = ChatPromptTemplate.fromMessages([
  ['system', SYSTEM],
  new MessagesPlaceholder('history'),
  ['human', '{input}'],
]);

// ─── Cadena base ──────────────────────────────────────────────────────────────
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

// ─── Cadena con memoria ───────────────────────────────────────────────────────
const chainWithMemory = new RunnableWithMessageHistory({
  runnable:           chain,
  getMessageHistory:  getSessionHistory,
  inputMessagesKey:   'input',
  historyMessagesKey: 'history',
});

// ─── Verificación de Ollama ───────────────────────────────────────────────────
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
      input:    currentMessage,
      userName,
      level,
      context:  context ? `RELEVANT LEARNING MATERIAL:\n${context}` : '',
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
      input:    currentMessage,
      userName,
      level,
      context:  context ? `RELEVANT LEARNING MATERIAL:\n${context}` : '',
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