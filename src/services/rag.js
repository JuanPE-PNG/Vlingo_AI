import { getDB } from './database.js';

/**
 * Busca fragmentos de material relevantes para una consulta del usuario
 * @param {string} query - Mensaje del usuario
 * @param {string} level - Nivel del usuario (A1, A2, B1, B2)
 * @param {number} topK - Cuántos fragmentos retornar
 * @returns {string} Contexto combinado para inyectar al prompt
 */
export function retrieveContext(query, level = 'A1', topK = 3) {
  const db = getDB();

  const keywords = extractKeywords(query);
  if (keywords.length === 0) return '';

  const levelGroup = getLevelGroup(level);

  const placeholders = keywords.map(() => '?').join(', ');
  const keywordConditions = keywords.map(() => `(content LIKE ? OR keywords LIKE ?)`).join(' OR ');
  const keywordParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);

  let results = [];

  try {
    const stmt = db.prepare(`
      SELECT content, keywords, level, category,
             (
               ${keywords.map(() => `CASE WHEN content LIKE ? THEN 2 ELSE 0 END`).join(' + ')} +
               ${keywords.map(() => `CASE WHEN keywords LIKE ? THEN 3 ELSE 0 END`).join(' + ')} +
               CASE WHEN level = ? THEN 2 ELSE 0 END
             ) as score
      FROM materials
      WHERE (${keywordConditions} OR level IN (${levelGroup.map(() => '?').join(',')}))
      ORDER BY score DESC
      LIMIT ?
    `);

    const params = [
      ...keywords.map(k => `%${k}%`), // para el score content
      ...keywords.map(k => `%${k}%`), // para el score keywords
      level,                            // para el score level
      ...keywordParams,                 // para el WHERE
      ...levelGroup,                    // para el WHERE por nivel
      topK * 2,
    ];

    results = stmt.all(...params);
  } catch {
    try {
      const simple = db.prepare(`
        SELECT content, keywords, level, category
        FROM materials
        WHERE level IN (${levelGroup.map(() => '?').join(',')})
        ORDER BY RANDOM()
        LIMIT ?
      `);
      results = simple.all(...levelGroup, topK);
    } catch {
      return '';
    }
  }

  if (results.length === 0) return '';

  const top = results.slice(0, topK);
  const context = top
    .map(r => `[${r.level || level} - ${r.category || 'general'}]\n${r.content}`)
    .join('\n\n---\n\n');

  return context;
}

function extractKeywords(text) {
  const stopwords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'this', 'that', 'these', 'those', 'what', 'how', 'when', 'where', 'why',
    'and', 'or', 'but', 'if', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'como', 'que', 'es', 'en', 'el', 'la', 'los', 'las', 'un', 'una',
    'de', 'del', 'al', 'se', 'me', 'te', 'le', 'nos', 'y', 'o', 'pero',
    'si', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'quiero', 'puedo',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w))
    .slice(0, 8); // máximo 8 keywords
}


function getLevelGroup(level) {
  const groups = {
    'A1': ['A1', 'A2'],
    'A2': ['A1', 'A2', 'B1'],
    'B1': ['A2', 'B1', 'B2'],
    'B2': ['B1', 'B2'],
    'C1': ['B2', 'C1'],
    'C2': ['C1', 'C2'],
  };
  return groups[level] || ['A1', 'A2'];
}

/**
 * Divide un texto largo en fragmentos (chunks) para ingesta
 * @param {string} text - Texto completo
 * @param {number} chunkSize - Tamaño en caracteres
 * @param {number} overlap - Solapamiento entre chunks
 */
export function chunkText(text, chunkSize = 800, overlap = 100) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      const words = current.split(' ');
      current = words.slice(-Math.floor(overlap / 6)).join(' ') + ' ' + sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function extractKeywordsFromChunk(text) {
  const freq = {};
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'be', 'in', 'on', 'at', 'to']);

  for (const w of words) {
    if (w.length > 3 && !stopwords.has(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([w]) => w)
    .join(',');
}
