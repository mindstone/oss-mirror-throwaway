/**
 * Compile-time type assertions that verify Zod-inferred types match manual TS types.
 * If any of these fail to compile, the Zod schema has drifted from the TS source of truth.
 * Checked by `npm run lint:ts` (part of validate:fast).
 *
 * Uses IsExactStrict conditional type for exact structural equality — catches missing
 * optional fields that simple assignment checks would miss.
 */
import { describe, it, expect } from 'vitest';
import type { AgentEvent as ManualAgentEvent, AgentSession as ManualAgentSession } from '@shared/types/agent';
import type { IsExactStrict, AssertExact } from '@shared/types/typeAssertions';
import {
  AgentEventSchema,
  AgentSessionSchema,
  type AgentEvent as ZodAgentEvent,
  type AgentSession as ZodAgentSession,
} from '../agent';

// AgentEvent: Zod-inferred type must exactly match manual TS union
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time assertion, not a runtime type
type _EventCheck = AssertExact<IsExactStrict<ManualAgentEvent, ZodAgentEvent>>;

// AgentSession: Zod-inferred type must exactly match manual TS interface.
// Restored under S2-CI (2026-04-30) after S2-CH's strengthened helper surfaced
// real drift on `setupContext.pendingAnnouncement`. See
// `docs/plans/260429_r2_stage2_chunked_implementation_plan.md` § S2-CI.
//
// eslint-disable-next-line @typescript-eslint/naming-convention -- compile-time assertion, not a runtime type
type _SessionCheck = AssertExact<IsExactStrict<ManualAgentSession, ZodAgentSession>>;
describe('Zod ↔ TS type alignment (compile-time)', () => {
  it('compiles successfully — type assertions above are checked by tsc', () => {
    // The real guards are the type assertions above this test.
    // If AgentEvent Zod schema drifts from the TS union, `npm run lint:ts` will fail.
    expect(true).toBe(true);
  });

  it('accepts moderation errorKind values at runtime', () => {
    const moderationEvent: ManualAgentEvent = {
      type: 'error',
      error: "Your message was flagged by the model's safety filter.",
      errorKind: 'moderation',
      timestamp: Date.now(),
    };

    expect(AgentEventSchema.parse(moderationEvent)).toMatchObject({
      type: 'error',
      errorKind: 'moderation',
    });
  });

  it('accepts billingMeta values at runtime', () => {
    const billingEvent: ManualAgentEvent = {
      type: 'error',
      error: 'Your OpenRouter account has run out of credits.',
      errorKind: 'billing',
      billingMeta: {
        subtype: 'credits',
        upstreamProviderName: 'anthropic',
      },
      provider: 'OpenRouter',
      timestamp: Date.now(),
    };

    expect(AgentEventSchema.parse(billingEvent)).toMatchObject({
      type: 'error',
      errorKind: 'billing',
      billingMeta: {
        subtype: 'credits',
        upstreamProviderName: 'anthropic',
      },
      provider: 'OpenRouter',
    });
  });

  it('accepts sessions without annotations for backwards compatibility', () => {
    const session: ManualAgentSession = {
      id: 'session-without-annotations',
      title: 'Session',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
    };

    const result = AgentSessionSchema.safeParse(session);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.annotations).toBeUndefined();
    }
  });

  it('accepts sessions with pending conversation annotations', () => {
    const session: ManualAgentSession = {
      id: 'session-with-annotations',
      title: 'Session',
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      annotations: [{
        id: 'ann-1',
        messageId: 'msg-1',
        text: 'selected text',
        comment: 'remember this',
        createdAt: 2_000,
        startOffset: 0,
        endOffset: 13,
      }],
    };

    const result = AgentSessionSchema.safeParse(session);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.annotations).toEqual(session.annotations);
    }
  });

  it('round-trips top-level rawError through schema parse', () => {
    // S2 of docs/plans/260429_eval_reliability_judge_panel.md — the dispatcher
    // populates this for every error kind when errorSource === 'main'. Eval
    // diagnostics fall back to this field when meta-specific rawError is
    // absent. The redactor is a separate concern; this test only asserts the
    // schema accepts the optional field.
    const errorWithRawBody: ManualAgentEvent = {
      type: 'error',
      error: 'Cohere returned 400 — see raw body.',
      errorKind: 'unknown',
      errorSource: 'main',
      rawError: '{"error":{"message":"messages: Last assistant message must have non-empty content"}}',
      timestamp: Date.now(),
    };

    const roundTripped = AgentEventSchema.parse(JSON.parse(JSON.stringify(errorWithRawBody)));
    expect(roundTripped).toEqual(errorWithRawBody);
    expect(AgentEventSchema.parse({ ...errorWithRawBody, rawError: undefined }).type).toBe('error');
  });

  it('preserves watchdogDiagnostic through JSON roundtrip and schema parse', () => {
    const watchdogEvent: ManualAgentEvent = {
      type: 'error',
      error: 'Turn aborted after watchdog escalation.',
      watchdogDiagnostic: {
        phase: 'awaiting_tool_result',
        messageCount: 4,
        rawStreamEventCount: 11,
        rawStreamLastEventType: 'content_block_delta',
        rawStreamLastEventAgeMs: 12_000,
        watchdogLevel: 2,
        maxWatchdogLevel: 3,
        effectiveAbortMs: 90_000,
        model: 'claude-sonnet-4-5',
      },
      timestamp: 123_456,
    };

    const roundTripped = AgentEventSchema.parse(JSON.parse(JSON.stringify(watchdogEvent)));

    expect(roundTripped).toEqual(watchdogEvent);
  });

  it('round-trips tool events with imageRef populated', () => {
    const toolEvent: ManualAgentEvent = {
      type: 'tool',
      toolName: 'capture',
      detail: 'Captured screenshot',
      stage: 'end',
      timestamp: 170_000_000_000,
      imageRef: [{
        assetId: 'turn-1-1-0',
        mimeType: 'image/png',
        byteSize: 1024,
      }],
      toolResult: {
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUg==',
          },
          imageRef: {
            assetId: 'turn-1-1-0',
            mimeType: 'image/png',
            byteSize: 1024,
          },
        }],
      },
    };

    const roundTripped = AgentEventSchema.parse(JSON.parse(JSON.stringify(toolEvent)));
    expect(roundTripped).toEqual(toolEvent);
  });

  it('round-trips tool events with both imageContent and imageRef populated', () => {
    const toolEvent: ManualAgentEvent = {
      type: 'tool',
      toolName: 'capture',
      detail: 'Captured screenshot',
      stage: 'end',
      timestamp: 170_000_000_001,
      imageContent: [{ type: 'image', data: 'legacy-base64', mimeType: 'image/png' }],
      imageRef: [{
        assetId: 'turn-1-1-1',
        mimeType: 'image/png',
        byteSize: 2048,
      }],
    };

    const roundTripped = AgentEventSchema.parse(JSON.parse(JSON.stringify(toolEvent)));
    expect(roundTripped).toEqual(toolEvent);
  });

  it('preserves unknown imageRef fields via passthrough parsing', () => {
    const parsed = AgentEventSchema.parse({
      type: 'tool',
      toolName: 'capture',
      detail: 'Captured screenshot',
      stage: 'end',
      timestamp: 170_000_000_002,
      imageRef: [{
        assetId: 'turn-1-1-2',
        mimeType: 'image/png',
        byteSize: 4096,
        futureField: 'xyz',
      }],
    });

    if (parsed.type !== 'tool') {
      throw new Error(`Expected tool event, received ${parsed.type}`);
    }
    expect(parsed.imageRef?.[0]).toMatchObject({
      assetId: 'turn-1-1-2',
      futureField: 'xyz',
    });
  });
});
