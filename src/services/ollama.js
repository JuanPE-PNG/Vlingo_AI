import { ChatOllama } from '@langchain/ollama';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import {
  STUDENT_SYSTEM, TEACHER_SYSTEM, buildSystemPrompt, detectMode, isTeacher,
} from './prompts.js';

const MODEL  = process.env.OLLAMA_MODEL;
const TEMP   = parseFloat(process.env.MODEL_TEMPERATURE) || 0.4;
const TOKENS = parseInt(process.env.MODEL_MAX_TOKENS)    || 600;
// 4096 cabe en GPUs de 4 GB con un modelo 3B cuantizado (~150 MB extra de KV cache).
const NUMCTX = parseInt(process.env.OLLAMA_NUM_CTX)      || 4096;

// Presupuesto en caracteres para historial + contexto + mensaje (~3.5 chars/token).
// 4096 tokens - salida (~600) - system prompt (~700) ≈ 2600 tokens ≈ 9000 chars.
const INPUT_CHAR_BUDGET   = parseInt(process.env.INPUT_CHAR_BUDGET) || 9000;
const MIN_HISTORY_CHARS   = 1500;
const MAX_HISTORY_MSG_LEN = 1200;

// ─── Modelos ──────────────────────────────────────────────────────────────────
const baseOptions = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  model:   MODEL,
  numCtx:  NUMCTX,
};

const llm = new ChatOllama({
  ...baseOptions,
  temperature: TEMP,
  numPredict:  TOKENS,
});

// Evaluador: determinista y forzado a JSON.
const evalLlm = new ChatOllama({
  ...baseOptions,
  temperature: 0.1,
  numPredict:  400,
  format:      'json',
});


const parser = new StringOutputParser();
const WINDOW_SIZE = parseInt(process.env.CONTEXT_WINDOW) || 10;

// Un store por sessionId — se reconstruye desde SQLite en cada request
const sessionStores = new Map();

function getSessionHistory(sessionId) {
  if (!sessionStores.has(sessionId)) {
    sessionStores.set(sessionId, new InMemoryChatMessageHistory());
  }
  return sessionStores.get(sessionId);
}

function withMemory(systemTemplate) {
  const promptTemplate = ChatPromptTemplate.fromMessages([
    ['system', systemTemplate],
    new MessagesPlaceholder('history'),
    ['human', '{input}'],
  ]);
  return new RunnableWithMessageHistory({
    runnable:           promptTemplate.pipe(llm).pipe(parser),
    getMessageHistory:  getSessionHistory,
    inputMessagesKey:   'input',
    historyMessagesKey: 'history',
  });
}

const chains = {
  [STUDENT_SYSTEM]: withMemory(STUDENT_SYSTEM),
  [TEACHER_SYSTEM]: withMemory(TEACHER_SYSTEM),
};

// Conserva los mensajes más recientes que quepan en el presupuesto de caracteres.
function fitHistory(dbHistory, budget) {
  const kept = [];
  let used = 0;
  for (let i = dbHistory.length - 1; i >= 0; i--) {
    const m = dbHistory[i];
    const content = m.content.length > MAX_HISTORY_MSG_LEN
      ? m.content.slice(0, MAX_HISTORY_MSG_LEN) + '...'
      : m.content;
    if (used + content.length > budget) break;
    used += content.length;
    kept.unshift({ role: m.role, content });
  }
  // El historial debe empezar con un mensaje del usuario.
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

async function buildHistory(sessionId, dbHistory) {
  const history = new InMemoryChatMessageHistory();
  for (const m of dbHistory) {
    if (m.role === 'user') {
      await history.addMessage(new HumanMessage(m.content));
    } else if (m.role === 'assistant') {
      await history.addMessage(new AIMessage(m.content));
    }
  }
  // Registrar en el map para que la cadena lo encuentre por sessionId
  sessionStores.set(sessionId, history);
  return history;
}

// El modelo 3B a veces ignora "plain text": se limpia el markdown que la app mostraría literal.
function toPlainText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\*\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function prepareTurn(currentMessage, dbHistory, options) {
  const {
    level     = 'A1',
    userRole,
    userName  = 'Student',
    sessionId = 'default',
    course    = '',
    reference = '',
  } = options;
  const mode = options.mode || detectMode(currentMessage, dbHistory, Boolean(course));

  const { teacher, template, variables } = buildSystemPrompt({
    level, userRole, userName, mode, course, reference,
  });

  const contextChars  = course.length + reference.length;
  const historyBudget = Math.max(
    MIN_HISTORY_CHARS,
    INPUT_CHAR_BUDGET - contextChars - currentMessage.length,
  );
  const history = fitHistory(dbHistory, historyBudget);
  await buildHistory(sessionId, history);

  return {
    mode,
    chain: chains[template],
    input: { ...variables, input: currentMessage },
    config: {
      configurable: { sessionId },
      metadata:     { userName, level, sessionId, mode, teacher, historySize: history.length },
      tags:         ['vlingo', teacher ? 'teacher' : 'student', level, mode],
    },
  };
}


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
 * @param {Object} options         - { level, userRole, userName, sessionId, mode, course, reference }
 * @returns {Promise<{text: string, mode: string}>}
 */
export async function generateResponse(currentMessage, dbHistory, options = {}) {
  const { mode, chain, input, config } = await prepareTurn(currentMessage, dbHistory, options);
  const raw = await chain.invoke(input, { ...config, tags: [...config.tags, 'chat'] });
  return { text: toPlainText(raw), mode };
}

export async function generateResponseStream(currentMessage, dbHistory, options = {}, onChunk) {
  const { mode, chain, input, config } = await prepareTurn(currentMessage, dbHistory, options);
  const stream = await chain.stream(input, { ...config, tags: [...config.tags, 'stream'] });

  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (onChunk) onChunk(chunk);
  }
  return { text: toPlainText(text), mode };
}


// ─── Evaluación de escritura ──────────────────────────────────────────────────
const EVAL_FEEDBACK_LANG = {
  A1: 'Spanish', A2: 'Spanish', B1: 'English', B2: 'English', C1: 'English', C2: 'English',
};

const EVAL_LEVEL_EXPECTATIONS = {
  A1: 'Short simple sentences in present simple are expected. Do not penalize missing advanced structures.',
  A2: 'Simple sentences with past simple, present continuous and basic connectors are expected.',
  B1: 'Connected sentences with perfect tenses, conditionals and modals are expected.',
  B2: 'Varied, accurate structures and good vocabulary are expected. Correct but very basic text scores 90-94.',
  C1: 'Precise, natural, well-structured text is expected. Correct but very basic text scores 90-94.',
  C2: 'Near-native accuracy and style are expected. Correct but very basic text scores 90-94.',
};

const EVAL_SYSTEM = `You are a fair English writing evaluator for a Spanish-speaking student at CEFR level {level}.
Level expectation: {expectation}

Work in this order and return ONE JSON object with these keys:
1. "corrections": array with ONE string: the student's full text rewritten correctly, keeping their meaning and changing as little as possible. If it is already correct, copy it exactly.
2. "grammar_errors": array of strings in {feedbackLang}. One short explanation for EACH change you made in step 1, and nothing else. Only mention words that really appear in the student's text. Empty array if you changed nothing.
3. "score": integer 0-100 using the scale below.
4. "positive": one short sentence in {feedbackLang} praising something specific in the text.
5. "tip": one short actionable tip in Spanish. If the text is perfect, suggest how to enrich it at the next level.

SCORING
- 90-100: no errors. grammar_errors must be empty.
- 80-89: only minor slips (one article, capitalization, punctuation or spelling). Meaning is clear.
- 60-79: one or two clear errors (tense, verb form, preposition, word order). Meaning is recoverable.
- 40-59: three or more errors, or errors that make meaning hard.
- 0-39: mostly ungrammatical or unintelligible.

RULES
- Never invent errors. Do not flag US/UK variants, contractions, informal style or valid alternative word order.
- The examples below show the FORMAT only. Never copy their content.
- Output only the JSON object.

EXAMPLE A (feedback in Spanish)
Student text: "My sister like cats."
{{"corrections": ["My sister likes cats."], "grammar_errors": ["like debe ser likes: con he/she/it el verbo lleva -s."], "score": 75, "positive": "Buena frase corta y clara sobre tu familia.", "tip": "Revisa la -s del verbo cuando hablas de una sola persona."}}

EXAMPLE B (feedback in English)
Student text: "I have lived here for five years."
{{"corrections": ["I have lived here for five years."], "grammar_errors": [], "score": 96, "positive": "Good use of the present perfect with for.", "tip": "Prueba el presente perfecto continuo: I have been living here for five years."}}`;

const evalPrompt = ChatPromptTemplate.fromMessages([
  ['system', EVAL_SYSTEM],
  ['human', 'Exercise context: {exerciseContext}\nStudent text: "{studentText}"'],
]);

const evalChain = evalPrompt.pipe(evalLlm).pipe(new StringOutputParser());

function normalizeEvaluation(parsed, studentText) {
  const toStrings = v => (Array.isArray(v) ? v : v ? [v] : [])
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());

  const grammar_errors = toStrings(parsed.grammar_errors);
  const corrections    = toStrings(parsed.corrections).slice(0, 1);
  let score = Math.round(Number(parsed.score));
  if (!Number.isFinite(score)) score = grammar_errors.length ? 70 : 95;
  score = Math.min(100, Math.max(0, score));

  // Coherencia entre puntaje y errores reportados.
  if (grammar_errors.length === 0) score = Math.max(score, 90);
  else score = Math.min(score, 89);

  return {
    score,
    grammar_errors,
    corrections: corrections.length ? corrections : [studentText],
    positive:    typeof parsed.positive === 'string' && parsed.positive.trim() ? parsed.positive.trim() : 'Good effort!',
    tip:         typeof parsed.tip === 'string' && parsed.tip.trim() ? parsed.tip.trim() : 'Sigue practicando.',
  };
}

export async function evaluateText(studentText, exerciseContext, level = 'B1', userRole) {
  // Profesores y administradores se evalúan con la rúbrica más exigente.
  const lvl = isTeacher(level, userRole) ? 'C2' : (EVAL_FEEDBACK_LANG[level] ? level : 'A1');

  const raw = await evalChain.invoke(
    {
      level:           lvl,
      expectation:     EVAL_LEVEL_EXPECTATIONS[lvl],
      feedbackLang:    EVAL_FEEDBACK_LANG[lvl],
      exerciseContext,
      studentText,
    },
    { tags: ['vlingo', 'evaluate', lvl] }
  );

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return normalizeEvaluation(JSON.parse(jsonMatch[0]), studentText);
  } catch {
    return {
      score:          70,
      grammar_errors: [],
      corrections:    [studentText],
      positive:       'Good effort!',
      tip:            'No pude analizar bien tu texto. Intenta enviarlo de nuevo.',
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
