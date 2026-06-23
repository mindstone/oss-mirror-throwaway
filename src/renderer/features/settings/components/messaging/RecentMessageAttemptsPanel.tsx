import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlackRecentSender } from '@rebel/cloud-client';
import {
  clearSlackRecentSenders,
  configure,
  listSlackRecentSenders,
  removeSlackRecentSender,
} from '@rebel/cloud-client';
import { formatRelativeTime } from '@rebel/shared';
import { Button, Notice } from '@renderer/components/ui';
import { SettingSection } from '../SettingSection';
import { useSettingsSafe } from '../../SettingsProvider';
import { useInboundAuthorPolicy, type UseInboundAuthorPolicyResult } from '../../hooks/useInboundAuthorPolicy';

type CloudClientConfig = {
  cloudUrl: string;
  token: string;
};

function resolveCloudConfig(settings: unknown): CloudClientConfig | null {
  if (!settings || typeof settings !== 'object') return null;
  const cloudInstance = (settings as { cloudInstance?: unknown }).cloudInstance;
  if (!cloudInstance || typeof cloudInstance !== 'object') return null;
  const mode = (cloudInstance as { mode?: unknown }).mode;
  const cloudUrl = (cloudInstance as { cloudUrl?: unknown }).cloudUrl;
  const cloudToken = (cloudInstance as { cloudToken?: unknown }).cloudToken;
  if (mode !== 'cloud' || typeof cloudUrl !== 'string' || typeof cloudToken !== 'string') {
    return null;
  }
  if (!cloudUrl.trim() || !cloudToken.trim()) {
    return null;
  }
  return {
    cloudUrl: cloudUrl.trim(),
    token: cloudToken.trim(),
  };
}

function configureCloudClient(config: CloudClientConfig): void {
  configure({
    cloudUrl: config.cloudUrl,
    token: config.token,
  });
}

function normalizeId(value: string): string {
  return value.trim();
}

function truncateSlackId(value: string): string {
  const normalized = normalizeId(value);
  if (!normalized) return 'U…';
  if (normalized.length <= 6) return normalized;
  return `${normalized.slice(0, 2)}…${normalized.slice(-2)}`;
}

function channelTypeLabel(channelType: SlackRecentSender['lastChannelType']): string {
  if (channelType === 'im' || channelType === 'mpim') return 'Direct message';
  return 'Channel';
}

function firstChannelLabel(sender: SlackRecentSender): string | null {
  const firstChannel = sender.channelIds[0];
  if (!firstChannel) return null;
  const normalized = firstChannel.trim();
  if (!normalized) return null;
  if (channelTypeLabel(sender.lastChannelType) !== 'Channel') return null;
  return normalized.startsWith('#') ? normalized : `#${normalized}`;
}

function senderTitle(sender: SlackRecentSender): string {
  const displayName = sender.displayName?.trim();
  const handle = sender.handle?.trim().replace(/^@+/, '');
  if (displayName) return displayName;
  if (handle) return `@${handle}`;
  return 'Unknown Slack user';
}

function senderSubtitle(sender: SlackRecentSender): string | null {
  const displayName = sender.displayName?.trim();
  const handle = sender.handle?.trim().replace(/^@+/, '');
  if (displayName && handle) return `@${handle}`;
  return null;
}

function sortByNewest(left: SlackRecentSender, right: SlackRecentSender): number {
  return right.lastSeenAt - left.lastSeenAt;
}

export interface UseSlackRecentSendersResult {
  senders: SlackRecentSender[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (principalKey: string) => Promise<void>;
  clearAll: () => Promise<{ cleared: number }>;
}

export function useSlackRecentSenders(): UseSlackRecentSendersResult {
  const settingsContext = useSettingsSafe();
  const settings = settingsContext?.draftSettings ?? settingsContext?.settings ?? null;
  const cloudConfig = useMemo(() => resolveCloudConfig(settings), [settings]);
  const [senders, setSenders] = useState<SlackRecentSender[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!cloudConfig) return;
    setLoading(true);
    setError(null);
    try {
      configureCloudClient(cloudConfig);
      const rows = await listSlackRecentSenders();
      setSenders(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recent message attempts.');
    } finally {
      setLoading(false);
    }
  }, [cloudConfig]);

  useEffect(() => {
    if (!cloudConfig) return;
    void refresh();
  }, [cloudConfig, refresh]);

  const remove = useCallback(async (principalKey: string): Promise<void> => {
    setSenders((current) => current.filter((sender) => sender.principalKey !== principalKey));
    if (!cloudConfig) return;
    try {
      configureCloudClient(cloudConfig);
      await removeSlackRecentSender(principalKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss this recent sender.');
      await refresh();
    }
  }, [cloudConfig, refresh]);

  const clearAll = useCallback(async (): Promise<{ cleared: number }> => {
    const previous = senders;
    setSenders([]);
    if (!cloudConfig) {
      return { cleared: previous.length };
    }
    try {
      configureCloudClient(cloudConfig);
      return await clearSlackRecentSenders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear recent senders.');
      await refresh();
      return { cleared: 0 };
    }
  }, [cloudConfig, refresh, senders]);

  return {
    senders,
    loading,
    error,
    refresh,
    remove,
    clearAll,
  };
}

type SenderActions = Pick<
  UseInboundAuthorPolicyResult,
  'addToAllowlist' | 'addToBlocklist' | 'addToAgentAllowlist'
>;

function SenderRow({
  sender,
  policyActions,
  onDismiss,
  disabled = false,
}: {
  sender: SlackRecentSender;
  policyActions: SenderActions;
  onDismiss: (principalKey: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const channelLabel = channelTypeLabel(sender.lastChannelType);
  const firstChannel = firstChannelLabel(sender);
  const relativeSeenAt = formatRelativeTime(sender.lastSeenAt, { capitalize: false });
  const title = senderTitle(sender);
  const subtitle = senderSubtitle(sender);
  const slackId = truncateSlackId(sender.authorId || sender.normalizedAuthorId);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (disabled || isBusy) return;
    setIsBusy(true);
    try {
      await action();
    } finally {
      setIsBusy(false);
    }
  }, [disabled, isBusy]);

  return (
    <div
      style={{
        border: '1px solid var(--color-border-soft)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        display: 'grid',
        gap: 'var(--space-2)',
      }}
      data-testid={`recent-message-attempt-${sender.principalKey}`}
    >
      <div style={{ display: 'grid', gap: '2px' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {title}
        </div>
        {subtitle ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
            {subtitle}
          </div>
        ) : null}
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.78rem' }}>
          {`Slack ID ${slackId}`}
        </div>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.78rem' }}>
          {`${sender.attemptCount} attempt${sender.attemptCount === 1 ? '' : 's'} • ${relativeSeenAt}`}
        </div>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.78rem' }}>
          {firstChannel ? `${channelLabel} • ${firstChannel}` : channelLabel}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || isBusy}
          data-testid={`recent-message-attempt-allow-${sender.principalKey}`}
          onClick={() => {
            void runAction(async () => {
              if (sender.kind === 'agent') {
                await policyActions.addToAgentAllowlist('slack', sender.authorId);
              } else {
                await policyActions.addToAllowlist(sender.authorId);
              }
              await onDismiss(sender.principalKey);
            });
          }}
        >
          Allow this ID
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || isBusy}
          data-testid={`recent-message-attempt-block-${sender.principalKey}`}
          onClick={() => {
            void runAction(async () => {
              await policyActions.addToBlocklist(sender.authorId);
              await onDismiss(sender.principalKey);
            });
          }}
        >
          Block this ID
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || isBusy}
          data-testid={`recent-message-attempt-dismiss-${sender.principalKey}`}
          onClick={() => {
            void runAction(async () => {
              await onDismiss(sender.principalKey);
            });
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export interface RecentMessageAttemptsPanelProps {
  policyState?: UseInboundAuthorPolicyResult;
  recentSendersState?: UseSlackRecentSendersResult;
  slackConnected?: boolean;
}

export function RecentMessageAttemptsPanel({
  policyState,
  recentSendersState,
  slackConnected = true,
}: RecentMessageAttemptsPanelProps) {
  const hookedPolicyState = useInboundAuthorPolicy();
  const policy = policyState ?? hookedPolicyState;
  const hookedRecentSendersState = useSlackRecentSenders();
  const recent = recentSendersState ?? hookedRecentSendersState;
  const [isClearing, setIsClearing] = useState(false);

  const humanSenders = useMemo(
    () => recent.senders.filter((sender) => sender.kind === 'human').sort(sortByNewest),
    [recent.senders],
  );
  const agentSenders = useMemo(
    () => recent.senders.filter((sender) => sender.kind === 'agent').sort(sortByNewest),
    [recent.senders],
  );

  const handleClearAll = useCallback(async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await recent.clearAll();
    } finally {
      setIsClearing(false);
    }
  }, [isClearing, recent]);

  return (
    <SettingSection
      title="Recent message attempts"
      description="Review recent blocked senders, then allow, block, or dismiss each one."
      data-section="recent-message-attempts"
      data-testid="recent-message-attempts-panel"
    >
      {!slackConnected ? (
        <Notice tone="info" placement="inline" data-testid="recent-message-attempts-disconnected-notice">
          Connect Slack to add people from recent attempts.
        </Notice>
      ) : null}

      {recent.error ? (
        <Notice tone="warning" placement="inline" data-testid="recent-message-attempts-error">
          {recent.error}
        </Notice>
      ) : null}

      {recent.senders.length > 0 ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isClearing}
            onClick={() => {
              void handleClearAll();
            }}
            data-testid="recent-message-attempts-clear-all"
          >
            Clear all
          </Button>
        </div>
      ) : null}

      {recent.loading && recent.senders.length === 0 ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
          Loading recent message attempts…
        </div>
      ) : null}

      {!recent.loading && recent.senders.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--color-border-soft)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            color: 'var(--color-text-secondary)',
            fontSize: '0.85rem',
          }}
          data-testid="recent-message-attempts-empty"
        >
          No blocked attempts yet. Slack, briefly civil.
        </div>
      ) : null}

      {humanSenders.length > 0 ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {humanSenders.map((sender) => (
            <SenderRow
              key={sender.principalKey}
              sender={sender}
              policyActions={policy}
              onDismiss={recent.remove}
              disabled={isClearing}
            />
          ))}
        </div>
      ) : null}

      {agentSenders.length > 0 ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h4
            style={{
              margin: 'var(--space-2) 0 0',
              fontSize: '0.85rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--color-text-secondary)',
            }}
          >
            Other Rebels
          </h4>
          {agentSenders.map((sender) => (
            <SenderRow
              key={sender.principalKey}
              sender={sender}
              policyActions={policy}
              onDismiss={recent.remove}
              disabled={isClearing}
            />
          ))}
        </div>
      ) : null}
    </SettingSection>
  );
}
