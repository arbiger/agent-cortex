#!/usr/bin/env node
/**
 * ac-build-episode.js — Node ESM CLI
 *
 * Aggregates captured events for a session into a single episode memory.
 *
 * Usage A (CLI flags):
 *   node scripts/ac-build-episode.js --agent-tag=codex --session-id=<id> \
 *     [--title=<t>] [--summary=<s>] [--topic-key=<k>]
 *
 * Usage B (stdin JSON):
 *   echo '{"agent_tag":"codex","session_id":"abc","title":"...","summary":"..."}' | \
 *     node scripts/ac-build-episode.js
 *
 * Exit codes:
 *   0 — success, stdout: episode_id: <uuid>\n event_count: <N>
 *   1 — validation error (missing agent_tag / session_id)
 *   2 — build error (no captured events, DB error)
 */

import { getDb } from '../src/sqlite_store.js';
import { buildSessionEpisode } from '../src/episode_builder.js';

/**
 * Parse minimal CLI args: --flag=value pairs only.
 * Returns { flags, positional }.
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (m) {
      flags[m[1].replace(/-/g, '_')] = m[2];
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * Resolve input: positional file path takes priority.
 * Falls back to reading all of stdin only if data is available.
 * Returns parsed JSON object or throws.
 */
async function resolveInput(positional) {
  if (positional.length > 0) {
    const { readFile } = await import('fs');
    const { resolve } = await import('path');
    const filePath = resolve(process.cwd(), positional[0]);
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text.trim());
  }
  // Read stdin only if it has data on it; never block on empty stdin
  let text = '';
  try {
    // Use fs/promises readFile only for file path; skip stdin to avoid pipe-closed issues
    text = await new Promise((resolve) => {
      let data = '';
      let settled = false;
      const { stdin } = process;
      // If no stdin data will come (pipe closed immediately), resolve empty quickly
      if (stdin.isTTY || !stdin.readable) { resolve(''); return; }
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      stdin.on('data', (chunk) => { data += chunk; });
      stdin.on('end',  () => settle(data));
      stdin.on('error', () => settle(''));
      // Safety net: if stdin closes without data, resolve after short wait
      setTimeout(() => settle(data), 300);
    });
  } catch (_) {
    text = '';
  }
  if (!text || !text.trim()) {
    return {}; // Empty stdin = no input JSON
  }
  return JSON.parse(text.trim());
}

/**
 * Validate required fields, throwing with descriptive message.
 */
function validate({ agent_tag, session_id }) {
  if (!agent_tag || typeof agent_tag !== 'string' || !agent_tag.trim()) {
    throw new Error('agent_tag is required and must be a non-empty string');
  }
  if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
    throw new Error('session_id is required and must be a non-empty string');
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  // Resolve input — file arg or stdin
  let input;
  try {
    input = await resolveInput(positional);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[ac-build-episode] JSON parse error: ${err.message}`);
      process.exit(1);
    }
    console.error(`[ac-build-episode] I/O error: ${err.message}`);
    process.exit(2);
  }

  // CLI flags override JSON payload
  const agent_tag  = (flags.agent_tag  || input.agent_tag  || '').trim();
  const session_id = (flags.session_id || input.session_id || '').trim();
  const title      = (flags.title      || input.title      || null);
  const summary    = (flags.summary    || input.summary    || null);
  const topic_key  = (flags.topic_key  || input.topic_key  || null);

  // Validate
  try {
    validate({ agent_tag, session_id });
  } catch (err) {
    console.error(`[ac-build-episode] Validation error: ${err.message}`);
    process.exit(1);
  }

  // Default title / summary generation
  const resolvedTitle   = title   || `${agent_tag} session ${session_id}`;
  const eventCountGuess = ''; // will be filled after build
  const resolvedSummary = summary || `Auto-built from captured events for session ${session_id}`;

  // Build store facade (same pattern as ac-ingest-event.js)
  const store = {
    query(sql, params = []) {
      const db = getDb();
      const stmt = db.prepare(sql);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('SELECT')) {
        return Promise.resolve({ rows: stmt.all(...params) });
      }
      const result = stmt.run(...params);
      return Promise.resolve({ rows: [], rowCount: result.changes });
    }
  };

  try {
    const episode = await buildSessionEpisode({
      store,
      agent_tag,
      session_id,
      title: resolvedTitle,
      summary: resolvedSummary,
      topic_key,
    });

    // Extract event_count from episode facts
    let eventCount = 0;
    try {
      const facts = typeof episode.facts === 'object'
        ? episode.facts
        : JSON.parse(episode.facts || '{}');
      eventCount = facts.event_count || 0;
    } catch (_) {}

    console.log(`episode_id: ${episode.id}`);
    console.log(`event_count: ${eventCount}`);
    process.exit(0);
  } catch (err) {
    if (err.message && err.message.includes('No captured events found')) {
      console.error(`[ac-build-episode] ${err.message}`);
      process.exit(2);
    }
    console.error(`[ac-build-episode] Build error: ${err.message}`);
    process.exit(2);
  }
}

main();
