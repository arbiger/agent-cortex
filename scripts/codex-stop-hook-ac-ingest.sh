#!/bin/bash
# =============================================================================
# codex-stop-hook-ac-ingest.sh
#
# Codex `Stop` hook wrapper — reads Codex Stop payload from stdin,
# synthesizes a memory_write_event-shaped payload, and pipes it to
# ac-ingest-event.js.
#
# Codex `Stop` payload shape (varies by version; we handle defensively):
#   {
#     "session_id": "abc-123",
#     "reason": "completed" | "error" | "user_cancelled",
#     "cwd": "/path/to/cwd",
#     "transcript_path": "/path/to/transcript.jsonl",
#     ...other fields...
#   }
#
# Synthesized event content:
#   Codex session ended: reason=<reason>, cwd=<cwd>, transcript=<transcript_path>
#
# Usage (in ~/.codex/hooks.json):
#   {
#     "hooks": {
#       "Stop": [
#         {
#           "hooks": [
#             {
#               "type": "command",
#               "command": "/Users/george/Georges/apps/agent-cortex/scripts/codex-stop-hook-ac-ingest.sh",
#               "timeout": 10000
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Override agent-tag via --agent-tag flag (default: codex).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AC_INGEST="${SCRIPT_DIR}/ac-ingest-event.js"

# ---------------------------------------------------------------------------
# Parse optional --agent-tag flag
# ---------------------------------------------------------------------------
AGENT_TAG="codex"
REMAINING_ARGS=()

for arg in "$@"; do
  if [[ "$arg" == --agent-tag=* ]]; then
    AGENT_TAG="${arg#*=}"
  else
    REMAINING_ARGS+=("$arg")
  fi
done

# ---------------------------------------------------------------------------
# Read stdin — the Codex Stop payload
# ---------------------------------------------------------------------------
if [[ -p /dev/stdin ]] || [[ ! -t 0 ]]; then
  # stdin is a pipe or redirected
  STDIN_CONTENT=$(cat)
else
  # No stdin (should not happen in hook context but be safe)
  STDIN_CONTENT="{}"
fi

# ---------------------------------------------------------------------------
# Synthesize payload — extract key fields, fill in defaults
# ---------------------------------------------------------------------------

# Use jq if available, otherwise fall back to regex extraction
合成() {
  local session_id reason cwd transcript_path tmpfile

  tmpfile=$(mktemp)

  echo "$STDIN_CONTENT" > "$tmpfile"

  # Extract known fields (empty string if missing)
  if command -v jq &> /dev/null; then
    session_id=$(jq -r '.session_id // empty' "$tmpfile" 2>/dev/null || echo "")
    reason=$(jq -r '.reason // empty' "$tmpfile" 2>/dev/null || echo "")
    cwd=$(jq -r '.cwd // empty' "$tmpfile" 2>/dev/null || echo "")
    transcript_path=$(jq -r '.transcript_path // empty' "$tmpfile" 2>/dev/null || echo "")
  else
    # Regex fallback (no jq)
    session_id=$(grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$tmpfile" 2>/dev/null | \
                 sed 's/"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' || echo "")
    reason=$(grep -o '"reason"[[:space:]]*:[[:space:]]*"[^"]*"' "$tmpfile" 2>/dev/null | \
             sed 's/"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' || echo "")
    cwd=$(grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' "$tmpfile" 2>/dev/null | \
          sed 's/"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' || echo "")
    transcript_path=$(grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' "$tmpfile" 2>/dev/null | \
                      sed 's/"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' || echo "")
  fi

  rm -f "$tmpfile"

  # Generate UUID if session_id missing
  if [[ -z "$session_id" ]]; then
    session_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || \
                 node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || \
                 date +%s%N)
  fi

  # Build the synthesized event content
  local synthesized_content="Codex session ended: reason=${reason:-unknown}, cwd=${cwd:-unknown}, transcript=${transcript_path:-none}"

  # Build JSON payload for ac-ingest-event.js
  # ac-ingest-event expects wire format: agent_tag, session_id, source, content, timestamp
  local timestamp_now
  timestamp_now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                  node -e "console.log(new Date().toISOString())" 2>/dev/null || \
                  gdate -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

  # If jq available, build clean JSON; otherwise use printf escape
  if command -v jq &> /dev/null; then
    jq -n \
      --arg agent_tag "$AGENT_TAG" \
      --arg session_id "$session_id" \
      --arg source "codex-stop-hook" \
      --arg content "$synthesized_content" \
      --arg timestamp "$timestamp_now" \
      '{
         agent_tag: $agent_tag,
         session_id: $session_id,
         source: $source,
         content: $content,
         timestamp: $timestamp
       }'
  else
    # Manual JSON (escape special chars in content)
    local escaped_content
    escaped_content="${synthesized_content//\\/\\\\}"
    escaped_content="${escaped_content//\"/\\\"}"
    escaped_content="${escaped_content//$'\n'/\\n}"
    escaped_content="${escaped_content//$'\r'/\\r}"
    escaped_content="${escaped_content//$'\t'/\\t}"

    printf '{"agent_tag":"%s","session_id":"%s","source":"codex-stop-hook","content":"%s","timestamp":"%s"}' \
      "$AGENT_TAG" "$session_id" "$escaped_content" "$timestamp_now"
    echo
  fi
}

PAYLOAD=$(合成)

# ---------------------------------------------------------------------------
# Pipe to ac-ingest-event.js
# ---------------------------------------------------------------------------
echo "$PAYLOAD" | node "$AC_INGEST" --agent-tag="$AGENT_TAG"
