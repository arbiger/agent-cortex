# Agent Cortex — Standalone MCP Server

A standalone MCP server for shared memory across AI agents.

> **2026-06-07 migration:** Backend changed from PostgreSQL to SQLite. The `CORTEX_PG_CONN` env var is replaced by `CORTEX_SQLITE_PATH` (single file, no separate DB service). See `DEV-LOG.md` for details.

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables (or use .env file)
export CORTEX_SQLITE_PATH=~/Documents/Georges/06\ 🧠\ Memory/agent_cortex.db
export CORTEX_VAULT_ROOT=~/Documents/Georges/06\ 🧠\ Memory
export CORTEX_LLM_URL=http://localhost:8000
export CORTEX_LLM_MODEL=Qwen3.6-35B-A3B-TurboQuant-MLX-4bit
export CORTEX_EMBED_URL=http://localhost:8000/v1/embeddings
export CORTEX_EMBED_MODEL=bge-m3-mlx-fp16

# Run
node src/server.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CORTEX_SQLITE_PATH` | SQLite database file path | `~/Documents/Georges/06 🧠 Memory/agent_cortex.db` |
| `CORTEX_VAULT_ROOT` | Path to memory vault folder | `~/Documents/Georges/06 🧠 Memory` |
| `CORTEX_LLM_URL` | LLM API endpoint | `http://localhost:8000` |
| `CORTEX_LLM_MODEL` | LLM model name | `Qwen3.6-35B-A3B-UD-MLX-3bit` |
| `CORTEX_EMBED_URL` | Embedding API endpoint | `http://localhost:8000/v1/embeddings` |
| `CORTEX_EMBED_MODEL` | Embedding model name | `bge-m3-mlx-fp16` |
| `CORTEX_TASKPAD_DB_PATH` | Path to agentic-taskpad SQLite database | `~/Documents/Georges/01 🎯 Projects/agentic-taskpad/agentic-taskpad.db` |

**Note:** `CORTEX_AGENT_TAG` is set per-agent in their config, NOT here.

## Agent Configuration

Each agent adds to their config:

```yaml
# Hermes (~/.hermes/config.yaml)
mcp_servers:
  agent-cortex:
    command: node
    args: [/path/to/src/server.js]
    env:
      CORTEX_AGENT_TAG: hermes
```

```json
// OpenCode (~/.opencode/opencode.json)
{
  "mcpServers": {
    "agent-cortex": {
      "command": "node",
      "args": ["/path/to/src/server.js"]
    }
  }
}
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.agent_cortex]
command = "/opt/homebrew/bin/node"
args = ["/Users/george/Georges/apps/agent-cortex/src/server.js"]
startup_timeout_sec = 120

[mcp_servers.agent_cortex.env]
CORTEX_AGENT_TAG = "codex"
HOME = "/Users/george"
```

## Database Setup

SQLite database is auto-created at `CORTEX_SQLITE_PATH` on first run. Tables:

- `memories` — memory documents
- `memory_embeddings` — vector embeddings (BLOB, Float32 LE, 4096 bytes)
- `causal_links` — causal relationships

## MCP Tools

- `memory_write` — write memory document
- `memory_query` — semantic/keyword/hybrid/causal search
- `memory_read_people` — read person profile
- `memory_causal_walk` — walk causal chain
- `memory_enrich` — run enrichment pipeline
- `memory_distill_people` — review-gated distillation of enriched memories into people file updates

## memory_distill_people Workflow

**Prerequisite:** Run `memory_enrich` first if you want the latest unprocessed memories included in distillation. The dry-run only reads memories that are already enriched (`enriched=TRUE`), so unprocessed memories are not automatically enriched during dry-run.

**Dry run** (`dry_run=true`): A read-only operation — generates a diff from already-enriched source memories, returns a `proposal_id`. No writes, no enrichment, no causal link creation. A count of unprocessed memories is included in the response with a note suggesting `memory_enrich` if you want them included.

**Commit** (`dry_run=false`): Requires `proposal_id` from a prior dry run. Validates the file hasn't changed since proposal, then writes the exact proposed content.

### Authorization

**Only a server configured as `george` can commit.** The `CORTEX_AGENT_TAG` environment variable identifies the server's identity. Non-George servers (or any agent calling the tool without `CORTEX_AGENT_TAG=george`) are restricted to **dry-run only**.

| Server `CORTEX_AGENT_TAG` | dry_run=true | dry_run=false (commit) |
|---------------------------|-------------|----------------------|
| `george`                  | ✓ allowed   | ✓ allowed            |
| any other value           | ✓ allowed   | ✗ Forbidden          |
| unset                     | ✓ allowed   | ✗ Forbidden          |

Example — starting the server for George (can commit):
```bash
CORTEX_AGENT_TAG=george node src/server.js
```

Example — starting the server for a subordinate agent (dry-run only):
```bash
CORTEX_AGENT_TAG=opencode node src/server.js
```

The `CORTEX_AGENT_TAG` is set per-agent in their start-up environment, not in a shared config file.

## Feedback Loop Prevention

The server validates `agent_tag` strictly. Valid tags:
- `opencode`
- `hermes`
- `openclaw`
- `george`
- `codex`

Invalid tags are rejected with an error — no silent fallback.
