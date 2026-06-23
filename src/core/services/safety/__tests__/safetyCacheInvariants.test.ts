import { describe, it, expect } from 'vitest';

import {
  buildNormalizedToolKey,
  getMemoizationStrategy,
  SAFETY_CACHE_MEMOIZATION_STRATEGIES,
  type BuildNormalizedToolKeyArgs,
  type SafetyCacheStrategyFamily,
} from '../toolNormalizationKeys';

type FieldMutator = (args: BuildNormalizedToolKeyArgs) => BuildNormalizedToolKeyArgs;

interface StrategyFixture {
  base: BuildNormalizedToolKeyArgs;
  mutateField: Record<string, FieldMutator>;
}

function cloneArgs(args: BuildNormalizedToolKeyArgs): BuildNormalizedToolKeyArgs {
  return {
    ...args,
    toolInput: JSON.parse(JSON.stringify(args.toolInput)) as unknown,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function setNestedArgsField(
  args: BuildNormalizedToolKeyArgs,
  field: string,
  value: unknown,
): BuildNormalizedToolKeyArgs {
  const next = cloneArgs(args);
  if (!isRecord(next.toolInput) || !isRecord(next.toolInput.args)) {
    throw new Error(`Fixture for ${args.toolName} does not have nested args`);
  }
  next.toolInput.args[field] = value;
  return next;
}

function setToolInputField(
  args: BuildNormalizedToolKeyArgs,
  field: string,
  value: unknown,
): BuildNormalizedToolKeyArgs {
  const next = cloneArgs(args);
  if (!isRecord(next.toolInput)) {
    throw new Error(`Fixture for ${args.toolName} does not have object toolInput`);
  }
  next.toolInput[field] = value;
  return next;
}

function addVolatileField(args: BuildNormalizedToolKeyArgs): BuildNormalizedToolKeyArgs {
  const next = cloneArgs(args);
  if (isRecord(next.toolInput)) {
    next.toolInput._rebel_staged = true;
    if (isRecord(next.toolInput.args)) {
      next.toolInput.args._rebel_staged = true;
    }
  }
  return next;
}

const fixtures: Record<SafetyCacheStrategyFamily, StrategyFixture> = {
  file_write: {
    base: {
      toolName: 'Write',
      effectiveToolId: 'Write',
      packageId: undefined,
      toolInput: { file_path: '/work/file.md', file_text: 'safe content' },
    },
    mutateField: {},
  },
  bash: {
    base: {
      toolName: 'Bash',
      effectiveToolId: 'Bash',
      packageId: undefined,
      toolInput: { command: 'echo hello', cwd: '/work/a' },
    },
    mutateField: {
      command: (args) => setToolInputField(args, 'command', 'echo goodbye'),
      cwd: (args) => setToolInputField(args, 'cwd', '/work/b'),
    },
  },
  image_generation: {
    base: {
      toolName: 'OpenAIImageGeneration__generate_image',
      effectiveToolId: 'OpenAIImageGeneration__generate_image',
      packageId: undefined,
      toolInput: {
        prompt: 'a quiet desk',
        model: 'dall-e-3',
        aspect_ratio: '1:1',
        quality: 'standard',
        moderation: 'auto',
        n: 1,
      },
    },
    mutateField: {
      prompt: (args) => setToolInputField(args, 'prompt', 'a busy train station'),
      model: (args) => setToolInputField(args, 'model', 'gpt-image-1'),
      size: (args) => setToolInputField(args, 'size', '512x512'),
      aspect_ratio: (args) => setToolInputField(args, 'aspect_ratio', '16:9'),
      quality: (args) => setToolInputField(args, 'quality', 'hd'),
      moderation: (args) => setToolInputField(args, 'moderation', 'low'),
      count: (args) => setToolInputField(args, 'n', 4),
    },
  },
  send_message: {
    base: {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'slack_send_message',
      packageId: 'Slack',
      toolInput: { args: { channel_id: 'C1', message_text: 'hello team' } },
    },
    mutateField: {
      channel: (args) => setNestedArgsField(args, 'channel_id', 'C2'),
      message_text: (args) => setNestedArgsField(args, 'message_text', 'stand down'),
    },
  },
  send_email: {
    base: {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'send_workspace_email',
      packageId: 'GoogleWorkspace',
      toolInput: {
        args: {
          to: ['a@example.com'],
          subject: 'Quarterly update',
          body: 'The attached numbers are ready.',
        },
      },
    },
    mutateField: {
      recipients: (args) => setNestedArgsField(args, 'to', ['b@example.com']),
      subject: (args) => setNestedArgsField(args, 'subject', 'Wire instructions'),
      body: (args) => setNestedArgsField(args, 'body', 'Wire the funds today.'),
    },
  },
  create_calendar_event: {
    base: {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'create_calendar_event',
      packageId: 'GoogleWorkspace',
      toolInput: {
        args: {
          calendar_id: 'primary',
          start_time: '2026-05-26T15:00:00Z',
          attendees: ['a@example.com'],
        },
      },
    },
    mutateField: {
      calendar_id: (args) => setNestedArgsField(args, 'calendar_id', 'team'),
      start_time: (args) => setNestedArgsField(args, 'start_time', '2026-05-26T15:01:00Z'),
      attendees: (args) => setNestedArgsField(args, 'attendees', ['b@example.com']),
    },
  },
  mcp_router: {
    base: {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'unknown_action',
      packageId: 'SomePkg',
      toolInput: {
        package_id: 'SomePkg',
        tool_id: 'unknown_action',
        args: { payload: 'one' },
      },
    },
    mutateField: {
      packageId: (args) => ({ ...cloneArgs(args), packageId: 'OtherPkg' }),
      tool_id: (args) => setToolInputField(args, 'tool_id', 'other_action'),
      canonical_args: (args) => setNestedArgsField(args, 'payload', 'two'),
    },
  },
  default: {
    base: {
      toolName: 'SomeMysteryTool',
      effectiveToolId: 'SomeMysteryTool',
      packageId: undefined,
      toolInput: { payload: 'one' },
    },
    mutateField: {
      toolName: (args) => ({
        ...cloneArgs(args),
        toolName: 'SomeOtherMysteryTool',
        effectiveToolId: 'SomeOtherMysteryTool',
      }),
      canonical_args: (args) => setToolInputField(args, 'payload', 'two'),
    },
  },
};

describe('safety cache memoization strategy invariants', () => {
  it('declares each strategy family once', () => {
    const families = SAFETY_CACHE_MEMOIZATION_STRATEGIES.map((strategy) => strategy.family);
    expect(new Set(families).size).toBe(families.length);
  });

  it('dispatches every fixture through its declared strategy', () => {
    for (const strategy of SAFETY_CACHE_MEMOIZATION_STRATEGIES) {
      const fixture = fixtures[strategy.family];
      expect(getMemoizationStrategy(fixture.base).family).toBe(strategy.family);
      expect(buildNormalizedToolKey(fixture.base)).toBe(
        strategy.memoizable ? strategy.buildKey(fixture.base) : null,
      );
    }
  });

  it('changes the key when any declared side-effect field changes', () => {
    const memoizableStrategies = SAFETY_CACHE_MEMOIZATION_STRATEGIES.filter(
      (strategy) => strategy.memoizable,
    );

    for (const strategy of memoizableStrategies) {
      const fixture = fixtures[strategy.family];
      const baseKey = strategy.buildKey(fixture.base);
      const baseNormalizedKey = buildNormalizedToolKey(fixture.base);
      expect(baseKey, `${strategy.family} base key`).not.toBeNull();
      expect(baseNormalizedKey, `${strategy.family} normalized base key`).toBe(baseKey);

      for (const sideEffectField of strategy.sideEffectFields) {
        const mutate = fixture.mutateField[sideEffectField];
        expect(mutate, `${strategy.family}.${sideEffectField} fixture`).toBeTypeOf('function');
        const changedArgs = mutate(fixture.base);
        const changedKey = strategy.buildKey(changedArgs);
        expect(changedKey, `${strategy.family}.${sideEffectField} changed key`).not.toBeNull();
        expect(changedKey, `${strategy.family}.${sideEffectField}`).not.toBe(baseKey);
        expect(buildNormalizedToolKey(changedArgs), `${strategy.family}.${sideEffectField}`).toBe(
          changedKey,
        );
      }
    }
  });

  it('does not change keys for volatile staging fields', () => {
    const memoizableStrategies = SAFETY_CACHE_MEMOIZATION_STRATEGIES.filter(
      (strategy) => strategy.memoizable,
    );

    for (const strategy of memoizableStrategies) {
      const fixture = fixtures[strategy.family];
      expect(strategy.buildKey(addVolatileField(fixture.base))).toBe(
        strategy.buildKey(fixture.base),
      );
    }
  });

  it('never memoizes non-memoizable tool families', () => {
    const nonMemoizableStrategies = SAFETY_CACHE_MEMOIZATION_STRATEGIES.filter(
      (strategy) => !strategy.memoizable,
    );

    for (const strategy of nonMemoizableStrategies) {
      const fixture = fixtures[strategy.family];
      expect(strategy.sideEffectFields, `${strategy.family} sideEffectFields`).toEqual([]);

      // The fixture base must dispatch to this strategy and never memoize. This
      // covers families matched by effectiveToolId/family (send_email, calendar)
      // which the toolName-override loop below would mis-dispatch.
      expect(getMemoizationStrategy(fixture.base).family, `${strategy.family} dispatch`).toBe(
        strategy.family,
      );
      expect(strategy.buildKey(fixture.base), `${strategy.family} strategy key`).toBeNull();
      expect(buildNormalizedToolKey(fixture.base), `${strategy.family} normalized key`).toBeNull();

      // Families matched by tool name (file writes) must be null for EVERY name.
      for (const toolName of strategy.toolNames ?? []) {
        const args = { ...fixture.base, toolName, effectiveToolId: toolName };
        expect(strategy.buildKey(args), `${toolName} strategy key`).toBeNull();
        expect(buildNormalizedToolKey(args), `${toolName} normalized key`).toBeNull();
      }
    }
  });

  // Precedence locks (behavioral-safety-adjacent — the postmortem's risk is a
  // higher-precedence rule being silently shadowed). The committed suite now
  // pins the two order-sensitive cases the external differential found.
  it('file-write tools win over a matching family pattern (NO_MEMOIZE precedence)', () => {
    // A write tool whose effectiveToolId ALSO looks like a memoizable family
    // (e.g. an image-gen id) must still resolve to file_write → null.
    const args = {
      toolName: 'Write',
      effectiveToolId: 'openai_generate_image',
      packageId: undefined,
      toolInput: { prompt: 'x', file_path: '/x.png' },
    };
    expect(getMemoizationStrategy(args).family).toBe('file_write');
    expect(buildNormalizedToolKey(args)).toBeNull();
  });

  it('a family-matching effectiveToolId wins over the generic mcp_router fallback', () => {
    // slack_send_message via the router resolves to send_message, NOT mcp_router.
    const args = {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId: 'slack_send_message',
      packageId: 'Slack',
      toolInput: { args: { channel_id: 'C1', message_text: 'hi' } },
    };
    expect(getMemoizationStrategy(args).family).toBe('send_message');
  });

  // Email-send detection completeness (re-review F1): provider variants beyond
  // Gmail (Microsoft Mail `send_email`/`email_send`, `forward_email`) must resolve
  // to the non-memoizable send_email strategy, not fall through to a memoizing one.
  it.each([
    ['send_email'],
    ['email_send'],
    ['forward_email'],
    ['send_workspace_email'],
    ['gmail_send_message'],
  ])('treats email-send id %s as non-memoizable send_email', (effectiveToolId) => {
    const args = {
      toolName: 'mcp__super-mcp-router__use_tool',
      effectiveToolId,
      packageId: 'Email',
      toolInput: { args: { to: ['a@example.com'], subject: 'S', body: 'B' } },
    };
    expect(getMemoizationStrategy(args).family).toBe('send_email');
    expect(buildNormalizedToolKey(args)).toBeNull();
  });
});
