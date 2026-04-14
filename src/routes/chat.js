import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../services/database.js';
import { generateResponse, generateResponseStream, evaluateText, clearSessionMemory } from '../services/ollama.js';
import { retrieveContext } from '../services/rag.js';

const router = Router();
const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW) || 10;

router.post('/message', async (req, res) => {
  const { userId, message, sessionId: bodySessionId, stream = false } = req.body;
  const sessionId = bodySessionId || req.headers['x-session-id'];

  if (!userId || !message?.trim()) {
    return res.status(400).json({ error: 'userId y message son requeridos' });
  }

  const db  = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }

  // Obtener o crear sesión
  let session = sessionId
    ? db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId)
    : null;

  if (!session) {
    const newId = uuidv4();
    db.prepare('INSERT INTO sessions (id, user_id, topic) VALUES (?, ?, ?)').run(newId, userId, 'General conversation');
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(newId);
  } else {
    db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(session.id);
  }

  const dbHistory = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, created_at FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) ORDER BY created_at ASC
  `).all(session.id, CONTEXT_WINDOW - 1);
  
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)").run(session.id, message.trim());

  const ragContext = retrieveContext(message, user.level, 3);

  const options = {
    level:     user.level,
    context:   ragContext,
    userName:  user.name,
    sessionId: session.id,
  };

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Session-ID', session.id);

      let fullResponse = '';

      await generateResponseStream(message.trim(), dbHistory, options, (chunk) => {
        fullResponse += chunk;
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      });

      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(session.id, fullResponse);
      res.write(`data: ${JSON.stringify({ done: true, sessionId: session.id })}\n\n`);
      res.end();

    } else {
      const response = await generateResponse(message.trim(), dbHistory, options);

      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(session.id, response);

      const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(session.id).c;

      res.json({
        sessionId:    session.id,
        message:      response,
        userLevel:    user.level,
        debug: {
          totalInDB:    totalMessages,
          sentToModel:  dbHistory.length,
          windowSize:   CONTEXT_WINDOW,
        },
      });
    }
  } catch (err) {
    console.error('[Chat error]', err.message);
    res.status(503).json({ error: 'Error al generar respuesta. ¿Ollama está corriendo?', detail: err.message });
  }
});

// GET /api/chat/history/:sessionId
router.get('/history/:sessionId', (req, res) => {
  const db = getDB();
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId requerido' });

  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.sessionId, userId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  const messages = db.prepare(`
    SELECT id, role, content, created_at FROM messages
    WHERE session_id = ? ORDER BY created_at ASC
  `).all(req.params.sessionId);

  res.json({ session, messages });
});

// GET /api/chat/sessions/:userId
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

// DELETE /api/chat/sessions/:sessionId
router.delete('/sessions/:sessionId', (req, res) => {
  const db = getDB();
  const { userId } = req.body;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.sessionId, userId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

  db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.sessionId);
  clearSessionMemory(req.params.sessionId);

  res.json({ ok: true });
});

// POST /api/chat/evaluate
router.post('/evaluate', async (req, res) => {
  const { userId, text, exerciseContext } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId y text son requeridos' });

  const db   = getDB();
  const user = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    const evaluation = await evaluateText(text, exerciseContext || 'Free writing', user.level);
    res.json(evaluation);
  } catch (err) {
    res.status(503).json({ error: 'Error al evaluar', detail: err.message });
  }
});

export default router;