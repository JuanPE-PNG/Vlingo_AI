import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { initDatabase } from '../src/services/database.js';
import { chunkText, extractKeywordsFromChunk } from '../src/services/rag.js';
import { getDB } from '../src/services/database.js';
import pdfParse from 'pdf-parse';

const MATERIALS_DIR = './data/materials';
const VALID_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VALID_CATEGORIES = ['grammar', 'vocabulary', 'speaking', 'listening', 'culture', 'general'];

async function ingest() {
  console.log('\n📚 VLINGO - Ingesta de Material Pedagógico');
  console.log('══════════════════════════════════════════');

  await initDatabase();
  const db = getDB();

  if (!fs.existsSync(MATERIALS_DIR)) {
    fs.mkdirSync(MATERIALS_DIR, { recursive: true });
    console.log(`\n Directorio creado: ${MATERIALS_DIR}`);
    console.log('   Coloca tus archivos .txt, .md o .pdf allí y ejecuta de nuevo.');
    return;
  }

  const files = fs.readdirSync(MATERIALS_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ['.pdf','.txt', '.md'].includes(ext);
  });

  if (files.length === 0) {
    console.log(`\nNo se encontraron archivos en ${MATERIALS_DIR}`);
    console.log('Coloca archivos .txt, .md, .pdf con tu material pedagógico.');
    return;
  }

  console.log(`\n🔍 Encontrados ${files.length} archivo(s)\n`);

  let totalChunks = 0;
  let processed = 0;
  let skipped = 0;

  const insert = db.prepare(`
    INSERT INTO materials (filename, chunk_index, content, level, category, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const file of files) {
    const filePath = path.join(MATERIALS_DIR, file);
    const basename = path.basename(file, path.extname(file));

    const parts = basename.toLowerCase().split('_');
    let level = 'A1';
    let category = 'general';

    if (VALID_LEVELS.includes(parts[0]?.toUpperCase())) {
      level = parts[0].toUpperCase();
      if (VALID_CATEGORIES.includes(parts[1])) {
        category = parts[1];
      }
    }

    const existing = db.prepare('SELECT COUNT(*) as c FROM materials WHERE filename = ?').get(file);
    if (existing.c > 0) {
      console.log(`⏭️  ${file} — ya ingresado (${existing.c} chunks), saltando`);
      skipped++;
      continue;
    }

    try {
      let text;
      const ext = path.extname(file).toLowerCase();

      if (ext === '.pdf') {
        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        text = parsed.text;
      } else {
        text = fs.readFileSync(filePath, 'utf-8');
      }

      if (!text || !text.trim()) {
        console.log(`⚠️  ${file} — vacío, saltando`);
        continue;
      }

      const chunks = chunkText(text, 800, 100);

      db.transaction(() => {
        chunks.forEach((chunk, i) => {
          const keywords = extractKeywordsFromChunk(chunk);
          insert.run(file, i, chunk, level, category, keywords);
        });
      })();

      console.log(`✅ ${file} → nivel ${level}, categoría ${category}, ${chunks.length} fragmentos`);
      totalChunks += chunks.length;
      processed++;

    } catch (err) {
      console.error(`❌ ${file} → Error: ${err.message}`);
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Procesados: ${processed} archivo(s)`);
  console.log(`⏭️  Saltados:   ${skipped} archivo(s) (ya existían)`);
  console.log(`Total fragmentos nuevos: ${totalChunks}`);

  const summary = db.prepare(`
    SELECT level, category, COUNT(*) as chunks, COUNT(DISTINCT filename) as files
    FROM materials
    GROUP BY level, category
    ORDER BY level, category
  `).all();

  if (summary.length > 0) {
    console.log('\nBase de conocimiento actual:');
    for (const row of summary) {
      console.log(`   ${row.level} / ${row.category}: ${row.files} archivo(s), ${row.chunks} fragmento(s)`);
    }
  }

  console.log('');
}

ingest().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
