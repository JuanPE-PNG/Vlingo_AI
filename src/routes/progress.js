import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../services/database.js';

const router = Router();

router.post('/user', (req, res) => {
  const { name, email, level = 'A1' } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name es requerido' });

  const validLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  if (!validLevels.includes(level)) {
    return res.status(400).json({ error: `level debe ser uno de: ${validLevels.join(', ')}` });
  }

  const db = getDB();

  if (email) {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) {
      // El nivel real vive en Supabase (test de nivelación). Si cambió allá,
      // sincronizarlo aquí: es el que alimenta los perfiles CEFR del prompt
      // y el filtro por nivel del RAG.
      if (existing.level !== level) {
        db.prepare("UPDATE users SET level = ?, updated_at = datetime('now') WHERE id = ?")
          .run(level, existing.id);
        const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
        return res.json({ user: refreshed, created: false, levelSynced: true });
      }
      return res.json({ user: existing, created: false });
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO users (id, name, email, level) VALUES (?, ?, ?, ?)
  `).run(id, name.trim(), email || null, level);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.status(201).json({ user, created: true });
});

/**
 * GET /api/progress/user/:userId
 * Obtiene el perfil completo de un usuario con estadísticas
 */
router.get('/user/:userId', (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Estadísticas de progreso
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_lessons_started,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      AVG(score) as avg_score,
      SUM(attempts) as total_attempts
    FROM user_progress WHERE user_id = ?
  `).get(req.params.userId);

  // Sesiones de chat
  const chatStats = db.prepare(`
    SELECT COUNT(DISTINCT s.id) as total_sessions,
           COUNT(m.id) as total_messages
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id AND m.role = 'user'
    WHERE s.user_id = ?
  `).get(req.params.userId);

  res.json({
    user,
    stats: {
      ...stats,
      avg_score: stats.avg_score ? Math.round(stats.avg_score) : 0,
      ...chatStats,
    },
  });
});

/**
 * PUT /api/progress/user/:userId
 * Actualiza datos del usuario (nombre, nivel)
 */
router.put('/user/:userId', (req, res) => {
  const db = getDB();
  const { name, level } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const updates = [];
  const params = [];

  if (name?.trim()) { updates.push('name = ?'); params.push(name.trim()); }
  if (level) { updates.push('level = ?'); params.push(level); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  updates.push('updated_at = datetime(\'now\')');
  params.push(req.params.userId);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  res.json({ user: updated });
});


router.post('/lesson', (req, res) => {
  const { userId, lessonId, status, score } = req.body;

  if (!userId || !lessonId || !status) {
    return res.status(400).json({ error: 'userId, lessonId y status son requeridos' });
  }

  const validStatuses = ['not_started', 'in_progress', 'completed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status debe ser uno de: ${validStatuses.join(', ')}` });
  }

  const db = getDB();

  const existing = db.prepare(`
    SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?
  `).get(userId, lessonId);

  if (existing) {
    db.prepare(`
      UPDATE user_progress SET
        status = ?,
        score = MAX(score, ?),
        attempts = attempts + 1,
        completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
        updated_at = datetime('now')
      WHERE user_id = ? AND lesson_id = ?
    `).run(status, score || existing.score, status, userId, lessonId);
  } else {
    db.prepare(`
      INSERT INTO user_progress (user_id, lesson_id, status, score, attempts, completed_at)
      VALUES (?, ?, ?, ?, 1, CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END)
    `).run(userId, lessonId, status, score || 0, status);
  }

  let levelUp = null;
  if (status === 'completed' && score >= 80) {
    const user = db.prepare('SELECT level FROM users WHERE id = ?').get(userId);
    const completed = db.prepare(`
      SELECT COUNT(*) as c FROM user_progress
      WHERE user_id = ? AND status = 'completed' AND score >= 70
    `).get(userId);

    const levelThresholds = { A1: 3, A2: 4, B1: 5, B2: 6 };
    const currentLevel = user?.level || 'A1';

    if (completed.c >= (levelThresholds[currentLevel] || 5)) {
      const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
      const nextLevel = levels[levels.indexOf(currentLevel) + 1];
      if (nextLevel) {
        levelUp = { suggested: nextLevel, message: `¡Excelente! Considera subir al nivel ${nextLevel}` };
      }
    }
  }

  const progress = db.prepare(`
    SELECT * FROM user_progress WHERE user_id = ? AND lesson_id = ?
  `).get(userId, lessonId);

  res.json({ progress, levelUp });
});

router.get('/:userId/lessons', (req, res) => {
  const db = getDB();
  const progress = db.prepare(`
    SELECT l.id, l.title, l.level, l.category, l.order_index,
           COALESCE(p.status, 'not_started') as status,
           COALESCE(p.score, 0) as score,
           COALESCE(p.attempts, 0) as attempts,
           p.completed_at
    FROM lessons l
    LEFT JOIN user_progress p ON p.lesson_id = l.id AND p.user_id = ?
    ORDER BY l.order_index ASC
  `).all(req.params.userId);

  res.json({ progress });
});

export default router;
