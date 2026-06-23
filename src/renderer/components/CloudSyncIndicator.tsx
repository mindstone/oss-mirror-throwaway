import { useEffect, useState, useRef, useCallback } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { IconButton } from '@renderer/components/ui/IconButton';
import type { CloudInstanceConfig } from '@shared/types';
import './CloudSyncIndicator.css';

interface CloudSyncIndicatorProps {
  cloudInstance?: CloudInstanceConfig;
  /** Called when the user clicks a non-synced indicator. */
  onNavigateToCloud?: () => void;
}

type SyncHealth = 'synced' | 'syncing' | 'offline' | 'error' | 'pressure-warning' | 'pressure-critical';

const POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 240_000;

function getTooltipContent(
  health: SyncHealth,
  host: string,
  pending: number,
  isManaged: boolean,
): string {
  switch (health) {
    case 'synced':
      return `Cloud synced \u2014 ${host}`;
    case 'syncing':
      return `Syncing ${pending} item${pending !== 1 ? 's' : ''} \u2014 ${host}`;
    case 'offline':
      return `Cloud unreachable \u2014 ${host}`;
    case 'error':
      return `Cloud service error \u2014 ${host}`;
    case 'pressure-warning':
      return isManaged
        ? `Cloud needs more room \u2014 Mindstone is handling it`
        : `Cloud is running tight \u2014 review speed options`;
    case 'pressure-critical':
      return isManaged
        ? `Cloud needs more room \u2014 Mindstone is handling it`
        : `Cloud needs more room \u2014 review speed options`;
  }
}

export function CloudSyncIndicator({ cloudInstance, onNavigateToCloud }: CloudSyncIndicatorProps) {
  const cloudUrl = cloudInstance?.cloudUrl;
  const isCloud = cloudInstance?.mode === 'cloud' && !!cloudUrl;
  const isManaged = cloudInstance?.provisionMode === 'managed';

  const [outbox, setOutbox] = useState<{ pending: number; failed: number }>({ pending: 0, failed: 0 });
  const [cloudHealth, setCloudHealth] = useState<'running' | 'offline' | 'error' | null>(null);
  const [pressureState, setPressureState] = useState<'ok' | 'warning' | 'critical' | 'unknown'>(
    cloudInstance?.lastPressureState ?? 'ok',
  );
  const backoffRef = useRef(POLL_INTERVAL_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const result = await window.cloudApi?.status?.();
      if (!result) return;
      if (
        result.status === 'running' ||
        result.status === 'warm' ||
        result.status === 'provisioning'
      ) {
        setCloudHealth('running');
        backoffRef.current = POLL_INTERVAL_MS;
      } else if (result.status === 'offline') {
        setCloudHealth('offline');
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      } else if (result.status === 'error') {
        setCloudHealth('error');
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      }
    } catch {
      setCloudHealth('offline');
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    }
  }, []);

  // Re-sync pressure state when the cloudInstance prop changes (e.g. settings refresh or instance
  // switch). The push channel keeps it fresh between changes; this catches prop-driven updates.
  useEffect(() => {
    setPressureState(cloudInstance?.lastPressureState ?? 'ok');
  }, [cloudInstance?.lastPressureState]);

  useEffect(() => {
    if (!isCloud) return;

    // Outbox subscription
    window.cloudApi?.outboxStatus?.()
      .then(setOutbox)
      .catch(() => {});
    const unsubOutbox = window.cloudApi?.onOutboxChanged?.(setOutbox);

    // Pressure state subscription (push channel — fires on state change)
    const unsubPressure = window.cloudApi?.onPressureState?.((data) => {
      setPressureState(data.state);
    });

    // Immediate health check on mount, then periodic
    checkHealth();

    const scheduleNext = () => {
      timerRef.current = setTimeout(async () => {
        if (document.visibilityState === 'visible') {
          await checkHealth();
        }
        scheduleNext();
      }, backoffRef.current);
    };
    scheduleNext();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkHealth();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsubOutbox?.();
      unsubPressure?.();
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isCloud, checkHealth]);

  if (!isCloud) return null;

  const host = (() => {
    try { return new URL(cloudUrl).host; } catch { return cloudUrl; }
  })();

  // Derive health with priority hierarchy:
  // offline > pressure-critical > error > pressure-warning > syncing > synced
  const health: SyncHealth =
    cloudHealth === 'offline' ? 'offline' :
    pressureState === 'critical' ? 'pressure-critical' :
    cloudHealth === 'error' ? 'error' :
    pressureState === 'warning' ? 'pressure-warning' :
    outbox.pending > 0 ? 'syncing' : 'synced';

  const tooltip = getTooltipContent(health, host, outbox.pending, isManaged);
  const IconComponent = health === 'offline' ? CloudOff : Cloud;
  const isClickable =
    health === 'offline' || health === 'error' ||
    health === 'pressure-warning' || health === 'pressure-critical';

  return (
    <Tooltip content={tooltip} delayShow={200}>
      <IconButton
        size="sm"
        className={`header-icon-button cloud-sync-indicator cloud-sync-indicator--${health}`}
        aria-label={tooltip}
        role="status"
        onClick={isClickable ? onNavigateToCloud : undefined}
      >
        <IconComponent size={16} aria-hidden="true" />
        {health !== 'synced' && (
          <span className={`cloud-sync-indicator__badge cloud-sync-indicator__badge--${health}`} />
        )}
      </IconButton>
    </Tooltip>
  );
}

CloudSyncIndicator.displayName = 'CloudSyncIndicator';
