#!/bin/bash
set -euo pipefail

VAULT="${CORTEX_VAULT_ROOT:-$HOME/Documents/Georges/06 🧠 Memory}"
DEST="${2:-$HOME/backups/agent-cortex}"

if [ $# -eq 1 ]; then
    DEST="$1"
fi

mkdir -p "$DEST"

DATE=$(date +%Y%m%d_%H%M%S)
OUTPUT="$DEST/vault_backup_$DATE.tar.gz"

tar -czf "$OUTPUT" -C "$(dirname "$VAULT")" "$(basename "$VAULT")"
echo "Vault archive: $OUTPUT"
