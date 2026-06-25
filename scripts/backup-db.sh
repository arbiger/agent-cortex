#!/bin/bash
set -euo pipefail

CORTEX_SQLITE_PATH="${CORTEX_SQLITE_PATH:-$HOME/Documents/Georges/06 🧠 Memory/agent_cortex.db}"
BACKUP_DIR="$HOME/backups/agent-cortex"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agent_cortex_${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$CORTEX_SQLITE_PATH" ]; then
  echo "ERROR: SQLite DB not found at $CORTEX_SQLITE_PATH"
  exit 1
fi

SRC_SIZE=$(stat -f%z "$CORTEX_SQLITE_PATH")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backing up $CORTEX_SQLITE_PATH (${SRC_SIZE} bytes)"

# Atomic snapshot via SQLite online backup API — WAL-safe, do NOT use cp
sqlite3 "$CORTEX_SQLITE_PATH" ".backup '$BACKUP_FILE'"

BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup written: $BACKUP_FILE (${BACKUP_SIZE} bytes)"

# Validate: open the backup and check it has the expected tables
if sqlite3 "$BACKUP_FILE" ".tables" | grep -q "memories"; then
  MEM_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT count(*) FROM memories;")
  LINK_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT count(*) FROM causal_links;")
  EMBED_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT count(*) FROM memory_embeddings;")
  echo "Backup valid: memories=$MEM_COUNT causal_links=$LINK_COUNT embeddings=$EMBED_COUNT"
  echo "RESULT=OK"
else
  echo "ERROR: Backup validation failed — 'memories' table not found"
  exit 1
fi