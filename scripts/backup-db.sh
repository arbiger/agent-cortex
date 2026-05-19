#!/bin/bash
set -euo pipefail

DEST="${1:-$HOME/backups/agent-cortex}"
mkdir -p "$DEST"

if [ -x /opt/homebrew/opt/postgresql@16/bin/pg_dump ]; then
    PG_DUMP="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
else
    PG_DUMP="pg_dump"
fi

DATE=$(date +%Y%m%d_%H%M%S)
OUTPUT="$DEST/db_dump_$DATE.sql"

"$PG_DUMP" -U george -d agent_cortex -f "$OUTPUT"
echo "DB dump: $OUTPUT"
