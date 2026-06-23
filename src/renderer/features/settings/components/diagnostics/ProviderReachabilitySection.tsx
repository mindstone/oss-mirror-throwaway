import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Notice, Spinner, Tooltip } from '@renderer/components/ui';
import type {
  ProbeErrorCode,
  ProbeResult,
  ProviderId,
  ProviderReachabilitySnapshot,
} from '@shared/diagnostics/providerReachabilitySnapshot';
import type { ActiveProvider } from '@shared/types/settings';
import { SettingSection } from '../SettingSection';
import styles from '../SettingsSurface.module.css';

const PROVIDERS: ProviderId[] = [
  'anthropic',
  'codex',
  'google',
  'openai',
  'openrouter',
  'rebel-cloud',
];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'ChatGPT Pro',
  google: 'Google Gemini',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'rebel-cloud': 'Rebel Cloud',
};

const ERROR_LABELS: Record<ProbeErrorCode, string> = {
  dns: 'Network problem',
  tls: 'Certificate check failed',
  http_4xx: 'Service problem',
  http_5xx: 'Service problem',
  timeout: 'Timed out',
  unknown: 'Service problem',
};

function providerForActive(activeProvider?: ActiveProvider): ProviderId {
  if (activeProvider === 'codex') return 'codex';
  if (activeProvider === 'mindstone') return 'openrouter';
  if (activeProvider === 'openrouter') return 'openrouter';
  return 'anthropic';
}

function getFreshUntil(snapshot: ProviderReachabilitySnapshot | null, nowMs: number): number | null {
  const providers = Object.values(snapshot?.providers ?? {});
  if (!snapshot?.snapshotPresent || providers.length === 0) return null;
  const expiresAt = Math.min(...providers.map((provider) => provider.expiresAt));
  return expiresAt > nowMs ? expiresAt : null;
}

function formatCheckedAgo(checkedAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - checkedAt) / 1000));
  return `Checked ${seconds}s ago`;
}

function secondaryText(result: ProbeResult | undefined, nowMs: number): string | null {
  if (!result) return null;
  if (result.status === 'unreachable' && result.errorCode) {
    return ERROR_LABELS[result.errorCode];
  }
  return formatCheckedAgo(result.checkedAt, nowMs);
}

interface ProviderReachabilitySectionProps {
  activeProvider?: ActiveProvider;
}

export function ProviderReachabilitySection({
  activeProvider,
}: ProviderReachabilitySectionProps) {
  const [snapshot, setSnapshot] = useState<ProviderReachabilitySnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const currentProvider = providerForActive(activeProvider);
  const freshUntil = getFreshUntil(snapshot, nowMs);
  const cacheFresh = freshUntil !== null;

  useEffect(() => {
    let cancelled = false;

    void window.diagnosticsApi.getProviderReachabilitySnapshot()
      .then((nextSnapshot) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setError(false);
      })
      .catch((err) => {
        console.warn('[ProviderReachabilitySection] Failed to read provider reachability snapshot', err);
        if (!cancelled) {
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!freshUntil) return undefined;
    const timeout = window.setTimeout(() => {
      setNowMs(Date.now());
    }, Math.max(0, freshUntil - nowMs));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [freshUntil, nowMs]);

  const handleCheck = useCallback(async () => {
    const clickNow = Date.now();
    setNowMs(clickNow);
    if (getFreshUntil(snapshot, clickNow)) return;

    setChecking(true);
    setError(false);
    try {
      const nextSnapshot = await window.diagnosticsApi.refreshProviderReachabilityCache();
      setSnapshot(nextSnapshot);
      setNowMs(Date.now());
    } catch (err) {
      console.warn('[ProviderReachabilitySection] Failed to refresh provider reachability cache', err);
      setError(true);
    } finally {
      setChecking(false);
    }
  }, [snapshot]);

  const rows = useMemo(() => {
    const providerIds = new Set<ProviderId>(PROVIDERS);
    providerIds.add(currentProvider);
    for (const provider of Object.keys(snapshot?.providers ?? {}) as ProviderId[]) {
      providerIds.add(provider);
    }

    return Array.from(providerIds).sort((a, b) => {
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      const aResult = snapshot?.providers?.[a];
      const bResult = snapshot?.providers?.[b];
      const aUnreachable = aResult?.status === 'unreachable';
      const bUnreachable = bResult?.status === 'unreachable';
      if (aUnreachable !== bUnreachable) return aUnreachable ? -1 : 1;
      return PROVIDER_LABELS[a].localeCompare(PROVIDER_LABELS[b]);
    });
  }, [currentProvider, snapshot?.providers]);

  const aggregateState = useMemo(() => {
    if (error) return 'error';
    if (checking) return 'checking';
    const results = Object.values(snapshot?.providers ?? {});
    if (!snapshot?.snapshotPresent || results.length === 0) return 'empty';
    return results.some((result) => result.status === 'unreachable') ? 'partial' : 'success';
  }, [checking, error, snapshot]);

  return (
    <SettingSection
      title="AI service connections"
      description="Check whether this device can reach the AI services Rebel uses. Useful when Rebel keeps failing and nobody wants to guess."
      data-testid="provider-reachability-section"
    >
      <div className={styles.providerReachabilityStack}>
        <Tooltip content="This checks basic connection reachability only. It does not send prompts, files, or API keys.">
          <p className={styles.providerReachabilityPrivacy}>
            Quick connection check only. No prompts, files, or API keys are sent.
          </p>
        </Tooltip>

        <div className={styles.providerReachabilityActionRow}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheck}
            disabled={checking || cacheFresh}
          >
            {checking && <Spinner size="xs" decorative />}
            {checking ? 'Checking…' : 'Check AI services'}
          </Button>
          {cacheFresh && snapshot?.lastRefreshAt && (
            <span className={styles.providerReachabilityMeta}>
              {formatCheckedAgo(snapshot.lastRefreshAt, nowMs)}
            </span>
          )}
        </div>

        {aggregateState === 'success' && (
          <Notice tone="success" density="compact">
            AI services are reachable.
          </Notice>
        )}
        {aggregateState === 'partial' && (
          <Notice tone="warning" density="compact">
            Some AI services need attention.
          </Notice>
        )}
        {aggregateState === 'empty' && (
          <p className={styles.providerReachabilityEmpty}>
            Not checked yet. Press the button. The button has one job.
          </p>
        )}
        {aggregateState === 'error' && (
          <Notice tone="error" density="compact">
            Couldn't check AI services. Your network may be blocking the check, or Rebel tripped over a cable. Try again.
          </Notice>
        )}

        <div className={styles.providerReachabilityRows} role="list">
          {rows.map((provider) => {
            const result = snapshot?.providers?.[provider];
            const statusLabel = checking
              ? 'Checking'
              : result?.status === 'reachable'
                ? 'Reachable'
                : result?.status === 'unreachable'
                  ? "Can't reach"
                  : 'Not checked';
            const badgeVariant = checking
              ? 'warning'
              : result?.status === 'reachable'
                ? 'success'
                : result?.status === 'unreachable'
                  ? 'destructive'
                  : 'muted';
            const detail = checking ? null : secondaryText(result, nowMs);
            const detailNode = detail ? (
              <span className={styles.providerReachabilityDetail}>{detail}</span>
            ) : null;

            return (
              <div key={provider} className={styles.providerReachabilityRow} role="listitem">
                <div className={styles.providerReachabilityNameBlock}>
                  <div className={styles.providerReachabilityNameRow}>
                    {provider === 'codex' ? (
                      <Tooltip content="ChatGPT Pro uses a different host than the OpenAI API — one can work while the other doesn't.">
                        <span className={styles.providerReachabilityName}>
                          {PROVIDER_LABELS[provider]}
                        </span>
                      </Tooltip>
                    ) : (
                      <span className={styles.providerReachabilityName}>
                        {PROVIDER_LABELS[provider]}
                      </span>
                    )}
                    {provider === currentProvider && (
                      <Badge variant="info" size="sm">Current</Badge>
                    )}
                  </div>
                  {result?.status === 'unreachable' && result.errorCode && detailNode ? (
                    <Tooltip content={`Probe detail: ${result.errorCode}`} placement="right">
                      {detailNode}
                    </Tooltip>
                  ) : detailNode}
                </div>
                <Badge variant={badgeVariant} size="sm">
                  {statusLabel}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>
    </SettingSection>
  );
}
