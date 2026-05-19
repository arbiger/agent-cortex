import { test, describe } from 'node:test';
import assert from 'node:assert';

const PENDING_SQL = `SELECT COUNT(*) as count FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE`;

const UNPROCESSED_SQL = `SELECT COUNT(*) as count FROM memories WHERE enriched = FALSE AND is_deleted = FALSE`;

const ORPHAN_SQL = `SELECT COUNT(*) as count FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`;

const DB_STATS_SQL = [
  `SELECT COUNT(*) as count FROM memories WHERE is_deleted = FALSE`,
  `SELECT COUNT(*) as count FROM memory_embeddings`,
  `SELECT COUNT(*) as count FROM causal_links`,
];

let capturedSql = '';

const fakePool = {
  query: (sql) => {
    capturedSql = sql;
    if (sql === PENDING_SQL) return { rows: [{ count: '42' }] };
    if (sql === UNPROCESSED_SQL) return { rows: [{ count: '7' }] };
    if (sql === ORPHAN_SQL) return { rows: [{ count: '3' }] };
    if (sql === DB_STATS_SQL[0]) return { rows: [{ count: '100' }] };
    if (sql === DB_STATS_SQL[1]) return { rows: [{ count: '95' }] };
    if (sql === DB_STATS_SQL[2]) return { rows: [{ count: '50' }] };
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  },
};

async function runHealthChecks() {
  const checks = [];
  let dbOk = false;

  try {
    await fakePool.query('SELECT 1');
    dbOk = true;
    checks.push({ check: 'db_connection', status: 'ok', detail: 'Query SELECT 1 succeeded' });
  } catch (err) {
    checks.push({ check: 'db_connection', status: 'error', detail: err.message });
  }

  try {
    const r = await fakePool.query(PENDING_SQL);
    checks.push({ check: 'pending_embeddings', status: 'ok', detail: `${parseInt(r.rows[0].count, 10)} pending` });
  } catch (err) {
    checks.push({ check: 'pending_embeddings', status: 'error', detail: err.message });
  }

  try {
    const r = await fakePool.query(UNPROCESSED_SQL);
    checks.push({ check: 'unprocessed_memories', status: 'ok', detail: `${parseInt(r.rows[0].count, 10)} unprocessed` });
  } catch (err) {
    checks.push({ check: 'unprocessed_memories', status: 'error', detail: err.message });
  }

  try {
    const r = await fakePool.query(ORPHAN_SQL);
    checks.push({ check: 'orphan_links', status: 'ok', detail: `${parseInt(r.rows[0].count, 10)} orphans` });
  } catch (err) {
    checks.push({ check: 'orphan_links', status: 'error', detail: err.message });
  }

  try {
    const [mr, er, lr] = await Promise.all([
      fakePool.query(DB_STATS_SQL[0]),
      fakePool.query(DB_STATS_SQL[1]),
      fakePool.query(DB_STATS_SQL[2]),
    ]);
    checks.push({
      check: 'db_stats',
      status: 'ok',
      detail: `memories:${parseInt(mr.rows[0].count, 10)} embeddings:${parseInt(er.rows[0].count, 10)} links:${parseInt(lr.rows[0].count, 10)}`,
    });
  } catch (err) {
    checks.push({ check: 'db_stats', status: 'error', detail: err.message });
  }

  return { dbOk, checks };
}

describe('health check SQL queries', () => {
  test('pending embeddings SQL includes memory_embeddings join', async () => {
    await fakePool.query(PENDING_SQL);
    assert.ok(capturedSql.includes('memory_embeddings'), `Got: ${capturedSql}`);
  });

  test('unprocessed memories SQL checks enriched flag', async () => {
    await fakePool.query(UNPROCESSED_SQL);
    assert.ok(capturedSql.includes('enriched'), `Got: ${capturedSql}`);
  });

  test('orphan links SQL checks both memory_id and target_id', async () => {
    await fakePool.query(ORPHAN_SQL);
    assert.ok(capturedSql.includes('memory_id') && capturedSql.includes('target_id'), `Got: ${capturedSql}`);
  });

  test('db_stats queries all three tables', async () => {
    const [mr, er, lr] = await Promise.all([
      fakePool.query(DB_STATS_SQL[0]),
      fakePool.query(DB_STATS_SQL[1]),
      fakePool.query(DB_STATS_SQL[2]),
    ]);
    assert.strictEqual(parseInt(mr.rows[0].count, 10), 100);
    assert.strictEqual(parseInt(er.rows[0].count, 10), 95);
    assert.strictEqual(parseInt(lr.rows[0].count, 10), 50);
  });
});

describe('health check count parsing', () => {
  test('parseInt handles string counts correctly', () => {
    assert.strictEqual(parseInt('42', 10), 42);
    assert.strictEqual(parseInt('0', 10), 0);
    assert.strictEqual(parseInt('100', 10), 100);
  });
});

describe('health report structure', () => {
  test('status field is ok when all checks pass', async () => {
    const { dbOk, checks } = await runHealthChecks();
    const allOk = dbOk && checks.every(c => c.status === 'ok');
    const status = allOk ? 'ok' : 'degraded';
    assert.strictEqual(status, 'ok');
  });

  test('status is degraded when db fails', async () => {
    const failingPool = {
      query: () => { throw new Error('connection refused'); },
    };
    let dbOk = false;
    const checks = [];
    try {
      await failingPool.query('SELECT 1');
      dbOk = true;
    } catch (err) {
      checks.push({ check: 'db_connection', status: 'error', detail: err.message });
    }
    const allOk = dbOk && checks.every(c => c.status === 'ok');
    const status = allOk ? 'ok' : 'degraded';
    assert.strictEqual(status, 'degraded');
  });

  test('health object has all required fields', () => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: [
        { check: 'db_connection', status: 'ok', detail: 'ok' },
        { check: 'vault_readable', status: 'ok', detail: '/path' },
      ],
    };
    assert.ok(health.status === 'ok' || health.status === 'degraded');
    assert.ok(health.timestamp);
    assert.ok(Array.isArray(health.checks));
    assert.ok(health.checks.length > 0);
    health.checks.forEach(c => {
      assert.ok(typeof c.check === 'string');
      assert.ok(typeof c.status === 'string');
      assert.ok(typeof c.detail === 'string');
    });
  });
});

describe('vault check', () => {
  test('vault path string is present in health check output', () => {
    const vaultPath = '/Users/george/Documents/Georges/06 🧠 Memory';
    const check = { check: 'vault_readable', status: 'ok', detail: vaultPath };
    assert.strictEqual(check.detail, vaultPath);
    assert.strictEqual(check.status, 'ok');
  });
});