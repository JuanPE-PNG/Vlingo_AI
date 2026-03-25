import { Ollama } from 'ollama';
 
const ollama = new Ollama({
  host: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
});
 
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const TEMPERATURE = parseFloat(process.env.MODEL_TEMPERATURE) || 0.7;
const MAX_TOKENS = parseInt(process.env.MODEL_MAX_TOKENS) || 512;
 
const BASE_SYSTEM_PROMPT = `You are VLINGO, a friendly English learning assistant for Spanish speakers.
 
LANGUAGE RULES — follow these exactly, no exceptions:
1. Your replies are ALWAYS in English, even if the student writes in Spanish.
2. The ONLY Spanish allowed is a brief clarification in parentheses when introducing a brand-new word the student has never seen. Example: "This is called a 'greeting' (saludo)."
3. If the student asks you something in Spanish (like "ayúdame a decir X"), understand their request but answer in English.
4. If the student asks you to translate a phrase FOR them, do NOT just give the translation. Instead, teach it: break it down word by word in English, then let them try.
5. Never switch fully to Spanish no matter what the student says.
 
HOW TO HANDLE "help me say X in English" requests:
- Acknowledge briefly in English: "Sure! Let's build that sentence."
- Break it into parts with simple English explanations.
- Give the full English phrase at the end.
- Ask them to repeat or use it in a new sentence.
Example — student says "ayúdame a decir Me llamo Juan":
  "Sure! 'Me llamo' means you are introducing your name.
   In English we say: 'My name is Juan.'
   → 'My' = possession, 'name' = nombre, 'is' = es.
   Now you try: how would you introduce your friend Carlos?"
 
CORRECTION STYLE:
When a student makes a grammar mistake, correct like this:
"Good try! We'd say '[correct form]' — [one-line reason]. [Continue conversation]."
Never make them feel bad. Keep corrections short.
 
LEVELS:
- A1/A2: very simple words, present tense only, short sentences
- B1/B2: varied vocabulary, past/future tenses, common idioms
- Always pitch your English slightly above the student's level (i+1 principle)
 
RESPONSE LENGTH:
- Chat / conversation: 2-4 sentences max
- Explanations: up to 8 sentences, structured clearly
- Never write long walls of text
 
SCOPE:
You are an English tutor only. If asked about unrelated topics, redirect politely to English practice.`;

/**
 * Verifica el modelo que se está usando está disponible en Ollama, especificado en el .env
 * @returns {boolean} true si el modelo está disponible, false en caso contrario
 */

export async function verifyOllama() {
  try {
    const models = await ollama.list();
    const available = models.models.map(m => m.name);
    const modelFound = available.some(name =>
      name.startsWith(MODEL.split(':')[0])
    );
 
    if (!modelFound) {
      console.warn(`⚠️  Modelo "${MODEL}" no encontrado.`);
      console.warn(`   Modelos disponibles: ${available.join(', ') || 'ninguno'}`);
      console.warn(`   Ejecuta: ollama pull ${MODEL}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Ollama no responde:', err.message);
    return false;
  }
}
 
/**
 * Genera una respuesta del asistente de forma completa, evitando el streaming.
 * @param {Array} messages - Historial de mensajes [{role, content}]
 * @param {Object} options - level, context (material pedagógico), userName
 * @returns {string} Respuesta del modelo
 */

export async function generateResponse(messages, options = {}) {
  const { level = 'A1', context = '', userName = 'estudiante' } = options;
 

  let systemPrompt = BASE_SYSTEM_PROMPT;
  systemPrompt += `\n\nSTUDENT INFO:\n- Name: ${userName}\n- Current level: ${level}`;
 
  if (context) {
    systemPrompt += `\n\nRELEVANT LEARNING MATERIAL (use this to guide your response):\n${context}`;
  }
 
  const response = await ollama.chat({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    options: {
      temperature: TEMPERATURE,
      num_predict: MAX_TOKENS,
      num_gpu: 99,        // Todas las capas en GPU
      num_thread: 4,      // Threads CPU
      num_ctx: 1024,      // Contexto
      num_batch: 512,     // Tamaño de batch para el prompt — acelera el "time to first token"
      low_vram: false,    // uso de la vram, false = usar toda la VRAM disponible sin restricciones
    },
  });
 
  return response.message.content;
}
 
/**
 * Genera respuesta con streaming (para UX más fluida en la app)
 * La app móvil puede mostrar el texto mientras se genera
 * @param {Array} messages
 * @param {Object} options
 * @param {Function} onChunk - callback(chunk: string) por cada fragmento
 */
export async function generateResponseStream(messages, options = {}, onChunk) {
  const { level = 'A1', context = '', userName = 'estudiante' } = options;
 
  let systemPrompt = BASE_SYSTEM_PROMPT;
  systemPrompt += `\n\nSTUDENT INFO:\n- Name: ${userName}\n- Current level: ${level}`;
 
  if (context) {
    systemPrompt += `\n\nRELEVANT LEARNING MATERIAL:\n${context}`;
  }
 
  const stream = await ollama.chat({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    stream: true,
    options: {
      temperature: TEMPERATURE,
      num_predict: MAX_TOKENS,
      num_gpu: 99,
      num_thread: 4,
      num_ctx: 1024,
      num_batch: 512,
      low_vram: false,
    },
  });
 
  let fullResponse = '';
  for await (const chunk of stream) {
    const text = chunk.message.content;
    fullResponse += text;
    if (onChunk) onChunk(text);
  }
 
  return fullResponse;
}
 
/**
 * Evalúa la pronunciación/gramática de una frase dada
 */
export async function evaluateText(studentText, expectedContext, level = 'B1') {
  const prompt = `You are an English teacher evaluating a student's writing.
Level: ${level}
 
The student wrote: "${studentText}"
Context/Exercise: ${expectedContext}
 
Evaluate briefly (JSON format only, no extra text):
{
  "score": <0-100>,
  "grammar_errors": ["error1", "error2"],
  "corrections": ["correction1"],
  "positive": "what they did well",
  "tip": "one actionable improvement tip in Spanish"
}`;
 
  const response = await ollama.chat({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.3, num_predict: 300 },
  });
 
  try {
    const jsonMatch = response.message.content.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      score: 70,
      grammar_errors: [],
      corrections: [],
      positive: 'Good effort!',
      tip: 'Continúa practicando.',
    };
  }
}
 
export { ollama, MODEL };