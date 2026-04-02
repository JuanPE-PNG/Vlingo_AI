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

// LangSmith se activa automáticamente con:
// LANGCHAIN_TRACING_V2=true, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT en .env

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
const SYSTEM = `You are VLINGO, a friendly English teacher for Spanish speakers.

MAIN BEHAVIOR:
You are an English teacher who normally speaks Spanish to explain things,
but always writes corrections in English.

LANGUAGE RULES — follow exactly:

1. Default behavior:
   - You speak in Spanish.
   - Corrections are ALWAYS written in English.

2. If the student writes ONLY in English:
   - You respond ONLY in English.
   - You correct in English.
   - Do not switch to Spanish.

3. If the student writes in Spanish or mixed Spanish:
   - You respond in Spanish.
   - Corrections must be written in English.

4. If the student asks for help to say something in English (examples: 
   "how do I say...", "ayúdame a decir...", "como digo...", "help me say..."):
   - This is NOT a correction.
   - Only the requested phrase should be written in English.
   - The rest of the explanation must follow the language rules above.
   - Treat it as teaching, not correcting.

TEACHING STYLE:
- You are a patient teacher.
- You correct mistakes gently.
- Keep explanations short.
- Encourage the student to try again.
- Do not write long paragraphs.
- Be friendly and supportive.

CORRECTION FORMAT:
Only when the student makes a mistake, use this structure:
"Buen intento. En inglés diríamos: '[correct sentence]'. [Short reason]."

If you are speaking fully in English:
"Good try. We'd say: '[correct sentence]'. [Short reason]."

TRANSLATION / HELP REQUESTS:
When the student asks how to say something:
1. Brief introduction.
2. Break sentence into parts.
3. Show full sentence in English.
4. Ask student to try another sentence.

Example:
Student: "ayúdame a decir quiero comprar comida"
You:
"Vamos a construir la frase.
'I' = yo
'want' = quiero
'to buy' = comprar
'food' = comida
La frase completa es: 'I want to buy food'.
Ahora intenta decir: Quiero comprar agua."

STUDENT INFO:
Name: {userName}
Level: {level}

LEVELS:
A1/A2:
- Simple vocabulary
- Present tense
- Short sentences

B1/B2:
- More vocabulary
- Past and future
- Opinions and explanations

Always use English slightly above the student's level (i+1).

RESPONSE LENGTH:
- Normal chat: 2–4 sentences
- Explanations: max 8 sentences
- Never write long walls of text

SCOPE:
You are only an English tutor.
If the student asks something unrelated, redirect the conversation to English practice.

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

// ─── Sliding Window Memory ────────────────────────────────────────────────────
//
// SQLite es la fuente de verdad. En cada llamada, reconstruimos la memoria
// de LangChain desde el historial que viene de SQLite, aplicando la ventana
// deslizante de WINDOW_SIZE mensajes.
//
// Flujo:
//   SQLite [msg1..msgN] → tomar últimos WINDOW_SIZE-1 → cargar en RAM
//   → LangChain invoca con el mensaje actual → agrega respuesta a RAM
//
// Cuando llega el mensaje 11 con ventana 10:
//   SQLite tiene [1..10], se cargan [2..10] en RAM (9 mensajes),
//   LangChain agrega el 11 durante el invoke → RAM queda [2..11] (10 mensajes)
//   En la siguiente llamada SQLite ya tiene [1..11], se cargan [3..11] → etc.

const WINDOW_SIZE = parseInt(process.env.CONTEXT_WINDOW) || 10;

// Registro global: sessionId → InMemoryChatMessageHistory
const sessionStores = new Map();

/**
 * Reconstruye la memoria de una sesión desde el historial de SQLite.
 * Se llama en CADA petición — SQLite siempre manda, la RAM es descartable.
 *
 * @param {string} sessionId
 * @param {Array}  dbHistory  - mensajes de SQLite [{role, content}]
 *                              NO incluye el mensaje actual (ya lo maneja LangChain)
 */
async function syncMemoryFromDB(sessionId, dbHistory) {
  // Crear siempre una instancia limpia — SQLite es la fuente de verdad
  const history = new InMemoryChatMessageHistory();

  // Aplicar ventana: tomar los últimos (WINDOW_SIZE - 1) del historial previo
  // El -1 es porque LangChain agregará el mensaje actual durante el invoke,
  // completando la ventana de WINDOW_SIZE mensajes totales en contexto.
  const windowed = dbHistory.slice(-(WINDOW_SIZE - 1));

  for (const m of windowed) {
    if (m.role === 'user') {
      await history.addMessage(new HumanMessage(m.content));
    } else if (m.role === 'assistant') {
      await history.addMessage(new AIMessage(m.content));
    }
  }

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

// ─── generateResponse ─────────────────────────────────────────────────────────
/**
 * @param {string} currentMessage  - el mensaje actual del usuario (solo texto)
 * @param {Array}  dbHistory       - historial PREVIO de SQLite [{role,content}]
 *                                   SIN incluir el mensaje actual
 * @param {Object} options         - { level, context, userName, sessionId }
 */
export async function generateResponse(currentMessage, dbHistory, options = {}) {
  const {
    level     = 'A1',
    context   = '',
    userName  = 'Student',
    sessionId = 'default',
  } = options;

  // Sincronizar RAM con SQLite antes de cada llamada
  await syncMemoryFromDB(sessionId, dbHistory);

  const contextBlock = context ? `RELEVANT LEARNING MATERIAL:\n${context}` : '';

  const response = await chainWithMemory.invoke(
    {
      input:    currentMessage,
      userName,
      level,
      context:  contextBlock,
    },
    {
      configurable: { sessionId },
      metadata:     { userName, level, sessionId },
      tags:         ['vlingo', 'chat', level],
    }
  );

  return response;
}

// ─── generateResponseStream ───────────────────────────────────────────────────
/**
 * @param {string}   currentMessage
 * @param {Array}    dbHistory       - historial PREVIO sin el mensaje actual
 * @param {Object}   options
 * @param {Function} onChunk
 */
export async function generateResponseStream(currentMessage, dbHistory, options = {}, onChunk) {
  const {
    level     = 'A1',
    context   = '',
    userName  = 'Student',
    sessionId = 'default',
  } = options;

  await syncMemoryFromDB(sessionId, dbHistory);

  const contextBlock = context ? `RELEVANT LEARNING MATERIAL:\n${context}` : '';

  const stream = await chainWithMemory.stream(
    {
      input:    currentMessage,
      userName,
      level,
      context:  contextBlock,
    },
    {
      configurable: { sessionId },
      metadata:     { userName, level, sessionId },
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

// ─── evaluateText ─────────────────────────────────────────────────────────────
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

// ─── Utilidades ───────────────────────────────────────────────────────────────

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