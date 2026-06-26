/**
 * ac-ingest-event.test.js
 *
 * Integration tests for the ac-ingest-event.js CLI.
 * Each test spawns a fresh Node subprocess with an isolated temp DB file.
 * DB verification uses a SEPARATE spawn to avoid singleton state conflicts.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = './scripts/ac-ingest-event.js';

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

/** Verify events in a DB file via a spawned sqlite3 CLI process */
function queryDb(dbPath, sql) {
  // Use the sqlite3 CLI tool if available, otherwise use node with better-sqlite3
  try {
    // Try sqlite3 CLI first
    const output = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8', timeout: 5000 });
    return { rows: output.trim().split('\n').map(line => line.split('|')) };
  } catch (_) {
    // Fallback: spawn node with inline better-sqlite3 query
    return new Promise((resolve) => {
      const nodeCode = `
        const Database = require('better-sqlite3');
        const db = new Database('${dbPath.replace(/'/g, "\\'")}');
        const rows = db.prepare('${sql.replace(/'/g, "\\'")}').all();
        db.close();
        console.log(JSON.stringify(rows));
      `;
      const proc = spawn('node', ['-e', nodeCode], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) { resolve({ rows: [], error: stderr }); return; }
        try { resolve({ rows: JSON.parse(stdout.trim()) }); }
        catch (_) { resolve({ rows: [], error: stdout }); }
      });
    });
  }
}

describe('ac-ingest-event CLI', { concurrency: 1 }, () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(`${tmpdir()}/ac-mvp2-`);
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
  // Happy path — stdin
  // -------------------------------------------------------------------------
  it('happy path via stdin — writes event, exits 0', async () => {
    const dbFile = `${tmpDir}/stdin.db`;
    const payload = {
      agent_tag: 'codex',
      session_id: 'test-001',
      source: 'codex-stop-hook',
      content: 'smoke test via stdin',
      timestamp: '2026-06-25T12:00:00Z',
    };

    const result = await spawnCli([], payload, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `Expected exit 0. stderr: ${result.stderr}`);
    assert.match(result.stdout, /event_id: [0-9a-f-]{36}/, `Expected UUID in stdout: ${result.stdout}`);
  });

  // -------------------------------------------------------------------------
  // Happy path — file argument
  // -------------------------------------------------------------------------
  it('happy path via file arg — writes event, exits 0', async () => {
    const tmpFile = `${tmpDir}/payload.json`;
    const dbFile = `${tmpDir}/filearg.db`;
    writeFileSync(tmpFile, JSON.stringify({
      agent_tag: 'hermes',
      session_id: 'test-002',
      source: 'hermes-hook',
      content: 'smoke test via file',
      timestamp: '2026-06-25T13:00:00Z',
    }));

    const result = await spawnCli([tmpFile], null, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `Expected exit 0. stderr: ${result.stderr}`);
    assert.match(result.stdout, /event_id: [0-9a-f-]{36}/);

    // Verify DB row via separate spawn
    // source_kind is stored in facts JSON (not as a direct column)
    const { rows } = await queryDb(dbFile,
      "SELECT agent_tag, json_extract(facts,'$.session_id'), json_extract(facts,'$.source_kind'), status FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='test-002'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][0], 'hermes');
    assert.strictEqual(rows[0][2], 'hermes-hook');
    assert.strictEqual(rows[0][3], 'captured');
  });

  // -------------------------------------------------------------------------
  // Validation error — missing content
  // -------------------------------------------------------------------------
  it('validation error missing content — exits 1, no DB row', async () => {
    const dbFile = `${tmpDir}/validation.db`;
    const result = await spawnCli([], {
      agent_tag: 'codex',
      session_id: 'bad-001',
      source: 'test',
      // content missing
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 1, `Expected exit 1. stderr: ${result.stderr}`);
    assert.match(result.stderr, /content is required/i, `Expected validation error in stderr: ${result.stderr}`);
    assert.strictEqual(result.stdout.trim(), '');
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------
  it('invalid JSON — exits 1', async () => {
    const dbFile = `${tmpDir}/invalidjson.db`;
    const result = await spawnCli([], 'not valid json {{{', { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 1, `Expected exit 1. stderr: ${result.stderr}`);
    assert.match(result.stderr, /JSON parse error/i);
  });

  // -------------------------------------------------------------------------
  // CLI flag overrides payload agent_tag
  // -------------------------------------------------------------------------
  it('CLI --agent-tag overrides payload agent_tag', async () => {
    const dbFile = `${tmpDir}/flagoverride.db`;
    const result = await spawnCli(['--agent-tag=george'], {
      agent_tag: 'hermes',
      session_id: 'flag-test-001',
      source: 'test',
      content: 'flag override test',
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /event_id:/);

    const { rows } = await queryDb(dbFile,
      "SELECT agent_tag FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='flag-test-001'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][0], 'george');
  });

  // -------------------------------------------------------------------------
  // Default status='captured' — wire status='grouped' is ignored
  // -------------------------------------------------------------------------
  it("wire status='grouped' is ignored — DB row has status='captured'", async () => {
    const dbFile = `${tmpDir}/statusignore.db`;
    const result = await spawnCli([], {
      agent_tag: 'codex',
      session_id: 'status-ignore-001',
      source: 'test',
      content: 'status ignored test',
      status: 'grouped',
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    const { rows } = await queryDb(dbFile,
      "SELECT status FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='status-ignore-001'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][0], 'captured');
  });

  // -------------------------------------------------------------------------
  // Unix ms timestamp converted to ISO
  // -------------------------------------------------------------------------
  it('Unix ms timestamp converted to ISO in DB', async () => {
    const dbFile = `${tmpDir}/tsconvert.db`;
    const result = await spawnCli([], {
      agent_tag: 'codex',
      session_id: 'ts-convert-001',
      source: 'test',
      content: 'timestamp conversion test',
      timestamp: 1750876800000, // Unix ms → 2025-06-25
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    const { rows } = await queryDb(dbFile,
      "SELECT json_extract(facts,'$.occurred_at') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='ts-convert-001'");
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0][0].startsWith('2025-06-25'), `Expected 2025-06-25..., got: ${rows[0][0]}`);
  });

  // -------------------------------------------------------------------------
  // Extra fields preserved in metadata
  // -------------------------------------------------------------------------
  it('extra Codex fields preserved in metadata.facts', async () => {
    const dbFile = `${tmpDir}/metadatapreserve.db`;
    const result = await spawnCli([], {
      agent_tag: 'codex',
      session_id: 'metadata-preserve-001',
      source: 'codex-stop-hook',
      content: 'metadata preserve test',
      timestamp: '2026-06-25T14:00:00Z',
      reason: 'completed',
      cwd: '/tmp/test',
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    const { rows } = await queryDb(dbFile,
      "SELECT json_extract(facts,'$.metadata') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='metadata-preserve-001'");
    assert.strictEqual(rows.length, 1);
    const meta = JSON.parse(rows[0][0]);
    assert.strictEqual(meta.reason, 'completed');
    assert.strictEqual(meta.cwd, '/tmp/test');
  });

  // -------------------------------------------------------------------------
  // Role field goes into metadata.role
  // -------------------------------------------------------------------------
  it('role field written to metadata.role', async () => {
    const dbFile = `${tmpDir}/rolefield.db`;
    const result = await spawnCli([], {
      agent_tag: 'opencode',
      session_id: 'role-test-001',
      source: 'opencode-hook',
      content: 'role field test',
      role: 'user',
    }, { CORTEX_SQLITE_PATH: dbFile });

    assert.strictEqual(result.code, 0, `stderr: ${result.stderr}`);

    const { rows } = await queryDb(dbFile,
      "SELECT json_extract(facts,'$.metadata.role') FROM memories WHERE memory_type='event' AND json_extract(facts,'$.session_id')='role-test-001'");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][0], 'user');
  });
});
