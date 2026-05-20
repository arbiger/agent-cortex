import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { generateRepairSummary } from '../tools/memory_repair.js';

describe('insertEmbedding ON CONFLICT handling', () => {
    test('insertEmbedding SQL uses ON CONFLICT with unique constraint, not bare index', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const insertFnMatch = serverSrc.match(/async function insertEmbedding\(memoryId, embedding\) \{[\s\S]*?\n\}/);
        assert.ok(insertFnMatch, 'insertEmbedding function should exist in dist/server.js');
        const insertFn = insertFnMatch[0];

        if (insertFn.includes('ON CONFLICT')) {
            assert.ok(
                insertFn.includes('UNIQUE') || insertFn.includes('unique_index') || insertFn.includes('constraint') ||
                serverSrc.includes('ADD CONSTRAINT') && serverSrc.includes('memory_embeddings') && serverSrc.includes('UNIQUE'),
                `ON CONFLICT clause found but must have UNIQUE constraint on memory_id (either inline or via migration)`
            );
        }
    });

    test('memory_embeddings.memory_id has unique constraint in schema setup', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const hasUniqueConstraint = serverSrc.includes('ADD CONSTRAINT') &&
            serverSrc.includes('memory_embeddings') &&
            serverSrc.includes('UNIQUE (memory_id)');
        assert.ok(
            hasUniqueConstraint,
            `Schema setup must add UNIQUE constraint on memory_embeddings.memory_id`
        );
    });
});

describe('Phase 0.5 schema compatibility', () => {
    test('updated_at column is added via ADD COLUMN IF NOT EXISTS in schema bootstrap', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const hasUpdatedAtColumn = serverSrc.includes('ADD COLUMN IF NOT EXISTS') &&
            serverSrc.includes('updated_at') &&
            serverSrc.includes('memory_embeddings');
        assert.ok(
            hasUpdatedAtColumn,
            `Schema bootstrap must add updated_at column to memory_embeddings using ADD COLUMN IF NOT EXISTS`
        );
    });

    test('unique constraint on memory_embeddings.memory_id uses DO block with pg_constraint check', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const hasDOBlock = serverSrc.includes('DO $$') || serverSrc.includes('DO$');
        const hasPgConstraintCheck = serverSrc.includes("SELECT 1 FROM pg_constraint") ||
            serverSrc.includes('pg_constraint') ||
            serverSrc.includes('conname');
        const hasUniqueOnMemoryId = serverSrc.includes('UNIQUE') && serverSrc.includes('memory_id');
        const noBadIfNotExists = !serverSrc.includes('ADD CONSTRAINT IF NOT EXISTS');
        assert.ok(
            hasDOBlock && hasPgConstraintCheck && hasUniqueOnMemoryId && noBadIfNotExists,
            `Unique constraint must use DO block with pg_constraint check, not ADD CONSTRAINT IF NOT EXISTS`
        );
    });

    test('insertEmbedding sets embedding_pending = FALSE after successful upsert', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const insertFnMatch = serverSrc.match(/async function insertEmbedding\(memoryId, embedding\) \{[\s\S]*?\n\}/);
        assert.ok(insertFnMatch, 'insertEmbedding function should exist');
        const insertFn = insertFnMatch[0];
        assert.ok(
            insertFn.includes('embedding_pending = FALSE'),
            `insertEmbedding must clear embedding_pending after successful upsert`
        );
    });

    test('insertEmbedding upsert does NOT set updated_at when column does not exist', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        const insertFnMatch = serverSrc.match(/async function insertEmbedding\(memoryId, embedding\) \{[\s\S]*?\n\}/);
        assert.ok(insertFnMatch, 'insertEmbedding function should exist');
        const insertFn = insertFnMatch[0];
        if (insertFn.includes('ON CONFLICT')) {
            const hasUpdatedAtSet = insertFn.includes('updated_at =');
            if (hasUpdatedAtSet) {
                const hasUpdatedAtColumn = serverSrc.includes('ADD COLUMN IF NOT EXISTS') &&
                    serverSrc.includes('updated_at') &&
                    serverSrc.includes('memory_embeddings');
                assert.ok(
                    hasUpdatedAtColumn,
                    `upsert sets updated_at but schema bootstrap does not add the column first`
                );
            }
        }
    });
});

describe('retryPendingEmbeddings per-row error tracking', () => {
    test('retryPendingEmbeddings returns errors array with per-row failure details', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        assert.ok(serverSrc.includes('async function retryPendingEmbeddings'), 'retryPendingEmbeddings function should exist');
        assert.ok(
            serverSrc.includes('errors.push'),
            `retryPendingEmbeddings must track errors array and push per-row failures`
        );
    });

    test('retryPendingEmbeddings return object includes errors array', () => {
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
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
            embedding_errors: ['memory abc: connection timeout', 'memory def: ON CONFLICT constraint violated'],
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
        const serverSrc = readFileSync('./dist/server.js', 'utf8');
        assert.ok(
            serverSrc.includes('embedResult.errors') && serverSrc.includes('embedResult.errors.length'),
            `memory_enrich response should surface embed errors via embedResult.errors and embedResult.errors.length`
        );
    });
});