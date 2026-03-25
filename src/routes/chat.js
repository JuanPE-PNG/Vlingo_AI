import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../services/database.js';
import { generateResponse, generateResponseStream, evaluateText } from '../services/ollama.js';
import { retrieveContext } from '../services/rag.js';

const router = Router();
const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW) || 10;

/**
 * POST /api/chat/message
 *
 * Envía un mensaje al asistente y recibe respuesta.
 *
 * Body:
 *   userId    - ID del usuario
 *   sessionId - ID de sesión (si null, crea una nueva)
 *   message   - Texto del mensaje del usuario
 *   stream    - boolean, si true usa SSE streaming
 *
 * Headers:
 *   X-Session-ID - alternativa a sessionId en body
 */
router.post('/message', async (req, res) => {
  const { userId, message, sessionId: bodySessionId, stream = false } = req.body;
  const sessionId = bodySessionId || req.headers['x-session-id'];

  if (!userId || !message?.trim()) {
    return res.status(400).json({ error: 'userId y message son requeridos' });
  }

  const db = getDB();

  // Verificar que el usuario existe
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado. Usa POST /api/progress/user para crear uno.' });
  }

  // Obtener o crear sesión
  let session = sessionId
    ? db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId)
    : null;

  if (!session) {
    const newId = uuidv4();
    db.prepare(`
      INSERT INTO sessions (id, user_id, topic) VALUES (?, ?, ?)
    `).run(newId, userId, 'General conversation');
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId);
  } else {
    // Actualizar última actividad
    db.prepare('UPDATE sessions SET last_active = datetime(\'now\') WHERE id = ?').run(session.id);
  }

  // Guardar mensaje del usuario
  db.prepare(`
    INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)
  `).run(session.id, message.trim());

  // Obtener historial reciente (últimos N mensajes)
  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(session.id, CONTEXT_WINDOW).reverse();

  // Recuperar contexto pedagógico relevante (RAG)
  const ragContext = retrieveContext(message, user.level, 3);

  // Preparar mensajes para el modelo
  const messages = history.map(m => ({ role: m.role, content: m.content }));

  try {
    if (stream) {
      // ─── Modo streaming (SSE) ────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Session-ID', session.id);

      let fullResponse = '';

      await generateResponseStream(
        messages,
        { level: user.level, context: ragContext, userName: user.name },
        (chunk) => {
          fullResponse += chunk;
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      );

      // Guardar respuesta completa
      db.prepare(`
        INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)
      `).run(session.id, fullResponse);

      res.write(`data: ${JSON.stringify({ done: true, sessionId: session.id })}\n\n`);
      res.end();

    } else {
      // ─── Modo normal (JSON) ──────────────────────────────────────────────
      const response = await generateResponse(
        messages,
        { level: user.level, context: ragContext, userName: user.name }
      );

      // Guardar respuesta del asistente
      db.prepare(`
        INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)
      `).run(session.id, response);

      res.json({
        sessionId: session.id,
        message: response,
        userLevel: user.level,
      });
    }
  } catch (err) {
    console.error('[Chat error]', err.message);
    res.status(503).json({
      error: 'Error al generar respuesta. ¿Ollama está corriendo?',
      detail: err.message,
    });
  }
});

/**
 * GET /api/chat/history/:sessionId
 * Obtiene el historial de una sesión
 */
router.get('/history/:sessionId', (req, res) => {
  const db = getDB();
  const { sessionId } = req.params;
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId requerido como query param' });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const messages = db.prepare(`
    SELECT id, role, content, created_at
    FROM messages WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId);

  res.json({ session, messages });
});

/**
 * GET /api/chat/sessions/:userId
 * Lista todas las sesiones de un usuario
 */
router.get('/sessions/:userId', (req, res) => {
  const db = getDB();
  const sessions = db.prepare(`
    SELECT s.*, COUNT(m.id) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.last_active DESC
    LIMIT 20
  `).all(req.params.userId);

  res.json({ sessions });
});

/**
 * DELETE /api/chat/sessions/:sessionId
 * Elimina una sesión y sus mensajes
 */
router.delete('/sessions/:sessionId', (req, res) => {
  const db = getDB();
  const { userId } = req.body;

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.sessionId, userId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.sessionId);

  res.json({ ok: true });
});

/**
 * POST /api/chat/evaluate
 * Evalúa una respuesta escrita del estudiante
 *
 * Body: { userId, text, exerciseContext }
 */
router.post('/evaluate', async (req, res) => {
  const { userId, text, exerciseContext } = req.body;

  if (!userId || !text) {
    return res.status(400).json({ error: 'userId y text son requeridos' });
  }

  const db = getDB();
  const user = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    const evaluation = await evaluateText(text, exerciseContext || 'Free writing', user.level);
    res.json(evaluation);
  } catch (err) {
    res.status(503).json({ error: 'Error al evaluar. ¿Ollama está corriendo?', detail: err.message });
  }
});

export default router;
