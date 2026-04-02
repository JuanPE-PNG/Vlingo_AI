import { Router } from 'express';
import { verifyOllama, MODEL, activeSessionCount, getSessionStats } from '../services/ollama.js';

const router = Router();

/**
 * GET /health
 * Estado del servidor y servicios
 */
router.get('/', async (req, res) => {
  const status = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    model: MODEL,
    ollama: 'unknown',
  };

  try {
    const models = await verifyOllama();
    const modelLoaded = models.models.some(m => m.name.startsWith(MODEL.split(':')[0]));
    status.ollama = modelLoaded ? 'ready' : 'model_not_found';
    status.available_models = models.models.map(m => m.name);
  } catch {
    status.ollama = 'offline';
    status.status = 'degraded';
  }

  const httpStatus = status.status === 'ok' ? 200 : 503;
  res.status(httpStatus).json(status);
});

router.get('/session/:sessionId', async (req, res) => {
  const stats = await getSessionStats(req.params.sessionId);
  res.json(stats);
});

export default router;
