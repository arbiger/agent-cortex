/**
 * AC MVP-3 OpenCode Plugin — End-to-End Smoke Test
 *
 * PURPOSE
 *   Verifies the OpenCode plugin correctly captures session.idle and session.error
 *   events and writes them to the AC SQLite database via writeEvent().
 *
 * USAGE
 *   npm run test:e2e:mvp3
 *
 * ENVIRONMENT
 *   - Node.js >=18 (ESM)
 *   - CORTEX_SQLITE_PATH may be set to a temp DB (default: ~/Documents/.../agent_cortex.db)
 *   - The plugin reads from the REAL AC runtime at RUNTIME below
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(__dirname, '..', '..'); // repo root

// Use a temp DB so we don't pollute the real AC database
const tempDir = mkdtempSync(join(tmpdir(), 'ac-mvp3-e2e-'));
const DB_PATH = join(tempDir, 'test-mvp3.db');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function cleanup() {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Import the plugin directly (bypass OpenCode) ───────────────────────────────
const { AgentCortexPlugin } = await import(join(RUNTIME, 'scripts', 'agent-cortex-plugin', 'plugin.js'));

console.log('\n=== MVP-3 OpenCode Plugin E2E ===\n');
console.error(`[e2e] Using temp DB: ${DB_PATH}`);

// Set env before loading AC modules
process.env.CORTEX_SQLITE_PATH = DB_PATH;

// ── Test ───────────────────────────────────────────────────────────────────────
try {
  // Bootstrap the plugin with a fake OpenCode project context
  const hooks = await AgentCortexPlugin(
    { project: { directory: '/tmp/mvp3-test' } },
    { ac_runtime_path: RUNTIME }
  );

  ok('Plugin returns event hook', typeof hooks.event === 'function', `got ${typeof hooks.event}`);

  // Simulate a session lifecycle
  const sessionId = 'e2e-test-session-001';
  const startedAt = new Date('2026-06-25T10:00:00Z').toISOString();
  const endedAt = new Date('2026-06-25T10:05:00Z').toISOString();

  // session.created
  await hooks.event({
    event: {
      type: 'session.created',
      sessionID: sessionId,
      timestamp: startedAt,
    },
  });
  ok('session.created handled without throw', true);

  // session.idle (first time — should write event)
  await hooks.event({
    event: {
      type: 'session.idle',
      sessionID: sessionId,
      timestamp: endedAt,
      idleReason: 'user_inactive',
    },
  });
  ok('session.idle handled without throw', true);

  // session.idle (second time — should be deduped silently)
  await hooks.event({
    event: {
      type: 'session.idle',
      sessionID: sessionId,
      timestamp: new Date('2026-06-25T10:06:00Z').toISOString(),
    },
  });
  ok('second session.idle handled without throw (dedupe)', true);

  // session.error
  const errorSessionId = 'e2e-test-error-session';
  await hooks.event({
    event: {
      type: 'session.error',
      sessionID: errorSessionId,
      timestamp: new Date().toISOString(),
      message: 'test error: something broke',
    },
  });
  ok('session.error handled without throw', true);

  // ── Verify events landed in DB ──────────────────────────────────────────────
  const { getDb } = await import(join(RUNTIME, 'src', 'sqlite_store.js'));
  const db = getDb();

  // Check idle event
  const idleRows = db.prepare(`
    SELECT id, agent_tag, source_kind, content, memory_type, status, embedding_pending,
           json_extract(facts, '$.session_id') as session_id,
           json_extract(facts, '$.source_kind') as facts_source_kind,
           json_extract(facts, '$.metadata.message_count') as msg_count,
           json_extract(facts, '$.metadata.tool_call_count') as tool_count,
           json_extract(facts, '$.metadata.last_user_message_preview') as user_preview,
           json_extract(facts, '$.metadata.directory') as dir
    FROM memories
    WHERE agent_tag = 'opencode' AND json_extract(facts, '$.source_kind') = 'opencode-session-idle'
    ORDER BY created_at ASC
  `).all();

  ok(`idle event landed in DB`, idleRows.length >= 1, `got ${idleRows.length}`);
  if (idleRows.length > 0) {
    ok(`idle event has correct agent_tag`, idleRows[0].agent_tag === 'opencode');
    ok(`idle event has correct memory_type`, idleRows[0].memory_type === 'event');
    ok(`idle event has correct status`, idleRows[0].status === 'captured');
    ok(`idle event has embedding_pending=1`, idleRows[0].embedding_pending === 1);
    ok(`idle event content is non-empty`, idleRows[0].content && idleRows[0].content.length > 0);
    ok(`idle event content contains session timestamps`, idleRows[0].content.includes('2026-06-25'));
  }

  // Check error event
  const errorRows = db.prepare(`
    SELECT id, agent_tag, source_kind, content, memory_type,
           json_extract(facts, '$.source_kind') as facts_source_kind
    FROM memories
    WHERE agent_tag = 'opencode' AND json_extract(facts, '$.source_kind') = 'opencode-session-error'
  `).all();

  ok(`error event landed in DB`, errorRows.length >= 1, `got ${errorRows.length}`);
  if (errorRows.length > 0) {
    ok(`error event content mentions error`, errorRows[0].content.includes('test error'));
  }

  // Verify session.created without session.idle does NOT write an event
  const orphanSessionId = 'e2e-orphan-session';
  await hooks.event({
    event: { type: 'session.created', sessionID: orphanSessionId, timestamp: new Date().toISOString() },
  });
  // Do NOT emit idle — session should not appear in memories
  const orphanRows = db.prepare(`
    SELECT id FROM memories
    WHERE agent_tag = 'opencode' AND json_extract(facts, '$.session_id') = ?
  `).all(orphanSessionId);
  ok(`session.created alone does NOT write an event`, orphanRows.length === 0, `got ${orphanRows.length}`);

} catch (e) {
  fail++;
  failures.push(`uncaught exception: ${e.message}`);
  console.error('[e2e] exception:', e);
} finally {
  cleanup();
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log('FAILURES:', failures.join(', '));
  process.exit(1);
} else {
  console.log('All good.');
  process.exit(0);
}
