import { Router } from 'express';
import { getDB } from '../services/database.js';
import { generateResponse } from '../services/ollama.js';

const router = Router();

/**
 * GET /api/lessons
 * Lista lecciones, opcionalmente filtradas por nivel y categoría
 */
router.get('/', (req, res) => {
  const db = getDB();
  const { level, category, userId } = req.query;

  let query = 'SELECT id, title, description, level, category, order_index FROM lessons WHERE 1=1';
  const params = [];

  if (level) { query += ' AND level = ?'; params.push(level); }
  if (category) { query += ' AND category = ?'; params.push(category); }

  query += ' ORDER BY order_index ASC';

  const lessons = db.prepare(query).all(...params);

  // Si hay userId, incluir el progreso del usuario en cada lección
  if (userId) {
    const progress = db.prepare(`
      SELECT lesson_id, status, score, attempts
      FROM user_progress WHERE user_id = ?
    `).all(userId);

    const progressMap = Object.fromEntries(progress.map(p => [p.lesson_id, p]));

    return res.json({
      lessons: lessons.map(l => ({
        ...l,
        progress: progressMap[l.id] || { status: 'not_started', score: 0, attempts: 0 },
      })),
    });
  }

  res.json({ lessons });
});

/**
 * GET /api/lessons/:id
 * Obtiene el detalle completo de una lección (incluye ejercicios)
 */
router.get('/:id', (req, res) => {
  const db = getDB();
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);

  if (!lesson) return res.status(404).json({ error: 'Lección no encontrada' });

  res.json({
    ...lesson,
    content: JSON.parse(lesson.content),
  });
});

/**
 * POST /api/lessons/:id/explain
 * Pide al asistente que explique un concepto de la lección
 *
 * Body: { userId, concept }
 * Ejemplo: { concept: "present simple negative" }
 */
router.post('/:id/explain', async (req, res) => {
  const { userId, concept } = req.body;
  const db = getDB();

  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Lección no encontrada' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const lessonContent = JSON.parse(lesson.content);

  const prompt = `The student is studying the lesson "${lesson.title}" (${lesson.level}).
Lesson content summary: ${JSON.stringify(lessonContent).slice(0, 500)}

The student asks you to explain: "${concept || lesson.title}"

Provide a clear, friendly explanation adapted to level ${user.level}.
Use examples. Keep it under 150 words. Respond in Spanish if the student's question is in Spanish.`;

  try {
    const explanation = await generateResponse(
      [{ role: 'user', content: prompt }],
      { level: user.level, userName: user.name }
    );

    res.json({ explanation, lessonId: lesson.id, concept });
  } catch (err) {
    res.status(503).json({ error: 'Error al generar explicación', detail: err.message });
  }
});

/**
 * POST /api/lessons/:id/hint
 * Obtiene una pista para un ejercicio específico sin revelar la respuesta
 *
 * Body: { userId, exerciseIndex, studentAnswer }
 */
router.post('/:id/hint', async (req, res) => {
  const { userId, exerciseIndex = 0, studentAnswer = '' } = req.body;
  const db = getDB();

  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
  if (!lesson) return res.status(404).json({ error: 'Lección no encontrada' });

  const user = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
  const content = JSON.parse(lesson.content);
  const exercise = content.exercises?.[exerciseIndex];

  if (!exercise) return res.status(404).json({ error: 'Ejercicio no encontrado' });

  const prompt = `Student is doing this exercise:
Type: ${exercise.type}
Prompt: "${exercise.prompt}"
${studentAnswer ? `Student's answer so far: "${studentAnswer}"` : ''}

Give a helpful HINT (not the answer!) that guides them. 
Keep it to 1-2 sentences. Be encouraging. Respond in Spanish.`;

  try {
    const hint = await generateResponse(
      [{ role: 'user', content: prompt }],
      { level: user?.level || 'A1' }
    );
    res.json({ hint });
  } catch (err) {
    res.status(503).json({ error: 'Error al generar pista', detail: err.message });
  }
});

export default router;
