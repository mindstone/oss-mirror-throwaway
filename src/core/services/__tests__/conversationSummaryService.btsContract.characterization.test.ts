/**
 * CHARACTERIZATION (behaviour-preserving) test net for the ConversationSummary
 * BTS consumer.
 *
 * Pins the CURRENT observable behaviour of `conversationSummaryService.ts` BEFORE
 * it is refactored into a per-use-case BTS client (CHIEF_ENGINEER2 Stage 4a,
 * PoC #2). Asserts on what the service SENDS to the BTS dispatch seam and how it
 * PARSES the response; mocks `behindTheScenesClient`, never hits a live model.
 *
 * THE CRITICAL PIN (wire contract): the `outputFormat` JSON Schema this service
 * sends today marks ALL 7 fields as `required`
 * (overview, userIntent, currentStatus, keyDecisions, openQuestions,
 *  gotchasAndInsights, resourcesMentioned). This DELIBERATELY DIFFERS from the
 * imported `ConversationSummarySchema` Zod type, which marks userIntent /
 * currentStatus / openQuestions as `.optional()` (only 4 required). A refactor
 * that derives the wire schema from that Zod type would SILENTLY RELAX the wire
 * contract the model sees — this test exists to catch exactly that. The drift is
 * pinned AS-IS here; reconciling it is a later stage's decision, not this one's.
 *
 * `SUMMARY_JSON_SCHEMA` is a module-private const (not exported), so the wire
 * contract is captured from the `outputFormat` actually passed to the mocked BTS
 * call — which is the faithful "what goes on the wire" assertion anyway.
 *
 * Three pins:
 *  1. Wire-contract: outputFormat.schema sent to the BTS call (7 required +
 *     additionalProperties:false), and category 'metadata' / outcomePolicy.
 *  2. Parse-success: a well-formed model response → the parsed ConversationSummary.
 *  3. Parse-resilience: malformed JSON / schema-mismatch → `null` (not throw);
 *     and a response omitting the Zod-optional fields → still parses (validates).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationSummarySchema } from '@shared/ipc/schemas/sessions';

const { mockCallBehindTheScenesWithAuth, mockHasValidAuth } = vi.hoisted(() => ({
  mockCallBehindTheScenesWithAuth: vi.fn<(...args: unknown[]) => unknown>(),
  mockHasValidAuth: vi.fn<(...args: unknown[]) => boolean>(() => true),
}));

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: (...args: unknown[]) => mockHasValidAuth(...args),
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: vi.fn(() => 'system-prompt'),
  PROMPT_IDS: { CONVERSATION_SUMMARY: 'metadata/conversation-summary' },
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({ isConnected: () => true }),
}));

import {
  generateConversationSummary,
  parseSummaryResponse,
} from '../conversationSummaryService';
import type { AgentSession } from '@shared/types';

/** A representative well-formed model response — all 7 fields present. */
const WELL_FORMED = {
  overview: 'Discussed the Q3 roadmap and agreed on three priorities.',
  userIntent: 'User wanted to lock the roadmap before the board meeting.',
  currentStatus: 'Roadmap drafted; awaiting design sign-off.',
  keyDecisions: ['Ship feature A in Q3', 'Defer feature B'],
  openQuestions: ['Who owns the migration?'],
  gotchasAndInsights: ['The old API is deprecated in August.'],
  resourcesMentioned: ['src/core/foo.ts', 'https://example.com/spec'],
};

function makeSession(): AgentSession {
  return {
    id: 'session-summary-char-1',
    title: 'Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      { role: 'user', text: 'Help me plan the Q3 roadmap.' } as any,
      { role: 'assistant', text: 'Here is a draft roadmap...' } as any,
    ],
    eventsByTurn: {},
    activeTurnId: null,
  } as unknown as AgentSession;
}

const settings = {} as any;

describe('conversationSummaryService — BTS wire-contract & parse characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasValidAuth.mockReturnValue(true);
  });

  // ── Pin 1: WIRE CONTRACT (the critical one — pins the 7-required drift) ─────
  describe('wire contract: outputFormat sent to the BTS call', () => {
    it('sends all 7 fields as required (the wire contract DIFFERS from the laxer Zod type)', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(WELL_FORMED) }],
      });

      await generateConversationSummary(settings, makeSession());

      expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
      const [, requestOptions, tracking] = mockCallBehindTheScenesWithAuth.mock.calls[0] as [
        unknown,
        { outputFormat: { type: string; schema: any } },
        { category: string; outcomePolicy?: string },
      ];
      const schema = requestOptions.outputFormat.schema;

      expect(requestOptions.outputFormat.type).toBe('json_schema');
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);

      // THE pin: all 7 fields in `required`, in this exact order.
      expect(schema.required).toEqual([
        'overview',
        'userIntent',
        'currentStatus',
        'keyDecisions',
        'openQuestions',
        'gotchasAndInsights',
        'resourcesMentioned',
      ]);
      expect(schema.required).toHaveLength(7);

      // Property shapes (string vs array-of-string) are part of the contract.
      expect(schema.properties.overview.type).toBe('string');
      expect(schema.properties.keyDecisions.type).toBe('array');
      expect(schema.properties.keyDecisions.items.type).toBe('string');

      expect(tracking.category).toBe('metadata');
      expect(tracking.outcomePolicy).toBe('turn_bearing');
    });

    it('DRIFT GUARD: the wire schema is STRICTER than ConversationSummarySchema (Zod has only 4 required)', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(WELL_FORMED) }],
      });

      await generateConversationSummary(settings, makeSession());

      const [, requestOptions] = mockCallBehindTheScenesWithAuth.mock.calls[0] as [
        unknown,
        { outputFormat: { schema: any } },
      ];
      const wireRequired: string[] = requestOptions.outputFormat.schema.required;

      // The Zod schema treats userIntent / currentStatus / openQuestions as
      // optional, so a summary omitting them still validates.
      const zodAcceptsPartial = ConversationSummarySchema.safeParse({
        overview: 'x',
        keyDecisions: [],
        gotchasAndInsights: [],
        resourcesMentioned: [],
      });
      expect(zodAcceptsPartial.success).toBe(true);

      // But the WIRE schema still demands those same fields. This asymmetry is
      // the pre-existing drift the refactor must NOT collapse onto the Zod type.
      expect(wireRequired).toContain('userIntent');
      expect(wireRequired).toContain('currentStatus');
      expect(wireRequired).toContain('openQuestions');
    });
  });

  // ── Pin 2: PARSE SUCCESS ───────────────────────────────────────────────────
  describe('parse-success', () => {
    it('parses a well-formed response into a ConversationSummary', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(WELL_FORMED) }],
      });

      const summary = await generateConversationSummary(settings, makeSession());

      expect(summary).not.toBeNull();
      expect(summary).toMatchObject({
        overview: WELL_FORMED.overview,
        userIntent: WELL_FORMED.userIntent,
        keyDecisions: WELL_FORMED.keyDecisions,
        resourcesMentioned: WELL_FORMED.resourcesMentioned,
      });
    });

    it('parseSummaryResponse returns the validated object for well-formed JSON', () => {
      const result = parseSummaryResponse(JSON.stringify(WELL_FORMED));
      expect(result).not.toBeNull();
      expect(result?.overview).toBe(WELL_FORMED.overview);
    });
  });

  // ── Pin 3: PARSE RESILIENCE (capture current null-on-fail behaviour) ────────
  describe('parse-resilience', () => {
    it('non-JSON response → null (parseSummaryResponse does not throw)', () => {
      expect(parseSummaryResponse('this is not json {')).toBeNull();
    });

    it('valid JSON but schema-mismatch (wrong types) → null', () => {
      // keyDecisions must be an array of strings; a string here fails Zod validation.
      const bad = JSON.stringify({ ...WELL_FORMED, keyDecisions: 'not-an-array' });
      expect(parseSummaryResponse(bad)).toBeNull();
    });

    it('response omitting the Zod-OPTIONAL fields still parses (current validate behaviour)', () => {
      // userIntent / currentStatus / openQuestions are .optional() in the Zod
      // schema, so parseSummaryResponse accepts a response without them even
      // though the wire schema marked them required. Pin this current asymmetry.
      const partial = JSON.stringify({
        overview: 'A short informational exchange.',
        keyDecisions: [],
        gotchasAndInsights: [],
        resourcesMentioned: [],
      });
      const result = parseSummaryResponse(partial);
      expect(result).not.toBeNull();
      expect(result?.overview).toBe('A short informational exchange.');
    });

    it('generateConversationSummary returns null (not throw) when parse fails', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: 'not json' }],
      });
      const summary = await generateConversationSummary(settings, makeSession());
      expect(summary).toBeNull();
    });

    it('returns null when there is no valid auth (never calls the BTS seam)', async () => {
      mockHasValidAuth.mockReturnValue(false);
      const summary = await generateConversationSummary(settings, makeSession());
      expect(summary).toBeNull();
      expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
    });
  });
});
