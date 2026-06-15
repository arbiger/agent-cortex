/**
 * In-memory brute-force cosine similarity search for agent-cortex embeddings.
 *
 * Vector BLOB format contract (do not change after migration):
 *   - Storage: little-endian Float32 BLOB, exactly 4096 bytes (1024 × 4)
 *   - Source: PG vector(1024) text format "[0.1,0.2,...]"
 *   - Validation: blob.length === 4096 on load; throw on mismatch
 *
 * API:
 *   loadIndex()         — at startup, load all embeddings from SQLite into memory
 *   searchSimilar(vec, limit=10) — brute-force cosine, return top-K {memory_id, similarity}
 *   addOrUpdate(id, vec) — upsert in index + persist BLOB to SQLite
 *   getCount()          — number of vectors currently loaded
 */

import { query } from './sqlite_store.js';

const DIM = 1024;
const BLOB_LEN = DIM * 4; // 4096 bytes

/** @type {{ memory_id: string, embedding: Float32Array }[]} */
let _index = [];
let _loaded = false;
let _signature = null;

async function getIndexSignature() {
  const result = await query(
    'SELECT COUNT(*) AS count, MAX(updated_at) AS max_updated_at FROM memory_embeddings'
  );
  const row = result.rows[0] || {};
  return `${row.count || 0}:${row.max_updated_at || ''}`;
}

/**
 * Parse a PG vector text string "[0.1,0.2,...]" into a Float32Array.
 * @param {string} pgText
 * @returns {Float32Array}
 */
export function pgVectorToBlob(pgText) {
  // Strip surrounding brackets, split by comma, parse floats
  const inner = pgText.trim();
  const stripped = inner.startsWith('[') ? inner.slice(1) : inner;
  const end = stripped.endsWith(']') ? stripped.slice(0, -1) : stripped;
  const parts = end.split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== DIM) {
    throw new Error(`Expected ${DIM} dimensions, got ${parts.length}`);
  }
  const arr = new Float32Array(parts);
  return arr;
}

/**
 * Convert a little-endian Float32 BLOB Buffer to a Float32Array.
 * Validates that blob.length === 4096.
 * @param {Buffer} blob
 * @returns {Float32Array}
 */
export function blobToVector(blob) {
  if (blob.length !== BLOB_LEN) {
    throw new Error(`Invalid BLOB length: expected ${BLOB_LEN}, got ${blob.length}`);
  }
  return new Float32Array(new Float32Array(blob.buffer, blob.byteOffset, DIM));
}

/**
 * Convert a Float32Array to a little-endian Float32 Buffer (4096 bytes).
 * @param {Float32Array} vec
 * @returns {Buffer}
 */
export function vectorToBlob(vec) {
  if (vec.length !== DIM) {
    throw new Error(`Invalid vector length: expected ${DIM}, got ${vec.length}`);
  }
  // Copy to a new Float32Array to avoid shared buffer issues, then to Buffer
  const copy = new Float32Array(vec);
  return Buffer.from(copy.buffer);
}

/**
 * Compute cosine similarity between two Float32Arrays.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < DIM; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Load all memory_embeddings from SQLite into the in-memory index.
 * Call once at server startup.
 * @returns {Promise<void>}
 */
export async function loadIndex() {
  const result = await query(
    'SELECT memory_id, embedding FROM memory_embeddings'
  );
  _index = [];
  for (const row of result.rows) {
    const blob = Buffer.from(row.embedding); // row.embedding is a Buffer from better-sqlite3
    if (blob.length !== BLOB_LEN) {
      throw new Error(`Invalid BLOB for memory_id ${row.memory_id}: expected ${BLOB_LEN}, got ${blob.length}`);
    }
    const vec = new Float32Array(new Float32Array(blob.buffer, blob.byteOffset, DIM));
    _index.push({ memory_id: row.memory_id, embedding: vec });
  }
  _loaded = true;
  _signature = await getIndexSignature();
}

async function refreshIndexIfChanged() {
  const signature = await getIndexSignature();
  if (!_loaded || signature !== _signature) {
    await loadIndex();
  }
}

/**
 * Search for the top-K most similar memory IDs to the given query vector.
 * @param {Float32Array} queryVec
 * @param {number} limit
 * @returns {{ memory_id: string, similarity: number }[]}
 */
export async function searchSimilar(queryVec, limit = 10) {
  await refreshIndexIfChanged();
  if (queryVec.length !== DIM) {
    throw new Error(`Invalid query vector length: expected ${DIM}, got ${queryVec.length}`);
  }

  // Compute similarity for all vectors
  const scored = _index.map(entry => ({
    memory_id: entry.memory_id,
    similarity: cosineSimilarity(queryVec, entry.embedding),
  }));

  // Sort by similarity descending
  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

/**
 * Add or update a vector in the in-memory index AND persist to SQLite.
 * If memory_id already exists in index, updates in place.
 *
 * @param {string} memoryId
 * @param {Float32Array} vec
 * @returns {Promise<void>}
 */
export async function addOrUpdate(memoryId, vec) {
  if (vec.length !== DIM) {
    throw new Error(`Invalid vector length: expected ${DIM}, got ${vec.length}`);
  }

  const blob = vectorToBlob(vec);

  // Upsert in SQLite
  await query(
    `INSERT INTO memory_embeddings (id, memory_id, embedding, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at`,
    [memoryId, memoryId, blob]
  );

  // Upsert in memory index
  const existing = _index.findIndex(e => e.memory_id === memoryId);
  if (existing >= 0) {
    _index[existing].embedding = new Float32Array(vec);
  } else {
    _index.push({ memory_id: memoryId, embedding: new Float32Array(vec) });
  }
  _loaded = true;
  _signature = null;
}

/**
 * Return the number of vectors currently in the in-memory index.
 * @returns {number}
 */
export function getCount() {
  return _index.length;
}

/** Reset the index (for testing) */
export function _resetIndex() {
  _index = [];
  _loaded = false;
  _signature = null;
}
