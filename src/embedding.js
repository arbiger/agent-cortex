import { loadConfig } from './config.js';

export function parseEmbeddingResponse(responseBody) {
  const data = JSON.parse(responseBody);
  return data.data[0].embedding;
}

export async function getEmbedding(input, options = {}) {
  const config = loadConfig(options.env);
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(config.EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.EMBED_MODEL, input }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Embedding failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } finally {
    clearTimeout(timeout);
  }
}