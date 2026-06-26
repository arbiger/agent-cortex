/**
 * event_normalizer.test.js
 *
 * Unit tests for event_normalizer.js — pure ESM, no DB, no I/O.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { normalizeHookEvent, validateAgentTag, parseTimestamp } from '../scripts/event_normalizer.js';

describe('parseTimestamp', () => {
  it('returns null for undefined', () => {
    assert.strictEqual(parseTimestamp(undefined), null);
  });

  it('returns null for null', () => {
    assert.strictEqual(parseTimestamp(null), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseTimestamp(''), null);
  });

  it('keeps ISO-8601 string as-is', () => {
    assert.strictEqual(
      parseTimestamp('2026-06-25T12:00:00Z'),
      '2026-06-25T12:00:00Z'
    );
    assert.strictEqual(
      parseTimestamp('2026-06-25T12:00:00.123Z'),
      '2026-06-25T12:00:00.123Z'
    );
    assert.strictEqual(
      parseTimestamp('2026-06-25T12:00:00+08:00'),
      '2026-06-25T12:00:00+08:00'
    );
  });

  it('converts Unix seconds (< 1e12) to ISO', () => {
    const result = parseTimestamp(1750876800); // ~2025-06-25 12:00:00 UTC
    assert.ok(result.endsWith('Z') || result.includes('+'), `Expected ISO string, got: ${result}`);
  });

  it('converts Unix ms (>= 1e12) to ISO', () => {
    const result = parseTimestamp(1750876800000);
    assert.ok(result.startsWith('2025-06-25'), `Expected 2025-06-25..., got: ${result}`);
  });

  it('throws for invalid string', () => {
    assert.throws(() => parseTimestamp('not-a-date'), /Invalid ISO-8601/i);
  });

  it('throws for negative number', () => {
    assert.throws(() => parseTimestamp(-1), /Invalid Unix ms/i);
  });

  it('throws for non-finite number', () => {
    assert.throws(() => parseTimestamp(NaN), /Invalid Unix ms/i);
  });
});

describe('validateAgentTag', () => {
  it('passes for valid agent_tag', () => {
    for (const tag of ['opencode', 'hermes', 'openclaw', 'george', 'codex', 'agy']) {
      assert.doesNotThrow(() => validateAgentTag(tag), `Should not throw for: ${tag}`);
    }
  });

  it('throws for null/undefined', () => {
    assert.throws(() => validateAgentTag(null), /agent_tag is required/i);
    assert.throws(() => validateAgentTag(undefined), /agent_tag is required/i);
  });

  it('throws for empty string', () => {
    assert.throws(() => validateAgentTag(''), /agent_tag is required/i);
    assert.throws(() => validateAgentTag('   '), /agent_tag is required/i);
  });

  it('throws for unknown agent_tag', () => {
    assert.throws(() => validateAgentTag('unknown'), /Invalid agent_tag/i);
    // Note: implementation trims before checking, so 'codex ' passes as 'codex'
    assert.throws(() => validateAgentTag('notvalid '), /Invalid agent_tag/i);
  });
});

describe('normalizeHookEvent — minimal payload', () => {
  it('only required 4 fields present', () => {
    const raw = {
      agent_tag: 'codex',
      session_id: 'sess-001',
      source: 'codex-stop-hook',
      content: 'hello world',
    };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.agent_tag, 'codex');
    assert.strictEqual(result.session_id, 'sess-001');
    assert.strictEqual(result.source_kind, 'codex-stop-hook');
    assert.strictEqual(result.content, 'hello world');
    assert.strictEqual(result.occurred_at, null);
    assert.strictEqual(result.source_ref, null);
  });
});

describe('normalizeHookEvent — full payload', () => {
  it('all 7 wire fields mapped correctly', () => {
    const raw = {
      agent_tag: 'hermes',
      session_id: 'sess-002',
      timestamp: '2026-06-25T12:00:00Z',
      source: 'hermes-session-hook',
      role: 'assistant',
      content: 'Full payload test',
      status: 'grouped', // should be ignored
    };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.agent_tag, 'hermes');
    assert.strictEqual(result.session_id, 'sess-002');
    assert.strictEqual(result.source_kind, 'hermes-session-hook');
    assert.strictEqual(result.content, 'Full payload test');
    assert.strictEqual(result.occurred_at, '2026-06-25T12:00:00Z');
    assert.deepStrictEqual(result.metadata, { role: 'assistant' });
    assert.strictEqual(result.source_ref, null);
  });
});

describe('normalizeHookEvent — missing required fields', () => {
  it('throws on missing agent_tag', () => {
    const raw = { session_id: 's', source: 'x', content: 'c' };
    delete raw.agent_tag;
    assert.throws(() => normalizeHookEvent(raw), /agent_tag is required/i);
  });

  it('throws on missing session_id', () => {
    const raw = { agent_tag: 'codex', source: 'x', content: 'c' };
    delete raw.session_id;
    assert.throws(() => normalizeHookEvent(raw), /session_id is required/i);
  });

  it('throws on missing source', () => {
    const raw = { agent_tag: 'codex', session_id: 's', content: 'c' };
    delete raw.source;
    assert.throws(() => normalizeHookEvent(raw), /source is required/i);
  });

  it('throws on missing content', () => {
    const raw = { agent_tag: 'codex', session_id: 's', source: 'x' };
    delete raw.content;
    assert.throws(() => normalizeHookEvent(raw), /content is required/i);
  });

  it('throws on empty content', () => {
    const raw = { agent_tag: 'codex', session_id: 's', source: 'x', content: '   ' };
    assert.throws(() => normalizeHookEvent(raw), /content is required/i);
  });

  it('throws on invalid agent_tag', () => {
    const raw = { agent_tag: 'notreal', session_id: 's', source: 'x', content: 'c' };
    assert.throws(() => normalizeHookEvent(raw), /Invalid agent_tag/i);
  });
});

describe('normalizeHookEvent — Unix ms timestamp', () => {
  it('converts Unix ms number to ISO', () => {
    const raw = {
      agent_tag: 'codex',
      session_id: 'sess-003',
      source: 'test',
      content: 'test',
      timestamp: 1750876800000,
    };
    const result = normalizeHookEvent(raw);
    assert.ok(result.occurred_at.startsWith('2025-06-25'), `Got: ${result.occurred_at}`);
  });
});

describe('normalizeHookEvent — wire status ignored', () => {
  it('output does NOT carry status field', () => {
    const raw = {
      agent_tag: 'codex',
      session_id: 'sess-004',
      source: 'test',
      content: 'test',
      status: 'grouped',
    };
    const result = normalizeHookEvent(raw);
    // status should not be in output at all (writeEvent handles it)
    assert.strictEqual(result.metadata, undefined); // no extra fields
    assert.strictEqual('status' in result, false);
  });
});

describe('normalizeHookEvent — extra fields in metadata', () => {
  it('extra fields preserved in metadata', () => {
    const raw = {
      agent_tag: 'codex',
      session_id: 'sess-005',
      source: 'test',
      content: 'test',
      reason: 'completed',
      cwd: '/tmp',
      custom_field: 'custom_value',
    };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.metadata.reason, 'completed');
    assert.strictEqual(result.metadata.cwd, '/tmp');
    assert.strictEqual(result.metadata.custom_field, 'custom_value');
    assert.strictEqual(result.metadata.role, undefined); // role not present
  });
});

describe('normalizeHookEvent — overrides > defaults', () => {
  it('defaults fill in when payload missing', () => {
    const raw = {
      session_id: 'sess-006',
      source: 'test',
      content: 'test',
      // agent_tag missing
    };
    const defaults = { agent_tag: 'george' };
    const result = normalizeHookEvent(raw, {}, defaults);
    assert.strictEqual(result.agent_tag, 'george');
  });

  it('payload overrides defaults', () => {
    const raw = {
      agent_tag: 'codex',
      session_id: 'sess-007',
      source: 'test',
      content: 'test',
    };
    const defaults = { agent_tag: 'george' };
    const result = normalizeHookEvent(raw, {}, defaults);
    assert.strictEqual(result.agent_tag, 'codex');
  });

  it('overrides win over payload', () => {
    const raw = {
      agent_tag: 'hermes',
      session_id: 'sess-008',
      source: 'test',
      content: 'test',
    };
    const overrides = { agent_tag: 'george' };
    const defaults = { agent_tag: 'codex' };
    const result = normalizeHookEvent(raw, overrides, defaults);
    assert.strictEqual(result.agent_tag, 'george');
  });
});

describe('normalizeHookEvent — role goes to metadata', () => {
  it('role present in metadata', () => {
    const raw = {
      agent_tag: 'opencode',
      session_id: 'sess-008',
      source: 'opencode-hook',
      content: 'test',
      role: 'user',
    };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.metadata.role, 'user');
  });

  it('role not present when not in payload', () => {
    const raw = {
      agent_tag: 'opencode',
      session_id: 'sess-009',
      source: 'opencode-hook',
      content: 'test',
    };
    const result = normalizeHookEvent(raw);
    // metadata may be undefined when no extra fields and no role
    assert.strictEqual(result.metadata?.role, undefined);
  });
});

describe('normalizeHookEvent — invalid payload types', () => {
  it('throws for array', () => {
    assert.throws(() => normalizeHookEvent([1, 2, 3]), /plain object/i);
  });

  it('throws for null', () => {
    assert.throws(() => normalizeHookEvent(null), /plain object/i);
  });

  it('throws for string', () => {
    assert.throws(() => normalizeHookEvent('not an object'), /plain object/i);
  });
});

describe('normalizeHookEvent — whitespace trimming', () => {
  it('trims agent_tag', () => {
    const raw = { agent_tag: '  codex  ', session_id: 's', source: 'x', content: 'c' };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.agent_tag, 'codex');
  });

  it('trims content', () => {
    const raw = { agent_tag: 'codex', session_id: 's', source: 'x', content: '  hello  ' };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.content, 'hello');
  });

  it('trims source_kind', () => {
    const raw = { agent_tag: 'codex', session_id: 's', source: '  hook  ', content: 'c' };
    const result = normalizeHookEvent(raw);
    assert.strictEqual(result.source_kind, 'hook');
  });
});
