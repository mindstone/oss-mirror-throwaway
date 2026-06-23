import { describe, expect, it } from 'vitest';

import { AgentEventSchemaFromManifest, type AgentEventFromSchema } from '@shared/contracts/agentEventManifest';
import {
  AgentEventSchema,
  AgentSessionSchema,
  type AgentEvent as ZodAgentEvent,
} from '@shared/ipc/schemas/agent';
import type { AgentSession as ManualAgentSession } from '@shared/types/agent';

const BASE_TIMESTAMP = 1_700_000_000_000;

type ToolEvent = Extract<ZodAgentEvent, { type: 'tool' }>;
type UserQuestionEvent = Extract<ZodAgentEvent, { type: 'user_question' }>;
type ResultEvent = Extract<ZodAgentEvent, { type: 'result' }>;
type ErrorEvent = Extract<ZodAgentEvent, { type: 'error' }>;

const TOOL_ORIGINS = ['real', 'synthetic-plan-seed', 'pre-turn-context', undefined] as const;

function formatIssues(result: {
  success: boolean;
  error?: { issues?: unknown };
}): string {
  if (result.success) {
    return 'none';
  }

  return JSON.stringify(result.error?.issues ?? [], null, 2);
}

function parseEventWithBothSchemas(input: unknown): {
  production: ZodAgentEvent;
  manifest: AgentEventFromSchema;
} {
  const productionResult = AgentEventSchema.safeParse(input);
  const manifestResult = AgentEventSchemaFromManifest.safeParse(input);

  expect(
    productionResult.success,
    `AgentEventSchema rejected fixture: ${formatIssues(productionResult)}`,
  ).toBe(true);
  expect(
    manifestResult.success,
    `AgentEventSchemaFromManifest rejected fixture: ${formatIssues(manifestResult)}`,
  ).toBe(true);

  if (!productionResult.success || !manifestResult.success) {
    throw new Error('Expected both schemas to accept fixture');
  }

  return {
    production: productionResult.data,
    manifest: manifestResult.data,
  };
}

function buildToolEvent(overrides: Partial<Omit<ToolEvent, 'type'>> = {}): ToolEvent {
  return {
    type: 'tool',
    toolName: 'Read',
    toolUseId: 'tool-use-1',
    detail: 'Read file for parity special-case coverage',
    stage: 'end',
    timestamp: BASE_TIMESTAMP,
    ...overrides,
  };
}

describe('parity special cases', () => {
  describe('tool._origin round-trip', () => {
    it.each(TOOL_ORIGINS)('value=%s', (origin) => {
      const input = origin === undefined
        ? buildToolEvent()
        : buildToolEvent({ _origin: origin });
      const { production, manifest } = parseEventWithBothSchemas(input);

      expect(manifest).toEqual(production);
      expect(production.type).toBe('tool');
      expect(manifest.type).toBe('tool');

      if (production.type !== 'tool' || manifest.type !== 'tool') {
        throw new Error('Expected tool event for _origin parity check');
      }

      expect(production._origin).toBe(origin);
      expect(manifest._origin).toBe(origin);

      if (origin === undefined) {
        expect(Object.prototype.hasOwnProperty.call(production, '_origin')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(manifest, '_origin')).toBe(false);
      }
    });

    it('rejects unrecognised _origin string', () => {
      const invalidOriginInput = {
        ...buildToolEvent(),
        _origin: 'agent_input',
      };

      const productionResult = AgentEventSchema.safeParse(invalidOriginInput);
      const manifestResult = AgentEventSchemaFromManifest.safeParse(invalidOriginInput);

      expect(productionResult.success).toBe(false);
      expect(manifestResult.success).toBe(false);
    });
  });

  describe('tool.mcpAppUiMeta.sourcePackageId multi-instance', () => {
    it('three sibling tool events retain distinct sourcePackageIds', () => {
      const sourcePackageIds = [
        'com.example.pkg.alpha',
        'com.example.pkg.beta',
        'com.example.pkg.gamma',
      ] as const;

      const inputs: ToolEvent[] = sourcePackageIds.map((sourcePackageId, index) =>
        buildToolEvent({
          toolUseId: `tool-use-${index + 1}`,
          detail: `mcpAppUiMeta.sourcePackageId probe ${index + 1}`,
          mcpAppUiMeta: {
            resourceUri: `mcp://app/view/${index + 1}`,
            sourcePackageId,
            visibility: ['app'],
          },
        }));

      const inputSnapshots = structuredClone(inputs);

      // Per final GPT review: parse through BOTH schemas to assert symmetric
      // sourcePackageId preservation. Production-schema parsing was previously
      // only covered transitively via the schema parity corpus.
      const manifestParsed = inputs.map((input) => AgentEventSchemaFromManifest.parse(input));
      const productionParsed = inputs.map((input) => AgentEventSchema.parse(input));

      expect(inputs).toEqual(inputSnapshots);
      expect(manifestParsed).toEqual(inputs);
      expect(productionParsed).toEqual(inputs);
      expect(manifestParsed).toEqual(productionParsed);

      const extractSourcePackageIds = (parsed: ZodAgentEvent[]): (string | null | undefined)[] =>
        parsed.map((event, index) => {
          expect(event.type).toBe('tool');
          if (event.type !== 'tool') {
            throw new Error(`Expected tool event at index ${index}`);
          }
          return event.mcpAppUiMeta?.sourcePackageId;
        });

      expect(extractSourcePackageIds(manifestParsed)).toEqual(sourcePackageIds);
      expect(extractSourcePackageIds(productionParsed)).toEqual(sourcePackageIds);
    });
  });

  describe('tool.mcpAppUiMeta A3a fields', () => {
    it('round-trips presentation metadata and structuredFallback through both schemas', () => {
      const input = buildToolEvent({
        toolName: 'compose_workspace_email',
        detail: 'Draft ready',
        mcpAppUiMeta: {
          resourceUri: 'ui://google-workspace/compose-email',
          presentation: 'primary',
          viewSummary: 'Email draft to person@example.com — subject "Hello".',
          viewRoleLabel: 'Editable email draft',
          structuredFallback: {
            kind: 'email-draft',
            payload: {
              to: ['person@example.com'],
              cc: [],
              bcc: [],
              subject: 'Hello',
              body: 'Plaintext draft body.',
            },
          },
        },
      });

      const { production, manifest } = parseEventWithBothSchemas(input);

      expect(production).toEqual(input);
      expect(manifest).toEqual(input);
      expect(production).toEqual(manifest);

      if (production.type !== 'tool' || manifest.type !== 'tool') {
        throw new Error('Expected tool event for mcpAppUiMeta A3a parity check');
      }

      expect(production.mcpAppUiMeta?.presentation).toBe('primary');
      expect(production.mcpAppUiMeta?.viewSummary).toBe('Email draft to person@example.com — subject "Hello".');
      expect(production.mcpAppUiMeta?.viewRoleLabel).toBe('Editable email draft');
      expect(production.mcpAppUiMeta?.structuredFallback).toEqual(
        manifest.mcpAppUiMeta?.structuredFallback,
      );
    });

    it('trims viewSummary and rejects primary metadata without one', () => {
      const trimmed = parseEventWithBothSchemas(buildToolEvent({
        mcpAppUiMeta: {
          resourceUri: 'ui://example/view',
          presentation: 'primary',
          viewSummary: '  Trimmed summary.  ',
        },
      }));

      expect(trimmed.production.type).toBe('tool');
      if (trimmed.production.type === 'tool') {
        expect(trimmed.production.mcpAppUiMeta?.viewSummary).toBe('Trimmed summary.');
      }

      const invalidPrimary = buildToolEvent({
        mcpAppUiMeta: {
          resourceUri: 'ui://example/view',
          presentation: 'primary',
        },
      });

      const productionResult = AgentEventSchema.safeParse(invalidPrimary);
      const manifestResult = AgentEventSchemaFromManifest.safeParse(invalidPrimary);

      expect(productionResult.success).toBe(false);
      expect(manifestResult.success).toBe(false);
      if (!productionResult.success) {
        expect(productionResult.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ['mcpAppUiMeta', 'viewSummary'] }),
          ]),
        );
      }
    });
  });

  describe('user_question questions[] array shape', () => {
    it('preserves order and per-question shape', () => {
      const input: UserQuestionEvent = {
        type: 'user_question',
        batchId: 'batch-special-array-shape',
        toolUseId: 'tool-use-array-shape',
        questions: [
          {
            id: 'q1',
            question: 'Pick deployment target(s)',
            header: 'Targets',
            context: 'You can pick more than one option.',
            options: [
              {
                id: 'staging',
                label: 'Staging',
                description: 'Deploy to staging environment',
              },
              {
                id: 'production',
                label: 'Production',
                description: 'Deploy to production environment',
                requiresInput: true,
                inputPlaceholder: 'Approval ticket ID',
                url: 'https://example.com/approval',
              },
            ],
            multiSelect: true,
          },
          {
            id: 'q2',
            question: 'Share release summary?',
            header: 'Comms',
            options: [
              {
                id: 'yes',
                label: 'Yes',
                description: 'Send summary to the team',
              },
              {
                id: 'no',
                label: 'No',
                description: 'Skip for now',
              },
            ],
            multiSelect: false,
          },
        ],
        sessionId: 'session-array-shape',
        timestamp: BASE_TIMESTAMP + 50,
      };

      const inputQuestionOrder = input.questions.map((question) => question.id);
      const { production, manifest } = parseEventWithBothSchemas(input);

      expect(manifest).toEqual(production);
      expect(production.type).toBe('user_question');
      expect(manifest.type).toBe('user_question');

      if (production.type !== 'user_question' || manifest.type !== 'user_question') {
        throw new Error('Expected user_question event for array-shape check');
      }

      expect(production.questions.map((question) => question.id)).toEqual(inputQuestionOrder);
      expect(manifest.questions.map((question) => question.id)).toEqual(inputQuestionOrder);
    });
  });

  describe('result/error deeply-nested metrics + metadata', () => {
    it('result with full usage/modelUsage/toolMetrics/subAgentMetrics/fallbacks', () => {
      const input: ResultEvent = {
        type: 'result',
        text: 'Turn completed with full telemetry',
        model: 'claude-opus-4-7',
        modelUsage: {
          primary: {
            inputTokens: 320,
            outputTokens: 140,
            cacheReadTokens: 24,
            cacheCreationTokens: 12,
            costUsd: 0.42,
            openRouterProvider: 'Fireworks',
            providersSeen: ['Fireworks'],
            fulfillmentProvider: {
              name: 'Fireworks',
              transport: 'openrouter',
              source: 'or-body',
              serverHints: {
                'cf-ray': 'xyz987',
              },
            },
          },
          fallback: {
            inputTokens: 45,
            outputTokens: 20,
            providersSeen: [],
          },
        },
        usage: {
          inputTokens: 365,
          outputTokens: 160,
          cacheCreationTokens: 12,
          cacheReadTokens: 24,
          costUsd: 0.51,
          contextUtilization: 62,
          contextWindow: 200000,
        },
        toolMetrics: {
          totalToolCalls: 6,
          failedToolCalls: 1,
          filesCreated: 2,
          filesEdited: 3,
          toolUsageByCategory: { read: 3, write: 2, search: 1 },
          mcpServerUsage: { filesystem: 3, search: 1, memory: 2 },
          totalToolOutputChars: 8192,
          mcpToolOutputChars: 5120,
          builtinToolOutputChars: 3072,
        },
        subAgentMetrics: {
          usedSubAgents: true,
          subAgentCount: 2,
          subAgentToolCount: 5,
        },
        fallbacks: [
          {
            type: 'model',
            from: 'claude-opus-4-7',
            to: 'claude-sonnet-4',
            reason: 'capacity spike',
          },
          {
            type: 'provider',
            from: 'anthropic',
            to: 'openrouter',
            reason: 'provider outage',
          },
        ],
        timestamp: BASE_TIMESTAMP + 75,
      };

      const { production, manifest } = parseEventWithBothSchemas(input);
      expect(manifest).toEqual(production);
      expect(production).toEqual(input);
      expect(manifest).toEqual(input);
    });

    it('error with full rateLimitMeta/billingMeta/timeoutDiagnostic/watchdogDiagnostic', () => {
      const input: ErrorEvent = {
        type: 'error',
        error: 'Rate limit exceeded',
        rawError: 'HTTP 429 upstream payload',
        isTransient: true,
        errorSource: 'main',
        errorKind: 'rate_limit',
        rateLimitMeta: {
          rawError: 'provider said try later',
          retryAfterMs: 2500,
          resetAtMs: BASE_TIMESTAMP + 120_000,
        },
        billingMeta: {
          subtype: 'credits',
          upstreamProviderName: 'anthropic',
          rawError: 'insufficient credits',
        },
        provider: 'OpenRouter',
        timeoutDiagnostic: {
          kind: 'transient_stall',
          indicator: 'no-stream-events',
          description: 'No stream deltas were received before timeout.',
        },
        watchdogDiagnostic: {
          phase: 'streaming',
          messageCount: 15,
          rawStreamEventCount: 9,
          rawStreamLastEventType: 'message_delta',
          rawStreamLastEventAgeMs: 1600,
          watchdogLevel: 2,
          maxWatchdogLevel: 4,
          effectiveAbortMs: 45_000,
          model: 'claude-opus-4-7',
        },
        timestamp: BASE_TIMESTAMP + 100,
      };

      const { production, manifest } = parseEventWithBothSchemas(input);
      expect(manifest).toEqual(production);
      expect(production).toEqual(input);
      expect(manifest).toEqual(input);
    });
  });

  describe('AgentSession round-trip', () => {
    it('minimal session round-trips', () => {
      const session: ManualAgentSession = {
        id: 'session-minimal',
        title: 'Minimal session',
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
      };

      const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
      expect(roundTripped).toEqual(session);
    });

    it('fully populated session round-trips', () => {
      const session: ManualAgentSession = {
        id: 'session-full',
        title: 'Full session',
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP + 1_000,
        cloudUpdatedAt: BASE_TIMESTAMP + 1_500,
        messages: [
          {
            id: 'msg-1',
            turnId: 'turn-1',
            role: 'assistant',
            text: 'Special-case parity checks complete.',
            createdAt: BASE_TIMESTAMP + 100,
          },
        ],
        eventsByTurn: {
          'turn-1': [
            {
              type: 'tool',
              toolName: 'Task',
              toolUseId: 'tool-use-session',
              parentToolUseId: null,
              detail: 'Embedded session tool event',
              stage: 'end',
              timestamp: BASE_TIMESTAMP + 200,
              mcpAppUiMeta: {
                resourceUri: 'mcp://app/view/session',
                sourcePackageId: 'com.example.session.pkg',
              },
              _origin: 'pre-turn-context',
            },
            {
              type: 'result',
              text: 'Embedded result event',
              timestamp: BASE_TIMESTAMP + 300,
              usage: {
                inputTokens: 20,
                outputTokens: 10,
                contextWindow: 200000,
              },
            },
          ],
        },
        maxSeq: 42,
        activeTurnId: 'turn-1',
        isBusy: true,
        lastError: 'Synthetic error marker',
        resolvedAt: BASE_TIMESTAMP + 1_600,
        doneAt: BASE_TIMESTAMP + 1_700,
        starredAt: BASE_TIMESTAMP + 1_800,
        deletedAt: null,
        autoTitleGeneratedAt: BASE_TIMESTAMP + 1_900,
        autoTitleTurnCount: 3,
        isCorrupted: false,
        origin: 'manual',
        memoryUpdateStatusByTurn: {
          'turn-1': {
            originalTurnId: 'turn-1',
            status: 'success',
            summary: 'Memory update succeeded',
            timestamp: BASE_TIMESTAMP + 2_000,
          },
        },
        timeSavedStatusByTurn: {
          'turn-1': {
            turnId: 'turn-1',
            status: 'success',
            actualDurationSeconds: 24,
            timestamp: BASE_TIMESTAMP + 2_100,
          },
        },
        automationId: 'automation-1',
        automationRunId: 'run-1',
        compactionBoundaries: [
          {
            afterMessageIndex: 0,
            summary: 'Compaction summary',
            timestamp: BASE_TIMESTAMP + 2_200,
            depth: 1,
          },
        ],
        privateMode: true,
        interruptedTurnId: 'turn-interrupted',
        draft: {
          text: 'Unsent draft text',
          updatedAt: BASE_TIMESTAMP + 2_300,
        },
        setupContext: {
          kind: 'bundled-app-bridge',
          pairSessionId: 'pair-1',
          pendingAnnouncement: {
            status: 'connected',
            emittedAt: BASE_TIMESTAMP + 2_400,
          },
        },
        toolDetailArchive: {
          'tool-use-session': {
            toolName: 'Task',
            input: '{"task":"special-case"}',
            output: '{"ok":true}',
            outputChars: 11,
          },
        },
        sessionWorkingModel: 'claude-opus-4-7',
        sessionThinkingModel: 'claude-sonnet-4',
        sessionWorkingProfileId: 'working-profile-1',
        sessionThinkingProfileId: 'thinking-profile-1',
        sessionThinkingEffort: 'high',
        meetingCompanion: {
          meetingUrl: 'https://example.com/meeting',
          botId: 'bot-1',
          meetingTitle: 'Weekly sync',
          startedAt: BASE_TIMESTAMP + 2_500,
          prepPath: '/tmp/prep.md',
          coach: {
            skillPath: '/skills/coach.md',
            skillName: 'Coach',
            showAllChecks: true,
          },
          lastInjectedCoachPath: '/skills/coach.md',
        },
      };

      const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
      expect(roundTripped).toEqual(session);
    });

    it('keeps backward compatibility for persisted thinking_delta events in historical sessions', () => {
      const session: ManualAgentSession = {
        id: 'session-legacy-thinking-delta',
        title: 'Legacy thinking session',
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP + 50,
        messages: [],
        eventsByTurn: {
          'turn-legacy': [
            {
              type: 'thinking_delta',
              text: 'legacy thought',
              timestamp: BASE_TIMESTAMP + 10,
              seq: 1,
            },
            {
              type: 'result',
              text: 'legacy completion',
              timestamp: BASE_TIMESTAMP + 20,
              seq: 2,
            },
          ],
        },
        maxSeq: 2,
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
      };

      const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
      expect(roundTripped).toEqual(session);
    });
  });
});
