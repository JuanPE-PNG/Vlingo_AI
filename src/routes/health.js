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

  // verifyOllama() devuelve un boolean (hace un invoke de prueba al modelo),
  // no la lista de modelos: tratarlo como objeto dejaba el health en 'offline'
  // permanente aunque Ollama estuviera corriendo.
  const ollamaOk = await verifyOllama();
  if (ollamaOk) {
    status.ollama = 'ready';
  } else {
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
