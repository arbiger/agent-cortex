/**
 * SQLite-only query facade for agent-cortex.
 *
 * All queries route through sqlite_store.js (CORTEX_SQLITE_PATH is read there).
 * This file is a thin facade — actual implementation lives in sqlite_store.js.
 */
import * as sqlite_store from './sqlite_store.js';

/**
 * Unified query API — always routes to SQLite.
 * @param {string} sql  — SQL with ? placeholders
 * @param {any[]} params
 */
export async function query(sql, params = []) {
  return sqlite_store.query(sql, params);
}

export async function getPendingEmbeddingsCount(config) {
  const result = await query(
    `SELECT COUNT(*) as count FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getUnprocessedMemoriesCount(config) {
  const result = await query(
    `SELECT COUNT(*) as count FROM memories WHERE enriched = FALSE AND is_deleted = FALSE`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getOrphanLinksCount(config) {
  const result = await query(
    `SELECT COUNT(*) as count FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getDbStats(config) {
  const [memories, embeddings, links] = await Promise.all([
    query(`SELECT COUNT(*) as count FROM memories WHERE is_deleted = FALSE`),
    query(`SELECT COUNT(*) as count FROM memory_embeddings`),
    query(`SELECT COUNT(*) as count FROM causal_links`),
  ]);
  return {
    memories: parseInt(memories.rows[0].count, 10),
    memory_embeddings: parseInt(embeddings.rows[0].count, 10),
    causal_links: parseInt(links.rows[0].count, 10),
  };
}

export async function checkConnection(config) {
  await query(`SELECT 1`);
  return true;
}
