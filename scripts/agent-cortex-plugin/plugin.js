/**
 * OpenCode Plugin — Agent-Cortex Integration (MVP-3 Phase 1)
 *
 * Hooks OpenCode `session.idle` and `session.error` events and writes them
 * to Agent-Cortex via writeEvent() from the AC runtime.
 *
 * Designed to NEVER throw. All event handlers are wrapped in try/catch.
 * Failures are logged to console.error (OpenCode captures stderr).
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy-load AC modules so the plugin file itself stays small + testable.
// This lets the plugin return empty hooks gracefully if the runtime path is invalid.
async function loadAcModules(runtimePath) {
  try {
    const eventIngestPath = join(runtimePath, 'src', 'event_ingest.js');
    const sqliteStorePath = join(runtimePath, 'src', 'sqlite_store.js');

    const [eventIngest, sqliteStore] = await Promise.all([
      import(eventIngestPath),
      import(sqliteStorePath),
    ]);

    return {
      writeEvent: eventIngest.writeEvent,
      getDb: sqliteStore.getDb,
    };
  } catch (e) {
    console.error('[agent-cortex] failed to import AC modules from', runtimePath, e.message);
    return null;
  }
}

/**
 * OpenCode plugin entry point.
 *
 * @param {object} input  — OpenCode PluginInput (client, project, directory, worktree, serverUrl, $)
 * @param {object} options — PluginOptions; accepts ac_runtime_path override
 * @returns {Promise<object>} Hooks object
 */
export const AgentCortexPlugin = async (input, options = {}) => {
  const runtimePath =
    options.ac_runtime_path ||
    process.env.AC_RUNTIME_PATH ||
    '/Users/george/Georges/apps/agent-cortex';

  const ac = await loadAcModules(runtimePath);
  if (!ac) {
    // Return empty hooks so OpenCode doesn't crash.
    return {};
  }

  const { writeEvent, getDb } = ac;
  const store = { query: (sql, params) => {
    const db = getDb();
    const stmt = db.prepare(sql);
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT')) {
      return Promise.resolve({ rows: stmt.all(...params) });
    }
    const result = stmt.run(...params);
    return Promise.resolve({ rows: [], rowCount: result.changes });
  }};

  const { createSessionTracker } = await import('./session_tracker.js');
  const tracker = createSessionTracker();

  return {
    event: async ({ event }) => {
      try {
        await handleEvent(event, { tracker, writeEvent, store, directory: input.project?.directory });
      } catch (e) {
        // Never throw — log and swallow.
        console.error('[agent-cortex] event handler failed:', e.message);
      }
    },
  };
};

/**
 * Handle a single OpenCode event.
 *
 * @param {object} event  — OpenCode Event object
 * @param {object} ctx    — { tracker, writeEvent, store, directory }
 */
async function handleEvent(event, { tracker, writeEvent, store, directory }) {
  switch (event.type) {
    case 'session.created': {
      tracker.recordStart(event.sessionID, {
        startedAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
        directory: directory || null,
      });
      break;
    }

    case 'session.idle': {
      // session.idle may fire repeatedly; only ingest once per session.
      if (tracker.isIngested(event.sessionID)) return;

      const payload = tracker.recordIdle(event.sessionID, {
        endedAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
        reason: event.idleReason || null,
      });
      if (!payload) return;

      await writeEvent({
        store,
        agent_tag: 'opencode',
        session_id: event.sessionID,
        source_kind: 'opencode-session-idle',
        content: synthesizeContent(payload),
        occurred_at: payload.ended_at,
        metadata: { ...payload, directory },
      });

      tracker.markIngested(event.sessionID);
      console.error('[agent-cortex] ingested session', event.sessionID);
      break;
    }

    case 'session.error': {
      const sessionId = event.sessionID || 'unknown';
      tracker.recordError(sessionId, { error: event.message || 'unknown error' });
      await writeEvent({
        store,
        agent_tag: 'opencode',
        session_id: sessionId,
        source_kind: 'opencode-session-error',
        content: `OpenCode session errored: ${event.message || 'unknown error'}`,
        occurred_at: new Date().toISOString(),
        metadata: {
          error: event.message || 'unknown error',
          directory: directory || null,
        },
      });
      console.error('[agent-cortex] ingested session error', sessionId);
      break;
    }

    default:
      // MVP-3 phase 1 intentionally ignores: session.compacted, message.updated, tool.execute.*, etc.
      break;
  }
}

/**
 * Synthesize a human-readable content string from a session snapshot.
 * @param {object} snapshot
 * @returns {string}
 */
function synthesizeContent(snapshot) {
  const lines = [];
  lines.push(`OpenCode session (${snapshot.started_at} -> ${snapshot.ended_at})`);
  lines.push(`Messages: ${snapshot.message_count} | Tool calls: ${snapshot.tool_call_count}`);
  if (snapshot.last_user_message_preview) {
    lines.push(`Last user: ${snapshot.last_user_message_preview}`);
  }
  if (snapshot.last_assistant_message_preview) {
    lines.push(`Last assistant: ${snapshot.last_assistant_message_preview}`);
  }
  return lines.join('\n');
}
