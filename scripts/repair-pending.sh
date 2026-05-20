#!/bin/bash
set -euo pipefail

PSQL_BIN=""
if [ -x /opt/homebrew/opt/postgresql@16/bin/psql ]; then
    PSQL_BIN="/opt/homebrew/opt/postgresql@16/bin/psql"
elif command -v psql &> /dev/null; then
    PSQL_BIN="psql"
else
    echo "Error: psql not found" >&2
    exit 1
fi

PSQL_CMD="$PSQL_BIN -U george -d agent_cortex"

RETRY_EMBEDDINGS=false
FIX_ORPHANS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --retry-embeddings)
            RETRY_EMBEDDINGS=true
            shift
            ;;
        --fix-orphans)
            FIX_ORPHANS=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--retry-embeddings] [--fix-orphans]"
            echo ""
            echo "Report pending embeddings and orphan causal links."
            echo "Default mode is read-only (no changes made)."
            echo ""
            echo "Flags:"
            echo "  --retry-embeddings   Retry failed embeddings via MCP tool"
            echo "  --fix-orphans        Delete orphan causal links (DANGEROUS)"
            echo ""
            echo "Requires: psql and running MCP server for --retry-embeddings"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

PENDING_SQL="SELECT COUNT(*) as count FROM memories m
     LEFT JOIN memory_embeddings e ON m.id = e.memory_id
     WHERE m.embedding_pending = TRUE AND e.id IS NULL AND m.is_deleted = FALSE"

ORPHAN_SQL="SELECT COUNT(*) as count FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)"

echo "=== Agent-Cortex Repair Report ==="
echo ""

echo "Checking pending embeddings..."
PENDING=$(eval "$PSQL_CMD -t -c \"$PENDING_SQL\"" 2>/dev/null || echo "0")
PENDING=$(echo "$PENDING" | tr -d '[:space:]')
echo "Pending embeddings: $PENDING"
echo ""

echo "Checking orphan causal links..."
ORPHANS=$(eval "$PSQL_CMD -t -c \"$ORPHAN_SQL\"" 2>/dev/null || echo "0")
ORPHANS=$(echo "$ORPHANS" | tr -d '[:space:]')
echo "Orphan links: $ORPHANS"
echo ""

if [ "$FIX_ORPHANS" = true ]; then
    echo "=== Fixing Orphans ==="
    DELETE_SQL="DELETE FROM causal_links cl
     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.memory_id)
        OR NOT EXISTS (SELECT 1 FROM memories WHERE id = cl.target_id)"
    DELETED=$(eval "$PSQL_CMD -t -c \"$DELETE_SQL\"" 2>/dev/null || echo "0")
    DELETED=$(echo "$DELETED" | tr -d '[:space:]')
    echo "Deleted orphan links: $DELETED"
    echo ""
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$(dirname "$SCRIPT_DIR")"
RETRY_SCRIPT="$SCRIPTS_DIR/scripts/retry-embeddings.mjs"

if [ "$RETRY_EMBEDDINGS" = true ]; then
    echo "=== Retrying Embeddings ==="
    echo "Calling MCP memory_repair tool..."
    if [ ! -f "$RETRY_SCRIPT" ]; then
        echo "Error: retry-embeddings.mjs not found at $RETRY_SCRIPT" >&2
        echo "MCP call skipped"
    else
        node "$RETRY_SCRIPT" "memory_repair" '{"retry_embeddings":true}' 2>&1 || echo "MCP call failed or timed out"
    fi
    echo ""
fi

echo "=== Summary ==="
echo "Pending embeddings: $PENDING"
echo "Orphan links: $ORPHANS"
echo ""
if [ "$FIX_ORPHANS" = false ] && [ "$RETRY_EMBEDDINGS" = false ]; then
    echo "No changes made (read-only mode). Use --fix-orphans or --retry-embeddings to make changes."
fi
