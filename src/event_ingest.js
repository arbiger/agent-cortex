/**
 * Event Ingestion — writes raw event records into the memories table.
 *
 * Exported functions:
 *   writeEvent({ store, agent_tag, session_id, source_kind, source_ref, content, topic_key, occurred_at, metadata })
 *   listEventsBySession({ store, agent_tag, session_id, status, includeGrouped })
 *   parseFactsJson(row)
 */
import { randomUUID } from 'crypto';

/**
 * Validate writeEvent input, throwing descriptive errors.
 * @param {object} args
 */
function validateWriteEventInput({ agent_tag, session_id, source_kind, content, metadata }) {
  if (!agent_tag || typeof agent_tag !== 'string' || !agent_tag.trim()) {
    throw new Error('agent_tag is required and must be a non-empty string');
  }
  if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
    throw new Error('session_id is required and must be a non-empty string');
  }
  if (!source_kind || typeof source_kind !== 'string' || !source_kind.trim()) {
    throw new Error('source_kind is required and must be a non-empty string');
  }
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required and must be a non-empty string');
  }
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata === 'string') {
      throw new Error('metadata must be a plain object if provided, not a string');
    }
    if (Array.isArray(metadata)) {
      throw new Error('metadata must be a plain object if provided, not an array');
    }
    if (typeof metadata !== 'object') {
      throw new Error('metadata must be a plain object if provided');
    }
  }
}

/**
 * Write a single event into the memories table.
 *
 * @param {object} opts
 * @param {object}   opts.store          — the db.js facade (must expose .query())
 * @param {string}   opts.agent_tag       — required
 * @param {string}   opts.session_id      — required
 * @param {string}   opts.source_kind     — required, free non-empty string
 * @param {string}   [opts.source_ref]    — optional, free string
 * @param {string}   opts.content         — required, non-empty
 * @param {string}   [opts.topic_key]     — optional
 * @param {string}   [opts.occurred_at]   — optional, ISO date string
 * @param {object}   [opts.metadata]     — optional, plain object
 * @returns {Promise<string>} memory id
 */
export async function writeEvent({ store, agent_tag, session_id, source_kind, source_ref, content, topic_key, occurred_at, metadata }) {
  validateWriteEventInput({ agent_tag, session_id, source_kind, content, metadata });

  const id = randomUUID();
  const factsPayload = {
    layer: 'event',
    session_id,
    source_kind: source_kind.trim(),
    source_ref: source_ref || null,
    occurred_at: occurred_at || null,
    metadata: metadata || null,
    grouped_into_episode_id: null,
  };

  await store.query(
    `INSERT INTO memories
       (id, agent_tag, source_file, topic_key, content, facts,
        memory_type, status, embedding_pending, is_deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'event', 'captured', 1, 0, datetime('now'), datetime('now'))`,
    [
      id,
      agent_tag.trim(),
      source_ref || 'event_ingest',
      topic_key || null,
      content,
      JSON.stringify(factsPayload),
    ]
  );

  return id;
}

/**
 * List events for a session.
 *
 * @param {object} opts
 * @param {object}  opts.store
 * @param {string}  opts.agent_tag
 * @param {string}  opts.session_id
 * @param {string}  [opts.status]       — filter by status (e.g. 'captured', 'grouped')
 * @param {boolean} [opts.includeGrouped] — if true and no status filter, include grouped events
 * @returns {Promise<Array>} rows
 */
export async function listEventsBySession({ store, agent_tag, session_id, status, includeGrouped }) {
  let sql = `SELECT * FROM memories
             WHERE agent_tag = ? AND memory_type = 'event' AND is_deleted = 0`;
  const params = [agent_tag];

  if (session_id) {
    // Filter by session_id via JSON extraction from facts
    sql += ` AND json_extract(facts, '$.session_id') = ?`;
    params.push(session_id);
  }

  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  } else if (!includeGrouped) {
    // By default exclude grouped events
    sql += ` AND (status IS NULL OR status != 'grouped')`;
  }

  sql += ` ORDER BY created_at ASC`;

  const result = await store.query(sql, params);
  return result.rows;
}

/**
 * Parse the facts JSON column safely.
 * @param {object} row
 * @returns {object|null}
 */
export function parseFactsJson(row) {
  if (!row || !row.facts) return null;
  if (typeof row.facts === 'object') return row.facts;
  try {
    return JSON.parse(row.facts);
  } catch {
    return null;
  }
}
