/**
 * Tests for src/episode_builder.js
 *
 * Test 1: Build episode from 3 captured events → episode row shape correct.
 * Test 2: After build, source events are status='grouped' with grouped_into_episode_id set.
 * Test 3: buildSessionEpisode throws on zero captured events.
 * Test 4: buildSessionEpisode throws on already-grouped session (no idempotent replay).
 * Test 5: deriveEpisodePeriod prefers facts.occurred_at over created_at.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('episode_builder', async () => {
  let sqlite_store;
  let writeEvent;
  let listEventsBySession;
  let parseFactsJson;
  let buildSessionEpisode;
  let deriveEpisodePeriod;

  before(async () => {
    process.env.CORTEX_SQLITE_PATH = ':memory:';
    sqlite_store = await import('../src/sqlite_store.js');
    sqlite_store.initSchema();
    const mod = await import('../src/episode_builder.js');
    buildSessionEpisode = mod.buildSessionEpisode;
    deriveEpisodePeriod = mod.deriveEpisodePeriod;
    const ei = await import('../src/event_ingest.js');
    writeEvent          = ei.writeEvent;
    listEventsBySession = ei.listEventsBySession;
    parseFactsJson      = ei.parseFactsJson;
  });

  after(() => {
    sqlite_store.closeDb();
    delete process.env.CORTEX_SQLITE_PATH;
  });

  it('Test 1: Build episode from 3 captured events — episode row has correct shape', async () => {
    // Write 3 captured events for session-episode-test
    const eventIds = [];
    for (let i = 0; i < 3; i++) {
      const id = await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-episode-1',
        source_kind: 'chat',
        content: `episode event ${i}`,
        occurred_at: new Date(2026, 5, 25, 10, i).toISOString(),
      });
      eventIds.push(id);
    }

    const episode = await buildSessionEpisode({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-episode-1',
      title: 'Test Episode Title',
      summary: 'Test episode summary text',
    });

    assert.ok(episode, 'buildSessionEpisode should return the episode row');
    assert.strictEqual(episode.memory_type, 'episode');
    assert.strictEqual(episode.status, 'grouped');
    assert.strictEqual(episode.source_kind, 'session');

    const facts = parseFactsJson(episode);
    assert.ok(facts, 'episode facts should parse');
    assert.deepStrictEqual(facts.source_event_ids, eventIds,
      `source_event_ids should match event IDs in order. Got: ${JSON.stringify(facts.source_event_ids)}`);
    assert.strictEqual(facts.event_count, 3);
    // period_start/period_end come from events' occurred_at (2026-06-25T10:00-02:00 through T10:02)
    assert.ok(episode.period_start !== null, 'period_start should be set from events');
    assert.ok(episode.period_end !== null, 'period_end should be set from events');
  });

  it('Test 2: After build, source events are status=grouped with grouped_into_episode_id set', async () => {
    const eventIds = [];
    for (let i = 0; i < 3; i++) {
      const id = await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-episode-2',
        source_kind: 'chat',
        content: `episode event ${i}`,
      });
      eventIds.push(id);
    }

    const episode = await buildSessionEpisode({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-episode-2',
      title: 'Episode 2',
      summary: 'Summary 2',
    });

    // Re-fetch events for this session
    const events = await listEventsBySession({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-episode-2',
      // includeGrouped: true to see all
    });

    for (const event of events) {
      assert.strictEqual(event.status, 'grouped',
        `Event ${event.id} should have status=grouped, got: ${event.status}`);
      const facts = parseFactsJson(event);
      assert.strictEqual(facts.grouped_into_episode_id, episode.id,
        `Event grouped_into_episode_id should be ${episode.id}, got: ${facts.grouped_into_episode_id}`);
    }
  });

  it('Test 3: buildSessionEpisode throws on zero captured events', async () => {
    try {
      await buildSessionEpisode({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-with-no-events',
        title: 'Empty Episode',
        summary: 'Summary',
      });
      assert.fail('Should throw when no captured events exist');
    } catch (e) {
      assert.ok(e.message.includes('No captured events found'),
        `Error should mention "No captured events found": ${e.message}`);
    }

    // Verify NO episode was created
    const rows = await sqlite_store.query(
      `SELECT id FROM memories WHERE memory_type = 'episode' AND json_extract(facts, '$.session_id') = ?`,
      ['session-with-no-events']
    );
    assert.strictEqual(rows.rows.length, 0, 'No episode should be created for empty session');
  });

  it('Test 4: buildSessionEpisode throws on already-grouped session (no idempotent replay)', async () => {
    // Write events and build first episode
    for (let i = 0; i < 3; i++) {
      await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-already-grouped',
        source_kind: 'chat',
        content: `event ${i}`,
      });
    }

    // First build should succeed
    await buildSessionEpisode({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-already-grouped',
      title: 'First Episode',
      summary: 'First summary',
    });

    // Second build should throw (no captured events left)
    try {
      await buildSessionEpisode({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-already-grouped',
        title: 'Second Episode',
        summary: 'Second summary',
      });
      assert.fail('Second build should throw');
    } catch (e) {
      assert.ok(e.message.includes('No captured events found'),
        `Error should mention "No captured events found": ${e.message}`);
    }
  });

  it('Test 5: deriveEpisodePeriod prefers facts.occurred_at over created_at', async () => {
    // Events where some have occurred_at in facts, some only have created_at
    const eventsWithOccurredAt = [
      { id: 'e1', created_at: '2026-06-25T12:00:00.000Z', facts: '{"occurred_at":"2026-06-25T08:00:00.000Z"}' },
      { id: 'e2', created_at: '2026-06-25T14:00:00.000Z', facts: '{"occurred_at":"2026-06-25T09:00:00.000Z"}' },
      { id: 'e3', created_at: '2026-06-25T16:00:00.000Z', facts: '{"occurred_at":null}' }, // should fall back to created_at
    ];
    const eventsWithoutOccurredAt = [
      { id: 'e4', created_at: '2026-06-25T11:00:00.000Z', facts: '{}' },
      { id: 'e5', created_at: '2026-06-25T15:00:00.000Z', facts: '{}' },
    ];

    const result1 = deriveEpisodePeriod(eventsWithOccurredAt);
    // e1: occurred_at=08:00, e2: occurred_at=09:00, e3: occurred_at=null → falls back to created_at=16:00
    assert.strictEqual(result1.period_start, '2026-06-25T08:00:00.000Z',
      'period_start should use earliest occurred_at');
    assert.strictEqual(result1.period_end, '2026-06-25T16:00:00.000Z',
      'period_end: e3 null occurred_at falls back to created_at=16:00 which is latest');

    // Mixed: e1/e2 have occurred_at, e3 falls back
    // So period_start = min(08:00, 09:00, 16:00) = 08:00 ✓
    // period_end = max(08:00, 09:00, 16:00) = 16:00 ✓

    const result2 = deriveEpisodePeriod(eventsWithoutOccurredAt);
    assert.strictEqual(result2.period_start, '2026-06-25T11:00:00.000Z');
    assert.strictEqual(result2.period_end, '2026-06-25T15:00:00.000Z');

    // Empty
    const result3 = deriveEpisodePeriod([]);
    assert.strictEqual(result3.period_start, null);
    assert.strictEqual(result3.period_end, null);
  });
});
