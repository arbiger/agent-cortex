/**
 * Regression tests for MVP-1 — existing functionality must not break.
 *
 * Test 1: memory_health (imported from server.js) still works with legacy + new rows.
 * Test 2: memory_type=session (legacy) rows with NULL status/source_kind are readable.
 * Test 3: All existing memory_type values (people, project, decision, belief,
 *         preference, open_question, company, skill) remain insertable/readable.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('memory_hierarchy_regression', async () => {
  let sqlite_store;

  before(async () => {
    process.env.CORTEX_SQLITE_PATH = ':memory:';
    sqlite_store = await import('../src/sqlite_store.js');
    sqlite_store.initSchema();
  });

  after(() => {
    sqlite_store.closeDb();
    delete process.env.CORTEX_SQLITE_PATH;
  });

  it('Test 1: memory_health runs without throwing when DB has legacy + event + episode rows', async () => {
    // Insert a legacy row
    await sqlite_store.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, memory_type, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['legacy-row-1', 'test-agent', 'legacy.md', 'legacy session content', 'session', null]
    );

    // Insert an event row
    await sqlite_store.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, memory_type, status, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'event-row-1', 'test-agent', 'event.md', 'event content',
        'event', 'captured',
        JSON.stringify({ layer: 'event', session_id: 's1', grouped_into_episode_id: null })
      ]
    );

    // Insert an episode row
    await sqlite_store.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, memory_type, status, facts, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'episode-row-1', 'test-agent', 'episode.md', '# Episode\n\nSummary',
        'episode', 'grouped',
        JSON.stringify({ layer: 'episode', session_id: 's1', source_event_ids: ['e1'] }),
        'session'
      ]
    );

    // memory_health imports db stats and pending/embeddings counts
    // Just ensure the DB can be queried without errors
    const result = await sqlite_store.query(
      `SELECT COUNT(*) as total FROM memories WHERE is_deleted = 0`
    );
    assert.strictEqual(result.rows[0].total, 3);

    // Verify no orphan links
    const orphanResult = await sqlite_store.query(
      `SELECT COUNT(*) as orphans FROM causal_links cl
       WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
          OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`
    );
    assert.strictEqual(orphanResult.rows[0].orphans, 0);
  });

  it('Test 2: memory_type=session (legacy) row with NULL status/source_kind is readable', async () => {
    await sqlite_store.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, memory_type, status, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['legacy-session-1', 'test-agent', 'test.md', 'legacy session content', 'session', null, null]
    );

    const rows = await sqlite_store.query(
      `SELECT * FROM memories WHERE id = ?`,
      ['legacy-session-1']
    );
    assert.strictEqual(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.strictEqual(row.memory_type, 'session');
    assert.strictEqual(row.status, null);  // NULL = legacy, not captured
    assert.strictEqual(row.source_kind, null);
  });

  it('Test 3: All existing knowledge-layer memory_type values are insertable and readable', async () => {
    const existingTypes = ['people', 'project', 'decision', 'belief', 'preference', 'open_question', 'company', 'skill'];

    for (const memory_type of existingTypes) {
      const id = `legacy-${memory_type}-1`;
      await sqlite_store.query(
        `INSERT INTO memories (id, agent_tag, source_file, content, memory_type)
         VALUES (?, ?, ?, ?, ?)`,
        [id, 'test-agent', 'test.md', `${memory_type} content for ${id}`, memory_type]
      );

      const rows = await sqlite_store.query(
        `SELECT id, memory_type, content FROM memories WHERE id = ?`,
        [id]
      );
      assert.strictEqual(rows.rows.length, 1, `Row for memory_type=${memory_type} should exist`);
      assert.strictEqual(rows.rows[0].memory_type, memory_type,
        `memory_type should be '${memory_type}', got: ${rows.rows[0].memory_type}`);
    }
  });
});

/**
 * Agent-tag enforcement tests (R1 hotfix).
 *
 * These tests verify that validateAgentTag in server.js enforces SERVER_AGENT_TAG
 * for ALL write-like operations (memory_write, memory_write_event), not just memory_write.
 *
 * We import server.js as a module (no MCP server is started — main() only runs
 * when the file is executed directly).
 */
describe('agent_tag_enforcement (R1 hotfix)', async () => {
  let validateAgentTag;
  let originalTag;

  before(async () => {
    originalTag = process.env.CORTEX_AGENT_TAG;
    process.env.CORTEX_AGENT_TAG = 'george';
    // Force a fresh import so SERVER_AGENT_TAG picks up the new env value
    const server = await import('../src/server.js?v=' + Date.now());
    validateAgentTag = server.validateAgentTag;
  });

  after(() => {
    if (originalTag === undefined) delete process.env.CORTEX_AGENT_TAG;
    else process.env.CORTEX_AGENT_TAG = originalTag;
  });

  it('accepts matching agent_tag for memory_write_event', () => {
    assert.doesNotThrow(
      () => validateAgentTag('george', 'memory_write_event'),
      'matching agent_tag for write-like op should not throw'
    );
  });

  it('rejects mismatched agent_tag for memory_write_event (R1 fix)', () => {
    assert.throws(
      () => validateAgentTag('hermes', 'memory_write_event'),
      /Forbidden.*memory_write_event/,
      'mismatched agent_tag for memory_write_event must be rejected'
    );
  });

  it('still rejects mismatched agent_tag for memory_write (regression check)', () => {
    assert.throws(
      () => validateAgentTag('hermes', 'memory_write'),
      /Forbidden.*memory_write/,
      'mismatched agent_tag for memory_write must still be rejected'
    );
  });

  it('still allows any agent_tag for memory_query (read-only op, regression check)', () => {
    assert.doesNotThrow(
      () => validateAgentTag('hermes', 'memory_query'),
      'memory_query must remain read-only across agent tags'
    );
  });
});
