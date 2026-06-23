import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeRecoveryError, type RecoveryAdapter } from '../recoveryAdapter';
import { makeRecoveryLastResortSkippedEvent, makeRecoveryStartedEvent, type RecoveryOutboundEvent } from '../recoveryEvents';
import type { RecoveryContext } from '../recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from './fixtures/stubAdapter';

const ctx = (): RecoveryContext => ({
  phase: 'post_activity',
  depth: 1,
  attempt: 1,
  longContextFallbackAttempted: false,
  skeletonAttempted: false,
  isRecoveryModelAttempt: false,
  enableRecovery: true,
  sessionId: 'session-1',
  turnId: 'turn-1',
  originalSessionId: 'original-session-1',
  originalPrompt: 'Prompt',
  abortSignal: new AbortController().signal,
});

function expectRequiredEnvelope(event: RecoveryOutboundEvent): void {
  expect(event.turnId).toBeTruthy();
  expect(event.sessionId).toBeTruthy();
  expect(event.originalSessionId).toBeTruthy();
  expect(Number.isInteger(event.depth)).toBe(true);
  expect(Number.isInteger(event.attempt)).toBe(true);
  expect(Number.isInteger(event.totalCalls)).toBe(true);
  expect(Number.isFinite(event.timestamp)).toBe(true);
}

describe('recoveryAdapter contract', () => {
  it('T2.1 in-memory stub satisfies the RecoveryAdapter interface', () => {
    const adapter: RecoveryAdapter = createStubRecoveryAdapter();

    expect(adapter).toBeDefined();
  });

  it('T2.2 stub adapter records all calls in order', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'success', result: 'ok' }],
    });

    adapter.recordFallback('turn-1', {
      type: 'model',
      from: 'sonnet',
      to: 'opus',
      reason: 'context-overflow-long-context-fallback',
    });
    adapter.dispatchEvent('turn-1', makeRecoveryStartedEvent(ctx(), 1));
    await adapter.invokeAgentLoop('prompt', { sessionId: 'session-1' }, () => {});
    await adapter.generateIntelligentSummary([makeMessage('user', 'hello')], {
      settings: adapter.getSettings(),
      taskContext: 'hello',
      depth: 1,
    });

    expect(adapter.calls.map((call) => call.name)).toEqual([
      'recordFallback',
      'dispatchEvent',
      'invokeAgentLoop',
      'getSettings',
      'generateIntelligentSummary',
    ]);
  });

  it('T2.3 all outbound variants carry provenance and total recovery budget fields', () => {
    const events = [
      makeRecoveryStartedEvent(ctx(), 1),
      makeRecoveryLastResortSkippedEvent(ctx(), 2, 'no_qualifying_profile'),
    ];

    for (const event of events) {
      expectRequiredEnvelope(event);
    }
  });

  it('T2.4 recovery:last_resort_skipped carries the required reason contract', () => {
    const noProfile = makeRecoveryLastResortSkippedEvent(ctx(), 2, 'no_qualifying_profile');
    const rateLimited = makeRecoveryLastResortSkippedEvent(ctx(), 2, 'rate_limited');

    expect(noProfile.reason).toBe('no_qualifying_profile');
    expect(rateLimited.reason).toBe('rate_limited');
  });

  it('R-Stage4.A2 AgentLoopOptions remains a structural superset of executeAgentTurn options', () => {
    const root = process.cwd();
    const executorSource = readFileSync(
      path.join(root, 'src/core/services/turnPipeline/agentTurnExecute.ts'),
      'utf8',
    );
    const adapterSource = readFileSync(
      path.join(root, 'src/core/services/recovery/recoveryAdapter.ts'),
      'utf8',
    );
    const requiredFields = [
      'resetConversation',
      'sessionId',
      'attachments',
      'bypassToolSafety',
      'memoryWriteHook',
      'privateMode',
      'mcpDenyHook',
      'modelOverride',
      'thinkingModelOverride',
      'longContextFallbackAttempted',
      'rateLimitFallbackAttempted',
      'activeProviderOverride',
      'routeRebuildHint',
      'inFlightProviderRoutePlan',
      'workingProfileOverrideId',
      'thinkingProfileOverrideId',
      'thinkingEffortOverride',
      'loadSessions',
      'getMeetingCompanionContext',
      'setLastInjectedCoachPath',
      'sessionType',
      'policy',
      'voiceActive',
      'unleashedMode',
      'councilMode',
      'existingAbortController',
      'inboundSafetyHook',
      'getFocusContext',
      'origin',
    ];

    for (const field of requiredFields) {
      expect(executorSource, `executeAgentTurn should still expose ${field}`).toMatch(new RegExp(`${field}\\??:`));
      expect(adapterSource, `AgentLoopOptions missing ${field}`).toMatch(new RegExp(`${field}\\??:`));
    }
  });
});

describe('normalizeRecoveryError (REBEL-5BM error attachment)', () => {
  it('serializes a STRING error into a real Error for the capture 3rd arg (instanceof Error fix)', () => {
    const result = normalizeRecoveryError({
      error: 'rate limit exceeded',
      errorKind: 'rate_limit',
      provider: 'Anthropic',
      rawError: 'HTTP 429 too many requests',
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('rate limit exceeded');
    expect(result.errorString).toBe('rate limit exceeded');
    expect(result.errorKind).toBe('rate_limit');
    expect(result.provider).toBe('Anthropic');
    expect(result.rawError).toBe('HTTP 429 too many requests');
  });

  it('redacts secrets before constructing the Error AND before the extra string', () => {
    const result = normalizeRecoveryError({ error: 'auth failed: Bearer synth-secrettoken12345' });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).not.toContain('synth-secrettoken12345');
    expect(result.error?.message).toContain('***REDACTED***');
    expect(result.errorString).not.toContain('synth-secrettoken12345');
    expect(result.errorString).toContain('***REDACTED***');
  });

  it('returns a redacted COPY of an Error (preserving name) and a redacted message string for extra', () => {
    const original = new Error('compaction-retry crashed');
    original.name = 'CompactionError';
    const result = normalizeRecoveryError({ error: original });

    // A redacted copy is returned (NOT the original instance) so no
    // un-redacted message/stack reaches captureException.
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBe(original);
    expect(result.error?.message).toBe('compaction-retry crashed');
    expect(result.error?.name).toBe('CompactionError');
    expect(result.errorString).toBe('compaction-retry crashed');
  });

  it('redacts a sensitive token in an Error instance message AND stack before they reach the capture (F1 hardening)', () => {
    const original = new Error('OpenRouter 402: https://openrouter.ai/api?api_key=synthsecret12345 failed');
    const result = normalizeRecoveryError({ error: original });

    expect(result.error).toBeInstanceOf(Error);
    // Returned Error message is redacted...
    expect(result.error?.message).not.toContain('synthsecret12345');
    expect(result.error?.message).toContain('***REDACTED***');
    // ...as is its stack (the first line repeats the message).
    expect(result.error?.stack ?? '').not.toContain('synthsecret12345');
    // ...and the extra string copy.
    expect(result.errorString).not.toContain('synthsecret12345');
    expect(result.errorString).toContain('***REDACTED***');
  });

  it('redacts the rawError diagnostic field self-contained (does not rely on caller sanitization)', () => {
    const result = normalizeRecoveryError({
      error: 'boom',
      rawError: 'upstream body Bearer synth-leaked-token-98765',
    });

    expect(result.rawError).toBeDefined();
    expect(result.rawError).not.toContain('synth-leaked-token-98765');
    expect(result.rawError).toContain('***REDACTED***');
  });

  it('returns error: undefined and threads diagnostics for a non-Error, non-string object (no raw object leak)', () => {
    const result = normalizeRecoveryError({
      error: { foo: 1, secret: 'do-not-leak' },
      errorKind: 'server_error',
      provider: 'OpenRouter',
    });

    expect(result.error).toBeUndefined();
    // No raw object is stringified into the extra string.
    expect(result.errorString).toBeUndefined();
    // Diagnostics still thread through.
    expect(result.errorKind).toBe('server_error');
    expect(result.provider).toBe('OpenRouter');
  });

  it('omits diagnostic fields and yields undefined error when no error form is supplied (never fabricates)', () => {
    const result = normalizeRecoveryError({});

    expect(result.error).toBeUndefined();
    expect(result.errorString).toBeUndefined();
    expect(result.errorKind).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.rawError).toBeUndefined();
  });
});
