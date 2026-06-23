import { memo } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { formatTokenCount } from '@shared/utils/usageFormatters';
import { formatDurationShort } from '@renderer/utils/formatters';
import { useSettingsSafe } from '@renderer/features/settings';
import type { ThinkingEffort, TurnFallback, ModelRoleWire } from '@shared/types';
import { resolveModelSettings } from '@shared/utils/settingsUtils';
import { assertNever } from '@shared/utils/assertNever';
import { credentialSourceToFriendlyName } from '@shared/utils/credentialSourceFriendlyName';
import { PROVIDER_CREDENTIAL_SOURCES } from '@shared/types/providerRoute';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';
import styles from './UsageTooltipContent.module.css';

const PROVIDER_CREDENTIAL_SOURCE_SET = new Set<string>(PROVIDER_CREDENTIAL_SOURCES);

/**
 * The Stage-4b multi-provider rate-limit failover `reason`. ONLY these records
 * carry a credential-source `to` (patched in on the retry) + a `billingSource`
 * axis, so ONLY they get the friendly "Switched to {name} — …" copy. Other
 * `type:'provider'` records (e.g. the older flag-OFF Codex failover, which writes
 * `reason:'codex-rate-limit'` with a REAL provider destination like `'openrouter'`)
 * must keep their previous `Provider: {from} → {to}` rendering — routing the new
 * copy over them would mislabel a known destination as "couldn't confirm where".
 */
const MULTI_PROVIDER_FAILOVER_REASON = 'multi-provider-rate-limit-failover';

/**
 * Calm, plain user-facing line for a `type: 'provider'` failover record. Keyed on
 * the billing axis so the user honestly sees when a fallback is metered. Raw enums
 * stay on the diagnostics "Details" surface (ContextTab) — never here.
 *
 * Only Stage-4b multi-provider records get the friendly copy (see
 * {@link MULTI_PROVIDER_FAILOVER_REASON}); every other provider record keeps the
 * legacy `Provider: {from} → {to}` rendering. For a Stage-4b record, `fb.to` is a
 * `ProviderCredentialSource` once the retry resolves, or stays `'auto-failover'`
 * when the failover never landed (honest "couldn't confirm where" state).
 */
export function providerFallbackLine(fb: TurnFallback): string {
  // Non-Stage-4b provider records (older flag-OFF Codex failover etc.): preserve
  // the previous rendering verbatim — they carry a real destination, not a
  // credential-source id + billing axis.
  if (fb.reason !== MULTI_PROVIDER_FAILOVER_REASON) {
    return `Provider: ${fb.from} → ${fb.to}`;
  }
  // Stage-4b record whose retry never landed on a confirmed provider — keep it
  // honest, no destination.
  if (!PROVIDER_CREDENTIAL_SOURCE_SET.has(fb.to)) {
    return 'Switched providers after a rate limit';
  }
  const name = credentialSourceToFriendlyName(fb.to as ProviderCredentialSource);
  switch (fb.billingSource) {
    case 'pay-per-use':
      return `Switched to ${name} — pay-as-you-go`;
    case 'pool':
      return `Switched to ${name} — using your credits`;
    case 'subscription':
      return `Switched to ${name} — covered`;
    default:
      // 'local' or null/absent — name it without a billing claim.
      return `Switched to ${name}`;
  }
}

/**
 * Single source of truth mapping a model role tier to the user-facing label used across
 * the product (Settings → Models uses exactly these words). Keyed on the WIRE spelling
 * (`ModelRoleWire`): the wire `'fast'` tier is the user's "Behind the Scenes" model — never
 * surface "fast"/"background". Exhaustive: adding a `ModelRoleWire` without a label here is a
 * compile error.
 */
export function runtimeRoleToUiLabel(role: ModelRoleWire): string {
  switch (role) {
    case 'thinking': return 'Planner';
    case 'working': return 'Main work';
    case 'fast': return 'Behind the Scenes';
    default: return assertNever(role, 'runtimeRoleToUiLabel');
  }
}

export interface ModelRole {
  /** Already-resolved display label (e.g. "Planner"). */
  role: string;
  model: string;
  authMethod?: string;
  provider?: string;
  pricingStatus?: 'priced' | 'unpriced';
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number | null;
  };
  /**
   * Whole-number token share (input+output) across observed rows.
   * Sentinel value `0` means a tiny non-zero share that should display as "<1%".
   */
  sharePct?: number;
  /**
   * Whether this role's model actually ran this turn ('observed') or is the configured model for
   * the role that didn't run ('configured_not_used' — e.g. the worker on a direct-answer turn, or
   * the Behind-the-Scenes model when no BTS call fired). Absent on legacy turns.
   */
  status?: 'observed' | 'configured_not_used';
}

export interface UsageData {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  costUsd?: number | null;
  model?: string;
  modelRoles?: ModelRole[];
  durationMs?: number | null;
  contextUtilization?: number | null;
  contextWindow?: number | null;
  thinkingEffort?: ThinkingEffort;
  authMethod?: string;
  fallbacks?: TurnFallback[];
  modelAgents?: Array<{ label: string; provider?: string }>;
}

const AUTH_METHOD_LABELS: Record<string, string> = {
  'api-key': 'API Key',
  'codex-subscription': 'ChatGPT Subscription',
  'openrouter': 'OpenRouter',
  'profile-direct': 'Provider API',
  'local': 'Local Model',
  'oauth-token': 'Claude Subscription (deprecated)',
};

const SUBSCRIPTION_AUTH_METHODS = new Set(['codex-subscription', 'oauth-token']);

const THINKING_LABELS: Record<ThinkingEffort, string> = {
  xhigh: 'Extra High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function formatModelRoleCostState(modelRole: ModelRole): string | null {
  if (modelRole.status !== 'observed') return null;

  const authMethod = modelRole.authMethod?.toLowerCase();
  const covered = authMethod ? SUBSCRIPTION_AUTH_METHODS.has(authMethod) : false;
  const pricingStatus = modelRole.pricingStatus;

  if (covered && pricingStatus === 'unpriced') return 'Covered, price unknown';
  if (covered) return 'Covered';
  if (pricingStatus === 'unpriced') return 'Cost unknown';

  const costUsd = modelRole.usage?.costUsd;
  if (costUsd == null || costUsd <= 0) return '<$0.01';
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
}

function formatModelRoleAuthProvider(
  modelRole: ModelRole,
  fallbackAuthMethod?: string,
): string {
  // Prefer the auth method — that's the billing path the user chose (e.g. "OpenRouter",
  // "ChatGPT Subscription"). The per-entry `provider` is the upstream fulfilment sub-provider
  // (e.g. "anthropic" behind OpenRouter); surfacing it as THE provider would misattribute who
  // served/billed the call (see pathologist H4 — provider identity must not be reconstructed from
  // downstream hints). Fall back to `provider` only when no auth method is known.
  const authMethod = modelRole.authMethod ?? fallbackAuthMethod;
  if (authMethod) {
    return AUTH_METHOD_LABELS[authMethod] ?? authMethod;
  }
  if (modelRole.provider) {
    return AUTH_METHOD_LABELS[modelRole.provider] ?? modelRole.provider;
  }
  return 'Unknown';
}

function formatModelShare(modelRole: ModelRole): string {
  if (modelRole.sharePct == null) return '';
  if (modelRole.sharePct === 0 && modelRole.usage) return '(<1%)';
  return `(${modelRole.sharePct}%)`;
}

function normalizeText(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return '1M';
  return `${Math.round(tokens / 1000)}K`;
}

interface SettingsDrift {
  field: string;
  turnValue: string;
  currentValue: string;
}

export function computeSettingsDrift(
  usage: UsageData,
  currentThinking?: ThinkingEffort,
  currentAuth?: string,
): SettingsDrift[] {
  const drifts: SettingsDrift[] = [];

  if (usage.thinkingEffort && currentThinking && usage.thinkingEffort !== currentThinking) {
    drifts.push({
      field: 'Thinking',
      turnValue: THINKING_LABELS[usage.thinkingEffort] ?? usage.thinkingEffort,
      currentValue: THINKING_LABELS[currentThinking] ?? currentThinking,
    });
  }

  if (usage.authMethod && currentAuth && usage.authMethod !== currentAuth) {
    drifts.push({
      field: 'Auth',
      turnValue: AUTH_METHOD_LABELS[usage.authMethod] ?? usage.authMethod,
      currentValue: AUTH_METHOD_LABELS[currentAuth] ?? currentAuth,
    });
  }

  return drifts;
}

type UsageTooltipContentProps = {
  usage: UsageData;
};

export const UsageTooltipContent = memo(({ usage }: UsageTooltipContentProps) => {
  const settingsContext = useSettingsSafe();
  const modelSettings = resolveModelSettings(settingsContext?.settings ?? {});

  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    model,
    modelRoles,
    durationMs,
    contextUtilization,
    contextWindow,
    thinkingEffort,
    authMethod,
    fallbacks,
    modelAgents,
  } = usage;

  // Show drift whenever the turn has Claude-specific fields, regardless of current model setting.
  // If user ran a Claude turn then switched to local model, the comparison is still meaningful.
  const settingsDrift = Object.keys(modelSettings).length > 0
    ? computeSettingsDrift(usage, modelSettings.thinkingEffort, modelSettings.authMethod)
    : [];

  const hasCacheData = (cacheReadTokens ?? 0) > 0 || (cacheCreationTokens ?? 0) > 0;
  const hasTokenData = (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0;
  const hasPerRowAuthProvider = Boolean(
    modelRoles?.some((row) => Boolean(row.authMethod || row.provider)),
  );
  const filteredModelAgents = (() => {
    if (!modelAgents || modelAgents.length === 0) return undefined;
    if (!modelRoles || modelRoles.length === 0) return modelAgents;

    const observedRows = modelRoles.filter((row) => row.status === 'observed');
    if (observedRows.length === 0) return modelAgents;

    const observedModelNames = new Set(
      observedRows.map((row) => normalizeText(row.model)).filter(Boolean),
    );

    const filtered = modelAgents.filter((agent) => {
      const agentLabel = normalizeText(agent.label);
      const agentProvider = normalizeText(agent.provider);
      const exactNameMatch = agentLabel.length > 0 && observedModelNames.has(agentLabel);
      if (exactNameMatch) return false;

      const providerAndFuzzyModelMatch =
        agentLabel.length > 0 &&
        agentProvider.length > 0 &&
        observedRows.some((row) => {
          if (normalizeText(row.provider) !== agentProvider) return false;
          const observedLabel = normalizeText(row.model);
          return observedLabel.includes(agentLabel) || agentLabel.includes(observedLabel);
        });

      return !providerAndFuzzyModelMatch;
    });

    return filtered.length > 0 ? filtered : undefined;
  })();

  const formatCost = (cost: number) => {
    if (cost < 0.01) return '<$0.01';
    return `$${cost.toFixed(2)}`;
  };

  return (
    <div className={styles.container}>
      <div className={styles.title}>Turn Usage</div>

      {(model || modelRoles?.length || durationMs || thinkingEffort || authMethod) && (
        <div className={styles.section}>
          {modelRoles && modelRoles.length > 0 ? (
            modelRoles.map((mr, idx) => {
              const tokenShare = formatModelShare(mr);
              const tokenSummary = mr.usage
                ? `${formatTokenCount(mr.usage.inputTokens)} in / ${formatTokenCount(mr.usage.outputTokens)} out${tokenShare ? ` ${tokenShare}` : ''}`
                : null;
              const costState = formatModelRoleCostState(mr);
              const authProvider = formatModelRoleAuthProvider(mr, authMethod);
              const metadata = mr.status === 'configured_not_used'
                ? 'Not used this turn'
                : [tokenSummary, costState, authProvider].filter(Boolean).join(' | ');

              return (
                <div key={`${mr.role}-${mr.model}-${idx}`} className={styles.modelRow}>
                  <div className={styles.row}>
                    <span className={styles.label}>{mr.role}</span>
                    <span className={styles.value}>{mr.model}</span>
                  </div>
                  <div className={styles.modelMeta}>{metadata}</div>
                </div>
              );
            })
          ) : model ? (
            <div className={styles.row}>
              <span className={styles.label}>Model</span>
              <span className={styles.value}>{model}</span>
            </div>
          ) : null}
          {thinkingEffort && (
            <div className={styles.row}>
              <span className={styles.label}>Thinking</span>
              <span className={styles.value}>{THINKING_LABELS[thinkingEffort] ?? thinkingEffort}</span>
            </div>
          )}
          {authMethod && !hasPerRowAuthProvider && (
            <div className={styles.row}>
              <span className={styles.label}>Auth</span>
              <span className={styles.badge}>{AUTH_METHOD_LABELS[authMethod] ?? authMethod}</span>
            </div>
          )}
          {durationMs != null && durationMs > 0 && (
            <div className={styles.row}>
              <span className={styles.label}>Duration</span>
              <span className={styles.value}>{formatDurationShort(durationMs)}</span>
            </div>
          )}
        </div>
      )}

      {filteredModelAgents && filteredModelAgents.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Models Consulted</div>
          {filteredModelAgents.map((agent) => (
            <div key={`${agent.label}-${agent.provider ?? 'unknown'}`} className={styles.row}>
              <span className={styles.modelAgentLabel}>{agent.label}</span>
              {agent.provider && <span className={styles.modelAgentProvider}>{agent.provider}</span>}
            </div>
          ))}
        </div>
      )}

      {hasTokenData && (
        <div className={styles.section}>
          <div className={styles.row}>
            <span className={styles.label}>Input</span>
            <span className={styles.value}>{formatTokenCount(inputTokens ?? 0)} tokens</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Output</span>
            <span className={styles.value}>{formatTokenCount(outputTokens ?? 0)} tokens</span>
          </div>
        </div>
      )}

      {contextWindow != null && contextWindow > 0 && (
        <div className={styles.section}>
          <div className={styles.row}>
            <span className={styles.label}>Context window</span>
            <span className={styles.value}>{formatContextWindow(contextWindow)} tokens</span>
          </div>
          {contextUtilization != null && (
            <>
              <div className={styles.row}>
                <span className={styles.label}>Utilization</span>
                <span className={styles.value}>{contextUtilization}%</span>
              </div>
              <div className={styles.contextBar} role="progressbar" aria-valuenow={contextUtilization} aria-valuemin={0} aria-valuemax={100}>
                <div className={styles.contextBarFill} style={{ width: `${Math.min(100, contextUtilization)}%` }} />
              </div>
            </>
          )}
        </div>
      )}

      {hasCacheData && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Prompt Cache</div>
          {(cacheReadTokens ?? 0) > 0 && (
            <div className={styles.row}>
              <span className={styles.label}>Read from cache</span>
              <span className={styles.value}>{formatTokenCount(cacheReadTokens ?? 0)}</span>
            </div>
          )}
          {(cacheCreationTokens ?? 0) > 0 && (
            <div className={styles.row}>
              <span className={styles.label}>Written to cache</span>
              <span className={styles.value}>{formatTokenCount(cacheCreationTokens ?? 0)}</span>
            </div>
          )}
          {(() => {
            const totalBase = (inputTokens ?? 0) + (cacheCreationTokens ?? 0);
            if (totalBase > 0 && (cacheReadTokens ?? 0) > 0) {
              const hitRatio = Math.round(((cacheReadTokens ?? 0) / totalBase) * 100);
              return (
                <div className={styles.row}>
                  <span className={styles.label}>Hit ratio</span>
                  <span className={styles.value}>{hitRatio}%</span>
                </div>
              );
            }
            return null;
          })()}
          <div className={styles.hint}>
            Cached context is ~90% cheaper to process
          </div>
        </div>
      )}

      {fallbacks && fallbacks.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Degradation</div>
          {fallbacks.map((fb, i) => (
            <div key={i} className={styles.fallbackRow}>
              <AlertTriangle size={12} className={styles.fallbackIcon} aria-hidden />
              <span className={styles.fallbackText}>
                {fb.type === 'provider'
                  ? providerFallbackLine(fb)
                  : `${fb.type === 'auth' ? 'Auth' : fb.type === 'model' || fb.type === 'tier_model' ? 'Model' : 'Context'}: ${fb.from} → ${fb.to}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {costUsd != null && costUsd > 0 && (
        <div className={styles.cost}>
          <span className={styles.costLabel}>Cost</span>
          <span className={styles.costValue}>
            {authMethod && SUBSCRIPTION_AUTH_METHODS.has(authMethod)
              ? `${formatCost(costUsd)} (covered)`
              : formatCost(costUsd)}
          </span>
        </div>
      )}

      {authMethod && SUBSCRIPTION_AUTH_METHODS.has(authMethod) && (
        <div className={styles.hint}>
          Covered by your subscription — no extra charge
        </div>
      )}

      {settingsDrift.length > 0 && (
        <div className={styles.driftSection}>
          <div className={styles.sectionLabel}>Settings changed since this turn</div>
          {settingsDrift.map((drift) => (
            <div key={drift.field} className={styles.driftRow}>
              <span className={styles.driftField}>{drift.field}:</span>
              <span className={styles.driftOld}>{drift.turnValue}</span>
              <ArrowRight size={10} className={styles.driftArrow} aria-hidden />
              <span className={styles.driftNew}>{drift.currentValue}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

UsageTooltipContent.displayName = 'UsageTooltipContent';
