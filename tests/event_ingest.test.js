/**
 * Tests for src/event_ingest.js
 *
 * Test 1: Write 10 events for session-123, all return IDs, query returns exactly 10.
 * Test 2: Write 10 to session A, 2 to session B; listEventsBySession(A) returns 10.
 * Test 3: Validation rejects missing/empty required fields and bad metadata types.
 * Test 4: facts JSON parses and contains expected fields.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('event_ingest', async () => {
  let sqlite_store;
  let writeEvent;
  let listEventsBySession;
  let parseFactsJson;

  before(async () => {
    process.env.CORTEX_SQLITE_PATH = ':memory:';
    sqlite_store = await import('../src/sqlite_store.js');
    sqlite_store.initSchema();
    const mod = await import('../src/event_ingest.js');
    writeEvent         = mod.writeEvent;
    listEventsBySession = mod.listEventsBySession;
    parseFactsJson     = mod.parseFactsJson;
  });

  after(() => {
    sqlite_store.closeDb();
    delete process.env.CORTEX_SQLITE_PATH;
  });

  it('Test 1: Write 10 events for session-123, verify IDs returned and retrievable', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const id = await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-123',
        source_kind: 'chat',
        content: `event content ${i}`,
        occurred_at: new Date(2026, 0, 1, 0, i).toISOString(),
      });
      assert.ok(id, `writeEvent should return an id for event ${i}`);
      ids.push(id);
    }

    const events = await listEventsBySession({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-123',
    });

    assert.strictEqual(events.length, 10, 'Should have exactly 10 events for session-123');
    assert.ok(events.every(e => e.memory_type === 'event'), 'All rows should have memory_type=event');
    assert.ok(events.every(e => e.status === 'captured'), 'All rows should have status=captured');
  });

  it('Test 2: Sessions are isolated — 10 to A, 2 to B; list(A) returns 10', async () => {
    for (let i = 0; i < 10; i++) {
      await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-A',
        source_kind: 'chat',
        content: `event for A ${i}`,
      });
    }
    for (let i = 0; i < 2; i++) {
      await writeEvent({
        store: sqlite_store,
        agent_tag: 'test-agent',
        session_id: 'session-B',
        source_kind: 'chat',
        content: `event for B ${i}`,
      });
    }

    const eventsA = await listEventsBySession({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-A',
    });
    assert.strictEqual(eventsA.length, 10, 'Should have exactly 10 events for session-A');
  });

  it('Test 3: Validation rejects missing/empty required fields and bad metadata', async () => {
    // Missing agent_tag
    await writeEvent({
      store: sqlite_store,
      session_id: 's1', source_kind: 'chat', content: 'c'
    }).then(() => assert.fail('Should throw on missing agent_tag'))
      .catch(e => assert.ok(e.message.includes('agent_tag'), `Error should mention agent_tag: ${e.message}`));

    // Missing session_id
    await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent', source_kind: 'chat', content: 'c'
    }).then(() => assert.fail('Should throw on missing session_id'))
      .catch(e => assert.ok(e.message.includes('session_id'), `Error should mention session_id: ${e.message}`));

    // Missing source_kind
    await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent', session_id: 's1', content: 'c'
    }).then(() => assert.fail('Should throw on missing source_kind'))
      .catch(e => assert.ok(e.message.includes('source_kind'), `Error should mention source_kind: ${e.message}`));

    // Empty content
    await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent', session_id: 's1', source_kind: 'chat', content: '   '
    }).then(() => assert.fail('Should throw on empty content'))
      .catch(e => assert.ok(e.message.includes('content'), `Error should mention content: ${e.message}`));

    // Metadata as array — should throw
    await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent', session_id: 's1', source_kind: 'chat', content: 'c',
      metadata: [1, 2, 3]
    }).then(() => assert.fail('Should throw on metadata array'))
      .catch(e => assert.ok(e.message.includes('metadata'), `Error should mention metadata: ${e.message}`));

    // Metadata as string — should throw
    await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent', session_id: 's1', source_kind: 'chat', content: 'c',
      metadata: 'not-an-object'
    }).then(() => assert.fail('Should throw on metadata string'))
      .catch(e => assert.ok(e.message.includes('metadata'), `Error should mention metadata: ${e.message}`));
  });

  it('Test 4: facts JSON contains expected fields including layer=event and grouped_into_episode_id=null', async () => {
    const id = await writeEvent({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-facts-check',
      source_kind: 'chat',
      source_ref: 'msg-42',
      content: 'test content',
      occurred_at: '2026-06-25T10:00:00.000Z',
      metadata: { foo: 'bar' },
    });

    const rows = await listEventsBySession({
      store: sqlite_store,
      agent_tag: 'test-agent',
      session_id: 'session-facts-check',
    });
    assert.strictEqual(rows.length, 1);

    const facts = parseFactsJson(rows[0]);
    assert.ok(facts, 'facts should parse');
    assert.strictEqual(facts.layer, 'event', `layer should be 'event', got: ${JSON.stringify(facts)}`);
    assert.strictEqual(facts.session_id, 'session-facts-check');
    assert.strictEqual(facts.source_kind, 'chat');
    assert.strictEqual(facts.source_ref, 'msg-42');
    assert.strictEqual(facts.occurred_at, '2026-06-25T10:00:00.000Z');
    assert.strictEqual(facts.metadata.foo, 'bar');
    assert.strictEqual(facts.grouped_into_episode_id, null,
      `grouped_into_episode_id should be null, got: ${facts.grouped_into_episode_id}`);
  });
});
