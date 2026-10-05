import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { initDatabase } from './services/database.js';
import { verifyOllama } from './services/ollama.js';

import chatRoutes from './routes/chat.js';
import lessonRoutes from './routes/lessons.js';
import progressRoutes from './routes/progress.js';
import materialsRoutes from './routes/materials.js';
import healthRoutes from './routes/health.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'x-api-key'],
}));


app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 60,
  message: { error: 'Demasiadas solicitudes. Intenta en un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false, // la clave no siempre es una IP; las validaciones de IPv6 no aplican
  keyGenerator: (req) =>
    req.body?.userId
    || req.query?.userId
    || req.headers['cf-connecting-ip']
    || req.ip,
}));


const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/health' || req.path.startsWith('/health/')) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  res.status(401).json({ error: 'No autorizado' });
});

// Rutas
app.use('/health', healthRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/lessons', lessonRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/materials', materialsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no encontrada` });
});

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({
    error: 'Error interno del servidor',
    detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

async function start() {
  console.log('\nVLINGO AI Backend');

  console.log('Inicializando base de datos...');
  await initDatabase();

  console.log(` Verificando Ollama (${process.env.OLLAMA_MODEL})...`);
  const ollamaOk = await verifyOllama();
  if (!ollamaOk) {
    console.error('No se pudo conectar con Ollama.');
    process.exit(1);
  }
  console.log('Ollama conectado');

  if (!API_KEY) {
    console.warn('\n  ADVERTENCIA: API_KEY no está definida en .env.');
    console.warn('  La API queda ABIERTA. No levantes el túnel sin configurarla.');
  }

  app.listen(PORT, () => {
    console.log(`\nServidor corriendo en http://localhost:${PORT}`);
    console.log(`Movil: http://<TU_IP_LOCAL>:${PORT}`);
    console.log(`Tunel: npm run tunnel (en otra terminal)`);
  });
}

start();
