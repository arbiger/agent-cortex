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

## Feedback Loop Prevention

The server validates `agent_tag` strictly. Valid tags:
- `opencode`
- `hermes`
- `openclaw`
- `george`

Invalid tags are rejected with an error — no silent fallback.
