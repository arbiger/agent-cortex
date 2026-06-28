/**
 * Session Tracker — pure in-memory session state manager.
 *
 * No IO. No imports from AC runtime. Designed for unit testing without mocks.
 *
 * Exports:
 *   createSessionTracker() → { recordStart, recordMessage, recordToolCall, recordIdle, recordError, markIngested, isIngested, clear, snapshot }
 */

/**
 * @returns {object} session tracker instance
 */
export function createSessionTracker() {
  // sessionId → { started_at, directory, message_count, tool_call_count, last_user_message_preview, last_assistant_message_preview, ended_at, error_info, ingested }
  const sessions = new Map();

  /**
   * Start tracking a new session.
   * @param {string} sessionId
   * @param {{ startedAt: string, directory: string }} opts
   */
  function recordStart(sessionId, { startedAt, directory }) {
    sessions.set(sessionId, {
      started_at: startedAt,
      directory: directory || null,
      message_count: 0,
      tool_call_count: 0,
      last_user_message_preview: null,
      last_assistant_message_preview: null,
      ended_at: null,
      error_info: null,
      ingested: false,
    });
  }

  /**
   * Record a message from the session.
   * @param {string} sessionId
   * @param {{ role: 'user'|'assistant', preview: string }} opts
   */
  function recordMessage(sessionId, { role, preview }) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.message_count++;
    if (role === 'user') {
      s.last_user_message_preview = preview ? String(preview).slice(0, 200) : null;
    } else if (role === 'assistant') {
      s.last_assistant_message_preview = preview ? String(preview).slice(0, 200) : null;
    }
  }

  /**
   * Record a tool call in the session.
   * @param {string} sessionId
   * @param {{ toolName: string }} _opts
   */
  function recordToolCall(sessionId, _opts) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.tool_call_count++;
  }

  /**
   * Mark session as idle and return the snapshot for ingest.
   * Returns null if already ingested or session doesn't exist.
   * @param {string} sessionId
   * @param {{ endedAt: string, reason?: string }} opts
   * @returns {object|null} snapshot
   */
  function recordIdle(sessionId, { endedAt, reason }) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    if (s.ingested) return null;
    s.ended_at = endedAt;
    const snapshot = {
      started_at: s.started_at,
      ended_at: s.ended_at,
      message_count: s.message_count,
      tool_call_count: s.tool_call_count,
      last_user_message_preview: s.last_user_message_preview,
      last_assistant_message_preview: s.last_assistant_message_preview,
      directory: s.directory,
      idle_reason: reason || null,
    };
    return snapshot;
  }

  /**
   * Record session error info.
   * @param {string} sessionId
   * @param {{ error: string }} opts
   * @returns {object} error info
   */
  function recordError(sessionId, { error }) {
    const s = sessions.get(sessionId);
    if (!s) {
      // Create a placeholder session for the error
      sessions.set(sessionId, {
        started_at: null,
        directory: null,
        message_count: 0,
        tool_call_count: 0,
        last_user_message_preview: null,
        last_assistant_message_preview: null,
        ended_at: null,
        error_info: { error, recorded_at: new Date().toISOString() },
        ingested: false,
      });
    } else {
      s.error_info = { error, recorded_at: new Date().toISOString() };
    }
    return sessions.get(sessionId).error_info;
  }

  /**
   * Mark a session as ingested (dedupe flag).
   * @param {string} sessionId
   */
  function markIngested(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.ingested = true;
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  function isIngested(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.ingested : false;
  }

  /**
   * Remove a session from memory (GC).
   * @param {string} sessionId
   */
  function clear(sessionId) {
    sessions.delete(sessionId);
  }

  /**
   * Debugging snapshot of all sessions.
   * @returns {object}
   */
  function snapshot() {
    const out = {};
    for (const [id, s] of sessions) {
      out[id] = { ...s };
    }
    return out;
  }

  return { recordStart, recordMessage, recordToolCall, recordIdle, recordError, markIngested, isIngested, clear, snapshot };
}
