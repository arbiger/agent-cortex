export const PENDING_SQL = `SELECT COUNT(*) as count FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE`;

export const ORPHAN_COUNT_SQL = `SELECT COUNT(*) as count FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`;

export const ORPHAN_DELETE_SQL = `DELETE FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)`;

export function generateRepairSummary(pendingCount, orphanCount, options = {}) {
    const { retryEmbeddings = false, fixOrphans = false, embedded = 0, deleted = 0, errors = [] } = options;
    return {
        timestamp: new Date().toISOString(),
        pending_embeddings: parseInt(pendingCount, 10),
        orphan_links: parseInt(orphanCount, 10),
        actions: {
            retry_embeddings: retryEmbeddings,
            fix_orphans: fixOrphans,
        },
        results: {
            embedded: retryEmbeddings ? embedded : null,
            deleted: fixOrphans ? deleted : null,
        },
        errors,
    };
}

export function parseCountResult(result) {
    if (!result || !result.rows || !result.rows[0]) return 0;
    const count = result.rows[0].count;
    if (count === undefined || count === null) return 0;
    return parseInt(count, 10);
}