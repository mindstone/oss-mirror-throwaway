import type { ModelProfile } from '@shared/types';
import { getErrorReporter } from '@core/errorReporter';
import type { ConfiguredFallbackRole } from './configuredRoleFallback';
import { assertNever } from '@shared/utils/assertNever';
import {
  ConnectionNotConfiguredError,
  UnsupportedModelError,
} from '@shared/utils/connectionCredentials';
import { brandDirectAnthropicBareWireModel, type WireModelId, type DirectAnthropicBareWireModel } from '@shared/utils/wireModelId';
import type { BillingSource } from '@shared/utils/billingSource';
import { toModelDialect } from '@shared/utils/modelIdClassifier';
import type {
  DispatchableTransport,
  ProviderCredentialSource,
  ProviderModelDialect,
  ProviderRouteProvider,
  ProviderRouteTransport,
  TerminalTransport,
} from '@shared/types/providerRoute';
export { assertNever };
export type {
  DispatchableTransport,
  ProviderCredentialSource,
  ProviderModelDialect,
  ProviderRouteProvider,
  ProviderRouteTransport,
  TerminalTransport,
} from '@shared/types/providerRoute';

export const DISPATCH_PATHS = [
  'direct-provider',
  'local-proxy-route-table',
  'local-proxy-passthrough',
  'none',
] as const;

export type DispatchPath = typeof DISPATCH_PATHS[number];

export type DispatchableDispatchPath = Exclude<DispatchPath, 'none'>;

export class NonDispatchableRoutePlanError extends Error {
  readonly dispatchPath: DispatchPath;

  constructor(dispatchPath: DispatchPath, context?: string) {
    const detail = context ? ` (${context})` : '';
    super(`Dispatch path "${dispatchPath}" is terminal and cannot be executed${detail}`);
    this.name = 'NonDispatchableRoutePlanError';
    this.dispatchPath = dispatchPath;
  }
}

export class RouteTableRuntimeContextError extends Error {
  readonly reason: 'missing-turn-id' | 'missing-routed-model';

  constructor(reason: 'missing-turn-id' | 'missing-routed-model') {
    const message = reason === 'missing-turn-id'
      ? 'Route-table dispatch requires a non-empty turnId'
      : 'Route-table dispatch requires a non-empty routedModel';
    super(message);
    this.name = 'RouteTableRuntimeContextError';
    this.reason = reason;
  }
}

export function isRouteTableScope(scope: ProviderRouteScope): boolean {
  switch (scope) {
    case 'council':
    case 'ad-hoc':
      return true;
    case 'normal-turn':
    case 'retry':
    case 'fallback':
    case 'eval':
      return false;
    default:
      return assertNever(scope, 'ProviderRouteScope in isRouteTableScope');
  }
}

export function deriveDispatchPath(
  transport: ProviderRouteTransport,
  routeScope: ProviderRouteScope,
): DispatchPath {
  switch (transport) {
    case 'anthropic-compatible-local-proxy':
      return isRouteTableScope(routeScope)
        ? 'local-proxy-route-table'
        : 'local-proxy-passthrough';
    case 'codex-proxy':
    case 'openrouter-proxy':
      return 'local-proxy-passthrough';
    case 'anthropic-direct':
    case 'openai-compatible-http':
    case 'local-openai-compatible-http':
      return 'direct-provider';
    case 'no-credentials':
    case 'fail-closed-codex-disconnected':
      return 'none';
    default:
      return assertNever(transport, 'ProviderRouteTransport');
  }
}

export function isProxyDispatch(dispatchPath: DispatchPath): boolean {
  switch (dispatchPath) {
    case 'local-proxy-route-table':
    case 'local-proxy-passthrough':
      return true;
    case 'direct-provider':
    case 'none':
      return false;
    default:
      return assertNever(dispatchPath, 'DispatchPath');
  }
}

export function isRouteTableDispatch(dispatchPath: DispatchPath): boolean {
  switch (dispatchPath) {
    case 'local-proxy-route-table':
      return true;
    case 'local-proxy-passthrough':
    case 'direct-provider':
    case 'none':
      return false;
    default:
      return assertNever(dispatchPath, 'DispatchPath');
  }
}

/**
 * The Anthropic-dialect transports whose `AnthropicClient` is built NON-passthrough
 * (`isOpenRouterPassthrough=false`): `codex-proxy` (`x-codex-turn`),
 * `anthropic-compatible-local-proxy` (no `x-openrouter-turn`), and `anthropic-direct`.
 * A slash-namespaced body model on ANY of these trips the wire guard
 * (`resolveAnthropicWireModel`, anthropicClient.ts:802) with a confusing
 * `invalid_request` mislabelled to the client. The ONLY Anthropic-dialect passthrough
 * transport is `openrouter-proxy` (`x-openrouter-turn`), which is slash-TOLERATED and
 * must NEVER fire this guard.
 */
const NON_PASSTHROUGH_ANTHROPIC_TRANSPORTS: ReadonlySet<string> = new Set([
  'codex-proxy',
  'anthropic-compatible-local-proxy',
  'anthropic-direct',
]);

/** Is `transport` one whose AnthropicClient is built non-passthrough (slash body invalid)? */
export function isNonPassthroughAnthropicTransport(transport: string): boolean {
  return NON_PASSTHROUGH_ANTHROPIC_TRANSPORTS.has(transport);
}

/**
 * Stage 3 class-killer (memory-BTS route mismatch / REBEL-5N8): fail LOUD at the
 * single client-build seam (`createClientFromRoutePlan`) when a non-passthrough
 * Anthropic client would be paired with a slash-namespaced BODY model — instead of
 * letting `resolveAnthropicWireModel` throw a mislabelled `invalid_request` at the
 * wire. Broadens the prior sub-agent-only backstop (agentTool.ts) from
 * `anthropic-compatible-local-proxy` to ALL non-passthrough Anthropic transports
 * and from the sub-agent door to the shared seam (top-level turns, BTS, sub-agents,
 * and any future producer that regresses).
 *
 * CALLERS MUST invoke this AFTER the route-table early-return: route-table dispatch
 * (`local-proxy-route-table`) legitimately carries an alias body model (`'working'`)
 * with the concrete slash backend in `x-routed-model`, validated at the proxy
 * egress — it must NOT reach this guard. Keys on the BODY model exactly like the
 * agentTool backstop. Returns a classified routing Error (`__agentErrorKind:'routing'`)
 * so the caller can `throw` it; returns `null` when the pairing is valid.
 */
export function nonPassthroughAnthropicSlashBodyError(
  transport: string,
  bodyModel: string,
  context: { resolvedModel?: string; door?: string } = {},
): (Error & { __agentErrorKind: 'routing'; __routingCause: string }) | null {
  if (!NON_PASSTHROUGH_ANTHROPIC_TRANSPORTS.has(transport)) return null;
  if (!bodyModel.includes('/')) return null;
  const doorPrefix = context.door ? `${context.door}: ` : '';
  const resolvedSuffix = context.resolvedModel ? ` (resolved model "${context.resolvedModel}")` : '';
  const error = new Error(
    `${doorPrefix}routing mismatch: non-passthrough Anthropic dispatch (transport "${transport}") ` +
    `resolved a foreign body model "${bodyModel}"${resolvedSuffix}. A slash-namespaced id is not valid ` +
    `for a direct-Anthropic-dialect client; the concrete backend belongs in the x-routed-model header ` +
    `(route-table) or requires an OpenRouter-passthrough route.`,
  ) as Error & { __agentErrorKind: 'routing'; __routingCause: string };
  error.__agentErrorKind = 'routing';
  error.__routingCause = 'non-passthrough-anthropic-slash-body';
  return error;
}

export function isDirectDispatch(dispatchPath: DispatchPath): boolean {
  switch (dispatchPath) {
    case 'direct-provider':
      return true;
    case 'local-proxy-route-table':
    case 'local-proxy-passthrough':
    case 'none':
      return false;
    default:
      return assertNever(dispatchPath, 'DispatchPath');
  }
}

function isTerminalDispatchPath(dispatchPath: DispatchPath): dispatchPath is 'none' {
  switch (dispatchPath) {
    case 'none':
      return true;
    case 'direct-provider':
    case 'local-proxy-route-table':
    case 'local-proxy-passthrough':
      return false;
    default:
      return assertNever(dispatchPath, 'DispatchPath');
  }
}

export function assertDispatchableRoutePlan<
  T extends {
    decision: {
      kind: ProviderRouteDecision['kind'];
      dispatchPath: DispatchPath;
    };
  },
>(
  plan: T,
): asserts plan is T {
  switch (plan.decision.kind) {
    case 'dispatchable':
      return;
    case 'terminal':
      throw new NonDispatchableRoutePlanError(
        plan.decision.dispatchPath,
        'assertDispatchableRoutePlan received terminal route decision',
      );
    default:
      throw new Error(`Unhandled ProviderRouteDecision kind in assertDispatchableRoutePlan: ${String(plan.decision.kind)}`);
  }
}

export function assertRouteTableRuntimeContext<
  T extends {
    decision: {
      dispatchPath: DispatchPath;
      routedModel?: string | null;
    };
    runtimeCtx: {
      turnId?: string | null;
      routedModel?: string | null;
    };
  },
>(
  plan: T,
): asserts plan is T & {
  decision: T['decision'] & {
    routedModel: string;
  };
  runtimeCtx: T['runtimeCtx'] & {
    turnId: string;
    routedModel: string;
  };
} {
  if (!isRouteTableDispatch(plan.decision.dispatchPath)) {
    return;
  }
  if (typeof plan.runtimeCtx.turnId !== 'string' || plan.runtimeCtx.turnId.trim().length === 0) {
    throw new RouteTableRuntimeContextError('missing-turn-id');
  }
  if (typeof plan.decision.routedModel !== 'string' || plan.decision.routedModel.trim().length === 0) {
    throw new RouteTableRuntimeContextError('missing-routed-model');
  }
  if (typeof plan.runtimeCtx.routedModel !== 'string' || plan.runtimeCtx.routedModel.trim().length === 0) {
    throw new RouteTableRuntimeContextError('missing-routed-model');
  }
}

export const DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT = {
  anthropic: { 'anthropic-native': 'anthropic-direct' },
  openrouter: {
    'anthropic-native': 'openrouter-proxy',
    'openrouter-prefixed': 'openrouter-proxy',
    'openai-compatible': 'openrouter-proxy',
  },
  codex: { 'anthropic-native': 'anthropic-direct', 'openai-compatible': 'codex-proxy' },
  local: { 'local-openai-compatible': 'local-openai-compatible-http' },
} as const satisfies {
  anthropic: { 'anthropic-native': 'anthropic-direct' };
  openrouter: {
    'anthropic-native': 'openrouter-proxy';
    'openrouter-prefixed': 'openrouter-proxy';
    'openai-compatible': 'openrouter-proxy';
  };
  codex: { 'anthropic-native': 'anthropic-direct'; 'openai-compatible': 'codex-proxy' };
  local: { 'local-openai-compatible': 'local-openai-compatible-http' };
};

export type ProviderRouteRole = 'execution' | 'planning' | 'bts' | 'subagent';

export type ProviderRouteScope = 'normal-turn' | 'council' | 'ad-hoc' | 'retry' | 'fallback' | 'eval';

export type ProviderResolvedFrom =
  | 'settings'
  | 'model-string'
  | 'explicit-profile'
  | 'working-profile'
  | 'bts-model'
  | 'subagent-parent'
  | 'legacy-fallback';

export type CodexConnectivity = 'connected' | 'disconnected' | 'unknown' | 'unsupported';

export type RouteRebuildHint =
  | { kind: 'long-context-profile'; profileId: string }
  | { kind: 'thinking-downgrade'; reason: 'thinking-not-supported' }
  | { kind: 'alt-model'; model: string }
  | {
      kind: 'configured-role-fallback';
      role: ConfiguredFallbackRole;
      target: { kind: 'model'; model: string } | { kind: 'profile'; profileId: string };
      failedModel?: string;
      errorKind?: string;
    }
  | { kind: 'codex-rate-limit-tier'; tier: 'standard' | 'priority' }
  | { kind: 'codex-rate-limit-provider'; forceNonCodexTransport?: true };

export type ProviderFallbackHint = RouteRebuildHint;

export type ProviderInvalidReason =
  | 'missing-anthropic-credentials'
  /**
   * A native-Claude (`claude-*`) model was selected for a PRIMARY user turn while
   * the active provider is a connected ChatGPT Pro (Codex) subscription, but no
   * Anthropic credential exists — so the deliberate `claude-*`→Anthropic divert
   * dead-ends. Distinct from `missing-anthropic-credentials` (which keeps the
   * generic "Anthropic needs a key" terminal for BTS/background/subagent roles —
   * load-bearing for the 260501 auto-title fix) so the renderer can offer an
   * actionable "switch to a GPT model" recovery instead of a misleading
   * "Anthropic not connected" dead-end. See FOX-3494.
   */
  | 'missing-anthropic-credentials-for-claude-model'
  | 'missing-openrouter-credentials'
  | 'missing-mindstone-credentials'
  | 'missing-codex-connection'
  | 'missing-profile-credentials'
  | 'codex-disconnected-bts-blocked'
  | 'codex-unsupported-model'
  | 'proxy-dialect-in-direct-anthropic'
  | 'none';

export type ProviderRouteInvalidReason = Exclude<ProviderInvalidReason, 'none'>;

/**
 * Shared identity/scope fields for ProviderRouteDecision arms.
 *
 * Use `kind` on the concrete arms as the canonical discriminator; see
 * docs/project/boundary-registry.yaml for the routing boundary contract.
 */
export interface ProviderRouteDecisionBase {
  provider: ProviderRouteProvider;
  modelDialect: ProviderModelDialect;
  role: ProviderRouteRole;
  routeScope: ProviderRouteScope;
  routedModel?: string | null;
  canonicalModelId: string;
  wireModelId: WireModelId;
  profileId: string | null;
  resolvedFrom: ProviderResolvedFrom;
  codexConnectivity: CodexConnectivity;
  fallbackHint: RouteRebuildHint | null;
  credentialSource: ProviderCredentialSource;
  /**
   * Provenance-only "who pays" classification, derived ONCE from
   * `credentialSource` when the decision is built (see
   * `billingSourceForCredentialSource` in providerBillingSource.ts). Distinct axis
   * from `credentialSource` (which names the credential channel) — see that mapper
   * for the non-1:1 rationale. Optional + additive (WS1a): production decisions
   * always populate it; `null` for terminal/missing routes (no billing identity).
   * Nothing consumes it yet — it's for WS1b's proxy billing re-decision and the
   * observability surface.
   */
  billingSource?: BillingSource | null;
}

/**
 * Dispatchable route decision arm. `kind: 'dispatchable'` guarantees the
 * dispatch path and transport can be executed.
 */
export interface DispatchableRouteDecision extends ProviderRouteDecisionBase {
  kind: 'dispatchable';
  /** Wire dialect axis; dispatch membership is encoded by `dispatchPath` (see docs/project/boundary-registry.yaml). */
  transport: DispatchableTransport;
  /** Dispatch-routing axis orthogonal to `transport`; use this for proxy vs direct routing decisions. */
  dispatchPath: DispatchableDispatchPath;
  invalidReason: 'none';
}

/**
 * Terminal route decision arm. `kind: 'terminal'` guarantees this decision must
 * not enter dispatch and carries a non-`none` invalid reason.
 */
export interface TerminalRouteDecision extends ProviderRouteDecisionBase {
  kind: 'terminal';
  transport: TerminalTransport;
  dispatchPath: 'none';
  invalidReason: ProviderRouteInvalidReason;
}

export type ProviderRouteDecision = DispatchableRouteDecision | TerminalRouteDecision;

export function isDispatchableDecision(
  decision: ProviderRouteDecision,
): decision is DispatchableRouteDecision {
  return decision.kind === 'dispatchable';
}

export function isTerminalDecision(
  decision: ProviderRouteDecision,
): decision is TerminalRouteDecision {
  return decision.kind === 'terminal';
}

export function isRecoverableTerminalReason(reason: ProviderRouteInvalidReason): boolean {
  switch (reason) {
    case 'missing-anthropic-credentials':
    case 'missing-anthropic-credentials-for-claude-model':
    case 'missing-openrouter-credentials':
    case 'missing-mindstone-credentials':
    case 'missing-codex-connection':
    case 'missing-profile-credentials':
    case 'codex-disconnected-bts-blocked':
    case 'codex-unsupported-model':
      return true;
    case 'proxy-dialect-in-direct-anthropic':
      return false;
    default:
      return assertNever(reason, 'ProviderRouteInvalidReason');
  }
}

export function buildTerminalReconnectMessage(
  decision: TerminalRouteDecision,
): { message: string; provider: string } {
  switch (decision.invalidReason) {
    case 'missing-anthropic-credentials':
      return {
        provider: 'Anthropic',
        message: 'Anthropic needs an API key. Add it in Settings to continue.',
      };
    case 'missing-anthropic-credentials-for-claude-model':
      // Honest, model-aware attribution: the user is on ChatGPT Pro but picked a
      // Claude model that runs on Anthropic (not connected). The renderer
      // (classifyErrorUx) leads with a "switch to a GPT model" action; this
      // message is the fallback body for non-classified surfaces.
      return {
        provider: 'ChatGPT Pro',
        message: `You're connected to ChatGPT Pro, but the selected model — ${decision.wireModelId ?? 'this model'} — runs on Anthropic, which isn't connected. Your message is safe.`,
      };
    case 'missing-openrouter-credentials':
      return {
        provider: 'OpenRouter',
        message: 'OpenRouter needs reconnecting. Sign in again in Settings to continue.',
      };
    case 'missing-mindstone-credentials':
      return {
        provider: 'Mindstone',
        message: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
      };
    case 'missing-codex-connection':
    case 'codex-disconnected-bts-blocked':
      return {
        provider: 'ChatGPT Pro',
        message: 'ChatGPT Pro needs reconnecting. Sign in again in Settings to continue.',
      };
    case 'missing-profile-credentials':
      return {
        provider: 'Profile',
        message: 'This profile is missing a working API key. Add or update it in Settings to continue.',
      };
    case 'codex-unsupported-model':
      return {
        provider: 'ChatGPT Pro',
        message: `ChatGPT Pro doesn't support ${decision.wireModelId ?? 'this model'}. Pick a different model in Settings.`,
      };
    case 'proxy-dialect-in-direct-anthropic':
      throw new Error('buildTerminalReconnectMessage called for non-recoverable reason');
    default:
      return assertNever(decision.invalidReason, 'ProviderRouteInvalidReason');
  }
}

/**
 * FOX-3494: single mapper from a *recoverable* terminal route decision to the
 * thrown/dispatched error class, so every producer of a recoverable terminal
 * error agrees on the class AND the structured detail. Before this, three sites
 * (createClient at clientFactory.ts, buildSdkQueryOptions invariant at
 * agentTurnExecute.ts, and the configured-role fallback at turnErrorRecovery.ts)
 * each hand-built the error — and the fallback site dropped the
 * `missing-anthropic-credentials-for-claude-model` detail, silently losing the
 * "switch to a GPT model" recovery (round-2 regression review F1 / correctness F3).
 *
 * Keeps the established class contract: `codex-unsupported-model` →
 * `UnsupportedModelError`; `missing-anthropic-credentials-for-claude-model` →
 * `ConnectionNotConfiguredError` carrying `{ invalidReason, wireModel, failedRole }`
 * so the renderer (classifyErrorUx) leads with the role-aware switch-to-GPT action
 * and the IPC handler repairs the correct settings slot; every other recoverable
 * reason → a bare `ConnectionNotConfiguredError` (unchanged).
 *
 * Caller precondition: `isRecoverableTerminalReason(decision.invalidReason)` is
 * true (callers handle non-recoverable reasons — e.g. proxy-dialect — first).
 */
export function buildRecoverableTerminalRouteError(
  decision: TerminalRouteDecision,
): ConnectionNotConfiguredError | UnsupportedModelError {
  const { message, provider } = buildTerminalReconnectMessage(decision);
  if (decision.invalidReason === 'codex-unsupported-model') {
    return new UnsupportedModelError(message, decision.wireModelId, provider);
  }
  if (decision.invalidReason === 'missing-anthropic-credentials-for-claude-model') {
    return new ConnectionNotConfiguredError(message, provider, {
      invalidReason: decision.invalidReason,
      wireModel: decision.wireModelId,
      failedRole: decision.role,
    });
  }
  // Generic "Anthropic key missing" terminal: carry the same structured detail
  // (additive — inert for the existing copy) so classifyErrorUx can offer a
  // "Use <profile>" recovery when a selectable profile serves this model, e.g. a
  // custom OpenAI-compatible gateway proxying it for an Anthropic-no-key user.
  if (decision.invalidReason === 'missing-anthropic-credentials') {
    return new ConnectionNotConfiguredError(message, provider, {
      invalidReason: decision.invalidReason,
      wireModel: decision.wireModelId,
      failedRole: decision.role,
    });
  }
  return new ConnectionNotConfiguredError(message, provider);
}

export class MalformedRouteDecisionError extends Error {
  readonly reason: string;
  readonly value: unknown;

  constructor(reason: string, value: unknown) {
    super(`Malformed ProviderRouteDecision: ${reason}`);
    this.name = 'MalformedRouteDecisionError';
    this.reason = reason;
    this.value = value;
  }
}

const DISPATCHABLE_TRANSPORTS: ReadonlySet<ProviderRouteTransport> = new Set([
  'anthropic-direct',
  'anthropic-compatible-local-proxy',
  'openai-compatible-http',
  'local-openai-compatible-http',
  'codex-proxy',
  'openrouter-proxy',
]);

const TERMINAL_TRANSPORTS: ReadonlySet<ProviderRouteTransport> = new Set([
  'no-credentials',
  'fail-closed-codex-disconnected',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedRouteDecision(reason: string, value: unknown): never {
  throw new MalformedRouteDecisionError(reason, value);
}

export function validateRouteDecisionShape(value: unknown): asserts value is ProviderRouteDecision {
  if (!isRecord(value)) {
    malformedRouteDecision('expected object', value);
  }

  const { kind, dispatchPath, transport, invalidReason } = value;
  if (kind !== 'dispatchable' && kind !== 'terminal') {
    malformedRouteDecision('kind must be "dispatchable" or "terminal"', value);
  }
  if (!DISPATCH_PATHS.includes(dispatchPath as DispatchPath)) {
    malformedRouteDecision('dispatchPath must be a known DispatchPath', value);
  }
  if (typeof transport !== 'string') {
    malformedRouteDecision('transport must be a string', value);
  }
  if (typeof invalidReason !== 'string') {
    malformedRouteDecision('invalidReason must be a string', value);
  }

  switch (kind) {
    case 'dispatchable':
      if (isTerminalDispatchPath(dispatchPath as DispatchPath)) {
        malformedRouteDecision('dispatchable decisions cannot use dispatchPath "none"', value);
      }
      if (!DISPATCHABLE_TRANSPORTS.has(transport as ProviderRouteTransport)) {
        malformedRouteDecision('dispatchable decisions require a dispatchable transport', value);
      }
      if (invalidReason !== 'none') {
        malformedRouteDecision('dispatchable decisions require invalidReason "none"', value);
      }
      return;
    case 'terminal':
      if (!isTerminalDispatchPath(dispatchPath as DispatchPath)) {
        malformedRouteDecision('terminal decisions require dispatchPath "none"', value);
      }
      if (!TERMINAL_TRANSPORTS.has(transport as ProviderRouteTransport)) {
        malformedRouteDecision('terminal decisions require a terminal transport', value);
      }
      if (invalidReason === 'none') {
        malformedRouteDecision('terminal decisions require a non-"none" invalidReason', value);
      }
      return;
    default:
      return assertNever(kind, 'ProviderRouteDecision.kind');
  }
}

/**
 * Strip credential-bearing fields from a route decision before sending it to
 * Sentry. Defense in depth: the `credentialSource` enum already encodes only
 * categorical labels (no raw tokens), but we replace the value with the field
 * label so any future widening of the enum cannot leak an unexpected payload.
 */
export function sanitizeDecisionForCapture(decision: ProviderRouteDecision): Record<string, unknown> {
  return {
    kind: decision.kind,
    transport: decision.transport,
    dispatchPath: decision.dispatchPath,
    invalidReason: decision.invalidReason,
    provider: decision.provider,
    role: decision.role,
    routeScope: decision.routeScope,
    modelDialect: decision.modelDialect,
    canonicalModelId: decision.canonicalModelId,
    wireModelId: decision.wireModelId,
    profileId: decision.profileId,
    resolvedFrom: decision.resolvedFrom,
    codexConnectivity: decision.codexConnectivity,
    fallbackHint: decision.fallbackHint,
    credentialSource: '<credential-source-redacted>',
    // Categorical billing axis (subscription/pool/pay-per-use/local) — no raw
    // token material, safe to capture.
    billingSource: decision.billingSource ?? null,
  };
}

export function captureRouteInvariantBreach(
  decision: ProviderRouteDecision,
  message: string,
  options?: { subInvariant?: string },
): void {
  getErrorReporter().captureExceptionWithScope?.(
    new Error(message),
    (scope) => {
      scope.setTag('area', 'routing');
      scope.setTag('invariant', 'dispatchable-narrow');
      scope.setTag('subInvariant', options?.subInvariant ?? 'narrow-breached');
      scope.setContext('decision', sanitizeDecisionForCapture(decision));
    },
  );
}

export type ProviderRouteHeaderTuple = readonly [string, string];
export type ProviderRouteHeaderTuples = ReadonlyArray<ProviderRouteHeaderTuple>;

export function isProfileReference(model: string): boolean {
  return model.startsWith('profile:');
}

export function profileReferenceId(model: string): string | null {
  return isProfileReference(model) ? model.slice('profile:'.length) : null;
}

export function getProfileModel(profile: ModelProfile, fallbackModel: string): string {
  const model = profile.model?.trim();
  return model && model.length > 0 ? model : fallbackModel;
}

export function isLocalhostUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(url);
}

export function inferModelDialect(model: string, profile: ModelProfile | null): ProviderModelDialect {
  // Profile-driven branches STAY here — they read `profile`/`serverUrl`, not id
  // syntax. Only the bare-id arms (when `profile` is null) delegate to the
  // centralized `toModelDialect`, whose result widens into ProviderModelDialect.
  if (profile?.providerType === 'local' || (profile && isLocalhostUrl(profile.serverUrl))) {
    return 'local-openai-compatible';
  }
  if (profile?.providerType === 'anthropic') {
    return 'anthropic-native';
  }
  if (profile) {
    return 'profile-ref';
  }
  return toModelDialect(model);
}

export function stripAnthropicProviderPrefix(model: string): string {
  return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
}

export type DirectAnthropicModelResolution =
  | {
      kind: 'native-claude';
      inputModel: string;
      wireModel: DirectAnthropicBareWireModel;
    }
  | {
      kind: 'bare-non-claude';
      inputModel: string;
      wireModel: DirectAnthropicBareWireModel;
    }
  | {
      kind: 'foreign-dialect';
      inputModel: string;
      invalidReason: 'proxy-dialect-in-direct-anthropic';
    };

/**
 * THE single normalization chokepoint for direct-Anthropic routing. Every direct-Anthropic
 * route arm (active-provider, profile-Anthropic, Codex-divert) MUST resolve through this —
 * enforced by `scripts/check-direct-anthropic-route-chokepoint.ts`. Killing the
 * `direct_anthropic_dialect_normalization` recurring bug class (4× over time) by construction:
 * the three arms can no longer drift apart on how they handle the `anthropic/` dialect prefix.
 *
 * Semantics (see the truth-table in `providerRouteDecision.test.ts`):
 * - Strips exactly one matching `anthropic/` self-prefix → `kind:'native-claude'` with a bare,
 *   branded `wireModel` (`anthropic/claude-haiku-4-5` → `claude-haiku-4-5`). Strip-only — no
 *   dotted-alias normalization (preserves historical `brandRouteWireModel(strip(...))` behaviour).
 * - Slash-bearing foreign / nested / non-Claude ids (`openai/…`, `deepseek/…`,
 *   `anthropic/anthropic/…`, `anthropic/not-claude`) → `kind:'foreign-dialect'` (fail closed as
 *   `proxy-dialect-in-direct-anthropic`). The native-Claude-shape check is why a bare
 *   `anthropic/foo` is rejected rather than 404'ing at the wire.
 * - Bare ids (no slash) → wire unchanged. `claude-*` resolves as `kind:'native-claude'`;
 *   other bare ids resolve as `kind:'bare-non-claude'`, so the Codex arm can divert only Claude.
 */
export function resolveDirectAnthropicModel(model: string): DirectAnthropicModelResolution {
  const stripped = stripAnthropicProviderPrefix(model);
  const isNativeClaude = stripped.startsWith('claude-') && !stripped.includes('/');

  if (model.includes('/') && !isNativeClaude) {
    return {
      kind: 'foreign-dialect',
      inputModel: model,
      invalidReason: 'proxy-dialect-in-direct-anthropic',
    };
  }

  return {
    kind: isNativeClaude ? 'native-claude' : 'bare-non-claude',
    inputModel: model,
    wireModel: brandDirectAnthropicBareWireModel(stripped),
  };
}

export function isNativeAnthropicModel(model: string): boolean {
  return stripAnthropicProviderPrefix(model).startsWith('claude-') && !model.includes('/');
}
