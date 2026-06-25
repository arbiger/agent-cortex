/**
 * Regression tests for MVP-1 memory hierarchy schema additions.
 *
 * Test 1: After applySchema, PRAGMA table_info(memories) includes the 4 new columns.
 * Test 2: Calling applySchema twice does not throw (idempotent).
 * Test 3: Legacy row insert with NULL hierarchy columns reads back successfully.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

describe('memory_hierarchy_schema', async () => {
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

  it('Test 1: applySchema adds status, source_kind, period_start, period_end columns', async () => {
    const info = sqlite_store.getDb().prepare(`PRAGMA table_info(memories)`).all();
    const colNames = info.map(c => c.name);

    assert.ok(colNames.includes('status'),       `status column missing. Found: ${colNames.join(', ')}`);
    assert.ok(colNames.includes('source_kind'),  `source_kind column missing. Found: ${colNames.join(', ')}`);
    assert.ok(colNames.includes('period_start'), `period_start column missing. Found: ${colNames.join(', ')}`);
    assert.ok(colNames.includes('period_end'),   `period_end column missing. Found: ${colNames.join(', ')}`);
  });

  it('Test 2: applySchema is idempotent (calling twice does not throw)', async () => {
    // Should not throw
    sqlite_store.initSchema();
    // Verify columns still present
    const info = sqlite_store.getDb().prepare(`PRAGMA table_info(memories)`).all();
    const colNames = info.map(c => c.name);
    assert.ok(colNames.includes('status'));
    assert.ok(colNames.includes('source_kind'));
    assert.ok(colNames.includes('period_start'));
    assert.ok(colNames.includes('period_end'));
  });

  it('Test 3: Legacy row insert with NULL hierarchy columns reads back successfully', async () => {
    // Insert a row using only legacy columns (NULL for new hierarchy columns)
    const result = await sqlite_store.query(
      `INSERT INTO memories (id, agent_tag, source_file, content)
       VALUES (?, ?, ?, ?)`,
      ['legacy-test-1', 'test-agent', 'test.md', 'legacy memory content']
    );
    assert.strictEqual(result.rowCount, 1);

    // Read it back
    const rows = await sqlite_store.query(
      `SELECT id, agent_tag, content, memory_type, status, source_kind, period_start, period_end
       FROM memories WHERE id = ?`,
      ['legacy-test-1']
    );
    assert.strictEqual(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.strictEqual(row.id, 'legacy-test-1');
    assert.strictEqual(row.status, null);      // NULL means legacy/undefined
    assert.strictEqual(row.source_kind, null);
    assert.strictEqual(row.period_start, null);
    assert.strictEqual(row.period_end, null);
  });
});
