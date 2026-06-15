import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CORTEX_SQLITE_PATH;
});

describe('sqlite bootstrap', () => {
  it('auto-creates schema on first query against a fresh database path', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ac-bootstrap-'));
    tempDirs.push(tempDir);
    process.env.CORTEX_SQLITE_PATH = path.join(tempDir, 'agent_cortex.db');

    const sqliteStore = await import(`../src/sqlite_store.js?bootstrap=${Date.now()}`);
    const result = await sqliteStore.query('SELECT COUNT(*) AS count FROM memories');

    assert.deepStrictEqual(result.rows, [{ count: 0 }]);
    sqliteStore.closeDb();
  });
});
