/**
 * Plugin Unit Tests
 * Run: node --test tests/agent-cortex-plugin/plugin.test.js
 *
 * These tests verify the plugin logic with the real AC runtime.
 * The e2e test covers real DB writes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentCortexPlugin } from '../../scripts/agent-cortex-plugin/plugin.js';

const RUNTIME = '/Users/george/Georges/apps/agent-cortex';

/** Build a minimal OpenCode event input shape. */
function makeEvent(type, overrides = {}) {
  return { type, sessionID: 'test-session-1', timestamp: new Date().toISOString(), ...overrides };
}

describe('AgentCortexPlugin', () => {

  // 1. Plugin returns empty hooks if AC runtime path is invalid
  it('returns empty hooks when AC runtime path is invalid', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: '/nonexistent/path' }
    );
    assert.deepStrictEqual(hooks, {});
  });

  // 2. Plugin returns event hook on happy path
  it('returns event hook when AC modules load successfully', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    assert.ok(hooks.event, 'should have an event hook');
    assert.strictEqual(typeof hooks.event, 'function');
  });

  // 3. Plugin handles session.created → tracker.recordStart (no throw)
  it('session.created is handled without throw', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp/project' } },
      { ac_runtime_path: RUNTIME }
    );
    const ev = makeEvent('session.created');
    await hooks.event({ event: ev }); // no throw = pass
  });

  // 4. Plugin handles session.idle → writeEvent called (no throw)
  it('session.idle is handled without throw', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp/project' } },
      { ac_runtime_path: RUNTIME }
    );
    // First start session
    await hooks.event({ event: makeEvent('session.created') });
    // Then idle
    await hooks.event({ event: makeEvent('session.idle') });
  });

  // 5. Plugin handles second session.idle → dedupe (no throw)
  it('second session.idle is handled without throw (dedupe)', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    await hooks.event({ event: makeEvent('session.created') });
    await hooks.event({ event: makeEvent('session.idle') });
    await hooks.event({ event: makeEvent('session.idle') }); // second — should be silent
  });

  // 6. Plugin handles session.error → writeEvent called (no throw)
  it('session.error is handled without throw', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    await hooks.event({
      event: makeEvent('session.error', {
        message: 'something went wrong',
        sessionID: 'err-session',
      }),
    });
  });

  // 7. Plugin handler errors are caught (event handler does not throw)
  it('malformed events do not propagate', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    // These should all be caught internally
    await hooks.event({ event: null });
    await hooks.event({ event: undefined });
    await hooks.event({ event: {} }); // missing type
  });

  // 8. Plugin handles session lifecycle without throw
  it('full session lifecycle: created → idle', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    const sid = 'full-lifecycle-session';
    await hooks.event({ event: makeEvent('session.created', { sessionID: sid }) });
    await hooks.event({ event: makeEvent('session.idle', { sessionID: sid }) });
  });

  // 9. Unknown event types are silently ignored
  it('unknown event types are silently ignored', async () => {
    const hooks = await AgentCortexPlugin(
      { project: { directory: '/tmp' } },
      { ac_runtime_path: RUNTIME }
    );
    await hooks.event({ event: { type: 'message.updated', sessionID: 'x', message: {} } });
    await hooks.event({ event: { type: 'tool.execute.after', sessionID: 'x', toolCall: {} } });
    await hooks.event({ event: { type: 'session.compacted', sessionID: 'x' } });
  });
});
