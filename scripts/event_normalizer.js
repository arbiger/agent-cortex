/**
 * event_normalizer.js — pure ESM
 *
 * Normalizes raw hook payloads (Codex Stop hook, or any runtime hook)
 * into the shape accepted by writeEvent().
 *
 * Wire format (7 fields from runtime hook):
 *   { agent_tag, session_id, timestamp, source, role, content, status }
 *
 * writeEvent shape:
 *   { agent_tag, session_id, source_kind, content, occurred_at, metadata, source_ref }
 *
 * Exports:
 *   normalizeHookEvent(rawPayload, overrides?, defaults?) → { agent_tag, session_id, source_kind, content, occurred_at, metadata, source_ref }
 *   validateAgentTag(tag) → throws on invalid
 *   parseTimestamp(value) → ISO string | null
 */
import { VALID_AGENT_TAGS } from '../src/config.js';

// Fields we explicitly consume from the wire
const WIRE_FIELDS = new Set(['agent_tag', 'session_id', 'timestamp', 'source', 'role', 'content', 'status']);

/**
 * Parse a timestamp value into an ISO date string or null.
 * Accepts: ISO-8601 string, Unix ms number, undefined/null.
 * Returns: ISO string or null.
 */
export function parseTimestamp(value) {
  if (value === undefined || value === null) return null;

  // Already a string — validate it looks like ISO-8601
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Accept ISO-8601 (with or without timezone)
    const isoMatch = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?/.test(trimmed);
    if (!isoMatch) {
      throw new Error(`Invalid ISO-8601 timestamp string: "${trimmed}"`);
    }
    return trimmed;
  }

  // Unix ms number
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid Unix ms timestamp: ${value}`);
    }
    // Detect Unix seconds vs ms — if < 10^12 assume seconds
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }

  throw new Error(`timestamp must be ISO string or Unix ms number, got: ${typeof value}`);
}

/**
 * Validate agent_tag against VALID_AGENT_TAGS.
 * Throws with clear message on invalid.
 */
export function validateAgentTag(tag) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    throw new Error('agent_tag is required and must be a non-empty string');
  }
  if (!VALID_AGENT_TAGS.includes(tag.trim())) {
    throw new Error(`Invalid agent_tag: "${tag.trim()}". Valid: ${VALID_AGENT_TAGS.join(', ')}`);
  }
}

/**
 * Normalize a raw hook payload into writeEvent args.
 *
 * @param {object} raw - raw JSON payload from hook
 * @param {object} [overrides] - values that ALWAYS take precedence (e.g. CLI flags)
 * @param {object} [defaults] - values used only when payload field is missing
 * @returns {{ agent_tag, session_id, source_kind, content, occurred_at, metadata, source_ref }}
 *
 * Priority: overrides > raw (payload) > defaults
 *
 * Wire → writeEvent mapping:
 *   agent_tag  → agent_tag   (required, validated)
 *   session_id → session_id  (required, non-empty)
 *   timestamp  → occurred_at (ISO string or null)
 *   source     → source_kind (required, wire calls it 'source')
 *   role       → metadata.role (optional; goes into metadata if present)
 *   content    → content     (required, non-empty)
 *   status     → (ignored — always overwritten to 'captured' by writeEvent)
 *
 * Extra fields (not in wire spec) are passed through in metadata.
 */
export function normalizeHookEvent(raw, overrides = {}, defaults = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Payload must be a plain object');
  }

  /** Pick first-defined in priority order: overrides > raw > defaults */
  const pick = (key) =>
    overrides[key] !== undefined ? overrides[key]
    : raw[key] !== undefined ? raw[key]
    : defaults[key];

  // --- agent_tag (required, validated) ---
  const agent_tag = pick('agent_tag');
  if (!agent_tag) throw new Error('agent_tag is required');
  validateAgentTag(agent_tag);

  // --- session_id (required, non-empty) ---
  const session_id = pick('session_id');
  if (!session_id || (typeof session_id === 'string' && !session_id.trim())) {
    throw new Error('session_id is required and must be a non-empty string');
  }

  // --- source (required) ---
  const source = pick('source');
  if (!source || (typeof source === 'string' && !source.trim())) {
    throw new Error('source is required (wire field: source)');
  }
  const source_kind = source.trim();

  // --- content (required, non-empty) ---
  const content = pick('content');
  if (!content || (typeof content === 'string' && !content.trim())) {
    throw new Error('content is required and must be a non-empty string');
  }

  // --- timestamp → occurred_at ---
  const occurred_at = parseTimestamp(pick('timestamp') ?? null);

  // --- Build metadata ---
  // Wire role goes into metadata.role (override > raw > defaults)
  const roleVal = pick('role');
  const metadata = { ...raw.metadata };

  if (roleVal !== undefined) {
    metadata.role = roleVal;
  }

  // Wire status is explicitly ignored (writeEvent defaults to 'captured')
  // eslint-disable-next-line no-unused-vars
  const { status: _ignoredStatus, ...wireRest } = raw;
  // Merge remaining wire fields not already consumed
  for (const [k, v] of Object.entries(wireRest)) {
    if (!WIRE_FIELDS.has(k) && k !== 'metadata' && k !== 'role') {
      metadata[k] = v;
    }
  }

  const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;

  return {
    agent_tag: agent_tag.trim(),
    session_id: typeof session_id === 'string' ? session_id.trim() : session_id,
    source_kind,
    content: typeof content === 'string' ? content.trim() : content,
    occurred_at,
    metadata: finalMetadata,
    source_ref: null, // hook payloads don't carry source_ref
  };
}
