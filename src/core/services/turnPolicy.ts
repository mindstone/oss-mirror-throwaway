import type { SessionType } from '@core/services/promptTemplateService';
import type { TurnPolicy } from '@core/types/turnPolicy';
import { AUTOMATION_HARD_CEILING_MS } from '@core/services/turnPipeline/watchdogConstants';

const INTERACTIVE_POLICY: Readonly<TurnPolicy> = Object.freeze({
  prefetchUrls: true,
  semanticContext: 'sync',
  autoInjectPastConversations: true,
  watchdogHardCeilingMs: null,
  watchdogAbortsDuringApprovalWait: false,
  lane: 'foreground',
  promptSessionMode: 'interactive',
  origin: 'manual',
});

const AUTOMATION_POLICY: Readonly<TurnPolicy> = Object.freeze({
  prefetchUrls: false,
  semanticContext: 'off',
  autoInjectPastConversations: false,
  watchdogHardCeilingMs: AUTOMATION_HARD_CEILING_MS,
  watchdogAbortsDuringApprovalWait: true,
  lane: 'background',
  promptSessionMode: 'automation',
  origin: 'automation',
});

const CLI_POLICY: Readonly<TurnPolicy> = Object.freeze({
  prefetchUrls: true,
  semanticContext: 'sync',
  autoInjectPastConversations: true,
  watchdogHardCeilingMs: null,
  watchdogAbortsDuringApprovalWait: false,
  lane: 'foreground',
  promptSessionMode: 'cli',
  origin: 'manual',
});

const MCP_SERVER_POLICY: Readonly<TurnPolicy> = Object.freeze({
  prefetchUrls: true,
  semanticContext: 'sync',
  autoInjectPastConversations: true,
  watchdogHardCeilingMs: null,
  watchdogAbortsDuringApprovalWait: false,
  lane: 'foreground',
  promptSessionMode: 'mcp_server',
  origin: 'manual',
});

export const POLICY_DEFAULTS: Readonly<Record<SessionType, Readonly<TurnPolicy>>> = Object.freeze({
  interactive: INTERACTIVE_POLICY,
  automation: AUTOMATION_POLICY,
  cli: CLI_POLICY,
  mcp_server: MCP_SERVER_POLICY,
});

export function derivePolicy(
  sessionType: SessionType | 'onboarding-coach' | undefined,
  overrides?: Partial<TurnPolicy>,
  _logger?: { warn: (data: unknown, msg: string) => void },
): TurnPolicy {
  let normalised: SessionType;
  if (sessionType === undefined) {
    normalised = 'interactive';
  } else if (sessionType === 'onboarding-coach') {
    // 'onboarding-coach' is a renderer-side cast (mcpService.ts:3464) NOT in
    // the SessionType enum. The prompt-persona override is handled separately
    // at mcpService.ts; here we apply the interactive policy.
    normalised = 'interactive';
  } else if (sessionType in POLICY_DEFAULTS) {
    normalised = sessionType;
  } else {
    throw new Error(
      `derivePolicy: unknown sessionType '${String(sessionType)}'. Wire contract drift — investigate caller.`,
    );
  }
  const base = POLICY_DEFAULTS[normalised];
  if (!overrides) return { ...base };
  return { ...base, ...overrides };
}

export function getDefaultPolicyForSessionType(sessionType: SessionType): Readonly<TurnPolicy> {
  return POLICY_DEFAULTS[sessionType];
}
