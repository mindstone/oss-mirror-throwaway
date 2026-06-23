import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge, Notice, Spinner } from '@renderer/components/ui';
import type {
  OfficeSidecarRetryStartResponse,
  OfficeSidecarStatusResponse,
} from '@shared/ipc/channels/officeSidecar';
import styles from './SettingsSurface.module.css';

const POLL_INTERVAL_MS = 5_000;
const UNKNOWN_ERROR_MESSAGE = "Couldn't start the Office connection.";

interface OfficeSidecarApi {
  getStatus: () => Promise<OfficeSidecarStatusResponse>;
  retryStart: () => Promise<OfficeSidecarRetryStartResponse>;
}

function getOfficeSidecarApi(): OfficeSidecarApi | null {
  const w = window as unknown as { officeSidecarApi?: OfficeSidecarApi };
  return w.officeSidecarApi ?? null;
}

function buildUnavailableStatus(): OfficeSidecarStatusResponse {
  return {
    running: false,
    port: null,
    adopted: false,
    skipReason: null,
    lastError: {
      code: 'unknown',
      message: UNKNOWN_ERROR_MESSAGE,
      at: Date.now(),
    },
    startedAt: null,
  };
}

function toStatusResponse(
  response: OfficeSidecarRetryStartResponse,
): OfficeSidecarStatusResponse {
  return {
    running: response.restarted,
    port: response.port,
    adopted: response.adopted,
    skipReason: response.skipReason,
    lastError: response.error,
    startedAt: response.restarted ? Date.now() : null,
  };
}

export function OfficeSidecarStatusSection(): ReactElement | null {
  const api = getOfficeSidecarApi();
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const activeStatusRequestsRef = useRef(0);
  const retryingRef = useRef(false);
  const [status, setStatus] = useState<OfficeSidecarStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const loadStatus = useCallback(async (showPending: boolean, force = false): Promise<void> => {
    if (!force && activeStatusRequestsRef.current > 0) {
      return;
    }

    const requestId = ++requestIdRef.current;

    if (!api) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(buildUnavailableStatus());
        setLoading(false);
      }
      return;
    }

    activeStatusRequestsRef.current += 1;
    if (showPending && mountedRef.current && requestId === requestIdRef.current) {
      setLoading(true);
    }

    try {
      const nextStatus = await api.getStatus();
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(nextStatus);
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(buildUnavailableStatus());
      }
    } finally {
      activeStatusRequestsRef.current = Math.max(0, activeStatusRequestsRef.current - 1);
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void loadStatus(true);
    const intervalId = window.setInterval(() => {
      void loadStatus(false);
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      window.clearInterval(intervalId);
    };
  }, [loadStatus]);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!api || retryingRef.current) {
      return;
    }

    const requestId = ++requestIdRef.current;
    retryingRef.current = true;
    setRetrying(true);
    try {
      const nextStatus = await api.retryStart();
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(toStatusResponse(nextStatus));
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(buildUnavailableStatus());
      }
    } finally {
      retryingRef.current = false;
      if (mountedRef.current) {
        setRetrying(false);
      }
      await loadStatus(false, true);
    }
  }, [api, loadStatus]);

  const handleLearnMore = useCallback(() => {
    setShowAdvanced(true);
  }, []);

  if (loading && !status) {
    return (
      <div className={styles.setupView} data-testid="office-sidecar-status-loading">
        <Spinner size="sm" label="Checking Office connection…" />
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const isKillSwitched = status.skipReason === 'kill-switch';
  const isSurfaceNonDesktop = status.skipReason === 'surface-not-desktop';
  const isFailed = !status.running && status.lastError !== null;
  const isDegraded = status.running && status.lastError !== null;
  const isHealthy = status.running && status.lastError === null;
  const isAdopted = status.adopted;
  const hasVisibleState = isHealthy || isDegraded || isFailed || isKillSwitched || isSurfaceNonDesktop;

  if (!hasVisibleState) {
    return null;
  }

  return (
    <div className={styles.setupView} data-testid="office-sidecar-status-section">
      {isHealthy ? (
        <div className={styles.connectionStatusBannerHealthy} data-testid="office-sidecar-status-running">
          <div className={styles.flexCol}>
            <div className={styles.flexCenter}>
              <Badge variant="success" size="sm">Connected</Badge>
            </div>
            <span className={styles.setupHint}>Office is ready to talk to Rebel.</span>
          </div>
        </div>
      ) : null}

      {isDegraded ? (
        <Notice
          tone="warning"
          placement="inline"
          title="Office is running, but one setup step didn't finish."
          actions={[
            {
              label: 'Learn more',
              variant: 'secondary',
              onClick: handleLearnMore,
            },
          ]}
          data-testid="office-sidecar-status-degraded"
        >
          {status.lastError?.message ?? UNKNOWN_ERROR_MESSAGE}
        </Notice>
      ) : null}

      {isFailed ? (
        <Notice
          tone="error"
          placement="inline"
          role="alert"
          title="Office connection needs attention"
          actions={[
            {
              label: retrying ? 'Trying again...' : 'Try again',
              onClick: () => {
                void handleRetry();
              },
              disabled: retrying,
              loading: retrying,
            },
            {
              label: 'Learn more',
              variant: 'secondary',
              onClick: handleLearnMore,
            },
          ]}
          data-testid="office-sidecar-status-failed"
        >
          {status.lastError?.message ?? UNKNOWN_ERROR_MESSAGE}
        </Notice>
      ) : null}

      {isKillSwitched ? (
        <Notice tone="info" placement="inline" data-testid="office-sidecar-status-kill-switch">
          The Office connection has been turned off for this Rebel installation.
        </Notice>
      ) : null}

      {isSurfaceNonDesktop ? (
        <Notice tone="info" placement="inline" data-testid="office-sidecar-status-surface-not-desktop">
          The Office connection isn&apos;t available here. Use Rebel on desktop to connect with Word, Excel, and PowerPoint.
        </Notice>
      ) : null}

      {(isHealthy || isDegraded || isFailed || isAdopted) ? (
        <div className={styles.advancedSection}>
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setShowAdvanced((current) => !current)}
            aria-expanded={showAdvanced}
            data-testid="office-sidecar-advanced-toggle"
          >
            <ChevronRight
              size={14}
              className={`${styles.advancedChevron} ${showAdvanced ? styles.advancedChevronExpanded : ''}`}
              aria-hidden
            />
            <span className={styles.advancedToggleText}>Advanced</span>
          </button>
          {showAdvanced ? (
            <div
              id="office-sidecar-advanced"
              className={styles.advancedContent}
              data-testid="office-sidecar-advanced-content"
            >
              <div className={styles.flexCol}>
                {(isHealthy || isDegraded) && status.port !== null ? (
                  <span className={styles.setupHint}>port {status.port}</span>
                ) : null}
                {isAdopted ? (
                  <span className={styles.setupHint}>Using another Rebel instance&apos;s sidecar.</span>
                ) : null}
                {(isDegraded || isFailed) ? (
                  <span className={styles.setupHint}>
                    If Office still can&apos;t reach port 52100, another app may be using it.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
