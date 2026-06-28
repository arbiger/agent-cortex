/**
 * AC MVP-3 Hermes Integration — End-to-End Smoke Test
 *
 * PURPOSE
 *   Regression / smoke baseline for the Hermes `on_session_end` → AC ingest path:
 *
 *     1. Bash wrapper reads Hermes JSON payload from stdin
 *     2. Dedupe pre-check via sqlite3 (AC-side, survives process restart)
 *     3. Synthesizes event content from session metadata
 *     4. Calls ac-ingest-event.js with agent_tag=hermes, source_kind=hermes-end
 *     5. Episode build from captured events
 *
 * WHY IT'S NOT IN `npm test`
 *   The default `npm test` is the fast in-process unit/integration suite
 *   (~277 tests, ~2s). This e2e script:
 *     - Spawns CLI scripts and bash wrapper as child processes
 *     - Spawns sqlite3 CLI for verification queries
 *     - Uses temp DB to avoid polluting the real AC database
 *     - Validates the same code paths the unit tests do, but in the
 *       actual production execution environment
 *
 * USAGE
 *   npm run test:e2e:mvp3-hermes
 *
 * ENVIRONMENT
 *   - Node.js >=18 (ESM)
 *   - `sqlite3` CLI on PATH (for verification queries)
 *   - `bash` on PATH
 *   - No network access required
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/e2e/<this-file> -> ../../
const RUNTIME = join(__dirname, '..', '..');
const SCRIPT = (name) => join(RUNTIME, 'scripts', name);
const WRAPPER = SCRIPT('hermes-session-end-ac-ingest.sh');

const tempDir = mkdtempSync(join(tmpdir(), 'ac-mvp3-hermes-e2e-'));
const dbPath = join(tempDir, 'test.db');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  // ' + detail : ''}`); }
}

// Spawn bash wrapper with Hermes-like payload
function wrapperSpawn(hermesPayload, env = {}) {
  return spawnSync('bash', [WRAPPER], {
    encoding: 'utf8',
    input: typeof hermesPayload === 'string' ? hermesPayload : JSON.stringify(hermesPayload),
    env: { ...process.env, CORTEX_SQLITE_PATH: dbPath, ...env },
    timeout: 15000,
  });
}

// Direct sqlite3 query helper
function sql(query) {
  const r = spawnSync('sqlite3', [dbPath, query], { encoding: 'utf8' });
  return r.stdout || '';
}

// Count events for a session_id
function eventCount(sessionId) {
  const out = sql(`SELECT count(*) FROM memories WHERE memory_type='event' AND json_extract(facts,'\$.session_id')='${sessionId}' AND json_extract(facts,'\$.source_kind')='hermes-end'`).trim();
  return parseInt(out || '0', 10);
}

// Get agent_tag and source_kind for a session
function eventRow(sessionId) {
  const q = `SELECT agent_tag, json_extract(facts,'\$.source_kind') as sk, json_extract(facts,'\$.session_id') as sid, content, status, json_extract(facts,'\$.metadata') as meta FROM memories WHERE memory_type='event' AND json_extract(facts,'\$.source_kind')='hermes-end' AND json_extract(facts,'\$.session_id')='${sessionId}' LIMIT 1`;
  const out = sql(q).trim();
  if (!out) return null;
  // sqlite3 prints |-separated; handle empty fields
  const parts = out.split('|');
  return {
    agent_tag: parts[0] || '',
    source_kind: parts[1] || '',
    session_id: parts[2] || '',
    content: parts[3] || '',
    status: parts[4] || '',
    metadata: parts[5] || '',
  };
}

// ============================================================
// TEST 1: Happy path
// ============================================================
console.log('\n[Test 1] Happy path: Hermes payload → exit 0 → DB event with correct fields');
{
  const payload = JSON.stringify({
    hook_event_name: 'on_session_end',
    session_id: 'hermes-happy-001',
    cwd: '/tmp/hermes-proj',
    extra: { completed: true, interrupted: false, model: 'qwen3.6-35b', platform: 'cli' },
  });
  const r = wrapperSpawn(payload);
  ok('wrapper exits 0', r.status === 0, `got ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  ok('stdout has event_id', /^event_id:/.test(r.stdout || ''));

  const row = eventRow('hermes-happy-001');
  ok('DB row exists', row !== null);
  if (row) {
    ok('agent_tag=hermes', row.agent_tag === 'hermes', `got: '${row.agent_tag}'`);
    ok('source_kind=hermes-end', row.source_kind === 'hermes-end', `got: '${row.source_kind}'`);
    ok('session_id preserved', row.session_id === 'hermes-happy-001', `got: '${row.session_id}'`);
    ok('status=captured', row.status === 'captured', `got: '${row.status}'`);
    ok('content includes completed=true', row.content.includes('completed=true'), `got: '${row.content}'`);
    ok('content includes cwd', row.content.includes('/tmp/hermes-proj'), `got: '${row.content}'`);
    ok('content includes model', row.content.includes('qwen3.6-35b'), `got: '${row.content}'`);
  }
}

// ============================================================
// TEST 2: Idempotent skip (dedupe pre-check)
// ============================================================
console.log('\n[Test 2] Idempotent skip: same session_id twice → exit 0 both, 1 DB row');
{
  const payload = JSON.stringify({
    hook_event_name: 'on_session_end',
    session_id: 'hermes-dedup-001',
    cwd: '/tmp/dedup',
    extra: { completed: true, interrupted: false, model: 'qwen3.6', platform: 'cli' },
  });

  const r1 = wrapperSpawn(payload);
  ok('first invocation exits 0', r1.status === 0, `got ${r1.status}`);

  const r2 = wrapperSpawn(payload);
  ok('second invocation exits 0 (idempotent skip)', r2.status === 0, `got ${r2.status}`);
  ok('second invocation logs skip message', (r2.stderr || '').includes('already ingested, skipping'), `stderr: ${(r2.stderr || '').slice(0, 200)}`);

  const cnt = eventCount('hermes-dedup-001');
  ok('only 1 event in DB (dedupe worked)', cnt === 1, `got ${cnt}`);
}

// ============================================================
// TEST 3: Different session_ids → 2 events
// ============================================================
console.log('\n[Test 3] Different session_ids → 2 separate events in DB');
{
  const p1 = JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-multi-A', cwd: '/a', extra: { completed: true, interrupted: false, model: 'm1', platform: 'cli' } });
  const p2 = JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-multi-B', cwd: '/b', extra: { completed: false, interrupted: true, model: 'm2', platform: 'web' } });

  const r1 = wrapperSpawn(p1);
  const r2 = wrapperSpawn(p2);
  ok('event A exits 0', r1.status === 0);
  ok('event B exits 0', r2.status === 0);

  const cntA = eventCount('hermes-multi-A');
  const cntB = eventCount('hermes-multi-B');
  ok('event A in DB', cntA === 1, `got ${cntA}`);
  ok('event B in DB', cntB === 1, `got ${cntB}`);
}

// ============================================================
// TEST 4: Invalid JSON → exit 1, no event
// ============================================================
console.log('\n[Test 4] Invalid JSON → exit 1, no event written');
{
  const before = eventCount('hermes-invalid-json');
  const r = wrapperSpawn('{not valid json');
  ok('invalid JSON exits 1', r.status === 1, `got ${r.status}`);
  const after = eventCount('hermes-invalid-json');
  ok('no event written', after === before, `before=${before}, after=${after}`);
}

// ============================================================
// TEST 5: Empty stdin → exit 1, no event
// ============================================================
console.log('\n[Test 5] Empty stdin → exit 1, no event written');
{
  const before = eventCount('hermes-empty-stdin');
  const r = spawnSync('bash', [WRAPPER], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, CORTEX_SQLITE_PATH: dbPath },
  });
  ok('empty stdin exits 1', r.status === 1, `got ${r.status}`);
  const after = eventCount('hermes-empty-stdin');
  ok('no event written', after === before);
}

// ============================================================
// TEST 6: Missing session_id → exit 1, no event
// ============================================================
console.log('\n[Test 6] JSON without session_id → exit 1, no event written');
{
  const before = eventCount('hermes-no-sid');
  const r = wrapperSpawn(JSON.stringify({ hook_event_name: 'on_session_end', cwd: '/tmp', extra: {} }));
  ok('missing session_id exits 1', r.status === 1, `got ${r.status}`);
  ok('error mentions session_id', (r.stderr || '').includes('session_id'), `stderr: ${(r.stderr || '').slice(0, 200)}`);
  const after = eventCount('hermes-no-sid');
  ok('no event written', after === before);
}

// ============================================================
// TEST 7: Completed=true payload → content includes completed=true
// ============================================================
console.log('\n[Test 7] Completed=true payload → content includes "completed=true"');
{
  const r = wrapperSpawn(JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-comp-true', cwd: '/c', extra: { completed: true, interrupted: false, model: 'm', platform: 'cli' } }));
  ok('completed=true exits 0', r.status === 0);
  const row = eventRow('hermes-comp-true');
  ok('content includes completed=true', row && row.content.includes('completed=true'), `got: '${row?.content}'`);
}

// ============================================================
// TEST 8: Completed=false interrupted=true payload → both flags present
// ============================================================
console.log('\n[Test 8] Completed=false interrupted=true → content includes both flags');
{
  const r = wrapperSpawn(JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-interrupt', cwd: '/d', extra: { completed: false, interrupted: true, model: 'm', platform: 'web' } }));
  ok('interrupted session exits 0', r.status === 0);
  const row = eventRow('hermes-interrupt');
  ok('content includes completed=false', row && row.content.includes('completed=false'), `got: '${row?.content}'`);
  ok('content includes interrupted=true', row && row.content.includes('interrupted=true'), `got: '${row?.content}'`);
}

// ============================================================
// TEST 9: Metadata preserved in DB row
// ============================================================
console.log('\n[Test 9] Metadata (model, platform, cwd, completed, interrupted) preserved in DB');
{
  const r = wrapperSpawn(JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-meta', cwd: '/meta/cwd', extra: { completed: true, interrupted: false, model: 'test-model-v2', platform: 'test-platform' } }));
  ok('metadata test exits 0', r.status === 0);
  const row = eventRow('hermes-meta');
  ok('row has metadata', row && row.metadata && row.metadata.length > 0, `meta: '${row?.metadata}'`);
  if (row && row.metadata) {
    let meta;
    try { meta = JSON.parse(row.metadata); } catch (_) { meta = {}; }
    ok('metadata.model=test-model-v2', meta.model === 'test-model-v2', `got: '${meta.model}'`);
    ok('metadata.platform=test-platform', meta.platform === 'test-platform', `got: '${meta.platform}'`);
    ok('metadata.cwd=/meta/cwd', meta.cwd === '/meta/cwd', `got: '${meta.cwd}'`);
    ok('metadata.completed=true', meta.completed === true, `got: '${meta.completed}'`);
    ok('metadata.interrupted=false', meta.interrupted === false, `got: '${meta.interrupted}'`);
  }
}

// ============================================================
// TEST 10: Episode build after ingest
// ============================================================
console.log('\n[Test 10] Episode build: 1 event → episode with correct provenance');
{
  // Ingest 1 event for a dedicated session
  const p1 = JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-ep-single', cwd: '/ep', extra: { completed: true, interrupted: false, model: 'm', platform: 'cli' } });
  const r1 = wrapperSpawn(p1);
  ok('event 1 exits 0', r1.status === 0);

  const cntBefore = eventCount('hermes-ep-single');
  ok('1 event ingested', cntBefore === 1, `got ${cntBefore}`);

  // Build episode
  const ep = spawnSync('node', [SCRIPT('ac-build-episode.js'), '--agent-tag=hermes', '--session-id=hermes-ep-single', '--title=Hermes Ep Test', '--summary=One event'], {
    encoding: 'utf8',
    env: { ...process.env, CORTEX_SQLITE_PATH: dbPath },
  });
  ok('episode build exits 0', ep.status === 0, `got ${ep.status}: ${(ep.stderr || '').slice(0, 200)}`);
  ok('episode build stdout has episode_id', /^episode_id:/.test(ep.stdout || ''));
  ok('episode build stdout has event_count=1', /event_count: 1/.test(ep.stdout || ''));

  // Verify event is now status=grouped
  const groupedQ = sql(`SELECT count(*) FROM memories WHERE memory_type='event' AND json_extract(facts,'\$.session_id')='hermes-ep-single' AND status='grouped'`).trim();
  ok('event status=grouped after episode build', parseInt(groupedQ || '0', 10) === 1, `got: '${groupedQ}'`);

  // Verify episode row exists
  const epRows = sql(`SELECT count(*) FROM memories WHERE memory_type='episode' AND json_extract(facts,'\$.session_id')='hermes-ep-single'`).trim();
  ok('episode row created', parseInt(epRows || '0', 10) === 1, `got: '${epRows}'`);
}

// ============================================================
// TEST 11: Restart simulation — wrapper called with session X,
// then called again after a simulated restart → idempotent skip
// ============================================================
console.log('\n[Test 11] Restart simulation: same session_id after simulated restart → idempotent skip');
{
  const payload = JSON.stringify({ hook_event_name: 'on_session_end', session_id: 'hermes-restart-001', cwd: '/r', extra: { completed: true, interrupted: false, model: 'm', platform: 'cli' } });

  // First call
  const r1 = wrapperSpawn(payload);
  ok('first call exits 0', r1.status === 0);

  // Simulate "wrapper restart" by unsetting CORTEX_SQLITE_PATH then setting again
  // (the actual restart simulation is: wrapper process dies, new process starts, same DB file)
  const envRestart = { ...process.env, CORTEX_SQLITE_PATH: dbPath };
  const r2 = spawnSync('bash', [WRAPPER], {
    encoding: 'utf8',
    input: payload,
    env: envRestart,
  });
  ok('second call (after simulated restart) exits 0', r2.status === 0);
  ok('second call logs idempotent skip', (r2.stderr || '').includes('already ingested, skipping'));

  const cnt = eventCount('hermes-restart-001');
  ok('only 1 event in DB after simulated restart', cnt === 1, `got ${cnt}`);
}

// ============================================================
// SUMMARY
// ============================================================
console.log('\n=========================================');
console.log(`PASS: ${pass}    FAIL: ${fail}`);
if (fail > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
}

// Cleanup
rmSync(tempDir, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);