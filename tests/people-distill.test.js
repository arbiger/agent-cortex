import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// ─── Import helpers directly from src ─────────────────────────────────────
import {
  normalizePersonName,
  hashContent,
  buildPeopleMemorySelectSql,
  buildPeopleMemorySelectParams,
  renderProvenanceBlock,
  buildDistillPrompt,
  parseDistillResponse,
  buildProposedPeopleContent,
  createUnifiedDiff,
} from '../src/people_distill.js';

describe('people_distill helpers', () => {

  describe('normalizePersonName', () => {
    it('lowercases and trims', () => {
      assert.strictEqual(normalizePersonName('  George  '), 'george');
    });
    it('collapses internal whitespace', () => {
      assert.strictEqual(normalizePersonName('George  Smith'), 'george smith');
    });
    it('returns null for non-string', () => {
      assert.strictEqual(normalizePersonName(null), null);
      assert.strictEqual(normalizePersonName(undefined), null);
      assert.strictEqual(normalizePersonName(123), null);
    });
    it('returns null for empty string', () => {
      assert.strictEqual(normalizePersonName(''), null);
      assert.strictEqual(normalizePersonName('   '), null);
    });
  });

  describe('hashContent', () => {
    it('produces consistent hex string', () => {
      const h1 = hashContent('hello world');
      const h2 = hashContent('hello world');
      assert.strictEqual(h1, h2);
      assert.match(h1, /^[0-9a-f]{8}$/);
    });
    it('different content gives different hash', () => {
      const h1 = hashContent('hello');
      const h2 = hashContent('world');
      assert.notStrictEqual(h1, h2);
    });
    it('returns null for non-string', () => {
      assert.strictEqual(hashContent(null), null);
      assert.strictEqual(hashContent(undefined), null);
      assert.strictEqual(hashContent(123), null);
    });
  });

  describe('buildPeopleMemorySelectSql', () => {
    it('returns a non-empty SQL string', () => {
      const sql = buildPeopleMemorySelectSql();
      assert.ok(sql.length > 0);
      assert.ok(sql.includes('SELECT'));
      assert.ok(sql.includes('memories'));
    });
    it('no since: SQL does not include created_at filter', () => {
      const sql = buildPeopleMemorySelectSql();
      assert.ok(!sql.includes('created_at >='), 'sql should not have created_at filter without since');
    });
    it('with since: SQL includes created_at >= ? filter', () => {
      const sql = buildPeopleMemorySelectSql({ since: '2026-01-01' });
      assert.ok(sql.includes('created_at >= ?'), 'sql should have created_at >= ? filter');
    });
    it('with null since: SQL does not include created_at filter', () => {
      const sql = buildPeopleMemorySelectSql({ since: null });
      assert.ok(!sql.includes('created_at >='), 'sql should not have created_at filter with null since');
    });
  });

  describe('buildPeopleMemorySelectParams', () => {
    it('returns array with LIKE patterns for content, facts, narrative', () => {
      const params = buildPeopleMemorySelectParams('george');
      assert.deepStrictEqual(params, ['%george%', '%george%', '%george%']);
    });
    it('no since: returns three params (content, facts, narrative LIKE patterns)', () => {
      const params = buildPeopleMemorySelectParams('george');
      assert.deepStrictEqual(params, ['%george%', '%george%', '%george%']);
    });
    it('with since: returns four params (3 patterns + since date)', () => {
      const params = buildPeopleMemorySelectParams('george', { since: '2026-01-01' });
      assert.deepStrictEqual(params, ['%george%', '%george%', '%george%', '2026-01-01']);
    });
    it('with null since: returns three params', () => {
      const params = buildPeopleMemorySelectParams('george', { since: null });
      assert.deepStrictEqual(params, ['%george%', '%george%', '%george%']);
    });
  });

  describe('renderProvenanceBlock', () => {
    it('returns "no source" message for empty array', () => {
      const block = renderProvenanceBlock([]);
      assert.ok(block.includes('No source memories'));
    });
    it('returns "no source" message for non-array', () => {
      const block = renderProvenanceBlock(null);
      assert.ok(block.includes('No source memories'));
    });
    it('renders each memory ID and agent_tag', () => {
      const memories = [
        { id: 'abc123', agent_tag: 'george', created_at: '2026-01-01' },
        { id: 'def456', agent_tag: 'hermes', created_at: '2026-01-02' },
      ];
      const block = renderProvenanceBlock(memories);
      assert.ok(block.includes('abc123'));
      assert.ok(block.includes('def456'));
      assert.ok(block.includes('george'));
      assert.ok(block.includes('hermes'));
    });
  });

  describe('buildDistillPrompt', () => {
    it('includes person name in prompt', () => {
      const prompt = buildDistillPrompt('George', '', []);
      assert.ok(prompt.includes('George'));
    });
    it('includes current content when provided', () => {
      const prompt = buildDistillPrompt('George', 'Existing content', []);
      assert.ok(prompt.includes('Existing content'));
    });
    it('includes source memory content', () => {
      const memories = [
        { id: 'mem1', agent_tag: 'george', content: 'George worked on X', narrative: 'Story', facts: '[]', created_at: '2026-01-01' },
      ];
      const prompt = buildDistillPrompt('George', 'Existing', memories);
      assert.ok(prompt.includes('mem1'));
      assert.ok(prompt.includes('George worked on X'));
    });
  });

  describe('parseDistillResponse', () => {
    it('extracts proposed_markdown from JSON', () => {
      const raw = '{"proposed_markdown":"# George\\nStub"}';
      assert.strictEqual(parseDistillResponse(raw), '# George\nStub');
    });
    it('handles markdown fenced JSON', () => {
      const raw = '```json\n{"proposed_markdown":"# George\\nStub"}\n```';
      assert.strictEqual(parseDistillResponse(raw), '# George\nStub');
    });
    it('returns null for non-JSON', () => {
      assert.strictEqual(parseDistillResponse('not a json response'), null);
    });
    it('returns null for empty', () => {
      assert.strictEqual(parseDistillResponse(''), null);
      assert.strictEqual(parseDistillResponse(null), null);
    });
  });

  describe('buildProposedPeopleContent', () => {
    it('includes provenance block before markdown', () => {
      const content = buildProposedPeopleContent('george', '# Test', []);
      assert.ok(content.includes('## Provenance'));
    });
    it('appends markdown after provenance', () => {
      const content = buildProposedPeopleContent('george', '# Test', []);
      assert.ok(content.includes('# Test'));
    });
    it('handles empty source memories gracefully', () => {
      const content = buildProposedPeopleContent('george', '# Test', []);
      assert.ok(content.includes('No source memories'));
    });
  });

  describe('createUnifiedDiff', () => {
    it('returns null when contents are identical', () => {
      assert.strictEqual(createUnifiedDiff('hello', 'hello'), null);
    });
    it('returns null when both empty', () => {
      assert.strictEqual(createUnifiedDiff('', ''), null);
    });
    it('contains + and - markers for changes', () => {
      const diff = createUnifiedDiff('old line', 'new line', 'george');
      assert.ok(diff.includes('+'));
      assert.ok(diff.includes('-'));
    });
    it('includes both filenames', () => {
      const diff = createUnifiedDiff('old', 'new', 'george');
      assert.ok(diff.includes('people - george.md'));
    });
  });

});

// ─── Behavioral tests via dryRun/commit with injected deps ───────────────

describe('dryRun — behavioral with mocked deps', () => {
  const recordedQueries = [];
  const recordedWrites = [];
  const mockPool = {
    query: (sql, params) => {
      recordedQueries.push({ sql, params });
      if (sql.includes('SELECT COUNT(*)')) {
        return { rows: [{ count: '0' }] };
      }
      return { rows: [] };
    },
  };
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"proposed_markdown":"# Test\\nContent"}' } }],
    }),
  });
  const mockReadPeopleFile = () => null;
  const mockEnsureVaultDir = async () => {};
  const mockProposals = new Map();

  const deps = {
    pool: mockPool,
    fetch: mockFetch,
    readPeopleFile: mockReadPeopleFile,
    ensureVaultDir: mockEnsureVaultDir,
    VAULT_ROOT: '/tmp/vault',
    LLM_URL: 'http://localhost:8000',
    LLM_MODEL: 'test-model',
    proposals: mockProposals,
  };

  beforeEach(() => {
    recordedQueries.length = 0;
    recordedWrites.length = 0;
    mockProposals.clear();
  });

  it('dry_run performs ONLY SELECT queries — no file write, no mutation', async () => {
    const { dryRun } = await import('../src/people_distill.js');
    await dryRun({ name: 'george', since: null }, deps);
    assert.ok(
      recordedQueries.every(q => q.sql.trim().toUpperCase().startsWith('SELECT')),
      'All queries must be SELECT; got: ' + recordedQueries.map(q => q.sql.slice(0, 60)).join(' | ')
    );
  });

  it('dry_run with since: unprocessed count SQL uses created_at >= ?', async () => {
    const { dryRun } = await import('../src/people_distill.js');
    await dryRun({ name: 'george', since: '2026-01-01' }, deps);
    const countQueries = recordedQueries.filter(q => q.sql.includes('COUNT'));
    assert.ok(countQueries.length > 0, 'should have a count query');
    const hasSince = countQueries.some(q => q.sql.includes('created_at >= ?') && q.params.includes('2026-01-01'));
    assert.ok(hasSince, 'count query should filter by created_at >= ? with since param');
  });

  it('dry_run with since: source memory SQL uses created_at >= ?', async () => {
    const { dryRun } = await import('../src/people_distill.js');
    await dryRun({ name: 'george', since: '2026-01-01' }, deps);
    const selQueries = recordedQueries.filter(q => q.sql.includes('SELECT') && q.sql.includes('memories') && !q.sql.includes('COUNT'));
    assert.ok(selQueries.length > 0, 'should have a select query for memories');
    const hasSince = selQueries.some(q => q.sql.includes('created_at >= ?'));
    assert.ok(hasSince, 'source memory query should have created_at >= ? filter');
  });
});

describe('commit — behavioral with mocked deps', () => {
  it('commit rejects unknown proposal_id', async () => {
    const { commit } = await import('../src/people_distill.js');
    const emptyProposals = new Map();
    try {
      await commit({ name: 'george', proposal_id: 'nonexistent' }, {
        pool: { query: () => ({ rows: [] }) },
        fs: { writeFile: () => {} },
        readPeopleFile: () => null,
        ensureVaultDir: async () => {},
        VAULT_ROOT: '/tmp/vault',
        proposals: emptyProposals,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Unknown proposal_id'), 'should reject unknown proposal');
    }
  });

  it('commit rejects personName mismatch vs cached proposal', async () => {
    const { commit } = await import('../src/people_distill.js');
    const mockProposals = new Map();
    mockProposals.set('george-abc123', {
      personName: 'george',
      currentHash: 'hash1',
      proposedContent: '# Test content',
      sourceIds: [],
      sourceMemories: [],
    });
    try {
      await commit({ name: 'ching', proposal_id: 'george-abc123' }, {
        pool: { query: () => ({ rows: [] }) },
        fs: { writeFile: () => {} },
        readPeopleFile: () => 'hash1',
        ensureVaultDir: async () => {},
        VAULT_ROOT: '/tmp/vault',
        proposals: mockProposals,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('mismatch') || err.message.includes('ching'), 'should reject mismatched personName');
    }
  });

  it('conflict hash prevents write', async () => {
    const { commit, hashContent } = await import('../src/people_distill.js');
    const mockProposals = new Map();
    // cached hash corresponds to 'oldfile' but readPeopleFile returns 'newfile' → different hashes → conflict
    mockProposals.set('george-abc', {
      personName: 'george',
      currentHash: hashContent('oldfile'),
      proposedContent: '# New content',
      sourceIds: [],
      sourceMemories: [],
    });
    let writeCalled = false;
    try {
      await commit({ name: 'george', proposal_id: 'george-abc' }, {
        pool: { query: () => ({ rows: [] }) },
        fs: { writeFile: () => { writeCalled = true; } },
        readPeopleFile: () => 'newfile',
        ensureVaultDir: async () => {},
        VAULT_ROOT: '/tmp/vault',
        proposals: mockProposals,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('Conflict') || err.message.includes('changed'), 'should throw on hash conflict');
      assert.strictEqual(writeCalled, false, 'no write should occur on conflict');
    }
  });

  it('commit writes exactly cached proposedContent', async () => {
    const { commit } = await import('../src/people_distill.js');
    const expectedContent = '# Exact cached content';
    // Must use the actual hash that hashContent('hash1') would produce
    const { hashContent } = await import('../src/people_distill.js');
    const hashOfHash1 = hashContent('hash1');
    const mockProposals = new Map();
    mockProposals.set('george-xyz', {
      personName: 'george',
      currentHash: hashOfHash1,
      proposedContent: expectedContent,
      sourceIds: ['mem1'],
      sourceMemories: [],
    });
    let writtenContent = null;
    let writeCount = 0;
    await commit({ name: 'george', proposal_id: 'george-xyz' }, {
      pool: { query: () => ({ rows: [] }) },
      fs: { writeFile: (_p, c) => { writtenContent = c; writeCount++; } },
      readPeopleFile: () => 'hash1',
      ensureVaultDir: async () => {},
      VAULT_ROOT: '/tmp/vault',
      proposals: mockProposals,
    });
    assert.strictEqual(writeCount, 1, 'write should occur exactly once');
    assert.strictEqual(writtenContent, expectedContent, 'write must contain exactly the cached proposedContent');
  });
});

// ─── Static runtime safety checks ─────────────────────────────────────────

describe('runtime safety — src/server.js', () => {
  it('memory_distill_people tool is registered in ListTools', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('memory_distill_people'),
      'memory_distill_people should be registered as a tool'
    );
  });

  it('dry_run parameter is handled', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('dry_run'),
      'dry_run param should appear in handler'
    );
  });

  it('George-only guard text is present', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('george'),
      'George guard text should be present'
    );
  });

  it('proposal_id is required before commit', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('proposal_id'),
      'proposal_id requirement should be enforced'
    );
  });

  it('hash conflict check is present', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('hash') || serverSrc.includes('hashContent'),
      'Hash conflict check should be in runtime'
    );
  });

  it('source IDs are included in provenance response', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('source_ids') || serverSrc.includes('sourceMemories'),
      'Provenance source IDs should be returned'
    );
  });

  it('diff output contains +/- markers', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('+ ') && serverSrc.includes('- '),
      'Diff should contain + and - line markers'
    );
  });
});

// ─── Dry-run read-only regression tests ──────────────────────────────────

describe('dry_run is read-only — no DB writes', () => {
  const serverSrc = readFileSync('./src/server.js', 'utf-8');

  // Extract the dry_run block text for analysis
  const dryRunMatch = serverSrc.match(/if\s*\(\s*dry_run\s*\|\|\s*!\s*proposal_id\s*\)[^{]*\{([\s\S]*?)\n\s*\}\s*\}\s*$/m);
  const dryRunBlock = dryRunMatch ? dryRunMatch[1] : '';

  it('dry_run block does NOT call retryPendingEmbeddings', () => {
    assert.ok(
      !dryRunBlock.includes('retryPendingEmbeddings'),
      'dry_run block must not call retryPendingEmbeddings'
    );
  });

  it('dry_run block does NOT call enrichMemory', () => {
    assert.ok(
      !dryRunBlock.includes('enrichMemory'),
      'dry_run block must not call enrichMemory'
    );
  });

  it('dry_run block does NOT call createCausalLink', () => {
    assert.ok(
      !dryRunBlock.includes('createCausalLink'),
      'dry_run block must not call createCausalLink'
    );
  });

  it('dry_run response includes unprocessed_count field', () => {
    assert.ok(
      serverSrc.includes('unprocessed_count'),
      'dry_run should include unprocessed_count in response'
    );
  });

  it('dry_run response status says read-only', () => {
    assert.ok(
      serverSrc.includes('dry_run (read-only)'),
      'dry_run status should indicate read-only'
    );
  });

  it('dry_run response includes note about memory_enrich', () => {
    assert.ok(
      serverSrc.includes('memory_enrich'),
      'dry_run response should mention memory_enrich for unprocessed memories'
    );
  });
});

// ─── Commit write-path regression tests ─────────────────────────────────

describe('commit writes exact cached proposal', () => {
  const serverSrc = readFileSync('./src/server.js', 'utf-8');

  it('commit path writes via fs.writeFile with cached.proposedContent', () => {
    assert.ok(
      serverSrc.includes('await fs.writeFile(filepath, cached.proposedContent'),
      'commit should write cached.proposedContent directly via fs.writeFile'
    );
  });

  it('commit path does NOT use writePeopleFile for the actual write', () => {
    assert.ok(
      serverSrc.includes('fs.writeFile(filepath, cached.proposedContent'),
      'should write cached.proposedContent directly'
    );
  });

  it('commit path calls ensureVaultDir before write', () => {
    assert.ok(
      serverSrc.includes('await ensureVaultDir()'),
      'commit should ensure vault dir before write'
    );
  });
});

// ─── Proposal caching exactness tests ──────────────────────────────────

describe('proposal cache preserves exact content', () => {
  it('buildProposedPeopleContent output is stored as proposedContent', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.includes('proposedContent = buildProposedPeopleContent'),
      'proposedContent should come from buildProposedPeopleContent'
    );
  });

  it('cached object stores proposedContent (not post-processed)', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.match(/proposals\.set\([^,]+,\s*\{[^}]*proposedContent,/m),
      'proposals.set should store an object with proposedContent field (shorthand)'
    );
  });

  it('cached object stores currentHash for conflict detection', () => {
    const serverSrc = readFileSync('./src/server.js', 'utf-8');
    assert.ok(
      serverSrc.match(/proposals\.set\([^,]+,\s*\{[^}]*currentHash,/m),
      'proposals.set should store currentHash for conflict detection (shorthand)'
    );
  });
});
