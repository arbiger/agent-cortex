function stripCodeFences(text) {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractBalanced(text, openChar, closeChar) {
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

export function extractFirstJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('LLM response was empty');
  }

  const trimmed = stripCodeFences(text);

  try {
    return JSON.parse(trimmed);
  } catch {
  }

  const candidate = extractBalanced(trimmed, '{', '}');
  if (!candidate) {
    throw new Error('LLM response did not contain a valid JSON object');
  }

  return JSON.parse(candidate);
}

export function parseEnrichmentPayload(text) {
  const parsed = extractFirstJsonObject(text);
  const facts = Array.isArray(parsed.facts) ? parsed.facts.filter(v => typeof v === 'string') : [];
  const narrative = typeof parsed.narrative === 'string' && parsed.narrative.trim()
    ? parsed.narrative.trim()
    : null;
  const links = Array.isArray(parsed.links) ? parsed.links : [];

  if (!narrative) {
    throw new Error('LLM enrichment payload missing narrative');
  }

  return { facts, narrative, links };
}
