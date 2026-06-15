import Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { getEmbedding } from './embedding.js';
import * as vector_search from './vector_search.js';
import * as sqlite_store from './sqlite_store.js';

// Use config for DB path
function getTaskpadDbPath() {
  const config = loadConfig();
  return config.TASKPAD_DB_PATH || config.CORTEX_TASKPAD_DB_PATH ||
    '/Users/george/Documents/Georges/01 🎯 Projects/agentic-taskpad/agentic-taskpad.db';
}

// Lazy-opened connections (read-only)
let _taskpadDb = null;
function getTaskpadDb() {
  if (!_taskpadDb) {
    _taskpadDb = new Database(getTaskpadDbPath(), { readonly: true, fileMustExist: true });
  }
  return _taskpadDb;
}

/**
 * Cosine similarity between query Float32Array and a BLOB Buffer.
 * BLOB must be Float32 LE, 4096 bytes (1024-dim).
 */
export function cosineSimilarity(queryVec, blob) {
  const DIM = 1024;
  const EXPECTED_BYTES = DIM * 4;
  if (blob.length !== EXPECTED_BYTES) {
    return -1; // Invalid blob
  }
  const vec = new Float32Array(blob.buffer, blob.byteOffset, DIM);
  let dot = 0, normQ = 0, normB = 0;
  for (let i = 0; i < DIM; i++) {
    dot += queryVec[i] * vec[i];
    normQ += queryVec[i] * queryVec[i];
    normB += vec[i] * vec[i];
  }
  const denom = Math.sqrt(normQ) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search agentic-taskpad tasks via semantic similarity.
 * @param {number[]} queryEmbedding - plain JS array of 1024 floats
 * @param {object} options
 * @param {number} options.limit - max results
 * @param {string} options.taskpad_filter - 'active'|'H_only'|'all'
 * @returns {object[]} task results with similarity score
 */
function searchTasksSync(queryEmbedding, { limit = 10, taskpad_filter = 'active' } = {}) {
  let taskpadDb;
  try {
    taskpadDb = getTaskpadDb();
    // Verify table exists with a lightweight query
    taskpadDb.prepare("SELECT 1 FROM task_embeddings LIMIT 1").get();
  } catch (e) {
    // Graceful failure — taskpad unavailable
    return [];
  }

  // Build WHERE clause based on filter
  let stateClause = "WHERE t.state = 'active'";
  if (taskpad_filter === 'all') {
    stateClause = '';
  } else if (taskpad_filter === 'H_only') {
    stateClause = "WHERE t.state = 'active' AND t.priority = 'H'";
  }

  const sql = `
    SELECT t.id, t.title, t.owner, t.priority, t.state, t.updated_at,
           e.embedding
    FROM tasks t
    JOIN task_embeddings e ON t.id = e.task_id
    ${stateClause}
  `.trim().replace(/\s+/g, ' ');

  let rawRows;
  try {
    rawRows = taskpadDb.prepare(sql).all();
  } catch (e) {
    return [];
  }

  // Convert query embedding to Float32Array for similarity
  const queryVec = new Float32Array(queryEmbedding);

  // Filter and score
  const scored = [];
  for (const row of rawRows) {
    const sim = cosineSimilarity(queryVec, row.embedding);
    if (sim < 0) {
      // Invalid blob, skip
      continue;
    }
    scored.push({
      type: 'taskpad',
      task_code: row.id,  // 'id' like 'T001'
      title: row.title,
      assignee: row.owner || null,
      priority: row.priority,
      status: row.state,  // 'active'|'done'|'cancelled'
      score: sim,
      updated_at: row.updated_at,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Search agent_cortex memories via semantic similarity.
 * Uses existing in-memory vector index + sqlite_store.
 * @param {number[]} queryEmbedding - plain JS array of 1024 floats (embedding vector)
 * @param {number} limit - max results
 * @returns {object[]} memory results with similarity score
 */
async function searchMemories(queryEmbedding, limit = 10) {
  const similar = await vector_search.searchSimilar(new Float32Array(queryEmbedding), limit);
  if (similar.length === 0) return [];

  const ids = similar.map(s => s.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  const result = await sqlite_store.query(
    `SELECT id, content, topic_key, agent_tag, created_at
     FROM memories
     WHERE id IN (${placeholders}) AND is_deleted = 0`,
    ids
  );

  const simById = new Map(similar.map(s => [s.memory_id, s.similarity]));
  return result.rows.map(r => ({
    type: 'memory',
    id: r.id,
    topic_key: r.topic_key,
    agent_tag: r.agent_tag,
    content: r.content,
    score: simById.get(r.id) || 0,
    created_at: r.created_at,
  }));
}

/**
 * Reciprocal Rank Fusion (RRF) merge of memory and taskpad results.
 * @param {object[]} memories
 * @param {object[]} tasks
 * @param {number} memory_weight - weight for memory scores (0-1)
 * @returns {object[]} fused and sorted results
 */
export function rrfMerge(memories, tasks, memory_weight = 0.6) {
  const k = 60;
  const taskpad_weight = 1 - memory_weight;

  const combined = new Map();

  // Add memories
  memories.forEach((item, idx) => {
    combined.set(item.id, {
      ...item,
      fused_score: memory_weight * (1 / (k + idx + 1)),
    });
  });

  // Merge taskpad results
  tasks.forEach((item, idx) => {
    if (combined.has(item.task_code)) {
      const existing = combined.get(item.task_code);
      existing.fused_score += taskpad_weight * (1 / (k + idx + 1));
    } else {
      combined.set(item.task_code, {
        ...item,
        fused_score: taskpad_weight * (1 / (k + idx + 1)),
      });
    }
  });

  return Array.from(combined.values()).sort((a, b) => {
    if (b.fused_score !== a.fused_score) return b.fused_score - a.fused_score;
    // Tie-breaker: memories first, then tasks; within each, by id
    if (a.type !== b.type) return a.type === 'memory' ? -1 : 1;
    const aKey = a.type === 'memory' ? a.id : a.task_code;
    const bKey = b.type === 'memory' ? b.id : b.task_code;
    return String(aKey).localeCompare(String(bKey));
  });
}

/**
 * Main handler for query_unified tool.
 * Called by src/server.js when the 'query_unified' tool is invoked.
 */
export async function handleQueryUnified(args) {
  const {
    query: query_str,
    limit = 10,
    memory_weight = 0.6,
    taskpad_filter = 'active',
  } = args;

  const warnings = [];

  // Clamp limit to [1, 100]
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 10), 100);

  // Clamp memory_weight to [0, 1]; allow 0, reject NaN/invalid
  function clampMemoryWeight(input) {
    const parsed = parseFloat(input);
    if (isNaN(parsed)) return 0.6;  // invalid → default
    return Math.min(1, Math.max(0, parsed));  // valid → clamp
  }
  const safeMemoryWeight = clampMemoryWeight(memory_weight);

  // Validate taskpad_filter
  const VALID_FILTERS = ['all', 'H_only', 'active'];
  let safeFilter = VALID_FILTERS.includes(taskpad_filter) ? taskpad_filter : 'active';
  if (taskpad_filter && !VALID_FILTERS.includes(taskpad_filter)) {
    warnings.push(`invalid_taskpad_filter_defaulted_to_active`);
    safeFilter = 'active';
  }

  // Generate embedding ONCE and reuse for both searches
  let embedding = null;
  try {
    embedding = await getEmbedding(query_str);
  } catch (e) {
    warnings.push(`embedding generation failed: ${e.message}`);
  }

  // Search memories
  let memoryResults = [];
  if (embedding) {
    try {
      memoryResults = await searchMemories(embedding, safeLimit);
    } catch (e) {
      warnings.push(`memory search failed: ${e.message}`);
    }
  }

  // Search tasks (sync, uses better-sqlite3 directly)
  let taskResults = [];
  if (embedding) {
    try {
      taskResults = searchTasksSync(embedding, { limit: safeLimit, taskpad_filter: safeFilter });
    } catch (e) {
      warnings.push(`taskpad search unavailable: ${e.message}`);
    }
  }

  // RRF merge
  const results = rrfMerge(memoryResults, taskResults, safeMemoryWeight);

  const response = {
    results,
    query: query_str,
    memory_count: memoryResults.length,
    taskpad_count: taskResults.length,
  };
  if (warnings.length > 0) {
    response.warnings = warnings;
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response, null, 2),
    }],
  };
}
