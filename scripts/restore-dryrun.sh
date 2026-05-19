#!/bin/bash
set -euo pipefail

DUMP_SQL="${1:-}"
VAULT_TAR_GZ="${2:-}"

if [ -z "$DUMP_SQL" ] || [ -z "$VAULT_TAR_GZ" ]; then
    echo "Usage: $0 <DUMP_SQL> <VAULT_TAR_GZ>"
    echo "  DUMP_SQL     Path to PostgreSQL dump file (.sql)"
    echo "  VAULT_TAR_GZ Path to vault archive file (.tar.gz)"
    exit 1
fi

echo "=== restore-dryrun.sh — NO ACTUAL RESTORE WILL OCCUR ==="
echo ""

if [ ! -f "$DUMP_SQL" ]; then
    echo "ERROR: Dump file not found: $DUMP_SQL"
    exit 1
fi
if [ ! -r "$DUMP_SQL" ]; then
    echo "ERROR: Dump file not readable: $DUMP_SQL"
    exit 1
fi
echo "✓ Dump file exists and readable: $DUMP_SQL"

if [ ! -f "$VAULT_TAR_GZ" ]; then
    echo "ERROR: Vault archive not found: $VAULT_TAR_GZ"
    exit 1
fi
if [ ! -r "$VAULT_TAR_GZ" ]; then
    echo "ERROR: Vault archive not readable: $VAULT_TAR_GZ"
    exit 1
fi
echo "✓ Vault archive exists and readable: $VAULT_TAR_GZ"

if ! tar -tzf "$VAULT_TAR_GZ" > /dev/null 2>&1; then
    echo "ERROR: Vault archive is invalid or corrupted: $VAULT_TAR_GZ"
    exit 1
fi
echo "✓ Vault archive is valid (tar -tzf succeeded)"
ARCHIVE_CONTENTS=$(tar -tzf "$VAULT_TAR_GZ")
echo "  Archive contents preview:"
echo "$ARCHIVE_CONTENTS" | head -5
if [ $(echo "$ARCHIVE_CONTENTS" | wc -l) -gt 5 ]; then
    echo "  ... and $(echo "$ARCHIVE_CONTENTS" | wc -l) total entries"
fi

SQL_HEADER=$(head -c 100 "$DUMP_SQL")
if echo "$SQL_HEADER" | grep -qiE "(postgresql|dump)"; then
    echo "✓ SQL file appears to be a PostgreSQL dump"
elif echo "$SQL_HEADER" | grep -qi "CREATE TABLE\|INSERT INTO\|--"; then
    echo "✓ SQL file appears to be plain SQL"
else
    echo "WARNING: Cannot confirm SQL file is a valid PostgreSQL dump or plain SQL"
    echo "  First 100 chars: $SQL_HEADER"
fi

echo ""
echo "=== VALIDATION PASSED — RESTORE COMMANDS (MANUAL USE ONLY) ==="
echo ""
echo "# 1. Restore database (run as postgres or superuser):"
echo "#    Drop existing DB first (optional, DESTRUCTIVE):"
echo "#    psql -U george -c 'DROP DATABASE IF EXISTS agent_cortex;'"
echo "#    psql -U george -c 'CREATE DATABASE agent_cortex;'"
echo "#    Then restore:"
echo "   psql -U george -d agent_cortex -f \"$DUMP_SQL\""
echo ""
echo "# 2. Restore vault archive:"
ARCHIVE_FIRST_ENTRY=$(tar -tzf "$VAULT_TAR_GZ" | head -1)
INFERRED_VAULT_DIR=$(dirname "$ARCHIVE_FIRST_ENTRY")
if [ "$INFERRED_VAULT_DIR" = "." ] || [ -z "$INFERRED_VAULT_DIR" ]; then
    echo "#    Archive structure: $ARCHIVE_FIRST_ENTRY"
    echo "#    Detected vault path resolves to root — likely created by backup-vault.sh"
    echo "#    Example restore target parent: \$HOME/Documents/Georges"
    echo "#    (Replace \$HOME with your actual home path, e.g. /Users/george)"
    echo "   tar -xzf \"$VAULT_TAR_GZ\" -C \"\$HOME/Documents/Georges\""
else
    echo "#    Detected vault path from archive: $INFERRED_VAULT_DIR"
    echo "   tar -xzf \"$VAULT_TAR_GZ\" -C \"$(dirname "$INFERRED_VAULT_DIR")\""
fi
echo ""
echo "# 3. Verify after restore:"
echo "   psql -U george -d agent_cortex -c 'SELECT COUNT(*) FROM memories;'"
echo "   ls \"\$VAULT_DIR\""
echo ""
echo "=== END DRY-RUN ==="
