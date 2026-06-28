/**
 * Session Tracker — Unit Tests
 * Run: node --test tests/agent-cortex-plugin/session_tracker.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSessionTracker } from '../../scripts/agent-cortex-plugin/session_tracker.js';

describe('session_tracker', () => {

  // ── recordStart ──────────────────────────────────────────────────────────────

  it('recordStart creates a new session with started_at', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z', directory: '/tmp/test' });
    const snap = tracker.snapshot();
    assert.strictEqual(Object.keys(snap).length, 1);
    assert.strictEqual(snap.s1.started_at, '2026-06-25T10:00:00Z');
    assert.strictEqual(snap.s1.directory, '/tmp/test');
    assert.strictEqual(snap.s1.message_count, 0);
    assert.strictEqual(snap.s1.tool_call_count, 0);
    assert.strictEqual(snap.s1.ingested, false);
  });

  it('recordStart allows directory to be null', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    assert.strictEqual(tracker.snapshot().s1.directory, null);
  });

  // ── recordMessage ────────────────────────────────────────────────────────────

  it('recordMessage increments message_count', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordMessage('s1', { role: 'user', preview: 'Hello' });
    tracker.recordMessage('s1', { role: 'assistant', preview: 'Hi there' });
    assert.strictEqual(tracker.snapshot().s1.message_count, 2);
  });

  it('recordMessage stores last user preview (up to 200 chars)', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordMessage('s1', { role: 'user', preview: 'A'.repeat(250) });
    assert.strictEqual(tracker.snapshot().s1.last_user_message_preview.length, 200);
    assert.strictEqual(tracker.snapshot().s1.last_assistant_message_preview, null);
  });

  it('recordMessage stores last assistant preview', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordMessage('s1', { role: 'assistant', preview: 'How can I help?' });
    assert.strictEqual(tracker.snapshot().s1.last_assistant_message_preview, 'How can I help?');
  });

  it('recordMessage is no-op for unknown session', () => {
    const tracker = createSessionTracker();
    tracker.recordMessage('unknown', { role: 'user', preview: 'x' }); // must not throw
    assert.strictEqual(Object.keys(tracker.snapshot()).length, 0);
  });

  // ── recordToolCall ──────────────────────────────────────────────────────────

  it('recordToolCall increments tool_call_count', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordToolCall('s1', { toolName: 'bash' });
    tracker.recordToolCall('s1', { toolName: 'read' });
    assert.strictEqual(tracker.snapshot().s1.tool_call_count, 2);
  });

  it('recordToolCall is no-op for unknown session', () => {
    const tracker = createSessionTracker();
    tracker.recordToolCall('unknown', {}); // must not throw
  });

  // ── recordIdle ──────────────────────────────────────────────────────────────

  it('recordIdle returns the snapshot the first time', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordMessage('s1', { role: 'user', preview: 'test' });
    const payload = tracker.recordIdle('s1', { endedAt: '2026-06-25T10:05:00Z', reason: 'timeout' });
    assert.strictEqual(payload.started_at, '2026-06-25T10:00:00Z');
    assert.strictEqual(payload.ended_at, '2026-06-25T10:05:00Z');
    assert.strictEqual(payload.message_count, 1);
    assert.strictEqual(payload.idle_reason, 'timeout');
  });

  it('recordIdle returns null on second call only after markIngested (dedupe)', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordIdle('s1', { endedAt: '2026-06-25T10:05:00Z' });
    // Without markIngested, recordIdle still returns a snapshot (caller must mark)
    const second = tracker.recordIdle('s1', { endedAt: '2026-06-25T10:06:00Z' });
    assert.ok(second, 'should return snapshot without markIngested');
    // After markIngested, recordIdle returns null
    tracker.markIngested('s1');
    const third = tracker.recordIdle('s1', { endedAt: '2026-06-25T10:07:00Z' });
    assert.strictEqual(third, null);
  });

  it('recordIdle returns null for unknown session', () => {
    const tracker = createSessionTracker();
    const result = tracker.recordIdle('unknown', { endedAt: '2026-06-25T10:05:00Z' });
    assert.strictEqual(result, null);
  });

  // ── markIngested / isIngested ───────────────────────────────────────────────

  it('markIngested sets ingested flag', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    assert.strictEqual(tracker.isIngested('s1'), false);
    tracker.markIngested('s1');
    assert.strictEqual(tracker.isIngested('s1'), true);
  });

  it('isIngested returns false for unknown session', () => {
    const tracker = createSessionTracker();
    assert.strictEqual(tracker.isIngested('unknown'), false);
  });

  // ── recordError ─────────────────────────────────────────────────────────────

  it('recordError attaches error info to existing session', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordError('s1', { error: 'session crashed' });
    const err = tracker.snapshot().s1.error_info;
    assert.strictEqual(err.error, 'session crashed');
    assert.ok(err.recorded_at);
  });

  it('recordError creates placeholder session for unknown sessionId', () => {
    const tracker = createSessionTracker();
    tracker.recordError('unknown-session', { error: 'oops' });
    const s = tracker.snapshot()['unknown-session'];
    assert.strictEqual(s.error_info.error, 'oops');
    assert.strictEqual(s.started_at, null);
    assert.strictEqual(s.ingested, false);
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  it('clear removes session from state', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordStart('s2', { startedAt: '2026-06-25T11:00:00Z' });
    tracker.clear('s1');
    const snap = tracker.snapshot();
    assert.strictEqual(Object.keys(snap).length, 1);
    assert.strictEqual(snap.s2.started_at, '2026-06-25T11:00:00Z');
  });

  it('clear is safe on unknown session', () => {
    const tracker = createSessionTracker();
    tracker.clear('unknown'); // must not throw
  });

  // ── Multiple sessions ───────────────────────────────────────────────────────

  it('multiple sessions are tracked independently', () => {
    const tracker = createSessionTracker();
    tracker.recordStart('s1', { startedAt: '2026-06-25T10:00:00Z' });
    tracker.recordStart('s2', { startedAt: '2026-06-25T11:00:00Z' });
    tracker.recordMessage('s1', { role: 'user', preview: 'only s1' });
    tracker.recordToolCall('s2', { toolName: 'bash' });

    const snap = tracker.snapshot();
    assert.strictEqual(snap.s1.message_count, 1);
    assert.strictEqual(snap.s1.tool_call_count, 0);
    assert.strictEqual(snap.s2.message_count, 0);
    assert.strictEqual(snap.s2.tool_call_count, 1);

    tracker.recordIdle('s1', { endedAt: '2026-06-25T10:30:00Z' });
    // Caller must markIngested; without it, second recordIdle still returns snapshot
    const s1Idle = tracker.recordIdle('s1', { endedAt: '2026-06-25T10:31:00Z' });
    assert.ok(s1Idle, 'should return snapshot without markIngested');
    tracker.markIngested('s1');
    const s1IdleAfterMark = tracker.recordIdle('s1', { endedAt: '2026-06-25T10:32:00Z' });
    assert.strictEqual(s1IdleAfterMark, null); // now null after markIngested

    // s2 should not be affected
    assert.strictEqual(tracker.isIngested('s2'), false);
    const s2Idle = tracker.recordIdle('s2', { endedAt: '2026-06-25T11:30:00Z' });
    assert.ok(s2Idle);
  });
});
