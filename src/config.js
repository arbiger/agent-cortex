export const VALID_AGENT_TAGS = ['opencode', 'hermes', 'openclaw', 'george', 'codex', 'agy'];

export const DEFAULTS = {
  VAULT_ROOT: '/Users/george/Documents/Georges/06 🧠 Memory',
  LLM_URL: 'http://localhost:8000',
  LLM_MODEL: 'Qwen3.6-35B-A3B-UD-MLX-3bit',
  EMBED_URL: 'http://localhost:8000/v1/embeddings',
  EMBED_MODEL: 'bge-m3-mlx-fp16',
  SQLITE_PATH: '/Users/george/Documents/Georges/06 🧠 Memory/agent_cortex.db',
  PG_CONN: 'postgresql://george@localhost:5432/agent_cortex',
  TASKPAD_DB_PATH: '/Users/george/Documents/Georges/01 🎯 Projects/agentic-taskpad/agentic-taskpad.db',
};

export function loadConfig(env = process.env) {
  return {
    VAULT_ROOT: env.CORTEX_VAULT_ROOT || DEFAULTS.VAULT_ROOT,
    LLM_URL: env.CORTEX_LLM_URL || DEFAULTS.LLM_URL,
    LLM_MODEL: env.CORTEX_LLM_MODEL || DEFAULTS.LLM_MODEL,
    EMBED_URL: env.CORTEX_EMBED_URL || DEFAULTS.EMBED_URL,
    EMBED_MODEL: env.CORTEX_EMBED_MODEL || DEFAULTS.EMBED_MODEL,
    SQLITE_PATH: env.CORTEX_SQLITE_PATH || DEFAULTS.SQLITE_PATH,
    PG_CONN: env.CORTEX_PG_CONN || DEFAULTS.PG_CONN,
    SERVER_AGENT_TAG: env.CORTEX_AGENT_TAG || null,
    TASKPAD_DB_PATH: env.CORTEX_TASKPAD_DB_PATH || DEFAULTS.TASKPAD_DB_PATH,
  };
}

export function validateAgentTag(agentTag, serverAgentTag = loadConfig().SERVER_AGENT_TAG) {
  if (!agentTag || !VALID_AGENT_TAGS.includes(agentTag)) {
    throw new Error(`Invalid agent_tag: "${agentTag}". Valid: ${VALID_AGENT_TAGS.join(', ')}`);
  }
  if (serverAgentTag && agentTag !== serverAgentTag) {
    throw new Error(`Forbidden: cannot use agent_tag "${agentTag}" — server configured as "${serverAgentTag}"`);
  }
}
