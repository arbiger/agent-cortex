# Agent Cortex — Standalone MCP Server

A standalone MCP server for shared memory across AI agents.

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables (or use .env file)
export CORTEX_PG_CONN=postgresql://george@localhost:5432/agent_cortex
export CORTEX_VAULT_ROOT=~/Documents/Georges/06\ 🧠\ Memory
export CORTEX_LLM_URL=http://localhost:8000
export CORTEX_LLM_MODEL=Qwen3.6-35B-A3B-TurboQuant-MLX-4bit
export CORTEX_EMBED_URL=http://localhost:8000/v1/embeddings
export CORTEX_EMBED_MODEL=bge-m3-mlx-fp16

# Run
node dist/server.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CORTEX_PG_CONN` | PostgreSQL connection string | `postgresql://george@localhost:5432/agent_cortex` |
| `CORTEX_VAULT_ROOT` | Path to memory vault folder | `~/Documents/Georges/06 🧠 Memory` |
| `CORTEX_LLM_URL` | LLM API endpoint | `http://localhost:8000` |
| `CORTEX_LLM_MODEL` | LLM model name | `Qwen3.6-35B-A3B-UD-MLX-3bit` |
| `CORTEX_EMBED_URL` | Embedding API endpoint | `http://localhost:8000/v1/embeddings` |
| `CORTEX_EMBED_MODEL` | Embedding model name | `bge-m3-mlx-fp16` |
| `CORTEX_TASKDB_CONN` | PostgreSQL connection string for TaskPad database | `postgresql://george@localhost:5432/taskdb` |

**Note:** `CORTEX_AGENT_TAG` is set per-agent in their config, NOT here.

## Agent Configuration

Each agent adds to their config:

```yaml
# Hermes (~/.hermes/config.yaml)
mcp_servers:
  agent-cortex:
    command: node
    args: [/path/to/dist/server.js]
    env:
      CORTEX_AGENT_TAG: hermes
```

```json
// OpenCode (~/.opencode/opencode.json)
{
  "mcpServers": {
    "agent-cortex": {
      "command": "node",
      "args": ["/path/to/dist/server.js"]
    }
  }
}
```

## Database Setup

The database `agent_cortex` already has pgvector enabled. Tables:

- `ac_memories` — memory documents
- `ac_memory_embeddings` — vector embeddings
- `ac_causal_links` — causal relationships

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
CORTEX_AGENT_TAG=george node dist/server.js
```

Example — starting the server for a subordinate agent (dry-run only):
```bash
CORTEX_AGENT_TAG=opencode node dist/server.js
```

The `CORTEX_AGENT_TAG` is set per-agent in their start-up environment, not in a shared config file.

## Feedback Loop Prevention

The server validates `agent_tag` strictly. Valid tags:
- `opencode`
- `hermes`
- `openclaw`
- `george`

Invalid tags are rejected with an error — no silent fallback.
