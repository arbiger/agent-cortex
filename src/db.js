import pg from 'pg';
import { loadConfig } from './config.js';

const { Pool } = pg;

let _pool = null;

export function getPool(config) {
  if (_pool) return _pool;
  const cfg = config || loadConfig();
  _pool = new Pool({
    connectionString: cfg.PG_CONN,
  });
  return _pool;
}

export async function query(sql, params, config) {
  const pool = getPool(config);
  return pool.query(sql, params);
}

export async function getPendingEmbeddingsCount(config) {
  const pool = getPool(config);
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getUnprocessedMemoriesCount(config) {
  const pool = getPool(config);
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM memories WHERE enriched = FALSE AND is_deleted = FALSE`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getOrphanLinksCount(config) {
  const pool = getPool(config);
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getDbStats(config) {
  const pool = getPool(config);
  const [memories, embeddings, links] = await Promise.all([
    pool.query(`SELECT COUNT(*) as count FROM memories WHERE is_deleted = FALSE`),
    pool.query(`SELECT COUNT(*) as count FROM memory_embeddings`),
    pool.query(`SELECT COUNT(*) as count FROM causal_links`),
  ]);
  return {
    memories: parseInt(memories.rows[0].count, 10),
    memory_embeddings: parseInt(embeddings.rows[0].count, 10),
    causal_links: parseInt(links.rows[0].count, 10),
  };
}

export async function checkConnection(config) {
  const pool = getPool(config);
  await pool.query(`SELECT 1`);
  return true;
}

export function closePool() {
  if (_pool) {
    _pool.end();
    _pool = null;
  }
}