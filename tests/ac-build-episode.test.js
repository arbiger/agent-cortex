/**
 * ac-build-episode.test.js
 *
 * Integration tests for the ac-build-episode.js CLI.
 * Each test spawns a fresh Node subprocess with an isolated temp DB file.
 * DB verification uses a SEPARATE spawn to avoid singleton state conflicts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = './scripts/ac-build-episode.js';

/** Spawn CLI, resolve with { code, stdout, stderr } */
function spawnCli(args, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    const proc = spawn('node', [SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { resolve({ code, stdout, stderr }); });
    proc.on('error', (err) => { resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    if (input !== null && input !== undefined) {
      proc.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

/** Verify DB via spawned node + better-sqlite3 (avoids sqlite3 CLI output parsing issues). */
function queryDb(dbPath, sql) {
  return new Promise((resolve) => {
    const escapedDb = dbPath.replace(/'/g, "'\\''");
    const escapedSql = sql.replace(/'/g, "\\'");
    const nodeCode = `
      import('better-sqlite3').then(({ default: Database }) => {
        const db = new Database('${escapedDb}');
        const rows = db.prepare(\`${escapedSql}\`).all();
        db.close();
        process.stdout.write(JSON.stringify(rows));
      }).catch(err => {
        process.stderr.write(err.message);
        process.exit(1);
      });
    `;
    const proc = spawn('node', ['--input-type=module', '-e', nodeCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) { resolve({ rows: [], error: stderr }); return; }
      try { resolve({ rows: JSON.parse(stdout.trim() || '[]') }); }
      catch (_) { resolve({ rows: [], error: stdout }); }
    });
    proc.on('error', (err) => resolve({ rows: [], error: err.message }));
  });
}

/** Spawn ingest-event CLI (hardcoded for seed use). */
function spawnIngest(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    const proc = spawn('node', ['./scripts/ac-ingest-event.js', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => { resolve({ code, stdout, stderr }); });
    proc.on('error', (err) => { resolve({ code: -1, stdout, stderr: stderr + err.message }); });
  });
}

/**
 * Seed events via ac-ingest-event.js CLI sequentially (avoids DB locking).
 * Uses a temp JSON file to avoid stdin issues.
 */
async function seedEvents(dbFile, events, tmpDir) {
  for (const ev of events) {
    const tmpFile = `${tmpDir}/seed-${Date.now()}-${Math.random()}.json`;
    writeFileSync(tmpFile, JSON.stringify({
      agent_tag:  ev.agent_tag,
      session_id: ev.session_id,
      source:     ev.source_kind || 'test-hook',
      content:    ev.content,
      timestamp:  ev.occurred_at || undefined,
    }));
    const result = await spawnIngest([tmpFile], { CORTEX_SQLITE_PATH: dbFile });
    try { unlinkSync(tmpFile); } catch (_) {}
    if (result.code !== 0) {
      throw new Error(`seed event failed (exit ${result.code}): ${result.stderr}`);
    }
  }
}

describe('ac-build-episode CLI', { concurrency: 1 }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(`${tmpdir()}/ac-ep-`);
  });

  after(() => {
    try {
      const files = readdirSync(tmpDir);
      for (const f of files) {
        try { unlinkSync(`${tmpDir}/${f}`); } catch (_) {}
        try { unlinkSync(`${tmpDir}/${f}-wal`); } catch (_) {}
        try { unlinkSync(`${tmpDir}/${f}-shm`); } catch (_) {}
        try { unlinkSync(`${tmpDir}/${f}-journal`); } catch (_) {}
      }
    } catch (_) {}
  });

  // -------------------------------------------------------------------------
  // 1. Happy path — 3 events, episode created with correct event_count
  // -------------------------------------------------------------------------
  it('happy path — exits 0, episode_id and event_count in stdout, DB row created', async () => {
    const dbFile = `${tmpDir}/happy.db`;

    // Seed 3 events via direct DB write
    await seedEvents(dbFile, [
      { agent_tag: 'codex', session_id: 'ep-happy-001', content: 'event 1', source_kind: 'codex-stop-hook' },
      { agent_tag: 'codex', session_id: 'ep-happy-001', content: 'event 2', source_kind: 'codex-stop-hook' },
      { agent_tag: 'codex', session_id: 'ep-happy-001', content: 'event 3', source_kind: 'codex-stop-hook' },
    ], tmpDir);

    const result = await spawnCli(
      ['--agent-tag=codex', '--session-id=ep-happy-001',
       '--title=My Session', '--summary=My summary'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 0, `Expected exit 0. stderr: ${result.stderr}`);
    assert.match(result.stdout, /episode_id: [0-9a-f-]{36}/, `Expected episode_id UUID: ${result.stdout}`);
    assert.match(result.stdout, /event_count: 3/, `Expected event_count 3: ${result.stdout}`);

    // Verify episode row in DB
    const { rows } = await queryDb(dbFile,
      "SELECT id, memory_type, status, json_extract(facts,'$.event_count') as evc, json_extract(facts,'$.session_id') as sid FROM memories WHERE memory_type='episode'");
    assert.strictEqual(rows.length, 1, `Expected 1 episode row. Got: ${JSON.stringify(rows)}`);
    assert.strictEqual(String(rows[0].evc), '3', `Expected event_count 3 in facts: ${rows[0].evc}`);
    assert.strictEqual(rows[0].sid, 'ep-happy-001', `Expected session_id in facts: ${rows[0].sid}`);
  });

  // -------------------------------------------------------------------------
  // 2. Source events become grouped — status='grouped', grouped_into_episode_id set
  // -------------------------------------------------------------------------
  it('source events become grouped — status=grouped, grouped_into_episode_id set', async () => {
    const dbFile = `${tmpDir}/grouped.db`;

    await seedEvents(dbFile, [
      { agent_tag: 'codex', session_id: 'ep-grouped-001', content: 'event A', source_kind: 'hook' },
      { agent_tag: 'codex', session_id: 'ep-grouped-001', content: 'event B', source_kind: 'hook' },
    ], tmpDir);

    const result = await spawnCli(
      ['--agent-tag=codex', '--session-id=ep-grouped-001'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    // Extract episode_id from stdout
    const episodeIdMatch = result.stdout.match(/episode_id: ([0-9a-f-]+)/);
    assert.ok(episodeIdMatch, `No episode_id in stdout: ${result.stdout}`);
    const episodeId = episodeIdMatch[1];

    // Verify events are now grouped
    const { rows } = await queryDb(dbFile,
      `SELECT status, json_extract(facts,'$.grouped_into_episode_id') as grouped_id FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='ep-grouped-001'`);
    assert.strictEqual(rows.length, 2, `Expected 2 event rows. Got: ${JSON.stringify(rows)}`);
    for (const row of rows) {
      assert.strictEqual(row.status, 'grouped', `Expected status=grouped, got: ${row.status}`);
      assert.strictEqual(row.grouped_id, episodeId, `Expected grouped_into_episode_id=${episodeId}, got: ${row.grouped_id}`);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Empty session throws — exits 2, "No captured events found", no episode row
  // -------------------------------------------------------------------------
  it('empty session — exits 2, error message, no episode row', async () => {
    const dbFile = `${tmpDir}/empty.db`;

    // Create empty DB (no events)
    await seedEvents(dbFile, [], tmpDir);

    const result = await spawnCli(
      ['--agent-tag=codex', '--session-id=ep-empty-001'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 2, `Expected exit 2. stderr: ${result.stderr}`);
    assert.match(result.stderr, /No captured events found/i, `Expected "No captured events found" in stderr: ${result.stderr}`);

    // No episode row
    const { rows } = await queryDb(dbFile, "SELECT COUNT(*) as cnt FROM memories WHERE memory_type='episode'");
    assert.strictEqual(rows[0].cnt, 0, `Expected 0 episode rows for empty session`);
  });

  // -------------------------------------------------------------------------
  // 4. Validation error — missing agent_tag, exits 1
  // -------------------------------------------------------------------------
  it('missing agent_tag — exits 1, no DB writes', async () => {
    const dbFile = `${tmpDir}/no-agent.db`;

    const result = await spawnCli(
      ['--session-id=ep-no-agent-001'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 1, `Expected exit 1. stderr: ${result.stderr}`);
    assert.match(result.stderr, /agent_tag is required/i, `Expected validation error about agent_tag: ${result.stderr}`);
    assert.strictEqual(result.stdout.trim(), '');
  });

  // -------------------------------------------------------------------------
  // 5. Validation error — missing session_id, exits 1
  // -------------------------------------------------------------------------
  it('missing session_id — exits 1, no DB writes', async () => {
    const dbFile = `${tmpDir}/no-session.db`;

    const result = await spawnCli(
      ['--agent-tag=codex'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 1, `Expected exit 1. stderr: ${result.stderr}`);
    assert.match(result.stderr, /session_id is required/i, `Expected validation error about session_id: ${result.stderr}`);
    assert.strictEqual(result.stdout.trim(), '');
  });

  // -------------------------------------------------------------------------
  // 6. Default title/summary — only agent-tag + session-id, episode created
  // -------------------------------------------------------------------------
  it('default title/summary — exits 0, episode created with defaults', async () => {
    const dbFile = `${tmpDir}/defaults.db`;

    await seedEvents(dbFile, [
      { agent_tag: 'hermes', session_id: 'ep-defaults-001', content: 'single event', source_kind: 'test' },
    ], tmpDir);

    const result = await spawnCli(
      ['--agent-tag=hermes', '--session-id=ep-defaults-001'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /episode_id:/);

    // Verify episode has generated title and summary in content
    const { rows } = await queryDb(dbFile,
      "SELECT content FROM memories WHERE memory_type='episode' AND json_extract(facts,'$.session_id')='ep-defaults-001'");
    assert.strictEqual(rows.length, 1, `Expected 1 episode. Got: ${JSON.stringify(rows)}`);
    const content = rows[0].content;
    assert.ok(content.includes('hermes session ep-defaults-001') || content.includes('Session Episode'),
      `Expected default title in content. Got: ${content}`);
  });

  // -------------------------------------------------------------------------
  // 7. Topic key — episode row has topic_key set
  // -------------------------------------------------------------------------
  it('topic-key — exits 0, episode row has topic_key', async () => {
    const dbFile = `${tmpDir}/topic.db`;

    await seedEvents(dbFile, [
      { agent_tag: 'codex', session_id: 'ep-topic-001', content: 'event with topic', source_kind: 'test' },
    ], tmpDir);

    const result = await spawnCli(
      ['--agent-tag=codex', '--session-id=ep-topic-001', '--topic-key=mvp2-test'],
      null,
      { CORTEX_SQLITE_PATH: dbFile }
    );

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    const { rows } = await queryDb(dbFile,
      "SELECT topic_key FROM memories WHERE memory_type='episode' AND json_extract(facts,'$.session_id')='ep-topic-001'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].topic_key, 'mvp2-test', `Expected topic_key=mvp2-test, got: ${rows[0].topic_key}`);
  });
});
