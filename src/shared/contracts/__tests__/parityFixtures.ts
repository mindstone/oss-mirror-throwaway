/**
 * S2-D parity-corpus fixtures. DATA ONLY — no `describe`/`it` here. Tests live
 * in `parity.*.test.ts` files. Vitest only collects `*.test.*` / `*.spec.*`,
 * collect this file.
 *
 * 31 variants × 7 categories ≈ 217 fixtures (some categories may be N/A for
 * specific variants — explicitly tagged with `category`).
 *
 * See `docs/plans/260429_r2_stage2_chunked_implementation_plan.md` § S2-D.
 */

export const PARITY_VARIANTS = [
  'status',
  'assistant',
  'result',
  'tool',
  'error',
  'warning',
  'user_question',
  'user_question_answered',
  'assistant_delta',
  'thinking_delta',
  'context_overflow',
  'compaction_started',
  'compaction_summary_ready',
  'compaction_retrying',
  'compaction_completed',
  'compaction_failed',
  'recovery:started',
  'recovery:fallback_attempting',
  'recovery:fallback_succeeded',
  'recovery:compacting',
  'recovery:summary_ready',
  'recovery:retrying',
  'recovery:skeleton_attempting',
  'recovery:depth4_attempting',
  'recovery:succeeded',
  'recovery:failed',
  'recovery:last_resort_skipped',
  'turn_superseded',
  'user_message',
  'turn_started',
  'answer_phase_started',
] as const;

export type ParityVariant = (typeof PARITY_VARIANTS)[number];

export const PARITY_CATEGORIES = [
  'positive',
  'negative',
  'legacy',
  'version-skew',
  'extra-keys',
  'unknown-variant',
  'nested-metadata',
] as const;

export type FixtureCategory = (typeof PARITY_CATEGORIES)[number];

export interface ParityFixture {
  /** AgentEvent variant type the fixture targets (e.g. 'tool', 'assistant') */
  variant: ParityVariant;
  /** Test category */
  category: FixtureCategory;
  /** Human-readable label, used in test failure messages */
  label: string;
  /** Raw input — what gets parsed (likely JSON-serializable) */
  input: unknown;
  /** Whether both schemas should accept this input. */
  expectedAccept: boolean;
  /**
   * For positive + nested-metadata fixtures only: the canonical normalized
   * shape we expect after parse.
   */
  expectedNormalised?: unknown;
  /** Optional notes about why this fixture exists / what it tests */
  notes?: string;
}

const BASE_TIMESTAMP = 1700000000000;

const UNKNOWN_VARIANT_INPUT = {
  type: 'definitely-not-a-valid-variant',
  timestamp: BASE_TIMESTAMP,
  message: 'not-a-real-variant',
  seq: 1,
} as const;

const f = (
  variant: ParityVariant,
  category: FixtureCategory,
  label: string,
  input: unknown,
  opts: Partial<Pick<ParityFixture, 'expectedAccept' | 'expectedNormalised' | 'notes'>> = {},
): ParityFixture => ({
  variant,
  category,
  label,
  input,
  expectedAccept: opts.expectedAccept ?? (category !== 'negative' && category !== 'unknown-variant'),
  expectedNormalised: opts.expectedNormalised,
  notes: opts.notes,
});

const makeRecoveryBase = (index: number) => ({
  turnId: `turn-recovery-${index}`,
  sessionId: `session-recovery-${index}`,
  originalSessionId: `original-session-recovery-${index}`,
  depth: Math.min(index % 5, 4),
  attempt: (index % 3) + 1,
  totalCalls: index + 1,
  timestamp: BASE_TIMESTAMP + index,
});

const recoveryFixtureSpecs = [
  {
    type: 'recovery:started',
    valid: { phase: 'post_activity' },
    invalid: { phase: 'during_lunch' },
  },
  {
    type: 'recovery:fallback_attempting',
    valid: { target: { kind: 'model', modelName: 'Opus Recovery' } },
    invalid: { target: { kind: 'wizard' } },
  },
  {
    type: 'recovery:fallback_succeeded',
    valid: { target: { kind: 'profile', profileId: 'profile-1', profileName: 'Big window' } },
    invalid: { target: { kind: 'wizard' } },
  },
  {
    type: 'recovery:compacting',
    valid: {},
    invalid: { totalCalls: 'three' },
  },
  {
    type: 'recovery:summary_ready',
    valid: { summary: 'Recovered enough context to continue.' },
    invalid: { summary: 42 },
  },
  {
    type: 'recovery:retrying',
    valid: {},
    invalid: { depth: '1' },
  },
  {
    type: 'recovery:skeleton_attempting',
    valid: {},
    invalid: { attempt: '1' },
  },
  {
    type: 'recovery:depth4_attempting',
    valid: { profileId: 'profile-1', modelName: 'Opus Recovery', costEstimate: 'high' },
    invalid: { profileId: 'profile-1', modelName: 'Opus Recovery', costEstimate: 'low' },
  },
  {
    type: 'recovery:succeeded',
    valid: { finalDepth: 3, totalDurationMs: 1200 },
    invalid: { finalDepth: 3, totalDurationMs: -1 },
  },
  {
    type: 'recovery:failed',
    valid: { error: 'Recovery failed: agent loop error before recovery', exhaustedReason: 'agent_loop_error_before_recovery' },
    invalid: { error: 'Recovery failed', exhaustedReason: 'because' },
  },
  {
    type: 'recovery:last_resort_skipped',
    valid: {
      reason: 'no_qualifying_profile',
      userFacingTitle: 'No recovery model available',
      userFacingMessage: 'Choose a recovery model, then try again.',
      action: 'Open settings',
    },
    invalid: {
      reason: 'bored',
      userFacingTitle: 'No recovery model available',
      userFacingMessage: 'Choose a recovery model, then try again.',
      action: 'Open settings',
    },
  },
] as const satisfies ReadonlyArray<{
  type: Extract<ParityVariant, `recovery:${string}`>;
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
}>;

const recoveryParityFixtures: ParityFixture[] = recoveryFixtureSpecs.flatMap((spec, index) => {
  const base = makeRecoveryBase(index);
  const positive = { type: spec.type, ...base, ...spec.valid };
  const negative = { type: spec.type, ...base, ...spec.valid, ...spec.invalid };
  const versionSkew = { ...positive, seq: 3000 + index };
  const extraKeys = { ...positive, extraTopLevel: 'strip-me' };
  const nestedMetadata = spec.type === 'recovery:fallback_attempting'
    ? {
        ...versionSkew,
        target: { kind: 'model', modelName: 'Opus Recovery', nestedExtra: 'strip-me' },
      }
    : versionSkew;

  const expectedNested = spec.type === 'recovery:fallback_attempting'
    ? {
        ...versionSkew,
        target: { kind: 'model', modelName: 'Opus Recovery' },
      }
    : versionSkew;

  return [
    f(spec.type, 'positive', `${spec.type} positive minimal`, positive, {
      expectedNormalised: positive,
    }),
    f(spec.type, 'negative', `${spec.type} rejects invalid recovery payload`, negative),
    f(spec.type, 'legacy', `${spec.type} legacy required fields only`, positive, {
      notes: 'Stage 3 recovery events have no pre-dual-write legacy shape; required fields remain mandatory.',
    }),
    f(spec.type, 'version-skew', `${spec.type} accepts seq from newer producer`, versionSkew, {
      notes: 'Version-skew proxy via optional seq.',
    }),
    f(spec.type, 'extra-keys', `${spec.type} strips unknown top-level key`, extraKeys),
    f(spec.type, 'unknown-variant', `unknown variant sentinel for ${spec.type}`, UNKNOWN_VARIANT_INPUT, {
      expectedAccept: false,
    }),
    f(spec.type, 'nested-metadata', `${spec.type} nested metadata canonical payload`, nestedMetadata, {
      expectedNormalised: expectedNested,
      notes: spec.type === 'recovery:fallback_attempting'
        ? 'Nested target unknown keys are stripped by the boundary schema.'
        : 'No additional nested metadata object on this recovery event.',
    }),
  ];
});

export const parityFixtures: ParityFixture[] = [
  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------
  f(
    'status',
    'positive',
    'status positive minimal',
    { type: 'status', message: 'Working...', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'status', message: 'Working...', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('status', 'negative', 'status rejects non-string message', {
    type: 'status',
    message: 42,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'status',
    'legacy',
    'status legacy no seq field',
    { type: 'status', message: 'Legacy status', timestamp: BASE_TIMESTAMP - 50 },
    { notes: 'Legacy payloads predate widespread seq stamping.' },
  ),
  f(
    'status',
    'version-skew',
    'status accepts future seq value',
    { type: 'status', message: 'Future seq stamp', timestamp: BASE_TIMESTAMP, seq: 4096 },
    { notes: 'Version-skew proxy: newer producer includes seq with larger value.' },
  ),
  f('status', 'extra-keys', 'status strips unknown top-level key', {
    type: 'status',
    message: 'Has unknown key',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'status',
    'unknown-variant',
    'unknown variant sentinel for status',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'status',
    'nested-metadata',
    'status nested-metadata N/A canonical payload',
    { type: 'status', message: 'No nested payload for status', timestamp: BASE_TIMESTAMP, seq: 2 },
    {
      expectedNormalised: { type: 'status', message: 'No nested payload for status', timestamp: BASE_TIMESTAMP, seq: 2 },
      notes: 'This variant has no nested metadata fields; fixture keeps category slot explicit.',
    },
  ),

  // ---------------------------------------------------------------------------
  // assistant
  // ---------------------------------------------------------------------------
  f(
    'assistant',
    'positive',
    'assistant positive with seq=1',
    { type: 'assistant', text: 'Hello from assistant', timestamp: BASE_TIMESTAMP, seq: 1 },
    {
      expectedNormalised: { type: 'assistant', text: 'Hello from assistant', timestamp: BASE_TIMESTAMP, seq: 1 },
      notes: 'Seq coverage (accepted positive integer).',
    },
  ),
  f('assistant', 'negative', 'assistant rejects non-string text', {
    type: 'assistant',
    text: 123,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'assistant',
    'negative',
    'assistant rejects seq=0',
    { type: 'assistant', text: 'Bad seq zero', timestamp: BASE_TIMESTAMP, seq: 0 },
    { notes: 'Seq coverage: must be positive int.' },
  ),
  f(
    'assistant',
    'negative',
    'assistant rejects seq=1.5',
    { type: 'assistant', text: 'Bad seq float', timestamp: BASE_TIMESTAMP, seq: 1.5 },
    { notes: 'Seq coverage: must be int.' },
  ),
  f(
    'assistant',
    'negative',
    'assistant rejects seq as string',
    { type: 'assistant', text: 'Bad seq string', timestamp: BASE_TIMESTAMP, seq: '1' },
    { notes: 'Seq coverage: must be number.' },
  ),
  f(
    'assistant',
    'legacy',
    'assistant legacy without seq',
    { type: 'assistant', text: 'Old assistant event', timestamp: BASE_TIMESTAMP - 25 },
    { notes: 'Legacy payload accepted without seq.' },
  ),
  f(
    'assistant',
    'version-skew',
    'assistant accepts high seq from newer producer',
    { type: 'assistant', text: 'Future producer seq', timestamp: BASE_TIMESTAMP, seq: 9999 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('assistant', 'extra-keys', 'assistant strips unknown top-level key', {
    type: 'assistant',
    text: 'Assistant with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'assistant',
    'unknown-variant',
    'unknown variant sentinel for assistant',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'assistant',
    'nested-metadata',
    'assistant nested-metadata N/A canonical payload',
    {
      type: 'assistant',
      text: 'No nested object on assistant, still reserved category.',
      timestamp: BASE_TIMESTAMP,
      seq: 2,
    },
    {
      expectedNormalised: {
        type: 'assistant',
        text: 'No nested object on assistant, still reserved category.',
        timestamp: BASE_TIMESTAMP,
        seq: 2,
      },
      notes: 'Assistant variant has no nested metadata fields.',
    },
  ),

  // ---------------------------------------------------------------------------
  // result
  // ---------------------------------------------------------------------------
  f(
    'result',
    'positive',
    'result positive with seq=1',
    { type: 'result', text: 'Done', timestamp: BASE_TIMESTAMP, seq: 1 },
    {
      expectedNormalised: { type: 'result', text: 'Done', timestamp: BASE_TIMESTAMP, seq: 1 },
      notes: 'Seq coverage (accepted positive integer).',
    },
  ),
  f(
    'result',
    'positive',
    'result with populated roles[] (annotation layer round-trips through both schemas)',
    {
      type: 'result',
      text: 'Done',
      timestamp: BASE_TIMESTAMP,
      seq: 2,
      modelUsage: {
        'claude-opus-4-8': {
          inputTokens: 2,
          outputTokens: 151,
          costUsd: 0.01,
          authMethod: 'openrouter',
          providersSeen: ['anthropic'],
        },
      },
      roles: [
        {
          role: 'thinking',
          canonicalModelId: 'claude-opus-4-8',
          rawModelId: 'anthropic/claude-4.8-opus-20260528',
          status: 'observed',
          modelUsageKey: 'claude-opus-4-8',
          authMethod: 'openrouter',
          provider: 'anthropic',
          pricingStatus: 'priced',
        },
        {
          role: 'working',
          canonicalModelId: 'deepseek-v4-pro',
          rawModelId: 'deepseek/deepseek-v4-pro',
          status: 'configured_not_used',
        },
        {
          role: 'fast',
          canonicalModelId: 'deepseek-v4-flash',
          rawModelId: 'deepseek/deepseek-v4-flash',
          status: 'configured_not_used',
        },
      ],
    },
    {
      expectedNormalised: {
        type: 'result',
        text: 'Done',
        timestamp: BASE_TIMESTAMP,
        seq: 2,
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 2,
            outputTokens: 151,
            costUsd: 0.01,
            authMethod: 'openrouter',
            providersSeen: ['anthropic'],
          },
        },
        roles: [
          {
            role: 'thinking',
            canonicalModelId: 'claude-opus-4-8',
            rawModelId: 'anthropic/claude-4.8-opus-20260528',
            status: 'observed',
            modelUsageKey: 'claude-opus-4-8',
            authMethod: 'openrouter',
            provider: 'anthropic',
            pricingStatus: 'priced',
          },
          {
            role: 'working',
            canonicalModelId: 'deepseek-v4-pro',
            rawModelId: 'deepseek/deepseek-v4-pro',
            status: 'configured_not_used',
          },
          {
            role: 'fast',
            canonicalModelId: 'deepseek-v4-flash',
            rawModelId: 'deepseek/deepseek-v4-flash',
            status: 'configured_not_used',
          },
        ],
      },
      notes:
        'Exercises the additive roles[] field with all three tiers (one observed w/ usageKey+auth+provider+pricing, two configured_not_used). expectedNormalised set so the strip-detection assertion runs — proves neither the production schema nor the manifest silently drops roles[].',
    },
  ),
  f('result', 'negative', 'result rejects missing text', {
    type: 'result',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'result',
    'negative',
    'result rejects seq=0',
    { type: 'result', text: 'Bad seq zero', timestamp: BASE_TIMESTAMP, seq: 0 },
    { notes: 'Seq coverage: must be positive int.' },
  ),
  f(
    'result',
    'negative',
    'result rejects seq=1.5',
    { type: 'result', text: 'Bad seq float', timestamp: BASE_TIMESTAMP, seq: 1.5 },
    { notes: 'Seq coverage: must be int.' },
  ),
  f(
    'result',
    'negative',
    'result rejects seq as string',
    { type: 'result', text: 'Bad seq string', timestamp: BASE_TIMESTAMP, seq: '1' },
    { notes: 'Seq coverage: must be number.' },
  ),
  f(
    'result',
    'legacy',
    'result legacy minimal',
    { type: 'result', text: 'Older result payload', timestamp: BASE_TIMESTAMP - 20 },
    { notes: 'Legacy shape without newer optional telemetry fields.' },
  ),
  f(
    'result',
    'version-skew',
    'result accepts modern optional fields from newer producer',
    {
      type: 'result',
      text: 'Newer producer optional fields',
      timestamp: BASE_TIMESTAMP,
      authMethod: 'token',
      turnEndReason: 'completed',
      seq: 2048,
    },
    { notes: 'Version-skew represented by optional turn metadata fields.' },
  ),
  f('result', 'extra-keys', 'result strips unknown top-level key', {
    type: 'result',
    text: 'Result with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'result',
    'unknown-variant',
    'unknown variant sentinel for result',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'result',
    'nested-metadata',
    'result nested metadata with usage and metrics',
    {
      type: 'result',
      text: 'Result with nested metrics',
      timestamp: BASE_TIMESTAMP,
      model: 'claude-opus-4-7',
      modelUsage: {
        primary: {
          inputTokens: 120,
          outputTokens: 45,
          cacheReadTokens: 30,
          cacheCreationTokens: 10,
          costUsd: 0.12,
          openRouterProvider: 'Fireworks',
          providersSeen: ['Fireworks'],
          fulfillmentProvider: {
            name: 'Fireworks',
            transport: 'openrouter',
            source: 'or-body',
            serverHints: {
              'cf-ray': 'abc123',
            },
          },
        },
      },
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cacheCreationTokens: 10,
        cacheReadTokens: 30,
        costUsd: 0.12,
        contextUtilization: 47,
        contextWindow: 200000,
      },
      toolMetrics: {
        totalToolCalls: 3,
        failedToolCalls: 1,
        filesCreated: 1,
        filesEdited: 2,
        toolUsageByCategory: { read: 2, write: 1 },
        mcpServerUsage: { filesystem: 2, search: 1 },
        totalToolOutputChars: 4000,
        mcpToolOutputChars: 2500,
        builtinToolOutputChars: 1500,
      },
      outputShapeMetrics: {
        wordCount: 42,
        headingCount: 1,
        bulletCount: 3,
        numberedListCount: 0,
        codeBlockCount: 0,
        tableLineCount: 0,
        linkCount: 1,
        hasSourceSection: true,
        shapeBucket: 'structured_response',
      },
      subAgentMetrics: {
        usedSubAgents: true,
        subAgentCount: 2,
        subAgentToolCount: 4,
      },
      thinkingEffort: 'high',
      authMethod: 'api-key',
      fallbacks: [
        {
          type: 'model',
          from: 'claude-opus-4-7',
          to: 'claude-sonnet-4',
          reason: 'capacity',
        },
        {
          type: 'provider',
          from: 'anthropic-api-key',
          to: 'openrouter-oauth-token',
          reason: 'multi-provider-rate-limit-failover',
          billingSource: 'pool',
        },
      ],
      turnEndReason: 'completed',
      seq: 7,
    },
    {
      expectedNormalised: {
        type: 'result',
        text: 'Result with nested metrics',
        timestamp: BASE_TIMESTAMP,
        model: 'claude-opus-4-7',
        modelUsage: {
          primary: {
            inputTokens: 120,
            outputTokens: 45,
            cacheReadTokens: 30,
            cacheCreationTokens: 10,
            costUsd: 0.12,
            openRouterProvider: 'Fireworks',
            providersSeen: ['Fireworks'],
            fulfillmentProvider: {
              name: 'Fireworks',
              transport: 'openrouter',
              source: 'or-body',
              serverHints: {
                'cf-ray': 'abc123',
              },
            },
          },
        },
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          cacheCreationTokens: 10,
          cacheReadTokens: 30,
          costUsd: 0.12,
          contextUtilization: 47,
          contextWindow: 200000,
        },
        toolMetrics: {
          totalToolCalls: 3,
          failedToolCalls: 1,
          filesCreated: 1,
          filesEdited: 2,
          toolUsageByCategory: { read: 2, write: 1 },
          mcpServerUsage: { filesystem: 2, search: 1 },
          totalToolOutputChars: 4000,
          mcpToolOutputChars: 2500,
          builtinToolOutputChars: 1500,
        },
        outputShapeMetrics: {
          wordCount: 42,
          headingCount: 1,
          bulletCount: 3,
          numberedListCount: 0,
          codeBlockCount: 0,
          tableLineCount: 0,
          linkCount: 1,
          hasSourceSection: true,
          shapeBucket: 'structured_response',
        },
        subAgentMetrics: {
          usedSubAgents: true,
          subAgentCount: 2,
          subAgentToolCount: 4,
        },
        thinkingEffort: 'high',
        authMethod: 'api-key',
        fallbacks: [
          {
            type: 'model',
            from: 'claude-opus-4-7',
            to: 'claude-sonnet-4',
            reason: 'capacity',
          },
          {
            type: 'provider',
            from: 'anthropic-api-key',
            to: 'openrouter-oauth-token',
            reason: 'multi-provider-rate-limit-failover',
            billingSource: 'pool',
          },
        ],
        turnEndReason: 'completed',
        seq: 7,
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // tool
  // ---------------------------------------------------------------------------
  f(
    'tool',
    'positive',
    'tool positive with seq=1 and _origin',
    {
      type: 'tool',
      toolName: 'Read',
      toolUseId: 'tool-use-1',
      detail: 'Reading file',
      stage: 'start',
      timestamp: BASE_TIMESTAMP,
      _origin: 'real',
      seq: 1,
    },
    {
      expectedNormalised: {
        type: 'tool',
        toolName: 'Read',
        toolUseId: 'tool-use-1',
        detail: 'Reading file',
        stage: 'start',
        timestamp: BASE_TIMESTAMP,
        _origin: 'real',
        seq: 1,
      },
      notes: 'Seq coverage + _origin coverage.',
    },
  ),
  f('tool', 'negative', 'tool rejects invalid stage literal', {
    type: 'tool',
    toolName: 'Read',
    detail: 'Invalid stage',
    stage: 'middle',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'tool',
    'negative',
    'tool rejects seq=0',
    {
      type: 'tool',
      toolName: 'Read',
      detail: 'Bad seq zero',
      stage: 'start',
      timestamp: BASE_TIMESTAMP,
      seq: 0,
    },
    { notes: 'Seq coverage: must be positive int.' },
  ),
  f(
    'tool',
    'negative',
    'tool rejects seq=1.5',
    {
      type: 'tool',
      toolName: 'Read',
      detail: 'Bad seq float',
      stage: 'start',
      timestamp: BASE_TIMESTAMP,
      seq: 1.5,
    },
    { notes: 'Seq coverage: must be int.' },
  ),
  f(
    'tool',
    'negative',
    'tool rejects seq as string',
    {
      type: 'tool',
      toolName: 'Read',
      detail: 'Bad seq string',
      stage: 'start',
      timestamp: BASE_TIMESTAMP,
      seq: '1',
    },
    { notes: 'Seq coverage: must be number.' },
  ),
  f(
    'tool',
    'legacy',
    'tool legacy payload without _origin and mcp metadata',
    {
      type: 'tool',
      toolName: 'Read',
      detail: 'Legacy event payload',
      stage: 'end',
      timestamp: BASE_TIMESTAMP - 15,
    },
    { notes: 'Back-compat path: no _origin field.' },
  ),
  f(
    'tool',
    'version-skew',
    'tool accepts optional modern fields from newer producer',
    {
      type: 'tool',
      toolName: 'FilesystemRead',
      toolUseId: 'tool-use-2',
      parentToolUseId: null,
      detail: 'Future-compatible optional fields present',
      stage: 'end',
      isError: false,
      timestamp: BASE_TIMESTAMP,
      seq: 5000,
    },
    { notes: 'Version-skew proxy via optional fields + high seq.' },
  ),
  f('tool', 'extra-keys', 'tool strips unknown top-level and nested keys', {
    type: 'tool',
    toolName: 'Read',
    detail: 'Tool with unknown keys',
    stage: 'end',
    timestamp: BASE_TIMESTAMP,
    mcpAppUiMeta: {
      resourceUri: 'mcp://app/view/123',
      sourcePackageId: 'pkg.a',
      presentation: 'inline',
      unexpectedNested: 'strip-me',
    },
    extraTopLevel: 'strip-me',
  }),
  f(
    'tool',
    'unknown-variant',
    'unknown variant sentinel for tool',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'tool',
    'nested-metadata',
    'tool nested metadata includes image content and mcpAppUiMeta',
    {
      type: 'tool',
      toolName: 'RenderMcpApp',
      toolUseId: 'tool-use-nested',
      parentToolUseId: 'parent-tool-1',
      detail: 'Rendered MCP app view with metadata',
      stage: 'end',
      isError: false,
      timestamp: BASE_TIMESTAMP,
      imageContent: [
        { type: 'image', data: 'base64-data-1', mimeType: 'image/png' },
      ],
      mcpAppUiMeta: {
        resourceUri: 'mcp://app/view/abc',
        sourcePackageId: 'com.example.dashboard',
        protocolUrl: 'mcp://protocol/view',
        originalFilePath: '/tmp/example.html',
        presentation: 'primary',
        viewSummary: 'Email draft to person@example.com — subject "Quarterly check-in".',
        viewRoleLabel: 'Editable email draft',
        structuredFallback: {
          kind: 'email-draft',
          payload: {
            to: ['person@example.com'],
            cc: ['team@example.com'],
            bcc: [],
            subject: 'Quarterly check-in',
            body: 'Hello — here is the quarterly check-in draft.',
          },
        },
        visibility: ['model', 'app'],
        csp: {
          connectDomains: ['https://api.example.com'],
          resourceDomains: ['https://cdn.example.com'],
          frameDomains: ['https://frame.example.com'],
        },
        permissions: {
          camera: false,
          microphone: true,
          geolocation: false,
          clipboardWrite: true,
        },
      },
      _origin: 'synthetic-plan-seed',
      seq: 8,
    },
    {
      expectedNormalised: {
        type: 'tool',
        toolName: 'RenderMcpApp',
        toolUseId: 'tool-use-nested',
        parentToolUseId: 'parent-tool-1',
        detail: 'Rendered MCP app view with metadata',
        stage: 'end',
        isError: false,
        timestamp: BASE_TIMESTAMP,
        imageContent: [
          { type: 'image', data: 'base64-data-1', mimeType: 'image/png' },
        ],
        mcpAppUiMeta: {
          resourceUri: 'mcp://app/view/abc',
          sourcePackageId: 'com.example.dashboard',
          protocolUrl: 'mcp://protocol/view',
          originalFilePath: '/tmp/example.html',
          presentation: 'primary',
          viewSummary: 'Email draft to person@example.com — subject "Quarterly check-in".',
          viewRoleLabel: 'Editable email draft',
          structuredFallback: {
            kind: 'email-draft',
            payload: {
              to: ['person@example.com'],
              cc: ['team@example.com'],
              bcc: [],
              subject: 'Quarterly check-in',
              body: 'Hello — here is the quarterly check-in draft.',
            },
          },
          visibility: ['model', 'app'],
          csp: {
            connectDomains: ['https://api.example.com'],
            resourceDomains: ['https://cdn.example.com'],
            frameDomains: ['https://frame.example.com'],
          },
          permissions: {
            camera: false,
            microphone: true,
            geolocation: false,
            clipboardWrite: true,
          },
        },
        _origin: 'synthetic-plan-seed',
        seq: 8,
      },
    },
  ),
  f(
    'tool',
    'version-skew',
    'tool mcpAppUiMeta supports explicit inline presentation baseline',
    {
      type: 'tool',
      toolName: 'RenderInlineMcpApp',
      detail: 'Inline MCP app view',
      stage: 'end',
      timestamp: BASE_TIMESTAMP,
      mcpAppUiMeta: {
        resourceUri: 'ui://example/inline',
        presentation: 'inline',
        viewSummary: 'Inline view summary survives as optional plaintext.',
      },
    },
  ),
  f(
    'tool',
    'version-skew',
    'tool mcpAppUiMeta supports calendar-pick structured fallback',
    {
      type: 'tool',
      toolName: 'CalendarPicker',
      detail: 'Calendar picker view',
      stage: 'end',
      timestamp: BASE_TIMESTAMP,
      mcpAppUiMeta: {
        resourceUri: 'ui://calendar/pick',
        presentation: 'primary',
        viewSummary: 'Choose a meeting time.',
        structuredFallback: {
          kind: 'calendar-pick',
          payload: {
            title: 'Choose a time',
            options: [{ id: 'slot-1', label: 'Tuesday 10:00', start: '2026-05-12T10:00:00Z' }],
          },
        },
      },
    },
  ),
  f(
    'tool',
    'version-skew',
    'tool mcpAppUiMeta supports document-outline structured fallback',
    {
      type: 'tool',
      toolName: 'DocumentOutliner',
      detail: 'Document outline view',
      stage: 'end',
      timestamp: BASE_TIMESTAMP,
      mcpAppUiMeta: {
        resourceUri: 'ui://docs/outline',
        presentation: 'primary',
        viewSummary: 'Document outline ready.',
        structuredFallback: {
          kind: 'document-outline',
          payload: {
            title: 'Launch memo',
            sections: [{ heading: 'Summary', bullets: ['Audience', 'Timing'] }],
          },
        },
      },
    },
  ),
  f(
    'tool',
    'version-skew',
    'tool mcpAppUiMeta supports plain structured fallback',
    {
      type: 'tool',
      toolName: 'PlainRenderer',
      detail: 'Plain fallback view',
      stage: 'end',
      timestamp: BASE_TIMESTAMP,
      mcpAppUiMeta: {
        resourceUri: 'ui://plain/view',
        presentation: 'primary',
        viewSummary: 'Plain summary ready.',
        structuredFallback: {
          kind: 'plain',
          payload: { markdown: 'Plain fallback content.' },
        },
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // error
  // ---------------------------------------------------------------------------
  f(
    'error',
    'positive',
    'error positive minimal',
    { type: 'error', error: 'Something failed', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'error', error: 'Something failed', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('error', 'negative', 'error rejects non-string error field', {
    type: 'error',
    error: { message: 'not-string' },
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'error',
    'legacy',
    'error legacy minimal payload',
    { type: 'error', error: 'Legacy error', timestamp: BASE_TIMESTAMP - 10 },
    { notes: 'Legacy payload without modern metadata fields.' },
  ),
  f(
    'error',
    'version-skew',
    'error accepts optional metadata from newer producer',
    {
      type: 'error',
      error: 'Newer error metadata available',
      rawError: 'HTTP 429',
      errorSource: 'main',
      provider: 'Anthropic',
      timestamp: BASE_TIMESTAMP,
      seq: 777,
    },
    { notes: 'Version-skew proxy via optional metadata fields + seq.' },
  ),
  f('error', 'extra-keys', 'error strips unknown top-level key', {
    type: 'error',
    error: 'Error with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'error',
    'unknown-variant',
    'unknown variant sentinel for error',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'error',
    'nested-metadata',
    'error nested metadata with diagnostics',
    {
      type: 'error',
      error: 'Rate limit exceeded',
      rawError: 'upstream raw body',
      isTransient: true,
      errorSource: 'main',
      errorKind: 'rate_limit',
      rateLimitMeta: {
        rawError: 'upstream 429 detail',
        retryAfterMs: 2500,
        resetAtMs: BASE_TIMESTAMP + 30_000,
      },
      billingMeta: {
        subtype: 'credits',
        upstreamProviderName: 'anthropic',
        rawError: 'out of credits',
      },
      provider: 'OpenRouter',
      timeoutDiagnostic: {
        kind: 'transient_stall',
        indicator: 'no-stream-events',
        description: 'No stream deltas observed.',
      },
      watchdogDiagnostic: {
        phase: 'streaming',
        messageCount: 12,
        rawStreamEventCount: 5,
        rawStreamLastEventType: 'message_stop',
        rawStreamLastEventAgeMs: 1200,
        watchdogLevel: 2,
        maxWatchdogLevel: 4,
        effectiveAbortMs: 45_000,
        model: 'claude-opus-4-7',
      },
      timestamp: BASE_TIMESTAMP,
      seq: 9,
    },
    {
      expectedNormalised: {
        type: 'error',
        error: 'Rate limit exceeded',
        rawError: 'upstream raw body',
        isTransient: true,
        errorSource: 'main',
        errorKind: 'rate_limit',
        rateLimitMeta: {
          rawError: 'upstream 429 detail',
          retryAfterMs: 2500,
          resetAtMs: BASE_TIMESTAMP + 30_000,
        },
        billingMeta: {
          subtype: 'credits',
          upstreamProviderName: 'anthropic',
          rawError: 'out of credits',
        },
        provider: 'OpenRouter',
        timeoutDiagnostic: {
          kind: 'transient_stall',
          indicator: 'no-stream-events',
          description: 'No stream deltas observed.',
        },
        watchdogDiagnostic: {
          phase: 'streaming',
          messageCount: 12,
          rawStreamEventCount: 5,
          rawStreamLastEventType: 'message_stop',
          rawStreamLastEventAgeMs: 1200,
          watchdogLevel: 2,
          maxWatchdogLevel: 4,
          effectiveAbortMs: 45_000,
          model: 'claude-opus-4-7',
        },
        timestamp: BASE_TIMESTAMP,
        seq: 9,
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // warning
  // ---------------------------------------------------------------------------
  f(
    'warning',
    'positive',
    'warning positive minimal',
    { type: 'warning', message: 'Heads up', category: 'tooling', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'warning', message: 'Heads up', category: 'tooling', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('warning', 'negative', 'warning rejects non-string category', {
    type: 'warning',
    message: 'Bad category type',
    category: 99,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'warning',
    'legacy',
    'warning legacy without category',
    { type: 'warning', message: 'Legacy warning', timestamp: BASE_TIMESTAMP - 12 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'warning',
    'version-skew',
    'warning accepts seq from newer producer',
    { type: 'warning', message: 'Future seq warning', timestamp: BASE_TIMESTAMP, seq: 3210 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('warning', 'extra-keys', 'warning strips unknown top-level key', {
    type: 'warning',
    message: 'Warning with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'warning',
    'unknown-variant',
    'unknown variant sentinel for warning',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'warning',
    'nested-metadata',
    'warning nested-metadata N/A canonical payload',
    { type: 'warning', message: 'No nested payload for warning', timestamp: BASE_TIMESTAMP, seq: 2 },
    {
      expectedNormalised: { type: 'warning', message: 'No nested payload for warning', timestamp: BASE_TIMESTAMP, seq: 2 },
      notes: 'Warning has no nested metadata structure.',
    },
  ),

  // ---------------------------------------------------------------------------
  // user_question
  // ---------------------------------------------------------------------------
  f(
    'user_question',
    'positive',
    'user_question positive minimal',
    {
      type: 'user_question',
      batchId: 'batch-1',
      toolUseId: 'tool-use-ask',
      questions: [
        {
          id: 'q1',
          question: 'Which provider should we use?',
          header: 'Provider',
          options: [
            { id: 'anthropic', label: 'Anthropic', description: 'Use Anthropic directly' },
          ],
          multiSelect: false,
        },
      ],
      sessionId: 'session-1',
      timestamp: BASE_TIMESTAMP,
    },
    {
      expectedNormalised: {
        type: 'user_question',
        batchId: 'batch-1',
        toolUseId: 'tool-use-ask',
        questions: [
          {
            id: 'q1',
            question: 'Which provider should we use?',
            header: 'Provider',
            options: [
              { id: 'anthropic', label: 'Anthropic', description: 'Use Anthropic directly' },
            ],
            multiSelect: false,
          },
        ],
        sessionId: 'session-1',
        timestamp: BASE_TIMESTAMP,
      },
    },
  ),
  f('user_question', 'negative', 'user_question rejects non-array questions', {
    type: 'user_question',
    batchId: 'batch-bad',
    toolUseId: 'tool-bad',
    questions: 'not-an-array',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'user_question',
    'legacy',
    'user_question legacy without sessionId',
    {
      type: 'user_question',
      batchId: 'batch-legacy',
      toolUseId: 'tool-legacy',
      questions: [
        {
          id: 'q-legacy',
          question: 'Legacy question?',
          header: 'Legacy',
          options: [{ id: 'yes', label: 'Yes', description: 'Confirm' }],
          multiSelect: false,
        },
      ],
      timestamp: BASE_TIMESTAMP - 8,
    },
    { notes: 'Legacy payload omits sessionId (optional for compatibility).' },
  ),
  f(
    'user_question',
    'version-skew',
    'user_question accepts seq and optional session metadata',
    {
      type: 'user_question',
      batchId: 'batch-skew',
      toolUseId: 'tool-skew',
      questions: [
        {
          id: 'q-skew',
          question: 'Provide updated key',
          header: 'Credentials',
          options: [{ id: 'upload', label: 'Upload', description: 'Upload from manager' }],
          multiSelect: false,
        },
      ],
      sessionId: 'session-skew',
      timestamp: BASE_TIMESTAMP,
      seq: 1200,
    },
    { notes: 'Version-skew proxy via optional seq + sessionId.' },
  ),
  f('user_question', 'extra-keys', 'user_question strips unknown top-level key', {
    type: 'user_question',
    batchId: 'batch-extra',
    toolUseId: 'tool-extra',
    questions: [
      {
        id: 'q-extra',
        question: 'Extra keys?',
        header: 'Extras',
        options: [{ id: 'ok', label: 'OK', description: 'Proceed' }],
        multiSelect: false,
      },
    ],
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'user_question',
    'unknown-variant',
    'unknown variant sentinel for user_question',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'user_question',
    'positive',
    'user_question with approval_clarification purpose preserved',
    {
      type: 'user_question',
      batchId: 'batch-purpose',
      toolUseId: 'tool-purpose',
      questions: [
        {
          id: 'q-purpose',
          question: 'Which calendar should this go on?',
          header: 'Calendar',
          options: [
            { id: 'work', label: 'Work', description: 'Work calendar' },
            { id: 'personal', label: 'Personal', description: 'Personal calendar' },
          ],
          multiSelect: false,
          purpose: 'approval_clarification',
        },
      ],
      sessionId: 'session-purpose',
      timestamp: BASE_TIMESTAMP,
    },
    {
      expectedNormalised: {
        type: 'user_question',
        batchId: 'batch-purpose',
        toolUseId: 'tool-purpose',
        questions: [
          {
            id: 'q-purpose',
            question: 'Which calendar should this go on?',
            header: 'Calendar',
            options: [
              { id: 'work', label: 'Work', description: 'Work calendar' },
              { id: 'personal', label: 'Personal', description: 'Personal calendar' },
            ],
            multiSelect: false,
            purpose: 'approval_clarification',
          },
        ],
        sessionId: 'session-purpose',
        timestamp: BASE_TIMESTAMP,
      },
      notes: 'Stage 2 of 260506_approvals_clarifying_question_user_flow.md preserves the optional `purpose` field across schema/manifest parity.',
    },
  ),
  f(
    'user_question',
    'nested-metadata',
    'user_question nested metadata with rich options',
    {
      type: 'user_question',
      batchId: 'batch-nested',
      toolUseId: 'tool-nested',
      questions: [
        {
          id: 'q1',
          question: 'Choose deployment targets',
          header: 'Targets',
          context: 'Multiple environments are available.',
          options: [
            {
              id: 'staging',
              label: 'Staging',
              description: 'Deploy to staging',
              requiresInput: false,
            },
            {
              id: 'production',
              label: 'Production',
              description: 'Deploy to production',
              requiresInput: true,
              inputPlaceholder: 'Approval ticket',
              url: 'https://example.com/approval',
            },
          ],
          multiSelect: true,
        },
        {
          id: 'q2',
          question: 'Share release note?',
          header: 'Comms',
          options: [{ id: 'yes', label: 'Yes', description: 'Publish note' }],
          multiSelect: false,
        },
      ],
      sessionId: 'session-nested',
      timestamp: BASE_TIMESTAMP,
      seq: 15,
    },
    {
      expectedNormalised: {
        type: 'user_question',
        batchId: 'batch-nested',
        toolUseId: 'tool-nested',
        questions: [
          {
            id: 'q1',
            question: 'Choose deployment targets',
            header: 'Targets',
            context: 'Multiple environments are available.',
            options: [
              {
                id: 'staging',
                label: 'Staging',
                description: 'Deploy to staging',
                requiresInput: false,
              },
              {
                id: 'production',
                label: 'Production',
                description: 'Deploy to production',
                requiresInput: true,
                inputPlaceholder: 'Approval ticket',
                url: 'https://example.com/approval',
              },
            ],
            multiSelect: true,
          },
          {
            id: 'q2',
            question: 'Share release note?',
            header: 'Comms',
            options: [{ id: 'yes', label: 'Yes', description: 'Publish note' }],
            multiSelect: false,
          },
        ],
        sessionId: 'session-nested',
        timestamp: BASE_TIMESTAMP,
        seq: 15,
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // user_question_answered
  // ---------------------------------------------------------------------------
  f(
    'user_question_answered',
    'positive',
    'user_question_answered positive minimal',
    {
      type: 'user_question_answered',
      batchId: 'batch-1',
      answers: [
        {
          questionId: 'q1',
          selectedOptionIds: ['anthropic'],
        },
      ],
      timestamp: BASE_TIMESTAMP,
    },
    {
      expectedNormalised: {
        type: 'user_question_answered',
        batchId: 'batch-1',
        answers: [
          {
            questionId: 'q1',
            selectedOptionIds: ['anthropic'],
          },
        ],
        timestamp: BASE_TIMESTAMP,
      },
    },
  ),
  f('user_question_answered', 'negative', 'user_question_answered rejects non-array answers', {
    type: 'user_question_answered',
    batchId: 'batch-bad',
    answers: 'not-an-array',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'user_question_answered',
    'legacy',
    'user_question_answered legacy without skipped/sessionId',
    {
      type: 'user_question_answered',
      batchId: 'batch-legacy',
      answers: [{ questionId: 'q1', selectedOptionIds: ['yes'] }],
      timestamp: BASE_TIMESTAMP - 8,
    },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'user_question_answered',
    'version-skew',
    'user_question_answered accepts seq and optional fields',
    {
      type: 'user_question_answered',
      batchId: 'batch-skew',
      answers: [{ questionId: 'q1', selectedOptionIds: ['yes'], freeText: 'extra context' }],
      skipped: false,
      sessionId: 'session-skew',
      timestamp: BASE_TIMESTAMP,
      seq: 1400,
    },
    { notes: 'Version-skew proxy via optional seq and response metadata.' },
  ),
  f('user_question_answered', 'extra-keys', 'user_question_answered strips unknown top-level key', {
    type: 'user_question_answered',
    batchId: 'batch-extra',
    answers: [{ questionId: 'q1', selectedOptionIds: ['yes'] }],
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'user_question_answered',
    'unknown-variant',
    'unknown variant sentinel for user_question_answered',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'user_question_answered',
    'positive',
    'user_question_answered with skipped receipt preserved',
    {
      type: 'user_question_answered',
      batchId: 'batch-skipped',
      answers: [],
      skipped: true,
      sessionId: 'session-skipped',
      timestamp: BASE_TIMESTAMP,
    },
    {
      expectedNormalised: {
        type: 'user_question_answered',
        batchId: 'batch-skipped',
        answers: [],
        skipped: true,
        sessionId: 'session-skipped',
        timestamp: BASE_TIMESTAMP,
      },
      notes: 'Skipped user-question receipts remain part of the shared event contract.',
    },
  ),
  f(
    'user_question_answered',
    'nested-metadata',
    'user_question_answered nested metadata with attachments',
    {
      type: 'user_question_answered',
      batchId: 'batch-nested',
      answers: [
        {
          questionId: 'q1',
          selectedOptionIds: ['production'],
          freeText: 'Proceed with approval ticket ABC-123',
          attachments: [
            {
              id: 'att-1',
              name: 'approval.png',
              type: 'image',
              mimeType: 'image/png',
            },
          ],
        },
      ],
      skipped: false,
      sessionId: 'session-nested',
      timestamp: BASE_TIMESTAMP,
      seq: 16,
    },
    {
      expectedNormalised: {
        type: 'user_question_answered',
        batchId: 'batch-nested',
        answers: [
          {
            questionId: 'q1',
            selectedOptionIds: ['production'],
            freeText: 'Proceed with approval ticket ABC-123',
            attachments: [
              {
                id: 'att-1',
                name: 'approval.png',
                type: 'image',
                mimeType: 'image/png',
              },
            ],
          },
        ],
        skipped: false,
        sessionId: 'session-nested',
        timestamp: BASE_TIMESTAMP,
        seq: 16,
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // assistant_delta
  // ---------------------------------------------------------------------------
  f(
    'assistant_delta',
    'positive',
    'assistant_delta positive minimal',
    { type: 'assistant_delta', text: 'partial text', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'assistant_delta', text: 'partial text', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('assistant_delta', 'negative', 'assistant_delta rejects non-string text', {
    type: 'assistant_delta',
    text: false,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'assistant_delta',
    'legacy',
    'assistant_delta legacy no seq',
    { type: 'assistant_delta', text: 'legacy delta', timestamp: BASE_TIMESTAMP - 6 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'assistant_delta',
    'version-skew',
    'assistant_delta accepts seq from newer producer',
    { type: 'assistant_delta', text: 'future delta', timestamp: BASE_TIMESTAMP, seq: 2000 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('assistant_delta', 'extra-keys', 'assistant_delta strips unknown top-level key', {
    type: 'assistant_delta',
    text: 'delta extra',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'assistant_delta',
    'unknown-variant',
    'unknown variant sentinel for assistant_delta',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'assistant_delta',
    'nested-metadata',
    'assistant_delta nested-metadata N/A canonical payload',
    { type: 'assistant_delta', text: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 3 },
    {
      expectedNormalised: { type: 'assistant_delta', text: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 3 },
      notes: 'No nested metadata shape on assistant_delta.',
    },
  ),

  // ---------------------------------------------------------------------------
  // thinking_delta
  // ---------------------------------------------------------------------------
  f(
    'thinking_delta',
    'positive',
    'thinking_delta positive minimal',
    { type: 'thinking_delta', text: 'reasoning chunk', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'thinking_delta', text: 'reasoning chunk', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('thinking_delta', 'negative', 'thinking_delta rejects non-string text', {
    type: 'thinking_delta',
    text: 0,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'thinking_delta',
    'legacy',
    'thinking_delta legacy no seq',
    { type: 'thinking_delta', text: 'legacy thought', timestamp: BASE_TIMESTAMP - 6 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'thinking_delta',
    'version-skew',
    'thinking_delta accepts seq from newer producer',
    { type: 'thinking_delta', text: 'future thought', timestamp: BASE_TIMESTAMP, seq: 2001 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('thinking_delta', 'extra-keys', 'thinking_delta strips unknown top-level key', {
    type: 'thinking_delta',
    text: 'thought extra',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'thinking_delta',
    'unknown-variant',
    'unknown variant sentinel for thinking_delta',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'thinking_delta',
    'nested-metadata',
    'thinking_delta nested-metadata N/A canonical payload',
    { type: 'thinking_delta', text: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 3 },
    {
      expectedNormalised: { type: 'thinking_delta', text: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 3 },
      notes: 'No nested metadata shape on thinking_delta.',
    },
  ),

  // ---------------------------------------------------------------------------
  // context_overflow
  // ---------------------------------------------------------------------------
  f(
    'context_overflow',
    'positive',
    'context_overflow positive minimal',
    { type: 'context_overflow', originalPrompt: 'Long prompt content', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'context_overflow', originalPrompt: 'Long prompt content', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('context_overflow', 'negative', 'context_overflow rejects missing originalPrompt', {
    type: 'context_overflow',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'context_overflow',
    'legacy',
    'context_overflow legacy required fields only',
    { type: 'context_overflow', originalPrompt: 'legacy prompt', timestamp: BASE_TIMESTAMP - 5 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'context_overflow',
    'version-skew',
    'context_overflow accepts seq from newer producer',
    { type: 'context_overflow', originalPrompt: 'future prompt', timestamp: BASE_TIMESTAMP, seq: 1500 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('context_overflow', 'extra-keys', 'context_overflow strips unknown top-level key', {
    type: 'context_overflow',
    originalPrompt: 'prompt with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'context_overflow',
    'unknown-variant',
    'unknown variant sentinel for context_overflow',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'context_overflow',
    'nested-metadata',
    'context_overflow nested-metadata N/A canonical payload',
    { type: 'context_overflow', originalPrompt: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 4 },
    {
      expectedNormalised: { type: 'context_overflow', originalPrompt: 'no nested object', timestamp: BASE_TIMESTAMP, seq: 4 },
      notes: 'No nested metadata shape on context_overflow.',
    },
  ),

  // ---------------------------------------------------------------------------
  // compaction_started
  // ---------------------------------------------------------------------------
  f(
    'compaction_started',
    'positive',
    'compaction_started positive minimal',
    { type: 'compaction_started', depth: 1, sessionId: 'session-1', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'compaction_started', depth: 1, sessionId: 'session-1', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('compaction_started', 'negative', 'compaction_started rejects non-number depth', {
    type: 'compaction_started',
    depth: '1',
    sessionId: 'session-1',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'compaction_started',
    'legacy',
    'compaction_started legacy required fields only',
    { type: 'compaction_started', depth: 1, sessionId: 'session-legacy', timestamp: BASE_TIMESTAMP - 4 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'compaction_started',
    'version-skew',
    'compaction_started accepts seq from newer producer',
    { type: 'compaction_started', depth: 2, sessionId: 'session-skew', timestamp: BASE_TIMESTAMP, seq: 1600 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('compaction_started', 'extra-keys', 'compaction_started strips unknown top-level key', {
    type: 'compaction_started',
    depth: 1,
    sessionId: 'session-extra',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'compaction_started',
    'unknown-variant',
    'unknown variant sentinel for compaction_started',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'compaction_started',
    'nested-metadata',
    'compaction_started nested-metadata N/A canonical payload',
    { type: 'compaction_started', depth: 3, sessionId: 'session-nested', timestamp: BASE_TIMESTAMP, seq: 5 },
    {
      expectedNormalised: { type: 'compaction_started', depth: 3, sessionId: 'session-nested', timestamp: BASE_TIMESTAMP, seq: 5 },
      notes: 'No nested metadata object on compaction_started.',
    },
  ),

  // ---------------------------------------------------------------------------
  // compaction_summary_ready
  // ---------------------------------------------------------------------------
  f(
    'compaction_summary_ready',
    'positive',
    'compaction_summary_ready positive minimal',
    {
      type: 'compaction_summary_ready',
      summary: 'Compaction summary text',
      depth: 1,
      timestamp: BASE_TIMESTAMP,
    },
    {
      expectedNormalised: {
        type: 'compaction_summary_ready',
        summary: 'Compaction summary text',
        depth: 1,
        timestamp: BASE_TIMESTAMP,
      },
    },
  ),
  f('compaction_summary_ready', 'negative', 'compaction_summary_ready rejects missing summary', {
    type: 'compaction_summary_ready',
    depth: 1,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'compaction_summary_ready',
    'legacy',
    'compaction_summary_ready legacy required fields only',
    {
      type: 'compaction_summary_ready',
      summary: 'legacy summary',
      depth: 1,
      timestamp: BASE_TIMESTAMP - 4,
    },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'compaction_summary_ready',
    'version-skew',
    'compaction_summary_ready accepts seq from newer producer',
    {
      type: 'compaction_summary_ready',
      summary: 'future summary',
      depth: 2,
      timestamp: BASE_TIMESTAMP,
      seq: 1700,
    },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('compaction_summary_ready', 'extra-keys', 'compaction_summary_ready strips unknown top-level key', {
    type: 'compaction_summary_ready',
    summary: 'summary extra',
    depth: 1,
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'compaction_summary_ready',
    'unknown-variant',
    'unknown variant sentinel for compaction_summary_ready',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'compaction_summary_ready',
    'nested-metadata',
    'compaction_summary_ready nested-metadata N/A canonical payload',
    {
      type: 'compaction_summary_ready',
      summary: 'no nested object',
      depth: 2,
      timestamp: BASE_TIMESTAMP,
      seq: 6,
    },
    {
      expectedNormalised: {
        type: 'compaction_summary_ready',
        summary: 'no nested object',
        depth: 2,
        timestamp: BASE_TIMESTAMP,
        seq: 6,
      },
      notes: 'No nested metadata object on compaction_summary_ready.',
    },
  ),

  // ---------------------------------------------------------------------------
  // compaction_retrying
  // ---------------------------------------------------------------------------
  f(
    'compaction_retrying',
    'positive',
    'compaction_retrying positive minimal',
    { type: 'compaction_retrying', depth: 1, timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'compaction_retrying', depth: 1, timestamp: BASE_TIMESTAMP },
    },
  ),
  f('compaction_retrying', 'negative', 'compaction_retrying rejects non-number depth', {
    type: 'compaction_retrying',
    depth: '1',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'compaction_retrying',
    'legacy',
    'compaction_retrying legacy required fields only',
    { type: 'compaction_retrying', depth: 1, timestamp: BASE_TIMESTAMP - 3 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'compaction_retrying',
    'version-skew',
    'compaction_retrying accepts seq from newer producer',
    { type: 'compaction_retrying', depth: 2, timestamp: BASE_TIMESTAMP, seq: 1800 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('compaction_retrying', 'extra-keys', 'compaction_retrying strips unknown top-level key', {
    type: 'compaction_retrying',
    depth: 1,
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'compaction_retrying',
    'unknown-variant',
    'unknown variant sentinel for compaction_retrying',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'compaction_retrying',
    'nested-metadata',
    'compaction_retrying nested-metadata N/A canonical payload',
    { type: 'compaction_retrying', depth: 2, timestamp: BASE_TIMESTAMP, seq: 6 },
    {
      expectedNormalised: { type: 'compaction_retrying', depth: 2, timestamp: BASE_TIMESTAMP, seq: 6 },
      notes: 'No nested metadata object on compaction_retrying.',
    },
  ),

  // ---------------------------------------------------------------------------
  // compaction_completed
  // ---------------------------------------------------------------------------
  f(
    'compaction_completed',
    'positive',
    'compaction_completed positive minimal',
    { type: 'compaction_completed', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'compaction_completed', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('compaction_completed', 'negative', 'compaction_completed rejects non-number timestamp', {
    type: 'compaction_completed',
    timestamp: 'now',
  }),
  f(
    'compaction_completed',
    'legacy',
    'compaction_completed legacy required fields only',
    { type: 'compaction_completed', timestamp: BASE_TIMESTAMP - 2 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'compaction_completed',
    'version-skew',
    'compaction_completed accepts seq from newer producer',
    { type: 'compaction_completed', timestamp: BASE_TIMESTAMP, seq: 1900 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('compaction_completed', 'extra-keys', 'compaction_completed strips unknown top-level key', {
    type: 'compaction_completed',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'compaction_completed',
    'unknown-variant',
    'unknown variant sentinel for compaction_completed',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'compaction_completed',
    'nested-metadata',
    'compaction_completed nested-metadata N/A canonical payload',
    { type: 'compaction_completed', timestamp: BASE_TIMESTAMP, seq: 7 },
    {
      expectedNormalised: { type: 'compaction_completed', timestamp: BASE_TIMESTAMP, seq: 7 },
      notes: 'No nested metadata object on compaction_completed.',
    },
  ),

  // ---------------------------------------------------------------------------
  // compaction_failed
  // ---------------------------------------------------------------------------
  f(
    'compaction_failed',
    'positive',
    'compaction_failed positive minimal',
    { type: 'compaction_failed', error: 'Compaction failed', depth: 1, timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'compaction_failed', error: 'Compaction failed', depth: 1, timestamp: BASE_TIMESTAMP },
    },
  ),
  f('compaction_failed', 'negative', 'compaction_failed rejects missing error string', {
    type: 'compaction_failed',
    depth: 1,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'compaction_failed',
    'legacy',
    'compaction_failed legacy required fields only',
    { type: 'compaction_failed', error: 'legacy fail', depth: 1, timestamp: BASE_TIMESTAMP - 2 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'compaction_failed',
    'version-skew',
    'compaction_failed accepts seq from newer producer',
    { type: 'compaction_failed', error: 'future fail', depth: 2, timestamp: BASE_TIMESTAMP, seq: 1950 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('compaction_failed', 'extra-keys', 'compaction_failed strips unknown top-level key', {
    type: 'compaction_failed',
    error: 'fail with extras',
    depth: 1,
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'compaction_failed',
    'unknown-variant',
    'unknown variant sentinel for compaction_failed',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'compaction_failed',
    'nested-metadata',
    'compaction_failed nested-metadata N/A canonical payload',
    { type: 'compaction_failed', error: 'no nested object', depth: 2, timestamp: BASE_TIMESTAMP, seq: 7 },
    {
      expectedNormalised: { type: 'compaction_failed', error: 'no nested object', depth: 2, timestamp: BASE_TIMESTAMP, seq: 7 },
      notes: 'No nested metadata object on compaction_failed.',
    },
  ),

  // ---------------------------------------------------------------------------
  // recovery:*
  // ---------------------------------------------------------------------------
  ...recoveryParityFixtures,

  // REBEL-5BM: the new started-non-overflow reason + the backfilled
  // long_context_fallback_failed reason must both round-trip through the
  // recovery:failed schema across both boundary schemas.
  f(
    'recovery:failed',
    'positive',
    'recovery:failed carries agent_loop_error_after_recovery reason',
    {
      type: 'recovery:failed',
      ...makeRecoveryBase(100),
      error: 'Recovery failed: agent_loop_error_after_recovery',
      exhaustedReason: 'agent_loop_error_after_recovery',
    },
    {
      expectedNormalised: {
        type: 'recovery:failed',
        ...makeRecoveryBase(100),
        error: 'Recovery failed: agent_loop_error_after_recovery',
        exhaustedReason: 'agent_loop_error_after_recovery',
      },
    },
  ),
  f(
    'recovery:failed',
    'positive',
    'recovery:failed carries long_context_fallback_failed reason',
    {
      type: 'recovery:failed',
      ...makeRecoveryBase(101),
      error: 'Recovery failed: long_context_fallback_failed',
      exhaustedReason: 'long_context_fallback_failed',
    },
    {
      expectedNormalised: {
        type: 'recovery:failed',
        ...makeRecoveryBase(101),
        error: 'Recovery failed: long_context_fallback_failed',
        exhaustedReason: 'long_context_fallback_failed',
      },
    },
  ),

  // ---------------------------------------------------------------------------
  // turn_superseded
  // ---------------------------------------------------------------------------
  f(
    'turn_superseded',
    'positive',
    'turn_superseded positive minimal',
    { type: 'turn_superseded', newTurnId: 'turn-2', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'turn_superseded', newTurnId: 'turn-2', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('turn_superseded', 'negative', 'turn_superseded rejects missing newTurnId', {
    type: 'turn_superseded',
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'turn_superseded',
    'legacy',
    'turn_superseded legacy required fields only',
    { type: 'turn_superseded', newTurnId: 'turn-legacy', timestamp: BASE_TIMESTAMP - 2 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'turn_superseded',
    'version-skew',
    'turn_superseded accepts seq from newer producer',
    { type: 'turn_superseded', newTurnId: 'turn-skew', timestamp: BASE_TIMESTAMP, seq: 2002 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('turn_superseded', 'extra-keys', 'turn_superseded strips unknown top-level key', {
    type: 'turn_superseded',
    newTurnId: 'turn-extra',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'turn_superseded',
    'unknown-variant',
    'unknown variant sentinel for turn_superseded',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'turn_superseded',
    'nested-metadata',
    'turn_superseded nested-metadata N/A canonical payload',
    { type: 'turn_superseded', newTurnId: 'turn-nested', timestamp: BASE_TIMESTAMP, seq: 8 },
    {
      expectedNormalised: { type: 'turn_superseded', newTurnId: 'turn-nested', timestamp: BASE_TIMESTAMP, seq: 8 },
      notes: 'No nested metadata object on turn_superseded.',
    },
  ),

  // ---------------------------------------------------------------------------
  // user_message
  // ---------------------------------------------------------------------------
  f(
    'user_message',
    'positive',
    'user_message positive minimal',
    { type: 'user_message', text: 'Hello Rebel', isHidden: false, timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'user_message', text: 'Hello Rebel', isHidden: false, timestamp: BASE_TIMESTAMP },
    },
  ),
  f('user_message', 'negative', 'user_message rejects non-string text', {
    type: 'user_message',
    text: 404,
    timestamp: BASE_TIMESTAMP,
  }),
  f(
    'user_message',
    'legacy',
    'user_message legacy without isHidden',
    { type: 'user_message', text: 'Legacy hidden default', timestamp: BASE_TIMESTAMP - 1 },
    { notes: 'Legacy payload omits optional isHidden.' },
  ),
  f(
    'user_message',
    'version-skew',
    'user_message accepts seq from newer producer',
    { type: 'user_message', text: 'Future user message', isHidden: true, timestamp: BASE_TIMESTAMP, seq: 2300 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('user_message', 'extra-keys', 'user_message strips unknown top-level key', {
    type: 'user_message',
    text: 'Message with extras',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'user_message',
    'unknown-variant',
    'unknown variant sentinel for user_message',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'user_message',
    'nested-metadata',
    'user_message nested-metadata N/A canonical payload',
    { type: 'user_message', text: 'No nested object', isHidden: true, timestamp: BASE_TIMESTAMP, seq: 9 },
    {
      expectedNormalised: { type: 'user_message', text: 'No nested object', isHidden: true, timestamp: BASE_TIMESTAMP, seq: 9 },
      notes: 'No nested metadata object on user_message.',
    },
  ),

  // ---------------------------------------------------------------------------
  // turn_started
  // ---------------------------------------------------------------------------
  f(
    'turn_started',
    'positive',
    'turn_started positive minimal',
    { type: 'turn_started', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'turn_started', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('turn_started', 'negative', 'turn_started rejects non-number timestamp', {
    type: 'turn_started',
    timestamp: 'now',
  }),
  f(
    'turn_started',
    'legacy',
    'turn_started legacy required fields only',
    { type: 'turn_started', timestamp: BASE_TIMESTAMP - 1 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'turn_started',
    'version-skew',
    'turn_started accepts seq from newer producer',
    { type: 'turn_started', timestamp: BASE_TIMESTAMP, seq: 2400 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('turn_started', 'extra-keys', 'turn_started strips unknown top-level key', {
    type: 'turn_started',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'turn_started',
    'unknown-variant',
    'unknown variant sentinel for turn_started',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'turn_started',
    'nested-metadata',
    'turn_started nested-metadata N/A canonical payload',
    { type: 'turn_started', timestamp: BASE_TIMESTAMP, seq: 9 },
    {
      expectedNormalised: { type: 'turn_started', timestamp: BASE_TIMESTAMP, seq: 9 },
      notes: 'No nested metadata object on turn_started.',
    },
  ),

  // ---------------------------------------------------------------------------
  // answer_phase_started (260508 Stage 2 — desktop-renderer-IPC-only marker)
  // ---------------------------------------------------------------------------
  f(
    'answer_phase_started',
    'positive',
    'answer_phase_started positive minimal',
    { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP },
    {
      expectedNormalised: { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP },
    },
  ),
  f('answer_phase_started', 'negative', 'answer_phase_started rejects non-number timestamp', {
    type: 'answer_phase_started',
    timestamp: 'now',
  }),
  f(
    'answer_phase_started',
    'legacy',
    'answer_phase_started legacy required fields only',
    { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP - 1 },
    { notes: 'Legacy payload uses required fields only.' },
  ),
  f(
    'answer_phase_started',
    'version-skew',
    'answer_phase_started accepts seq from newer producer',
    { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP, seq: 2400 },
    { notes: 'Version-skew proxy via optional seq.' },
  ),
  f('answer_phase_started', 'extra-keys', 'answer_phase_started strips unknown top-level key', {
    type: 'answer_phase_started',
    timestamp: BASE_TIMESTAMP,
    extraTopLevel: 'strip-me',
  }),
  f(
    'answer_phase_started',
    'unknown-variant',
    'unknown variant sentinel for answer_phase_started',
    UNKNOWN_VARIANT_INPUT,
    { expectedAccept: false },
  ),
  f(
    'answer_phase_started',
    'nested-metadata',
    'answer_phase_started nested-metadata N/A canonical payload',
    { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP, seq: 9 },
    {
      expectedNormalised: { type: 'answer_phase_started', timestamp: BASE_TIMESTAMP, seq: 9 },
      notes: 'No nested metadata object on answer_phase_started.',
    },
  ),
];
