import { useEffect, useRef, useState } from 'react';
import type { HealthStatus } from '@renderer/components/HelpMenu';
import { hasCheckId, isHealthCheckId, type HealthCheckId } from '@shared/ipc/schemas/health';
import { useTimeoutRef } from './useTimeoutRef';
import { useIntervalRef } from './useIntervalRef';

export type DegradedCheck = {
  id: string;
  name: string;
  status: 'warn' | 'fail';
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

interface UseHealthStatusPollingOptions {
  onHealthDegraded?: (checks: DegradedCheck[]) => void;
}

type UseHealthStatusPollingResult = {
  healthStatus: HealthStatus;
  healthIssueCount: number;
  mcpRuntimeHealthDegraded: boolean;
};

/** Only notify for checks users can actually fix via Settings.
 *
 * Media-permission checks (microphonePermission, screenRecordingPermission) are
 * intentionally EXCLUDED: they're diagnostics-only. A denied/restricted state
 * would otherwise toast even for users who never use that feature (mic / local
 * meeting recording) — the same false-nag class as voiceApiKeyValid (REBEL-128).
 * Screen Recording is requested in context at the first local recording, so a
 * denied state surfaces there with a clear error rather than as a global toast. */
const USER_ACTIONABLE_CHECKS: ReadonlySet<HealthCheckId> = new Set([
  'calendarCacheHealth',
  'mcpConfigValid',
  'superMcpHealth',
  'bundledServers',
  'mcpSkippedServers',
  'claudeApiKeyValid',
  // voiceApiKeyValid intentionally excluded — fires on startup even when user doesn't use voice (REBEL-128)
  'authHealth',
  'autoUpdateHealth',
  'workspaceAccessible',
  'oauthRefreshHealth',
  'apiCooldownHealth',
  'mcpRuntimeHealth',
  // Disk-full: surface a user-facing warning toast so the user knows why saves
  // might fail (REBEL — ENOSPC). Rendered as a calm warning (environmental, not
  // an app fault) via ENVIRONMENTAL_WARNING_CHECKS in App.tsx.
  'diskSpace',
]);

/**
 * Cold-start toast policy: what each check does on the FIRST health report
 * after app start when already warn/fail.
 * - 'toast': pre-existing degradation fires the onHealthDegraded toast.
 * - 'suppress': contributes to the glow/issue count but does NOT fire a toast —
 *   pre-existing degraded state at cold-start is information, not an alarm
 *   (AC-9, docs/plans/260511_degraded_state_surfacing.md).
 * Subsequent in-session transitions (pass→warn etc.) still toast via the
 * regular diff path, following each check's CHECK_NOTIFY policy.
 *
 * Current 'suppress' members:
 * - oauthRefreshHealth: the reconnect latch is persisted, so a warn from a
 *   previous session would otherwise re-toast on every launch.
 * - calendarCacheHealth: its warn inputs (needs-reconnect latch, persisted
 *   syncWarnings, stale cache) are all persisted state too — same every-launch
 *   nag without suppression.
 *
 * NEW checks MUST declare a policy here — the exhaustive Record (satisfies
 * Record<HealthCheckId, …>) makes a missing or excess entry a COMPILE error,
 * so a check can no longer default to the noisy behavior silently. Pick
 * 'suppress' whenever the check's warn/fail condition is derived from
 * PERSISTED state that legitimately survives a restart: at cold-start the user
 * has already been told (or will see the glow); only NEW degradations deserve
 * a toast.
 */
type ColdStartToastPolicy = 'toast' | 'suppress';
const COLD_START_TOAST_POLICY = {
  userDataWritable: 'toast',
  workspaceAccessible: 'toast',
  rebelSystemPresent: 'toast',
  systemPromptRenders: 'toast',
  systemPromptCoherence: 'toast',
  safetyPromptExists: 'toast',
  memoryPromptExists: 'toast',
  claudeApiKeyValid: 'toast',
  nodeBundleHealth: 'toast',
  msvcRuntimeHealth: 'toast',
  mcpConfigValid: 'toast',
  bundledServers: 'toast',
  superMcpHealth: 'toast',
  microphonePermission: 'toast',
  // Derived from persisted OS permission state; the common cold-start state is
  // 'not-determined' (mapped to pass — requested on-demand at first local
  // recording), and a denied/restricted warn survives restart rather than being
  // a NEW degradation. Suppress the cold-start toast.
  screenRecordingPermission: 'suppress',
  workspacePathIssues: 'toast',
  envOverrides: 'toast',
  symlinkHealth: 'toast',
  diskSpace: 'toast',
  portAvailable: 'toast',
  voiceApiKeyValid: 'toast',
  anthropicReachable: 'toast',
  rebelSystemSyncStatus: 'toast',
  tempDirectoryHealth: 'toast',
  gitBashHealth: 'toast',
  powerShellHealth: 'toast',
  skillsConvention: 'toast',
  embeddingServiceReady: 'toast',
  semanticIndexHealth: 'toast',
  spaceReadmeSizes: 'toast',
  spaceSharingConfig: 'toast',
  brokenSpaceFrontmatter: 'toast',
  calendarCacheHealth: 'suppress',
  toolIndexHealth: 'toast',
  enhancementHealth: 'toast',
  mcpSkippedServers: 'toast',
  authHealth: 'toast',
  autoUpdateHealth: 'toast',
  inboxHealth: 'toast',
  conversationIndexHealth: 'toast',
  userProfileComplete: 'toast',
  conflictingCopies: 'toast',
  fullDiskAccess: 'toast',
  cloudServiceHealth: 'toast',
  promptFilesExist: 'toast',
  promptFilesRender: 'toast',
  apiCooldownHealth: 'toast',
  oauthRefreshHealth: 'suppress',
  mcpRuntimeHealth: 'toast',
  toolAdvisoryHealth: 'toast',
} satisfies Record<HealthCheckId, ColdStartToastPolicy>;

type CheckNotify = 'on-degrade' | 'on-condition';

/**
 * Per-check notification policy.
 * - 'on-degrade' (default): contributes to glow AND fires the onHealthDegraded
 *   callback (which triggers the toast).
 * - 'on-condition': contributes to glow but does NOT fire the toast — used for
 *   checks where the toast is delivered via a different channel (e.g.
 *   apiCooldownHealth, which uses the event-driven cooldown bridge instead).
 */
const CHECK_NOTIFY: Partial<Record<HealthCheckId, CheckNotify>> = {
  apiCooldownHealth: 'on-condition',
};

function notifyMode(checkId: string): CheckNotify {
  return (isHealthCheckId(checkId) ? CHECK_NOTIFY[checkId] : undefined) ?? 'on-degrade';
}

export const useHealthStatusPolling = (options?: UseHealthStatusPollingOptions): UseHealthStatusPollingResult => {
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('unknown');
  const [healthIssueCount, setHealthIssueCount] = useState(0);
  const [mcpRuntimeHealthDegraded, setMcpRuntimeHealthDegraded] = useState(false);
  const initialDelayTimer = useTimeoutRef();
  const pollingInterval = useIntervalRef();

  // Stable ref for callback to avoid re-creating the polling effect
  const onHealthDegradedRef = useRef(options?.onHealthDegraded);
  onHealthDegradedRef.current = options?.onHealthDegraded;

  // Transition detection refs (persist across polls, never trigger re-renders)
  const previousStatuses = useRef<Map<string, string>>(new Map());
  const notifiedChecks = useRef<Set<string>>(new Set());
  const isFirstReport = useRef(true);

  useEffect(() => {
    const runHealthCheck = async () => {
      try {
        const report = await window.systemHealthApi.healthCheck({ tier: 'quick' });
        const newStatus: HealthStatus =
          report.status === 'healthy' ? 'healthy' : report.status === 'critical' ? 'critical' : 'warn';
        setHealthStatus(newStatus);
        const issues = Object.values(report.checks).filter((c) => c.status === 'fail' || c.status === 'warn');
        setHealthIssueCount(issues.length);
        const mcpRuntime = report.checks.mcpRuntimeHealth;
        setMcpRuntimeHealthDegraded(
          mcpRuntime?.status === 'warn' || mcpRuntime?.status === 'fail',
        );

        // Transition detection: notify on degradations
        if (onHealthDegradedRef.current) {
          const checks = Object.values(report.checks);
          const newlyDegraded: DegradedCheck[] = [];

          if (isFirstReport.current) {
            // First report: notify about any pre-existing failures/warnings.
            // Checks whose COLD_START_TOAST_POLICY is 'suppress' still mark
            // `notifiedChecks` (so subsequent polls don't re-toast) but do NOT
            // trigger the toast.
            isFirstReport.current = false;
            for (const check of checks) {
              if (
                (check.status === 'warn' || check.status === 'fail') &&
                hasCheckId(USER_ACTIONABLE_CHECKS, check.id)
              ) {
                if (
                  COLD_START_TOAST_POLICY[check.id] === 'toast' &&
                  notifyMode(check.id) === 'on-degrade'
                ) {
                  newlyDegraded.push({
                    id: check.id,
                    name: check.name,
                    status: check.status,
                    message: check.message,
                    remediation: check.remediation,
                    details: check.details,
                  });
                }
                notifiedChecks.current.add(check.id);
              }
            }
          } else {
            // Subsequent reports: diff against previous statuses
            for (const check of checks) {
              const prev = previousStatuses.current.get(check.id);

              // Clear notified set for checks that recovered to pass
              if (check.status === 'pass' && notifiedChecks.current.has(check.id)) {
                notifiedChecks.current.delete(check.id);
              }

              // Detect degradation transitions (pass/skip->warn, pass/skip->fail, warn->fail)
              if (
                check.status !== 'skip' &&
                (check.status === 'warn' || check.status === 'fail') &&
                hasCheckId(USER_ACTIONABLE_CHECKS, check.id) &&
                !notifiedChecks.current.has(check.id) &&
                prev !== undefined &&
                prev !== check.status &&
                (prev === 'pass' || prev === 'skip' || (prev === 'warn' && check.status === 'fail'))
              ) {
                if (notifyMode(check.id) === 'on-degrade') {
                  newlyDegraded.push({
                    id: check.id,
                    name: check.name,
                    status: check.status,
                    message: check.message,
                    remediation: check.remediation,
                    details: check.details,
                  });
                }
                notifiedChecks.current.add(check.id);
              }
            }
          }

          // Update previous statuses for next comparison
          for (const check of checks) {
            previousStatuses.current.set(check.id, check.status);
          }

          if (newlyDegraded.length > 0) {
            onHealthDegradedRef.current(newlyDegraded);
          }
        }
      } catch {
        // Silently fail - don't disrupt the app for health check failures
      }
    };

    // Delay first check by 10s to let services initialize (Super-MCP, etc.)
    initialDelayTimer.set(() => {
      void runHealthCheck();
    }, 10_000);

    // Re-check every 3 minutes (reduced from 60s to minimize main thread blocking)
    // Health status rarely changes during normal operation, and the 2-3s check duration
    // was causing noticeable UI lag every minute
    pollingInterval.set(runHealthCheck, 180_000);
  }, [initialDelayTimer, pollingInterval]);

  return { healthStatus, healthIssueCount, mcpRuntimeHealthDegraded };
};
