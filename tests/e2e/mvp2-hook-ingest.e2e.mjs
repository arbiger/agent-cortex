/**
 * AC MVP-2 Hook Ingest — End-to-End Smoke Test
 *
 * PURPOSE
 *   Regression / smoke baseline for the three things that are easy to break
 *   by refactoring but hard to catch with unit tests alone:
 *
 *     1. Hook ingest — `scripts/ac-ingest-event.js` correctly writes a
 *        `memory_type='event'` row from a wire-format payload.
 *     2. Episode build — `scripts/ac-build-episode.js` correctly aggregates
 *        captured events into a `memory_type='episode'` row.
 *     3. Provenance verification — source events are flipped to
 *        `status='grouped'` and `facts.grouped_into_episode_id` points
 *        back to the new episode.
 *
 * WHY IT'S NOT IN `npm test`
 *   The default `npm test` is the fast in-process unit/integration suite
 *   (~280 tests, ~2s). This e2e script:
 *     - Spawns CLI scripts as child processes (slower, ~5s total)
 *     - Touches the filesystem (creates temp SQLite DB)
 *     - Requires `sqlite3` CLI on PATH for verification queries
 *     - Validates the SAME code paths the unit tests do, but in the
 *       actual production execution environment
 *
 *   Keeping it separate preserves the fast feedback loop of `npm test`
 *   while preserving the real end-to-end protection layer.
 *
 * USAGE
 *   npm run test:e2e:mvp2
 *
 * ENVIRONMENT
 *   - Node.js >=18 (uses `node --test` style assertions + ESM)
 *   - `sqlite3` CLI on PATH (for verification queries)
 *   - No network access required
 *
 * ADDING MORE E2E TESTS
 *   Add a new `*.e2e.mjs` under `tests/e2e/` and wire it as a separate
 *   `npm run test:e2e:<name>` script in package.json. Do NOT add to
 *   `npm test` glob — keep them out of the fast lane.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Runtime repo root = tests/e2e/<this-file> -> ../../
const RUNTIME = join(__dirname, '..', '..');
const SCRIPT = (name) => join(RUNTIME, 'scripts', name);

const tempDir = mkdtempSync(join(tmpdir(), 'ac-mvp2-e2e-'));
const dbPath = join(tempDir, 'test.db');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push({name, detail}); console.log(`  ✗ ${name}${detail ? '  // ' + detail : ''}`); }
}

// ---- Helper: run CLI ----
function cli(name, args = [], payload = null, env = {}) {
  const finalArgs = [SCRIPT(name), ...args];
  return spawnSync('node', finalArgs, {
    encoding: 'utf8',
    input: payload !== null ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : undefined,
    env: { ...process.env, CORTEX_SQLITE_PATH: dbPath, ...env },
    timeout: 15000,
  });
}

function sql(query) {
  const r = spawnSync('sqlite3', [dbPath, query], { encoding: 'utf8' });
  return r.stdout || '';
}

// ============ TEST 1: Happy path ============
console.log('\n[Test 1] Happy path: 2 sessions, multi events, episode build');
{
  for (let i = 1; i <= 3; i++) {
    const r = cli('ac-ingest-event.js', [], {
      agent_tag: 'codex', session_id: 'A', source: 'codex-stop-hook',
      content: `A${i}`, timestamp: new Date(2026, 5, 25, 10, i).toISOString(),
    });
    ok(`session-A event ${i} exits 0`, r.status === 0);
    ok(`session-A event ${i} stdout has event_id`, /^event_id:/.test(r.stdout || ''));
  }
  for (let i = 1; i <= 2; i++) {
    const r = cli('ac-ingest-event.js', [], {
      agent_tag: 'codex', session_id: 'B', source: 'codex-stop-hook',
      content: `B${i}`, timestamp: Date.UTC(2026, 5, 26, 12, i),
    });
    ok(`session-B event ${i} (Unix ms) exits 0`, r.status === 0);
  }
  const ba = cli('ac-build-episode.js', [], {
    agent_tag: 'codex', session_id: 'A', title: 'Session A', summary: 'Three events',
  });
  ok('build session-A exits 0', ba.status === 0);
  ok('build session-A has episode_id', /^episode_id:/.test(ba.stdout || ''));
  ok('build session-A event_count=3', /event_count: 3/.test(ba.stdout || ''));

  const bb = cli('ac-build-episode.js', ['--agent-tag=codex', '--session-id=B', '--title=Session B', '--summary=Two events']);
  ok('build session-B exits 0', bb.status === 0);
  ok('build session-B event_count=2', /event_count: 2/.test(bb.stdout || ''));
}

// ============ TEST 2: File arg path ============
console.log('\n[Test 2] CLI file arg path (no stdin)');
{
  const file = join(tempDir, 'payload.json');
  writeFileSync(file, JSON.stringify({ agent_tag: 'codex', session_id: 'C', source: 'codex-stop-hook', content: 'File arg test' }));
  const r = cli('ac-ingest-event.js', [file]);
  ok('file arg exits 0', r.status === 0);
  ok('file arg has event_id', /^event_id:/.test(r.stdout || ''));
}

// ============ TEST 3: Missing timestamp ============
//
// Note on NULL handling: the `sqlite3` CLI renders SQL NULL as empty output,
// NOT the literal string `null`. So `json_extract(...)` on a missing JSON key
// returns NULL which the CLI prints as `''`. We check for empty string here.
// (Earlier revision of this test compared against the literal string 'null'
// which was a test bug, not a code bug — the actual JSON stored does have
// `"occurred_at":null`.)
console.log('\n[Test 3] Missing timestamp -> occurred_at=null');
{
  const r = cli('ac-ingest-event.js', [], { agent_tag: 'codex', session_id: 'D', source: 'codex-stop-hook', content: 'No ts' });
  ok('no-ts exits 0', r.status === 0);
  const v = sql("SELECT json_extract(facts,'$.occurred_at') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='D'").trim();
  ok('no-ts: facts.occurred_at is SQL NULL (sqlite3 prints as empty)',
     v === '', `got: '${v}' (len=${v.length})`);
}

// ============ TEST 4: Wire status=grouped ignored ============
console.log('\n[Test 4] Wire status=grouped is ignored -> DB status=captured');
{
  const r = cli('ac-ingest-event.js', [], { agent_tag: 'codex', session_id: 'E', source: 'codex-stop-hook', content: 'X', status: 'grouped' });
  ok('status-override exits 0', r.status === 0);
  const v = sql("SELECT status FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='E'").trim();
  ok('status-override: DB status=captured', v === 'captured', `got: '${v}'`);
}

// ============ TEST 5: CLI override ============
console.log('\n[Test 5] CLI flags override payload (agent_tag, source_kind)');
{
  const r = cli('ac-ingest-event.js', ['--agent-tag=hermes', '--source-kind=hermes-end'], {
    agent_tag: 'codex', session_id: 'F', source: 'codex-stop-hook', content: 'Override',
  });
  ok('override exits 0', r.status === 0);
  const v = sql("SELECT agent_tag || '|' || json_extract(facts,'$.source_kind') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='F'").trim();
  ok('override: agent_tag=hermes, source_kind=hermes-end', v === 'hermes|hermes-end', `got: '${v}'`);
}

// ============ TEST 6: Extra metadata preserved ============
console.log('\n[Test 6] Extra payload fields preserved in facts.metadata');
{
  const r = cli('ac-ingest-event.js', [], {
    agent_tag: 'codex', session_id: 'G', source: 'codex-stop-hook', content: 'M',
    role: 'assistant', cwd: '/tmp', transcript_path: '/tmp/x.jsonl',
  });
  ok('metadata exits 0', r.status === 0);
  const v = sql("SELECT json_extract(facts,'$.metadata') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='G'").trim();
  let meta; try { meta = JSON.parse(v); } catch(e) { meta = {}; }
  ok('metadata.role=assistant', meta.role === 'assistant');
  ok('metadata.cwd=/tmp', meta.cwd === '/tmp');
  ok('metadata.transcript_path=/tmp/x.jsonl', meta.transcript_path === '/tmp/x.jsonl');
}

// ============ TEST 7: Empty session -> build fails ============
console.log('\n[Test 7] Empty session -> episode build exits 2');
{
  const r = cli('ac-build-episode.js', ['--agent-tag=codex', '--session-id=NONEXISTENT', '--title=E', '--summary=E']);
  ok('empty session exits 2', r.status === 2, `got: ${r.status}`);
  ok('empty session: stderr mentions "No captured events"', /No captured events/.test(r.stderr || ''));
}

// ============ TEST 8: Idempotency ============
console.log('\n[Test 8] Already-grouped session -> second build exits 2');
{
  const r = cli('ac-build-episode.js', ['--agent-tag=codex', '--session-id=A', '--title=2nd', '--summary=2nd']);
  ok('already-grouped exits 2', r.status === 2, `got: ${r.status}`);
}

// ============ TEST 9-14: Validation errors ============
const validations = [
  { name: 'missing agent_tag', payload: { session_id: 'X', source: 'S', content: 'C' }, field: 'agent_tag' },
  { name: 'missing session_id', payload: { agent_tag: 'codex', source: 'S', content: 'C' }, field: 'session_id' },
  { name: 'missing source', payload: { agent_tag: 'codex', session_id: 'X', content: 'C' }, field: 'source' },
  { name: 'missing content', payload: { agent_tag: 'codex', session_id: 'X', source: 'S' }, field: 'content' },
  { name: 'empty content', payload: { agent_tag: 'codex', session_id: 'X', source: 'S', content: '' }, field: 'content' },
  { name: 'invalid agent_tag', payload: { agent_tag: 'unknown_agent', session_id: 'X', source: 'S', content: 'C' }, field: 'agent_tag' },
];
for (const tc of validations) {
  console.log(`\n[validation] ${tc.name}`);
  const r = cli('ac-ingest-event.js', [], tc.payload);
  ok(`${tc.name}: exits 1`, r.status === 1, `got: ${r.status}`);
  const stderr = r.stderr || '';
  ok(`${tc.name}: stderr mentions "${tc.field}"`, new RegExp(tc.field, 'i').test(stderr), `stderr: ${stderr.slice(0, 200)}`);
}

// ============ TEST 15: Invalid JSON ============
console.log('\n[Test 15] Invalid JSON -> exits 1');
{
  const r = cli('ac-ingest-event.js', [], '{not valid json');
  ok('invalid JSON exits 1', r.status === 1);
  const stderr = r.stderr || '';
  ok('invalid JSON: stderr mentions JSON/parse', /JSON|parse/i.test(stderr), `stderr: ${stderr.slice(0, 200)}`);
}

// ============ TEST 16: Wrapper script with Codex-like payload ============
console.log('\n[Test 16] Codex wrapper script with realistic Codex Stop payload');
{
  const codexPayload = JSON.stringify({
    session_id: 'codex-realistic-001',
    reason: 'completed',
    cwd: '/Users/george/projects/test',
    transcript_path: '/Users/george/.codex/transcripts/abc.jsonl',
  });
  const r = spawnSync('bash', [join(RUNTIME, 'scripts/codex-stop-hook-ac-ingest.sh')], {
    encoding: 'utf8',
    input: codexPayload,
    env: { ...process.env, CORTEX_SQLITE_PATH: dbPath },
  });
  ok('wrapper exits 0', r.status === 0, `stderr: ${(r.stderr || '').slice(0, 300)}`);
  ok('wrapper has event_id', /^event_id:/.test(r.stdout || ''));
  const v = sql("SELECT agent_tag || '|' || json_extract(facts,'$.source_kind') || '|' || json_extract(facts,'$.session_id') || '|' || content FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='codex-realistic-001'").trim();
  const parts = v.split('|');
  ok('wrapper: agent_tag=codex', parts[0] === 'codex', `got: '${parts[0]}'`);
  ok('wrapper: source_kind=codex-stop-hook', parts[1] === 'codex-stop-hook', `got: '${parts[1]}'`);
  ok('wrapper: session_id preserved', parts[2] === 'codex-realistic-001', `got: '${parts[2]}'`);
  ok('wrapper: content includes reason=completed', (parts[3] || '').includes('completed'), `content: '${parts[3]}'`);
  ok('wrapper: content includes cwd', (parts[3] || '').includes('/Users/george/projects/test'), `content: '${parts[3]}'`);
}

// ============ TEST 17: Episode provenance cross-check ============
console.log('\n[Test 17] Episode provenance: source events linked back to episode');
{
  const events = sql("SELECT id, status, substr(json_extract(facts,'$.grouped_into_episode_id'),1,8) FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='A' ORDER BY created_at").trim().split('\n');
  ok('session-A: 3 events exist', events.length === 3, `got: ${events.length}`);
  const epPrefix = events[0].split('|')[2];
  ok('session-A: all events have same grouped_into_episode_id prefix',
     events.every(e => e.split('|')[2] === epPrefix), `prefix: ${epPrefix}`);
  ok('session-A: all events status=grouped',
     events.every(e => e.split('|')[1] === 'grouped'));
}

// ============ SUMMARY ============
console.log('\n=========================================');
console.log(`PASS: ${pass}    FAIL: ${fail}`);
if (fail > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
}

// Cleanup
rmSync(tempDir, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);