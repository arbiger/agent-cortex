# Agent-Cortex OpenCode Plugin (MVP-3 Phase 1)

Captures OpenCode `session.idle` and `session.error` events and writes them to Agent-Cortex via `writeEvent()`.

## What this does

When an OpenCode session ends (signalled by `session.idle`), the plugin synthesizes a session summary and writes it as a single AC event:

- `agent_tag: 'opencode'`
- `source_kind: 'opencode-session-idle'`
- Full metadata: started_at, ended_at, message_count, tool_call_count, last message previews, directory, idle_reason

On `session.error`, writes a separate event with `source_kind: 'opencode-session-error'` and error info.

**Phase 1 intentionally does NOT capture per-message or per-tool-call events** (avoid noise).

## Install

### Step 1 — Make the plugin available to OpenCode

**Option A — Symlink (recommended for development):**

```bash
ln -s \
  /Users/george/Georges/apps/agent-cortex/scripts/agent-cortex-plugin/plugin.js \
  ~/.config/opencode/plugins/agent-cortex.js
```

**Option B — Copy (for production):**

```bash
cp /Users/george/Georges/apps/agent-cortex/scripts/agent-cortex-plugin/plugin.js \
  ~/.config/opencode/plugins/agent-cortex.js
```

### Step 2 — Wire into opencode.json

Open `~/.config/opencode/opencode.json` and add the plugin entry to the `plugin` array:

```json
{
  "plugin": [
    ...existing plugins...,
    ["~/.config/opencode/plugins/agent-cortex.js", {
      "ac_runtime_path": "/Users/george/Georges/apps/agent-cortex"
    }]
  ]
}
```

You can also set the path via environment variable `AC_RUNTIME_PATH` instead of the plugin option.

### Step 3 — Restart OpenCode

Restart the OpenCode process to load the new plugin.

## Verify events landed in AC

After a session ends and OpenCode goes idle, run:

```bash
sqlite3 ~/Documents/Georges/06\ 🧠\ Memory/agent_cortex.db \
  "SELECT id, agent_tag, source_kind, substr(content, 1, 80) AS content_preview, status
   FROM memories
   WHERE agent_tag = 'opencode'
   ORDER BY created_at DESC
   LIMIT 5;"
```

You should see rows with `source_kind = 'opencode-session-idle'` or `'opencode-session-error'`.

To see the full metadata JSON:

```bash
sqlite3 ~/Documents/Georges/06\ 🧠\ Memory/agent_cortex.db \
  "SELECT id, source_kind, facts FROM memories WHERE agent_tag = 'opencode' ORDER BY created_at DESC LIMIT 3;"
```

## Uninstall

1. Remove the plugin entry from `opencode.json`
2. Delete `~/.config/opencode/plugins/agent-cortex.js`
3. Restart OpenCode

## Troubleshooting

**Plugin loads but no events appear in AC:**
- Check OpenCode stderr logs for `[agent-cortex]` prefixed lines
- Verify `CORTEX_SQLITE_PATH` is set correctly (or use the default path above)
- Run the AC self-test: `cd /Users/george/Georges/apps/agent-cortex && npm test`

**Events appear but with null metadata:**
- Ensure `directory` is passed correctly in `opencode.json` plugin options
- The plugin falls back to `null` for directory if not provided

**session.idle fires repeatedly (duplicate events):**
- This is expected — OpenCode may emit `session.idle` multiple times
- The plugin tracks `ingested` state per session and only writes once
- This dedupe is in-memory; restart resets the dedupe state

## File layout

```
scripts/agent-cortex-plugin/
├── plugin.js          # OpenCode plugin entry point (imported by OpenCode)
├── session_tracker.js # Pure in-memory session state (no AC dependency)
└── README.md          # This file
```
