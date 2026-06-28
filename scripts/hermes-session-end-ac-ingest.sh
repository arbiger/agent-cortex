#!/bin/bash
# =============================================================================
# hermes-session-end-ac-ingest.sh
#
# Hermes `on_session_end` hook wrapper — reads Hermes session-end JSON payload
# from stdin, synthesizes an AC event payload, and pipes it to
# ac-ingest-event.js with agent_tag=hermes.
#
# Hermes `on_session_end` payload shape:
#   {
#     "hook_event_name": "on_session_end",
#     "session_id": "sess_abc123",
#     "cwd": "/home/user/project",
#     "extra": {
#       "completed": true,
#       "interrupted": false,
#       "model": "qwen3.6-35b",
#       "platform": "cli"
#     }
#   }
#
# Synthesized event content:
#   Hermes session ended: completed=<bool>, interrupted=<bool>, model=<model>, platform=<platform>, cwd=<cwd>
#
# Dedupe: AC-side pre-check via sqlite3 query on memories table before ingest.
# Idempotent skip if session_id already exists as status='captured' event.
#
# Exit codes:
#   0 — success or idempotent skip
#   1 — validation / normalization error (missing session_id, malformed JSON)
#   2 — DB error
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AC_INGEST="${SCRIPT_DIR}/ac-ingest-event.js"

# ---------------------------------------------------------------------------
# Resolve DB path — CORTEX_SQLITE_PATH env var or default
# ---------------------------------------------------------------------------
DB_PATH="${CORTEX_SQLITE_PATH:-$HOME/Documents/Georges/06 🧠 Memory/agent_cortex.db}"

# ---------------------------------------------------------------------------
# Read stdin — the Hermes session-end payload
# ---------------------------------------------------------------------------
if [[ -p /dev/stdin ]] || [[ ! -t 0 ]]; then
  STDIN_CONTENT=$(cat)
else
  STDIN_CONTENT=""
fi

# Empty stdin → validation error
if [[ -z "$STDIN_CONTENT" ]]; then
  echo "[hermes-ac] Error: empty stdin — Hermes payload required" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse payload — extract key fields using jq or regex fallback
# ---------------------------------------------------------------------------

# Use a temp file to avoid subshell quoting issues
TMPFILE=$(mktemp)

cleanup() {
  rm -f "$TMPFILE"
}
trap cleanup EXIT

echo "$STDIN_CONTENT" > "$TMPFILE"

# Extract fields; empty string if missing
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(jq -r '.session_id // empty' "$TMPFILE" 2>/dev/null || echo "")
  CWD=$(jq -r '.cwd // empty' "$TMPFILE" 2>/dev/null || echo "")
  COMPLETED=$(jq -r 'if (.extra.completed | type) == "boolean" then .extra.completed | tojson else empty end' "$TMPFILE" 2>/dev/null || echo "")
  INTERRUPTED=$(jq -r 'if (.extra.interrupted | type) == "boolean" then .extra.interrupted | tojson else empty end' "$TMPFILE" 2>/dev/null || echo "")
  MODEL=$(jq -r '.extra.model // empty' "$TMPFILE" 2>/dev/null || echo "")
  PLATFORM=$(jq -r '.extra.platform // empty' "$TMPFILE" 2>/dev/null || echo "")
else
  # Regex fallback (no jq)
  SESSION_ID=$(grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMPFILE" 2>/dev/null | \
    sed 's/"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' | head -1 || echo "")
  CWD=$(grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMPFILE" 2>/dev/null | \
    sed 's/"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' | head -1 || echo "")
  COMPLETED=$(grep -o '"completed"[[:space:]]*:[[:space:]]*\(true\|false\)' "$TMPFILE" 2>/dev/null | \
    sed 's/"completed"[[:space:]]*:[[:space:]]*\(true\|false\)/\1/' | head -1 || echo "")
  INTERRUPTED=$(grep -o '"interrupted"[[:space:]]*:[[:space:]]*\(true\|false\)' "$TMPFILE" 2>/dev/null | \
    sed 's/"interrupted"[[:space:]]*:[[:space:]]*\(true\|false\)/\1/' | head -1 || echo "")
  MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMPFILE" 2>/dev/null | \
    sed 's/"model"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' | head -1 || echo "")
  PLATFORM=$(grep -o '"platform"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMPFILE" 2>/dev/null | \
    sed 's/"platform"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' | head -1 || echo "")
fi

# Validate session_id is present
if [[ -z "$SESSION_ID" ]]; then
  echo "[hermes-ac] Error: session_id is required but missing from payload" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Dedupe pre-check — AC-side via sqlite3 query
# Skip if this session_id already ingested as status='captured'
# ---------------------------------------------------------------------------
if [[ -f "$DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
  EXISTING=$(sqlite3 "$DB_PATH" \
    "SELECT count(*) FROM memories WHERE memory_type='event' AND status='captured' AND json_extract(facts,'\$.session_id')='$SESSION_ID' AND json_extract(facts,'\$.source_kind')='hermes-end'" \
    2>/dev/null || echo "0")
  if [[ "$EXISTING" -gt 0 ]]; then
    echo "[hermes-ac] session_id=$SESSION_ID already ingested, skipping (idempotent)" >&2
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Synthesize event content
# ---------------------------------------------------------------------------
if [[ -z "$COMPLETED" ]]; then COMPLETED="unknown"; fi
if [[ -z "$INTERRUPTED" ]]; then INTERRUPTED="unknown"; fi
if [[ -z "$MODEL" ]]; then MODEL="unknown"; fi
if [[ -z "$PLATFORM" ]]; then PLATFORM="unknown"; fi
if [[ -z "$CWD" ]]; then CWD="unknown"; fi

CONTENT="Hermes session ended: completed=$COMPLETED, interrupted=$INTERRUPTED, model=$MODEL, platform=$PLATFORM, cwd=$CWD"

# Build timestamp (now)
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
  node -e "console.log(new Date().toISOString())" 2>/dev/null || \
  gdate -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

# ---------------------------------------------------------------------------
# Build JSON payload for ac-ingest-event.js
# ---------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n \
    --arg agent_tag "hermes" \
    --arg session_id "$SESSION_ID" \
    --arg source "hermes-end" \
    --arg content "$CONTENT" \
    --arg timestamp "$TIMESTAMP" \
    --arg completed "$COMPLETED" \
    --arg interrupted "$INTERRUPTED" \
    --arg model "$MODEL" \
    --arg platform "$PLATFORM" \
    --arg cwd "$CWD" \
    '{
       agent_tag: $agent_tag,
       session_id: $session_id,
       source: $source,
       content: $content,
       timestamp: $timestamp,
       metadata: {
         completed: ($completed == "true"),
         interrupted: ($interrupted == "true"),
         model: $model,
         platform: $platform,
         cwd: $cwd
       }
     }')
else
  # Manual JSON escape (no jq)
  escape_json() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$//'
  }
  ESCAPED_CONTENT=$(escape_json "$CONTENT")
  ESCAPED_CWD=$(escape_json "$CWD")
  ESCAPED_MODEL=$(escape_json "$MODEL")
  ESCAPED_PLATFORM=$(escape_json "$PLATFORM")
  PAYLOAD="{\"agent_tag\":\"hermes\",\"session_id\":\"$SESSION_ID\",\"source\":\"hermes-end\",\"content\":\"$ESCAPED_CONTENT\",\"timestamp\":\"$TIMESTAMP\",\"metadata\":{\"completed\":$COMPLETED,\"interrupted\":$INTERRUPTED,\"model\":\"$ESCAPED_MODEL\",\"platform\":\"$ESCAPED_PLATFORM\",\"cwd\":\"$ESCAPED_CWD\"}}"
fi

# ---------------------------------------------------------------------------
# Pipe to ac-ingest-event.js with agent_tag=hermes, source-kind=hermes-end
# ---------------------------------------------------------------------------
echo "$PAYLOAD" | node "$AC_INGEST" --agent-tag=hermes --source-kind=hermes-end
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "[hermes-ac] session_id=$SESSION_ID ingested successfully" >&2
else
  echo "[hermes-ac] session_id=$SESSION_ID ingest failed with exit $EXIT_CODE" >&2
fi

exit $EXIT_CODE