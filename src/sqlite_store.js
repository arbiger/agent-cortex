/**
 * SQLite store — singleton Database instance using better-sqlite3.
 * Mirrors the PG schema exactly (memories, causal_links, memory_embeddings).
 *
 * Env var: CORTEX_SQLITE_PATH (default: ~/Documents/Georges/06 🧠 Memory/agent_cortex.db)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

let _db = null;

/**
 * Add a column to a table if it doesn't already exist.
 * Uses PRAGMA table_info to check, making the migration idempotent.
 */
function addColumnIfMissing(db, table, col, ddl) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = info.some(c => c.name === col);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_tag TEXT NOT NULL,
      source_file TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      facts TEXT,
      narrative TEXT,
      memory_type TEXT DEFAULT 'session',
      enriched INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      embedding_pending INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0
    );
  `);

  // MVP-1 memory hierarchy columns (idempotent)
  addColumnIfMissing(db, 'memories', 'status',      'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'memories', 'source_kind', 'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'memories', 'period_start','TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'memories', 'period_end',  'TEXT DEFAULT NULL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS causal_links (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL DEFAULT 0.5,
      created_at TEXT,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE,
      embedding BLOB NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent_tag ON memories(agent_tag);
    CREATE INDEX IF NOT EXISTS idx_memories_topic_key ON memories(topic_key);
    CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_embeddings_memory_id ON memory_embeddings(memory_id);
    CREATE INDEX IF NOT EXISTS idx_causal_from ON causal_links(memory_id);
    CREATE INDEX IF NOT EXISTS idx_causal_to ON causal_links(target_id);
  `);
}

/**
 * Returns the singleton Database instance (better-sqlite3).
 * Creates the DB directory if it doesn't exist.
 * Exported for synchronous transaction use in episode_builder.
 */
export function getDb() {
  if (_db) return _db;

  const dbPath = process.env.CORTEX_SQLITE_PATH
    || path.join(os.homedir(), 'Documents', 'Georges', '06 🧠 Memory', 'agent_cortex.db');

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  applySchema(_db);

  return _db;
}

/**
 * Initialize the SQLite schema — creates all 3 tables mirroring PG exactly.
 * Safe to call multiple times (CREATE TABLE IF NOT EXISTS).
 */
export function initSchema() {
  const db = getDb();
  applySchema(db);
}

/**
 * Query helper — returns { rows: [...] } shape compatible with PG callers.
 *
 * - SELECT:                       returns { rows: stmt.all(...) }
 * - INSERT/UPDATE/DELETE:         returns { rows: [], rowCount, lastInsertRowid } via .run()
 * - UPDATE/DELETE ... RETURNING:  returns { rows: stmt.all(...), rowCount: rows.length } via .all()
 *
 * Note: better-sqlite3 is synchronous; wrapped in Promise.resolve for PG API compat.
 *
 * @param {string} sql  — SQL with ? placeholders (NOT $1, $2)
 * @param {any[]} params
 */
export function query(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  const upper = sql.trim().toUpperCase();

  // SELECT → fetch all rows
  if (upper.startsWith('SELECT')) {
    return Promise.resolve({ rows: stmt.all(...params) });
  }

  // Non-SELECT with RETURNING (e.g. UPDATE/DELETE ... RETURNING *)
  if (/\bRETURNING\b/i.test(sql)) {
    const rows = stmt.all(...params);
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  // Plain INSERT/UPDATE/DELETE — use .run()
  const result = stmt.run(...params);
  return Promise.resolve({
    rows: [],
    rowCount: result.changes,
    lastInsertRowid: result.lastInsertRowid
  });
}

/** Close the singleton (for testing / graceful shutdown) */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Enable or disable foreign key enforcement */
export function setForeignKeys(enabled = true) {
  const db = getDb();
  db.pragma(`foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}
