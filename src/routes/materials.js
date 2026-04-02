import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDB } from '../services/database.js';
import { chunkText, extractKeywordsFromChunk } from '../services/rag.js';

const router = Router();

const upload = multer({
  dest: './data/materials/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB máximo
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.pdf', '.md', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no soportado. Usa: ${allowed.join(', ')}`));
    }
  },
});

router.post('/ingest', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo' });

  const { level = 'A1', category = 'general' } = req.body;
  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    let text = '';
    const ext = path.extname(originalName).toLowerCase();

    if (ext === '.txt' || ext === '.md') {
      text = fs.readFileSync(filePath, 'utf-8');

    } else if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      text = data.text;

    } else if (ext === '.json') {
      const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(json)) {
        text = json.map(item =>
          typeof item === 'string' ? item : (item.content || item.text || JSON.stringify(item))
        ).join('\n\n');
      } else {
        text = json.content || json.text || JSON.stringify(json, null, 2);
      }
    }

    if (!text.trim()) {
      return res.status(400).json({ error: 'El archivo no tiene contenido de texto' });
    }

    // Dividir en chunks e indexar
    const chunks = chunkText(text, 800, 100);
    const db = getDB();

    const insert = db.prepare(`
      INSERT INTO materials (filename, chunk_index, content, level, category, keywords)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((chunks) => {
      for (let i = 0; i < chunks.length; i++) {
        const keywords = extractKeywordsFromChunk(chunks[i]);
        insert.run(originalName, i, chunks[i], level, category, keywords);
      }
    });

    insertMany(chunks);

    // Limpiar archivo temporal
    fs.unlinkSync(filePath);

    res.json({
      ok: true,
      filename: originalName,
      chunks_created: chunks.length,
      level,
      category,
      message: `Material ingresado: ${chunks.length} fragmentos indexados`,
    });

  } catch (err) {
    // Limpiar en caso de error
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[Ingest error]', err.message);
    res.status(500).json({ error: 'Error al procesar el archivo', detail: err.message });
  }
});

router.post('/ingest-text', (req, res) => {
  const { text, filename = 'manual_entry', level = 'A1', category = 'general' } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: 'text es requerido' });

  const chunks = chunkText(text, 800, 100);
  const db = getDB();

  const insert = db.prepare(`
    INSERT INTO materials (filename, chunk_index, content, level, category, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    chunks.forEach((chunk, i) => {
      insert.run(filename, i, chunk, level, category, extractKeywordsFromChunk(chunk));
    });
  })();

  res.json({
    ok: true,
    filename,
    chunks_created: chunks.length,
    level,
    category,
  });
});

router.get('/', (req, res) => {
  const db = getDB();
  const materials = db.prepare(`
    SELECT filename, level, category,
           COUNT(*) as chunk_count,
           MIN(created_at) as ingested_at
    FROM materials
    GROUP BY filename, level, category
    ORDER BY ingested_at DESC
  `).all();

  res.json({ materials });
});

router.delete('/:filename', (req, res) => {
  const db = getDB();
  const result = db.prepare('DELETE FROM materials WHERE filename = ?').run(req.params.filename);
  res.json({ ok: true, deleted_chunks: result.changes });
});

export default router;
