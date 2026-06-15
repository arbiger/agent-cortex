import { describe, it } from 'node:test';
import assert from 'node:assert';
import { VALID_AGENT_TAGS, loadConfig, validateAgentTag } from '../src/config.js';

describe('config', () => {
  it('VALID_AGENT_TAGS contains expected values', () => {
    assert.deepStrictEqual(VALID_AGENT_TAGS, ['opencode', 'hermes', 'openclaw', 'george', 'codex', 'agy']);
  });

  it('loadConfig returns defaults when no env vars set', () => {
    const config = loadConfig({});
    assert.strictEqual(config.VAULT_ROOT, '/Users/george/Documents/Georges/06 🧠 Memory');
    assert.strictEqual(config.LLM_URL, 'http://localhost:8000');
    assert.strictEqual(config.EMBED_URL, 'http://localhost:8000/v1/embeddings');
    assert.strictEqual(config.EMBED_MODEL, 'bge-m3-mlx-fp16');
    assert.strictEqual(config.LLM_MODEL, 'Qwen3.6-35B-A3B-UD-MLX-3bit');
    assert.strictEqual(config.PG_CONN, 'postgresql://george@localhost:5432/agent_cortex');
  });

  it('loadConfig reads from env when set', () => {
    const config = loadConfig({
      CORTEX_VAULT_ROOT: '/custom/vault',
      CORTEX_LLM_URL: 'http://custom:9000',
      CORTEX_EMBED_URL: 'http://custom:9000/v1/embeddings',
      CORTEX_EMBED_MODEL: 'custom-model',
      CORTEX_LLM_MODEL: 'custom-llm',
      CORTEX_PG_CONN: 'postgresql://user@host:5432/db',
    });
    assert.strictEqual(config.VAULT_ROOT, '/custom/vault');
    assert.strictEqual(config.LLM_URL, 'http://custom:9000');
    assert.strictEqual(config.EMBED_URL, 'http://custom:9000/v1/embeddings');
    assert.strictEqual(config.EMBED_MODEL, 'custom-model');
    assert.strictEqual(config.LLM_MODEL, 'custom-llm');
    assert.strictEqual(config.PG_CONN, 'postgresql://user@host:5432/db');
  });

  it('loadConfig returns null SERVER_AGENT_TAG when not set', () => {
    const config = loadConfig({});
    assert.strictEqual(config.SERVER_AGENT_TAG, null);
  });

  it('loadConfig returns SERVER_AGENT_TAG from env', () => {
    const config = loadConfig({ CORTEX_AGENT_TAG: 'hermes' });
    assert.strictEqual(config.SERVER_AGENT_TAG, 'hermes');
  });

  it('validateAgentTag accepts valid agent tags', () => {
    for (const tag of VALID_AGENT_TAGS) {
      assert.doesNotThrow(() => validateAgentTag(tag));
    }
  });

  it('validateAgentTag throws on invalid agent tag', () => {
    assert.throws(
      () => validateAgentTag('invalid_tag'),
      /Invalid agent_tag: "invalid_tag"/
    );
  });

  it('validateAgentTag throws on null/undefined/empty agent tag', () => {
    assert.throws(() => validateAgentTag(null), /Invalid agent_tag/);
    assert.throws(() => validateAgentTag(undefined), /Invalid agent_tag/);
    assert.throws(() => validateAgentTag(''), /Invalid agent_tag/);
  });

  it('validateAgentTag allows any tag when SERVER_AGENT_TAG not set', () => {
    const config = loadConfig({});
    for (const tag of VALID_AGENT_TAGS) {
      assert.doesNotThrow(() => validateAgentTag(tag, config.SERVER_AGENT_TAG));
    }
  });

  it('validateAgentTag forbids memory_write when server has different tag', () => {
    assert.throws(
      () => validateAgentTag('hermes', 'george'),
      /Forbidden/
    );
  });

  it('validateAgentTag allows memory_write when agent matches server tag', () => {
    assert.doesNotThrow(() => validateAgentTag('george', 'george'));
  });

  it('env var names are present in runtime config modules', async () => {
    const { readFileSync } = await import('node:fs');
    const configSrc = readFileSync('./src/config.js', 'utf-8');
    assert.ok(configSrc.includes('CORTEX_VAULT_ROOT'), 'CORTEX_VAULT_ROOT env var should be present');
    assert.ok(configSrc.includes('CORTEX_LLM_URL'), 'CORTEX_LLM_URL env var should be present');
    assert.ok(configSrc.includes('CORTEX_EMBED_URL'), 'CORTEX_EMBED_URL env var should be present');
  });

  it('CORTEX_SQLITE_PATH env var is referenced in db layer', async () => {
    const { readFileSync } = await import('node:fs');
    const dbSrc = readFileSync('./src/db.js', 'utf-8');
    assert.ok(dbSrc.includes('CORTEX_SQLITE_PATH'), 'CORTEX_SQLITE_PATH env var should be in db.js');
  });

  it('LLM model and embed defaults are present in config', async () => {
    const { readFileSync } = await import('node:fs');
    const configSrc = readFileSync('./src/config.js', 'utf-8');
    assert.ok(configSrc.includes('LLM_MODEL'), 'LLM_MODEL should be defined');
    assert.ok(configSrc.includes('bge-m3-mlx-fp16'));
  });

  it('default embed URL path is present in config', async () => {
    const { readFileSync } = await import('node:fs');
    const configSrc = readFileSync('./src/config.js', 'utf-8');
    assert.ok(configSrc.includes('/v1/embeddings'));
  });
});
