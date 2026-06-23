import { vi } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';

/**
 * Guards mocked module export names only. This catches renamed/removed exports,
 * not value semantics or function signatures.
 */
type ModuleExportNameGuard<TModule> = Partial<Record<keyof TModule, unknown>>;

type BroadcastServiceModuleMock = ModuleExportNameGuard<typeof import('@core/broadcastService')>;
type ModelNormalizationMock = ModuleExportNameGuard<typeof import('@shared/utils/modelNormalization')>;

export interface ModelNormalizationMockDeps {
  resolveModelConfigMock: ReturnType<typeof vi.fn>;
}

export interface BroadcastServiceMockOptions {
  sendToAllWindows?: BroadcastService['sendToAllWindows'];
  sendToFocusedWindow?: BroadcastService['sendToFocusedWindow'];
  getBroadcastService?: () => BroadcastService;
  setBroadcastService?: (service: BroadcastService) => void;
}

export function createBroadcastServiceMock(options: BroadcastServiceMockOptions = {}) {
  const service = {
    sendToAllWindows: options.sendToAllWindows ?? vi.fn(),
    sendToFocusedWindow: options.sendToFocusedWindow ?? vi.fn(),
  } satisfies BroadcastService;

  return {
    getBroadcastService: options.getBroadcastService ?? vi.fn(() => service),
    setBroadcastService: options.setBroadcastService ?? vi.fn(),
  } satisfies BroadcastServiceModuleMock;
}

// Mirror production decodeRoutingModelId (src/shared/utils/modelChoiceCodec.ts):
// `model:<id>` strips the prefix; bare ids pass through; `profile:<id>` is
// rejected (returns null) because a profile ref is not a bare routing model id.
function decodeRoutingModelIdLike(value: string): string | null {
  if (value.startsWith('profile:')) return null;
  if (value.startsWith('model:')) {
    const stripped = value.slice('model:'.length).trim();
    return stripped || null;
  }
  return value;
}

/**
 * Neutral mock for `@shared/utils/modelNormalization`. The base object stubs the
 * commonly-needed exports; pass `overrides` for anything a specific test exercises.
 *
 * Note: the base mock intentionally does NOT define every export. In particular,
 * tests that drive the thinking-model-unavailability fallback path must override
 * both `isThinkingModelUnavailableError: () => true` AND `getModelDisplayName`
 * (the real fallback formats the user-facing message via `getModelDisplayName`,
 * which is undefined here unless supplied) — otherwise the consumer reads
 * `undefined` for that export and the path misbehaves silently.
 */
export function createModelNormalizationMock(
  f: ModelNormalizationMockDeps,
  overrides: ModelNormalizationMock = {},
) {
  const mock = {
    resolveModelConfig: f.resolveModelConfigMock,
    DEFAULT_AUXILIARY_MODEL: 'claude-haiku-4-5',
    MODEL_OPTIONS: [],
    stripExtendedContextFromConfig: vi.fn((cfg: unknown) => cfg),
    isExtendedContextUnavailableError: vi.fn(() => false),
    isThinkingModelUnavailableError: vi.fn(() => false),
    downgradeThinkingModelConfig: vi.fn((cfg: unknown) => cfg),
    ENV_THINKING_MODEL: 'PLANNING_MODEL',
    ENV_EXECUTION_MODEL: 'EXECUTION_MODEL',
    normalizeModel: vi.fn((model: string) => model),
    modelSupportsExtendedContext: vi.fn(() => false),
    PREFERRED_PLANNING_MODEL: 'claude-opus-4-8',
    FALLBACK_PLANNING_MODEL: 'claude-sonnet-4-6',
    PLAN_MODE_ALIAS: 'planner',
    getModelEffort: vi.fn(() => undefined),
    // REBEL-655: mirror the real precedence (override -> profile model -> setting),
    // normalizing falsy/whitespace to null. NEVER a Claude sentinel.
    resolvePlanningThinkingModel: vi.fn((args: {
      thinkingModelOverride: string | undefined;
      thinkingProfileModel: string | null | undefined;
      settingsThinkingModel: string | null | undefined;
    }) => {
      const normalize = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
      if (args.thinkingModelOverride !== undefined) return normalize(args.thinkingModelOverride);
      return normalize(args.thinkingProfileModel) ?? normalize(args.settingsThinkingModel);
    }),
    // Stage 1: the typed plan-mode target accessor. Mirrors the real precedence,
    // collapses to null when thinking is empty or equals the working model, else
    // brands the thinking model into a PlanModeTarget.
    resolvePlanModeTarget: vi.fn((args: {
      workingModel: string;
      thinkingModelOverride: string | undefined;
      thinkingProfileModel: string | null | undefined;
      settingsThinkingModel: string | null | undefined;
    }) => {
      const normalize = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
      const thinking = args.thinkingModelOverride !== undefined
        ? normalize(args.thinkingModelOverride)
        : (normalize(args.thinkingProfileModel) ?? normalize(args.settingsThinkingModel));
      if (!thinking || thinking === args.workingModel) return null;
      // Mirror production: thinking model goes through decodeRoutingModelId, which
      // rejects profile-encoded values (only bare/`model:`-prefixed ids brand).
      const decoded = decodeRoutingModelIdLike(thinking);
      if (!decoded) return null;
      return { thinkingModel: decoded };
    }),
    planModeTargetFromThinkingModel: vi.fn((thinkingModel: string | null | undefined, workingModel: string) => {
      const trimmed = thinkingModel?.trim();
      if (!trimmed || trimmed === workingModel) return null;
      // Mirror production (modelNormalization.planModeTargetFromThinkingModel):
      // route through decodeRoutingModelId so `profile:*` is rejected.
      const decoded = decodeRoutingModelIdLike(trimmed);
      if (!decoded) return null;
      return { thinkingModel: decoded };
    }),
  } satisfies ModelNormalizationMock;
  return {
    ...mock,
    ...overrides,
  } satisfies ModelNormalizationMock;
}
