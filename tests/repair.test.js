import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { generateRepairSummary, parseCountResult, PENDING_SQL, ORPHAN_COUNT_SQL, ORPHAN_DELETE_SQL } from '../tools/memory_repair.js';

const PENDING_SQL_CHECK = PENDING_SQL;
const ORPHAN_SQL_CHECK = ORPHAN_COUNT_SQL;

describe('memory_repair SQL queries', () => {
    test('PENDING_SQL includes memory_embeddings LEFT JOIN', () => {
        assert.ok(PENDING_SQL_CHECK.includes('memory_embeddings'), `Got: ${PENDING_SQL_CHECK}`);
    });

    test('PENDING_SQL checks embedding_pending = TRUE', () => {
        assert.ok(PENDING_SQL_CHECK.includes('embedding_pending = TRUE'), `Got: ${PENDING_SQL_CHECK}`);
    });

    test('ORPHAN_COUNT_SQL checks both memory_id and target_id', () => {
        assert.ok(ORPHAN_SQL_CHECK.includes('memory_id') && ORPHAN_SQL_CHECK.includes('target_id'), `Got: ${ORPHAN_SQL_CHECK}`);
    });

    test('ORPHAN_DELETE_SQL only deletes from causal_links', () => {
        assert.ok(ORPHAN_DELETE_SQL.trim().startsWith('DELETE FROM causal_links'), `Got: ${ORPHAN_DELETE_SQL}`);
        assert.ok(!ORPHAN_DELETE_SQL.includes('DELETE FROM memories'), 'Delete SQL must not delete from memories table');
    });

    test('ORPHAN_DELETE_SQL uses NOT EXISTS clause', () => {
        assert.ok(ORPHAN_DELETE_SQL.includes('NOT EXISTS'), `Got: ${ORPHAN_DELETE_SQL}`);
    });
});

describe('generateRepairSummary', () => {
    test('returns pending and orphan counts', () => {
        const summary = generateRepairSummary(5, 3);
        assert.strictEqual(summary.pending_embeddings, 5);
        assert.strictEqual(summary.orphan_links, 3);
    });

    test('sets retry_embeddings action flag when true', () => {
        const summary = generateRepairSummary(5, 3, { retryEmbeddings: true, embedded: 3 });
        assert.strictEqual(summary.actions.retry_embeddings, true);
        assert.strictEqual(summary.results.embedded, 3);
    });

    test('sets fix_orphans action flag when true', () => {
        const summary = generateRepairSummary(5, 3, { fixOrphans: true, deleted: 2 });
        assert.strictEqual(summary.actions.fix_orphans, true);
        assert.strictEqual(summary.results.deleted, 2);
    });

    test('results.embedded is null when retry_embeddings is false', () => {
        const summary = generateRepairSummary(5, 3);
        assert.strictEqual(summary.results.embedded, null);
    });

    test('results.deleted is null when fix_orphans is false', () => {
        const summary = generateRepairSummary(5, 3);
        assert.strictEqual(summary.results.deleted, null);
    });

    test('includes timestamp in ISO format', () => {
        const summary = generateRepairSummary(0, 0);
        assert.ok(summary.timestamp);
        assert.ok(summary.timestamp.includes('T'));
    });

    test('records errors array', () => {
        const summary = generateRepairSummary(5, 3, { errors: ['network timeout'] });
        assert.deepStrictEqual(summary.errors, ['network timeout']);
    });
});

describe('parseCountResult', () => {
    test('parses string count from query result', () => {
        const result = { rows: [{ count: '42' }] };
        assert.strictEqual(parseCountResult(result), 42);
    });

    test('parses zero count', () => {
        const result = { rows: [{ count: '0' }] };
        assert.strictEqual(parseCountResult(result), 0);
    });

    test('returns 0 for null result', () => {
        assert.strictEqual(parseCountResult(null), 0);
    });

    test('returns 0 for empty rows', () => {
        assert.strictEqual(parseCountResult({ rows: [] }), 0);
    });

    test('returns 0 for missing count column', () => {
        assert.strictEqual(parseCountResult({ rows: [{}] }), 0);
    });
});

describe('repair summary structure', () => {
    test('summary object has all required fields', () => {
        const summary = generateRepairSummary(10, 5, {
            retryEmbeddings: true,
            fixOrphans: true,
            embedded: 8,
            deleted: 2,
            errors: [],
        });
        assert.ok(typeof summary.timestamp === 'string');
        assert.ok(typeof summary.pending_embeddings === 'number');
        assert.ok(typeof summary.orphan_links === 'number');
        assert.ok(typeof summary.actions === 'object');
        assert.ok(typeof summary.results === 'object');
        assert.ok(Array.isArray(summary.errors));
    });

    test('summary serializes to JSON', () => {
        const summary = generateRepairSummary(10, 5);
        const json = JSON.stringify(summary);
        assert.ok(json.includes('pending_embeddings'));
        assert.ok(json.includes('orphan_links'));
    });
});

describe('repair script validation', () => {
    test('repair-pending.sh does not use pipe to node without error checking', () => {
        const scriptPath = new URL('../scripts/repair-pending.sh', import.meta.url).pathname;
        const content = readFileSync(scriptPath, 'utf8');
        const pipeToNode = /\|.*node\s+dist\/server\.js/;
        const hasPipe = pipeToNode.test(content);
        assert.ok(!hasPipe || content.includes('process.exit'), 'Script should not use unguarded pipe to node (use node wrapper with error checking)');
    });

    test('repair-pending.sh --retry-embeddings has explicit exit on failure', () => {
        const scriptPath = new URL('../scripts/repair-pending.sh', import.meta.url).pathname;
        const content = readFileSync(scriptPath, 'utf8');
        const retrySection = content.split('if [ "$RETRY_EMBEDDINGS"')[1] || '';
        assert.ok(retrySection.includes('process.exit'), 'Retry block should call process.exit on failure');
        assert.ok(retrySection.includes('MCP error') || retrySection.includes('No response'), 'Retry block should detect MCP errors');
    });

    test('repair-pending.sh --retry-embeddings avoids GNU timeout dependency', () => {
        const scriptPath = new URL('../scripts/repair-pending.sh', import.meta.url).pathname;
        const content = readFileSync(scriptPath, 'utf8');
        assert.ok(!content.includes('timeout '), 'Script should not use GNU timeout command');
    });

    test('retryPendingEmbeddings function includes delay parameter', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        assert.ok(serverSrc.includes('retryPendingEmbeddings(delayMs'), 'retryPendingEmbeddings should accept delayMs parameter');
    });

    test('retryPendingEmbeddings delays between embeddings when delayMs > 0', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        assert.ok(serverSrc.includes('setTimeout'), 'retryPendingEmbeddings should use setTimeout for delay');
        assert.ok(serverSrc.includes('delayMs') && serverSrc.includes('new Promise'), 'Should use delayMs with Promise setTimeout');
    });

    test('retryPendingEmbeddings returns early with zero pending', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const retryFn = serverSrc.match(/async function retryPendingEmbeddings[^}]+\}/s)?.[0] || '';
        assert.ok(retryFn.includes('pending.length === 0'), 'Should check for zero pending early return');
    });
});