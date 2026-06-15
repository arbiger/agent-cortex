import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeVector(fillIndex, value = 1) {
  const vec = new Float32Array(1024);
  vec[fillIndex] = value;
  return vec;
}

describe('vector_search cross-process refresh', () => {
  let sqliteStore;
  let vectorSearch;
  let tempDir;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'ac-vector-refresh-'));
    process.env.CORTEX_SQLITE_PATH = path.join(tempDir, 'agent_cortex.db');
    sqliteStore = await import(`../src/sqlite_store.js?vecstore=${Date.now()}`);
    vectorSearch = await import(`../src/vector_search.js?vecsearch=${Date.now()}`);
    sqliteStore.initSchema();
    vectorSearch._resetIndex();
  });

  afterEach(() => {
    vectorSearch._resetIndex();
    sqliteStore.closeDb();
    delete process.env.CORTEX_SQLITE_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes the in-memory index when another writer updates SQLite', async () => {
    const first = makeVector(0, 1);
    const second = makeVector(1, 1);
    const firstBlob = vectorSearch.vectorToBlob(first);
    const secondBlob = vectorSearch.vectorToBlob(second);

    await sqliteStore.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ['m1', 'codex', 'memory-codex.md', 'first memory']
    );
    await sqliteStore.query(
      `INSERT INTO memory_embeddings (id, memory_id, embedding, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      ['m1', 'm1', firstBlob]
    );

    await vectorSearch.loadIndex();

    await sqliteStore.query(
      `INSERT INTO memories (id, agent_tag, source_file, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ['m2', 'hermes', 'memory-hermes.md', 'second memory']
    );
    await sqliteStore.query(
      `INSERT INTO memory_embeddings (id, memory_id, embedding, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now', '+1 second'), datetime('now', '+1 second'))`,
      ['m2', 'm2', secondBlob]
    );

    const results = await vectorSearch.searchSimilar(second, 2);
    assert.strictEqual(results[0].memory_id, 'm2');
  });
});
