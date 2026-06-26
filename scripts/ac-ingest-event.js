#!/usr/bin/env node
/**
 * ac-ingest-event.js — Node ESM CLI
 *
 * Reads a single JSON event payload (from stdin or file arg), normalizes it,
 * and writes it to AC via writeEvent().
 *
 * Usage A (stdin):
 *   cat payload.json | node scripts/ac-ingest-event.js [--agent-tag=CODE] [--source-kind=KIND] [--session-id=ID]
 *
 * Usage B (file):
 *   node scripts/ac-ingest-event.js <path-to-json> [flags...]
 *
 * Exit codes:
 *   0 — success, stdout: event_id: <uuid>
 *   1 — validation / normalizer error
 *   2 — DB / I/O error
 */

import { readFile } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../src/sqlite_store.js';
import { writeEvent } from '../src/event_ingest.js';
import { normalizeHookEvent } from './event_normalizer.js';

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

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  // CLI flags are overrides — they always win over payload values
  const overrides = {};
  if (flags.agent_tag)   overrides.agent_tag = flags.agent_tag;
  if (flags.source_kind) overrides.source    = flags.source_kind;
  if (flags.session_id)  overrides.session_id = flags.session_id;

  let raw;
  try {
    let text;

    if (positional.length > 0) {
      // File argument
      const filePath = resolve(process.cwd(), positional[0]);
      text = await import('fs').then(fs => fs.promises.readFile(filePath, 'utf8'));
    } else {
      // Stdin
      text = await import('fs').then(fs => fs.promises.readFile('/dev/stdin', 'utf8'));
    }

    raw = JSON.parse(text.trim());
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[ac-ingest-event] JSON parse error: ${err.message}`, { stderr: process.stderr });
      process.exit(1);
    }
    console.error(`[ac-ingest-event] I/O error: ${err.message}`, { stderr: process.stderr });
    process.exit(2);
  }

  // Normalize — CLI flags are overrides that always win over payload
  let normalized;
  try {
    normalized = normalizeHookEvent(raw, overrides, {});
  } catch (err) {
    console.error(`[ac-ingest-event] Validation error: ${err.message}`);
    process.exit(1);
  }

  // Write to AC — wrap better-sqlite3 sync API in Promise for writeEvent compat
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
    const eventId = await writeEvent({
      store,
      agent_tag: normalized.agent_tag,
      session_id: normalized.session_id,
      source_kind: normalized.source_kind,
      content: normalized.content,
      occurred_at: normalized.occurred_at,
      metadata: normalized.metadata,
      source_ref: normalized.source_ref,
    });
    console.log(`event_id: ${eventId}`);
    process.exit(0);
  } catch (err) {
    console.error(`[ac-ingest-event] DB write error: ${err.message}`);
    process.exit(2);
  }
}

main();
