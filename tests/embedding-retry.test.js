import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { generateRepairSummary } from '../tools/memory_repair.js';

// NOTE: PG-specific schema migration tests removed (Phase 0.5 embedding-retry.test.js)
// Tests for ON CONFLICT, DO blocks, pg_constraint, ADD COLUMN IF NOT EXISTS
// are no longer applicable — SQLite schema is created via sqlite_store.js initSchema().

describe('insertEmbedding functional behavior', () => {
    test('insertEmbedding sets embedding_pending = 0 after successful upsert', () => {
        const serverSrc = readFileSync('./src/server.js', 'utf8');
        const insertFnMatch = serverSrc.match(/async function insertEmbedding\(memoryId, embedding\) \{[\s\S]*?\n\}/);
        assert.ok(insertFnMatch, 'insertEmbedding function should exist');
        const insertFn = insertFnMatch[0];
        assert.ok(
            insertFn.includes('embedding_pending = 0'),
            `insertEmbedding must clear embedding_pending after successful upsert`
        );
    });
});

describe('retryPendingEmbeddings per-row error tracking', () => {
    test('retryPendingEmbeddings returns errors array with per-row failure details', () => {
        const serverSrc = readFileSync('./src/server.js', 'utf8');
        assert.ok(serverSrc.includes('async function retryPendingEmbeddings'), 'retryPendingEmbeddings function should exist');
        assert.ok(
            serverSrc.includes('errors.push'),
            `retryPendingEmbeddings must track errors array and push per-row failures`
        );
    });

    test('retryPendingEmbeddings return object includes errors array', () => {
        const serverSrc = readFileSync('./src/server.js', 'utf8');
        assert.ok(
            serverSrc.includes('return { attempted: pending.length, embedded, errors }'),
            `retryPendingEmbeddings return must include errors array`
        );
    });
});

describe('generateRepairSummary accepts per-row embedding errors', () => {
    test('generateRepairSummary includes embedding_errors in results when retryEmbeddings is true', () => {
        const summary = generateRepairSummary(5, 0, {
            retryEmbeddings: true,
            embedded: 3,
            embedding_errors: ['memory abc: connection timeout', 'memory def: constraint violation'],
        });

        assert.ok('embedding_errors' in summary.results, 'summary.results must have embedding_errors field');
        assert.strictEqual(summary.results.embedding_errors.length, 2);
    });

    test('generateRepairSummary embedding_errors is null when retryEmbeddings is false', () => {
        const summary = generateRepairSummary(5, 0, { retryEmbeddings: false });
        assert.strictEqual(summary.results.embedding_errors, null);
    });
});

describe('memory_repair summary error exposure', () => {
    test('repair summary errors array is non-empty when embedding_errors has entries', () => {
        const summary = generateRepairSummary(5, 0, {
            retryEmbeddings: true,
            embedded: 3,
            embedding_errors: ['memory xyz: network failure'],
        });

        assert.ok(summary.errors.length > 0, 'summary.errors should contain error messages');
        assert.ok(
            summary.errors.some(e => e.includes('memory xyz')),
            'error message should reference the failed memory'
        );
    });

    test('retryPendingEmbeddings caught errors are surfaced in MCP response', () => {
        const serverSrc = readFileSync('./src/server.js', 'utf8');
        assert.ok(
            serverSrc.includes('embedResult.errors') && serverSrc.includes('embedResult.errors.length'),
            `memory_enrich response should surface embed errors via embedResult.errors and embedResult.errors.length`
        );
    });
});
