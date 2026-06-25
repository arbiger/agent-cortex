/**
 * Episode Builder — aggregates captured events into session episodes.
 *
 * Exported functions:
 *   buildSessionEpisode({ store, agent_tag, session_id, title, summary, topic_key })
 *   deriveEpisodePeriod(events)
 */
import { randomUUID } from 'crypto';
import { getDb } from './sqlite_store.js';
import { listEventsBySession, parseFactsJson } from './event_ingest.js';

/**
 * Derive period_start and period_end from a list of events.
 * Prefers facts.occurred_at over created_at when available.
 *
 * @param {Array} events — rows from listEventsBySession
 * @returns {{ period_start: string|null, period_end: string|null }}
 */
export function deriveEpisodePeriod(events) {
  if (!events || events.length === 0) {
    return { period_start: null, period_end: null };
  }

  const timestamps = events.map(e => {
    const facts = parseFactsJson(e);
    // Prefer facts.occurred_at, fall back to created_at
    return (facts && facts.occurred_at) || e.created_at || null;
  }).filter(Boolean);

  if (timestamps.length === 0) {
    return { period_start: null, period_end: null };
  }

  // Sort ISO strings lexicographically — works because ISO dates are sortable
  const sorted = [...timestamps].sort();

  return {
    period_start: sorted[0],
    period_end:   sorted[sorted.length - 1],
  };
}

/**
 * Build a session episode from all captured events belonging to the session.
 *
 * ALL operations happen in ONE SQLite transaction via the underlying
 * better-sqlite3 getDb() instance (synchronous batch inside db.transaction()).
 *
 * @param {object} opts
 * @param {object}  opts.store      — db.js facade
 * @param {string}  opts.agent_tag
 * @param {string}  opts.session_id
 * @param {string}  opts.title
 * @param {string}  opts.summary
 * @param {string}  [opts.topic_key]
 * @returns {Promise<object>} the new episode row
 */
export async function buildSessionEpisode({ store, agent_tag, session_id, title, summary, topic_key }) {
  // Fetch captured events for this session
  const capturedEvents = await listEventsBySession({
    store,
    agent_tag,
    session_id,
    status: 'captured',
  });

  if (capturedEvents.length === 0) {
    throw new Error(`No captured events found for session_id: ${session_id}`);
  }

  // Derive period from events
  const { period_start, period_end } = deriveEpisodePeriod(capturedEvents);

  const source_event_ids = capturedEvents.map(e => e.id);
  const episode_id = randomUUID();
  const now = new Date().toISOString();

  const episodeFacts = {
    layer: 'episode',
    session_id,
    source_event_ids,
    event_count: capturedEvents.length,
    title: title || '',
    summary: summary || '',
    candidate_facts: [],
    candidate_questions: [],
  };

  const episodeContent = `# ${title || 'Session Episode'}\n\n${summary || ''}`;

  // Synchronous transaction block using better-sqlite3
  const db = getDb();
  db.transaction(() => {
    // Insert episode row
    db.prepare(
      `INSERT INTO memories
         (id, agent_tag, source_file, topic_key, content, facts, narrative,
          memory_type, status, source_kind, period_start, period_end,
          embedding_pending, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'episode', 'grouped', 'session', ?, ?,
               1, 0, ?, ?)`
    ).run(
      episode_id,
      agent_tag,
      'episode_builder',
      topic_key || null,
      episodeContent,
      JSON.stringify(episodeFacts),
      summary || null,
      period_start || null,
      period_end || null,
      now,
      now
    );

    // Update each captured event to grouped
    for (const event of capturedEvents) {
      const facts = parseFactsJson(event) || {};
      facts.grouped_into_episode_id = episode_id;

      db.prepare(
        `UPDATE memories
         SET status = 'grouped', facts = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(facts),
        now,
        event.id
      );
    }
  })();

  // Fetch and return the episode row
  const episodeResult = await store.query(
    `SELECT * FROM memories WHERE id = ?`,
    [episode_id]
  );

  return episodeResult.rows[0];
}
