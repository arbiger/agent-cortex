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

if [ "$RETRY_EMBEDDINGS" = true ]; then
    echo "=== Retrying Embeddings ==="
    echo "Calling MCP memory_repair tool..."
    node -e "
const req = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'memory_repair',
    arguments: { retry_embeddings: true }
  }
});
const conn = await new Promise((res, rej) => {
  const { spawn } = require('child_process');
  const child = spawn('node', ['dist/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  setTimeout(() => { child.kill(); rej(new Error('timeout')); }, 8000);
  child.on('error', rej);
  res({ child, stdout, stderr });
}).catch(e => { console.error('Spawn error:', e.message); process.exit(1); });
const { child } = conn;
child.stdin.write(req + '\n');
child.stdin.end();
await new Promise(r => setTimeout(r, 2000));
const output = conn.stdout;
try {
  const lines = output.trim().split('\n');
  let foundResult = false;
  let foundError = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.error) { foundError = true; console.error('MCP error:', JSON.stringify(parsed.error)); }
      if (parsed.result) foundResult = true;
    } catch {}
  }
  if (!foundResult && !foundError && !output) {
    console.error('No response from MCP server');
    process.exit(1);
  }
  if (foundError) { console.error('MCP call contained errors'); process.exit(1); }
  console.log('MCP call completed');
} catch (e) {
  console.error('Parse error:', e.message);
  console.error('Raw output:', output);
  process.exit(1);
}
" 2>&1 || echo "MCP call failed or timed out"
    echo ""
fi

echo "=== Summary ==="
echo "Pending embeddings: $PENDING"
echo "Orphan links: $ORPHANS"
echo ""
if [ "$FIX_ORPHANS" = false ] && [ "$RETRY_EMBEDDINGS" = false ]; then
    echo "No changes made (read-only mode). Use --fix-orphans or --retry-embeddings to make changes."
fi
