import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../services/database.js';
import { generateResponse, generateResponseStream, evaluateText, clearSessionMemory } from '../services/ollama.js';
import { retrieveContext } from '../services/rag.js';
import { detectMode, isTeacher } from '../services/prompts.js';
import {
  getSessionContext, buildMemoryBlock, scheduleMemoryUpdate, scheduleErrorTracking,
} from '../services/memory.js';

const router = Router();
// ~1400 tokens: el curso debe caber junto al prompt en num_ctx 4096.
const MAX_ATTACHED   = 5000;
const VALID_ROLES    = ['estudiante', 'profesor', 'administrador'];

// POST /api/chat/new-session
// Crea una sesión limpia para un usuario. El cliente Android debe llamar este
// endpoint en cada login para obtener un sessionId fresco y evitar mostrar
// mensajes de cuentas anteriores.
router.post('/new-session', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requerido' });

  const db = getDB();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const newId = uuidv4();
  db.prepare('INSERT INTO sessions (id, user_id, topic) VALUES (?, ?, ?)').run(newId, userId, 'General conversation');

  res.status(201).json({ sessionId: newId });
});

router.post('/message', async (req, res) => {
  const { userId, message, sessionId: bodySessionId, stream = false, attachedContext, userRole } = req.body;
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

  // Historial sin límite fijo: resumen acumulado de la sesión + mensajes recientes sin resumir.
  const { summary, recent: dbHistory } = getSessionContext(session.id);

  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)").run(session.id, message.trim());

  // El curso adjunto tiene prioridad; el material de los PDF solo se usa para explicar gramática.
  const attached = (attachedContext || '').toString().trim();
  const course = attached.length > MAX_ATTACHED
    ? attached.slice(0, MAX_ATTACHED) + '\n[... curso recortado ...]'
    : attached;
  const mode = detectMode(message, dbHistory, Boolean(course));
  const reference = mode === 'grammar' ? retrieveContext(message, user.level, 2) : '';

  console.log(`[chat] modo=${mode} curso=${course.length} chars referencia=${reference.length} chars`);

  const role    = VALID_ROLES.includes(userRole) ? userRole : undefined;
  const teacher = isTeacher(user.level, role);
  const memory  = buildMemoryBlock({ userId, summary, teacher });

  const options = {
    level:     user.level,
    userRole:  role,
    userName:  user.name,
    sessionId: session.id,
    mode,
    course,
    reference,
    memory,
  };

  const afterReply = () => scheduleMemoryUpdate({
    userId, sessionId: session.id, message: message.trim(), teacher,
  });

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
      afterReply();

    } else {
      const { text: response } = await generateResponse(message.trim(), dbHistory, options);

      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(session.id, response);

      afterReply();

      const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(session.id).c;

      res.json({
        sessionId:    session.id,
        message:      response,
        userLevel:    user.level,
        debug: {
          mode,
          totalInDB:    totalMessages,
          sentToModel:  dbHistory.length,
          hasSummary:   Boolean(summary),
          memoryChars:  memory.length,
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
  const { userId, text, exerciseContext, userRole } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId y text son requeridos' });

  const db   = getDB();
  const user = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    const evaluation = await evaluateText(
      text,
      exerciseContext || 'Free writing',
      user.level,
      VALID_ROLES.includes(userRole) ? userRole : 'estudiante',
    );
    res.json(evaluation);

    if (evaluation.grammar_errors.length && evaluation.corrections[0] !== text) {
      scheduleErrorTracking({ userId, text });
    }
  } catch (err) {
    res.status(503).json({ error: 'Error al evaluar', detail: err.message });
  }
});

export default router;