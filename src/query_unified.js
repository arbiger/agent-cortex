import pg from 'pg';
import { loadConfig } from './config.js';
import { getEmbedding } from './embedding.js';

const { Pool } = pg;

// Separate pool for taskdb
let _taskdbPool = null;

function getTaskdbPool() {
  if (!_taskdbPool) {
    _taskdbPool = new Pool({
      connectionString: process.env.CORTEX_TASKDB_CONN
        || 'postgresql://george@localhost:5432/taskdb',
    });
  }
  return _taskdbPool;
}

function scoreFromDistance(dist) {
  // pgvector <=> operator returns cosine distance; similarity = 1 - distance
  return 1 - (parseFloat(dist) || 0);
}

/**
 * Search agent_cortex memories via semantic similarity.
 */
async function searchMemories(query_str, limit = 10) {
  const embedding = await getEmbedding(query_str);
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.PG_CONN });
  const vec = '[' + embedding.join(',') + ']';

  try {
    const result = await pool.query(`
      SELECT m.id, m.content, m.topic_key, m.agent_tag, m.created_at,
             1 - (e.embedding <=> $1::vector) AS similarity
      FROM memories m
      JOIN memory_embeddings e ON m.id = e.memory_id
      WHERE m.is_deleted = FALSE
      ORDER BY similarity DESC
      LIMIT $2
    `, [vec, limit]);

    return result.rows.map(r => ({
      type: 'memory',
      id: r.id,
      topic_key: r.topic_key,
      agent_tag: r.agent_tag,
      content: r.content,
      score: scoreFromDistance(r.similarity),
      created_at: r.created_at,
    }));
  } finally {
    await pool.end();
  }
}

/**
 * Search taskdb tasks via semantic similarity.
 */
async function searchTasks(query_str, limit = 10, taskpad_filter = 'active') {
  const embedding = await getEmbedding(query_str);
  const pool = getTaskdbPool();
  const vec = '[' + embedding.join(',') + ']';

  let extra = '';
  if (taskpad_filter === 'H_only') {
    extra = "AND t.priority = 'H'";
  } else if (taskpad_filter === 'all') {
    extra = '';
  }

  const result = await pool.query(`
    SELECT t.task_code, t.title, t.assignee, t.priority, t.status, t.updated_at,
           1 - (e.embedding <=> $1::vector) AS similarity
    FROM tasks t
    JOIN task_embeddings e ON t.id = e.task_id
    WHERE t.status IN ('A', 'P') ${extra}
    ORDER BY similarity DESC
    LIMIT $2
  `, [vec, limit]);

  return result.rows.map(r => ({
    type: 'taskpad',
    task_code: r.task_code,
    title: r.title,
    assignee: r.assignee,
    priority: r.priority,
    status: r.status,
    score: scoreFromDistance(r.similarity),
    updated_at: r.updated_at,
  }));
}

/**
 * Reciprocal Rank Fusion of memory and task results.
 */
function rrfMerge(memoryResults, taskpadResults, memory_weight = 0.6) {
  const k = 60;
  const taskpad_weight = 1 - memory_weight;
  const combined = new Map();

  memoryResults.forEach((item, idx) => {
    combined.set(item.id, {
      ...item,
      fused_score: memory_weight * (1 / (k + idx + 1)),
    });
  });

  taskpadResults.forEach((item, idx) => {
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

  return Array.from(combined.values()).sort((a, b) => b.fused_score - a.fused_score);
}

/**
 * Main handler for query_unified tool.
 * Called by dist/server.js when the 'query_unified' tool is invoked.
 */
export async function handleQueryUnified(args) {
  const {
    query: query_str,
    limit = 10,
    memory_weight = 0.6,
    taskpad_filter = 'active',
  } = args;

  const [memoryResults, taskpadResults] = await Promise.all([
    searchMemories(query_str, limit),
    searchTasks(query_str, limit, taskpad_filter),
  ]);

  const results = rrfMerge(memoryResults, taskpadResults, memory_weight);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        results,
        query: query_str,
        memory_count: memoryResults.length,
        taskpad_count: taskpadResults.length,
      }, null, 2),
    }],
  };
}