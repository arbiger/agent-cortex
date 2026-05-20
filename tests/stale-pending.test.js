import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { CLEAR_STALE_PENDING_SQL, generateRepairSummary } from '../tools/memory_repair.js';

describe('clearStalePendingCount SQL', () => {
    test('CLEAR_STALE_PENDING_SQL finds memories with embedding_pending=true that already have an embedding row', () => {
        assert.ok(CLEAR_STALE_PENDING_SQL, 'CLEAR_STALE_PENDING_SQL must be exported');
        assert.ok(CLEAR_STALE_PENDING_SQL.includes('embedding_pending = TRUE'), `Got: ${CLEAR_STALE_PENDING_SQL}`);
    });

    test('CLEAR_STALE_PENDING_SQL uses inner join to only match memories that already have an embedding row', () => {
        assert.ok(CLEAR_STALE_PENDING_SQL.includes('memory_embeddings'), `Got: ${CLEAR_STALE_PENDING_SQL}`);
        assert.ok(CLEAR_STALE_PENDING_SQL.includes('JOIN memory_embeddings'), `Got: ${CLEAR_STALE_PENDING_SQL}`);
    });

    test('CLEAR_STALE_PENDING_SQL excludes is_deleted memories', () => {
        assert.ok(CLEAR_STALE_PENDING_SQL.includes('is_deleted = FALSE'), `Got: ${CLEAR_STALE_PENDING_SQL}`);
    });
});

describe('clear stale pending action', () => {
    test('generateRepairSummary accepts cleared_stale_pending in options', () => {
        const summary = generateRepairSummary(5, 0, {
            retryEmbeddings: true,
            embedded: 4,
            cleared_stale_pending: 3,
            errors: [],
        });
        assert.strictEqual(summary.results.cleared_stale_pending, 3);
    });

    test('generateRepairSummary cleared_stale_pending is null when action not taken', () => {
        const summary = generateRepairSummary(5, 0, { retryEmbeddings: false });
        assert.strictEqual(summary.results.cleared_stale_pending, null);
    });

    test('memory_repair handler clears stale pending flags before retrying embeddings', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const repairHandler = serverSrc.match(/if \(name === 'memory_repair'\)[^]+?(?=if\s*\(name|$)/)?.[0] || '';
        assert.ok(
            repairHandler.includes('clearStalePending') || repairHandler.includes('cleared_stale_pending'),
            `memory_repair handler must clear stale pending flags and report cleared_stale_pending`
        );
    });

    test('memory_repair handler reports stale flags cleared in results', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        assert.ok(
            serverSrc.includes('cleared_stale_pending') && serverSrc.includes('results'),
            `memory_repair response must include cleared_stale_pending in results`
        );
    });
});

describe('getPendingEmbeddings unchanged behavior', () => {
    test('getPendingEmbeddings still uses LEFT JOIN with e.id IS NULL condition', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const getPendingFn = serverSrc.match(/async function getPendingEmbeddings\(\)[^]+?\n\}/)?.[0] || '';
        assert.ok(
            getPendingFn.includes('e.id IS NULL'),
            `getPendingEmbeddings must still only return memories with embedding_pending=true AND no embedding row`
        );
    });

    test('getPendingEmbeddings does not use CLEAR_STALE_PENDING_SQL', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const getPendingFn = serverSrc.match(/async function getPendingEmbeddings\(\)[^]+?\n\}/)?.[0] || '';
        assert.ok(
            !getPendingFn.includes('e.id IS NOT NULL'),
            `getPendingEmbeddings must NOT return memories that already have an embedding row`
        );
    });
});