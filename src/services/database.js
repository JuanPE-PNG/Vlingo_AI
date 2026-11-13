import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/vlingo.db';

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;

export function getDB() {
  if (!db) throw new Error('Base de datos no inicializada. Llama initDatabase() primero.');
  return db;
}

export async function initDatabase() {
  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // ─── Tablas ───────────────────────────────────────────────────────────────

  db.exec(`
    -- Usuarios de la app
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT UNIQUE,
      level       TEXT NOT NULL DEFAULT 'A1',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sesiones de conversación
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      topic       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Mensajes del chat
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Lecciones disponibles
    CREATE TABLE IF NOT EXISTS lessons (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      level       TEXT NOT NULL,
      category    TEXT NOT NULL,
      content     TEXT NOT NULL,  -- JSON con ejercicios
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Progreso del usuario por lección
    CREATE TABLE IF NOT EXISTS user_progress (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL REFERENCES users(id),
      lesson_id    TEXT NOT NULL REFERENCES lessons(id),
      status       TEXT NOT NULL DEFAULT 'not_started'
                   CHECK(status IN ('not_started', 'in_progress', 'completed')),
      score        INTEGER DEFAULT 0,
      attempts     INTEGER DEFAULT 0,
      completed_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, lesson_id)
    );

    -- Material pedagógico ingresado (para RAG simple)
    CREATE TABLE IF NOT EXISTS materials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      filename    TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT NOT NULL,
      level       TEXT,
      category    TEXT,
      keywords    TEXT,  -- keywords separadas por coma para búsqueda simple
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Memoria del asistente: datos que el usuario contó de sí mismo
    CREATE TABLE IF NOT EXISTS user_memory (
      user_id     TEXT NOT NULL REFERENCES users(id),
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );

    -- Errores gramaticales reales detectados en lo que escribe el usuario
    CREATE TABLE IF NOT EXISTS user_errors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL REFERENCES users(id),
      category    TEXT NOT NULL,
      wrong       TEXT NOT NULL,
      correct     TEXT NOT NULL,
      count       INTEGER NOT NULL DEFAULT 1,
      last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, category, wrong)
    );

    -- Índices para búsqueda rápida
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_progress_user ON user_progress(user_id);
    CREATE INDEX IF NOT EXISTS idx_materials_level ON materials(level);
    CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category);
  `);

  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!sessionCols.includes('summary')) {
    db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT');
  }
  if (!sessionCols.includes('summarized_until')) {
    db.exec('ALTER TABLE sessions ADD COLUMN summarized_until INTEGER NOT NULL DEFAULT 0');
  }

  seedLessons();

  return db;
}

function seedLessons() {
  const count = db.prepare('SELECT COUNT(*) as c FROM lessons').get();
  if (count.c > 0) return;

  const lessons = [
    {
      id: 'greetings-a1',
      title: 'Greetings & Introductions',
      description: 'Learn to say hello and introduce yourself',
      level: 'A1',
      category: 'speaking',
      content: JSON.stringify({
        vocabulary: ['hello', 'hi', 'my name is', 'nice to meet you', 'how are you', 'I am fine'],
        phrases: [
          { english: 'Hello, my name is...', spanish: 'Hola, mi nombre es...' },
          { english: 'Nice to meet you!', spanish: '¡Mucho gusto!' },
          { english: 'How are you?', spanish: '¿Cómo estás?' },
          { english: 'I am fine, thank you.', spanish: 'Estoy bien, gracias.' },
        ],
        exercises: [
          { type: 'fill_blank', prompt: 'Hello, ___ name is Maria.', answer: 'my' },
          { type: 'translate', prompt: '¿Cómo te llamas?', answer: 'What is your name?' },
          { type: 'conversation', prompt: 'Greet the assistant and introduce yourself' },
        ],
      }),
      order_index: 1,
    },
    {
      id: 'numbers-a1',
      title: 'Numbers 1-100',
      description: 'Learn to count and use numbers in conversation',
      level: 'A1',
      category: 'vocabulary',
      content: JSON.stringify({
        vocabulary: ['one', 'two', 'three', 'ten', 'twenty', 'hundred'],
        exercises: [
          { type: 'translate', prompt: '¿Cuántos años tienes?', answer: 'How old are you?' },
          { type: 'fill_blank', prompt: 'I am ___ years old. (25)', answer: 'twenty-five' },
        ],
      }),
      order_index: 2,
    },
    {
      id: 'present-simple-a2',
      title: 'Present Simple Tense',
      description: 'Talk about habits, routines, and facts',
      level: 'A2',
      category: 'grammar',
      content: JSON.stringify({
        explanation: 'Use present simple for habits (I work every day) and facts (Water boils at 100°C)',
        rules: [
          'I/You/We/They + verb base (I work)',
          'He/She/It + verb + s/es (He works)',
          'Negative: do not / does not + verb',
        ],
        exercises: [
          { type: 'fill_blank', prompt: 'She ___ (work) every day.', answer: 'works' },
          { type: 'correct', prompt: 'He don\'t like coffee.', answer: 'He doesn\'t like coffee.' },
          { type: 'conversation', prompt: 'Tell the assistant about your daily routine' },
        ],
      }),
      order_index: 3,
    },
    {
      id: 'past-simple-b1',
      title: 'Past Simple Tense',
      description: 'Talk about completed actions in the past',
      level: 'B1',
      category: 'grammar',
      content: JSON.stringify({
        explanation: 'Use past simple for finished actions: I worked yesterday.',
        rules: [
          'Regular verbs: verb + ed (worked, played, studied)',
          'Irregular verbs must be memorized (go→went, have→had, see→saw)',
          'Negative: did not + verb base (I did not go)',
          'Question: Did + subject + verb base? (Did you go?)',
        ],
        irregular_verbs: [
          { base: 'go', past: 'went' },
          { base: 'have', past: 'had' },
          { base: 'see', past: 'saw' },
          { base: 'eat', past: 'ate' },
          { base: 'come', past: 'came' },
        ],
        exercises: [
          { type: 'fill_blank', prompt: 'Yesterday I ___ (go) to the store.', answer: 'went' },
          { type: 'conversation', prompt: 'Tell the assistant what you did last weekend' },
        ],
      }),
      order_index: 4,
    },
  ];

  const insert = db.prepare(`
    INSERT INTO lessons (id, title, description, level, category, content, order_index)
    VALUES (@id, @title, @description, @level, @category, @content, @order_index)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });

  insertMany(lessons);
  console.log(`✅ ${lessons.length} lecciones de ejemplo insertadas`);
}
