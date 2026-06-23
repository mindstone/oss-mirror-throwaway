import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FileText, Package } from 'lucide-react';
import {
  Badge,
  Button,
  DecisionCardGroup,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui';
import type { DecisionCardOption } from '@renderer/components/ui';
import { useAppContext } from '@renderer/contexts';
import { WhatsNewDialog } from '@renderer/components/WhatsNewDialog';
import styles from '../SettingsSurface.module.css';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import { RecentDiagnosticActivitySection } from '../diagnostics/RecentDiagnosticActivitySection';
import { ProviderReachabilitySection } from '../diagnostics/ProviderReachabilitySection';
import type { DiagnosticsTabProps } from './types';
import type { SystemHealthReport, CheckResult } from '@shared/ipc/contracts';
import type { SafeModeContext } from '@shared/types';
import { formatVersionWithChannel } from '@shared/utils/versionDisplay';
import { SuperMcpRestartButton } from './SuperMcpRestartButton';

type DiagnosticExportFormat = 'standard' | 'detailed';

const diagnosticExportOptions: DecisionCardOption<DiagnosticExportFormat>[] = [
  {
    id: 'standard',
    icon: FileText,
    title: 'Standard (.md)',
    badge: (
      <span className={styles.diagExportDecisionBadge}>
        <Badge variant="muted" size="sm">Recommended</Badge>
      </span>
    ),
    description: 'Safe for external support. Contains health checks, settings, and logs only.',
    selectedContent: (
      <p className={styles.diagExportSelectedDetails}>
        Includes redacted settings, MCP configuration, recent session IDs, and the last 15 minutes of logs.
      </p>
    ),
    footer: 'No conversation content',
  },
  {
    id: 'detailed',
    icon: Package,
    title: 'Detailed (.zip)',
    badge: (
      <span className={styles.diagExportDecisionBadge}>
        <Badge variant="muted" size="sm">Review before sharing</Badge>
      </span>
    ),
    description: 'Full diagnostic data for complex issues. Includes conversation context and automation history.',
    selectedContent: (
      <ul className={styles.diagExportSelectedList}>
        <li>Everything in Standard, plus session excerpts, profile configuration, tool usage, and cost ledger data.</li>
        <li>May contain business context and personal information. Review it before sharing externally.</li>
      </ul>
    ),
    footer: 'More complete, more sensitive',
  },
];

type UpdateCheckStatus = 
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; version: string }
  | { state: 'update-available'; currentVersion: string; latestVersion: string; downloadUrl?: string }
  | { state: 'error'; message: string };

function compareVersions(current: string, latest: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] || 0;
    const lv = l[i] || 0;
    if (cv < lv) return -1;
    if (cv > lv) return 1;
  }
  return 0;
}

function isValidSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version.replace(/^v/, ''));
}

function getPlatformKey(): string {
  const platform = window.electronEnv?.platform;
  const arch = window.electronEnv?.arch;
  if (!platform || !arch) {
    console.error('[DiagnosticsTab] Platform detection failed - electronEnv is missing platform or arch');
    return '';
  }
  if (platform === 'darwin') return `mac-${arch}`;
  if (platform === 'win32') return `win-${arch}`;
  if (platform === 'linux') return `linux-${arch}`;
  return `${platform}-${arch}`;
}

export const DiagnosticsTab = ({
  draftSettings,
  updateDraft,
  onRelaunchOnboarding,
  onResetOnboardingChecklist,
}: DiagnosticsTabProps) => {
  const { showToast } = useAppContext();
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>({ state: 'idle' });
  const [healthReport, setHealthReport] = useState<SystemHealthReport | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [showPassedChecks, setShowPassedChecks] = useState(false);
  const [showSkippedChecks, setShowSkippedChecks] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<DiagnosticExportFormat>('standard');
  const [safeModeState, setSafeModeState] = useState<SafeModeContext | null>(null);
  const [safeModeLoading, setSafeModeLoading] = useState(false);
  const [showSafeModeConfirm, setShowSafeModeConfirm] = useState(false);

  const currentVersion = window.electronEnv?.appVersion || 'unknown';
  const buildChannel = window.electronEnv?.buildChannel;
  const displayVersion = formatVersionWithChannel(currentVersion, buildChannel);

  // Load Safe Mode state on mount
  useEffect(() => {
    window.appApi.safeModeState().then(setSafeModeState).catch(console.error);
  }, []);

  const handleEnterSafeMode = useCallback(async () => {
    setSafeModeLoading(true);
    try {
      await window.appApi.enterSafeMode({ reason: 'user' });
      // App will restart, no need to reset state
    } catch (error) {
      console.error('Failed to enter safe mode:', error);
      showToast({ title: 'Failed to enter Safe Mode' });
      setSafeModeLoading(false);
    }
  }, [showToast]);

  const handleExitSafeMode = useCallback(async () => {
    setSafeModeLoading(true);
    try {
      await window.appApi.exitSafeMode();
      // App will restart, no need to reset state
    } catch (error) {
      console.error('Failed to exit safe mode:', error);
      showToast({ title: 'Failed to exit Safe Mode' });
      setSafeModeLoading(false);
    }
  }, [showToast]);

  const updateDiagnostics = useCallback((key: 'developerMode', value: boolean) => {
    updateDraft('diagnostics', {
      ...draftSettings.diagnostics,
      [key]: value,
    });
  }, [draftSettings.diagnostics, updateDraft]);

  const handleRunHealthCheck = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const report = await window.systemHealthApi.healthCheck({ tier: 'full' });
      setHealthReport(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setHealthError(message);
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const handleCopyHealthReport = useCallback(async () => {
    try {
      const { markdown } = await window.systemHealthApi.healthExport();
      await navigator.clipboard.writeText(markdown);
      showToast({ title: 'Report copied to clipboard' });
    } catch (error) {
      console.error('Failed to copy health report:', error);
      showToast({ title: 'Failed to copy report' });
    }
  }, [showToast]);

  const [downloading, setDownloading] = useState(false);

  const handleDownloadDiagnostics = useCallback(async () => {
    setDownloading(true);
    // Defense-in-depth: the main process bounds bundle assembly with its own
    // deadline (Stage 2), but if the IPC round-trip itself never settles this
    // handler would leave `downloading:true` forever ("stuck on preparing").
    // Race the invoke against a renderer-side timeout so it ALWAYS resolves.
    const RENDERER_EXPORT_TIMEOUT_MS = 45000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const withTimeout = <T,>(work: Promise<T>): Promise<T> => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Diagnostics export timed out')),
          RENDERER_EXPORT_TIMEOUT_MS,
        );
      });
      return Promise.race([work, timeoutPromise]);
    };
    try {
      if (exportFormat === 'standard') {
        // Standard format: Markdown with minimal data (safer for external sharing)
        const result = await withTimeout(window.systemHealthApi.healthExportWithLogs({
          logWindowMinutes: 15,
        }));

        if (!result.content || !result.filename) {
          throw new Error('Failed to generate diagnostic report');
        }

        const blob = new Blob([result.content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast({ title: 'Diagnostic report downloaded', variant: 'success' });
      } else {
        // Detailed format: ZIP with comprehensive data
        const result = await withTimeout(window.systemHealthApi.healthExportZip({
          logWindowMinutes: 15,
        }));

        if (!result.success || !result.data || !result.filename) {
          throw new Error(result.error || 'Failed to generate diagnostic bundle');
        }

        const blob = new Blob([result.data], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (result.partial) {
          showToast({
            title: 'Partial diagnostic bundle downloaded',
            description: 'Some sections were unavailable, but the rest is included.',
            variant: 'warning',
          });
        } else {
          showToast({ title: 'Diagnostic bundle downloaded', variant: 'success' });
        }
      }
    } catch (error) {
      console.error('Failed to download diagnostics:', error);
      showToast({ title: 'Failed to download diagnostics', variant: 'error' });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      setDownloading(false);
    }
  }, [showToast, exportFormat]);

  const handleCheckForUpdates = useCallback(async () => {
    setUpdateStatus({ state: 'checking' });

    try {
      // First try the native auto-updater (will trigger download dialog if update found)
      const autoUpdateResult = await window.miscApi.checkForUpdates();
      
      if (autoUpdateResult.available && autoUpdateResult.version) {
        // Auto-updater found an update with version info - use it directly
        setUpdateStatus({
          state: 'update-available',
          currentVersion,
          latestVersion: autoUpdateResult.version,
        });
        return;
      }
      // If auto-updater found update but no version, continue to manifest check to get version

      // No update via auto-updater, check manifest for version comparison
      const manifestResult = await window.miscApi.fetchUpdateManifest();
      
      if (!manifestResult.success || !manifestResult.manifest) {
        // If we can't fetch manifest but auto-updater said no updates, assume up-to-date
        if (!autoUpdateResult.error) {
          setUpdateStatus({ state: 'up-to-date', version: currentVersion });
        } else {
          setUpdateStatus({ state: 'error', message: manifestResult.error || 'Unable to check for updates' });
        }
        return;
      }

      const manifest = manifestResult.manifest;
      const comparison = compareVersions(currentVersion, manifest.version);

      if (comparison < 0) {
        // There's a newer version available
        const platformKey = getPlatformKey();
        if (!platformKey) {
          // Platform detection failed - show error instead of broken download link
          setUpdateStatus({
            state: 'error',
            message: 'Unable to detect your platform. Please download manually from mindstone.ai',
          });
          return;
        }
        const platformInfo = manifest.platforms[platformKey];
        setUpdateStatus({
          state: 'update-available',
          currentVersion,
          latestVersion: manifest.version,
          downloadUrl: platformInfo?.url,
        });
      } else {
        setUpdateStatus({ state: 'up-to-date', version: currentVersion });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setUpdateStatus({ state: 'error', message });
    }
  }, [currentVersion]);

  const getStatusColor = (status: 'healthy' | 'degraded' | 'critical') => {
    switch (status) {
      case 'healthy': return 'var(--color-success)';
      case 'degraded': return 'var(--color-warning)';
      case 'critical': return 'var(--color-destructive)';
    }
  };

  const getCheckStatusColor = (status: 'pass' | 'warn' | 'fail' | 'skip') => {
    switch (status) {
      case 'pass': return 'var(--color-success)';
      case 'warn': return 'var(--color-warning)';
      case 'fail': return 'var(--color-destructive)';
      case 'skip': return 'var(--color-text-muted)';
    }
  };

  const getCheckStatusIcon = (status: 'pass' | 'warn' | 'fail' | 'skip') => {
    switch (status) {
      case 'pass': return '\u2713';
      case 'warn': return '\u26A0';
      case 'fail': return '\u2717';
      case 'skip': return '\u2014';
    }
  };

  const renderCheckResult = (check: CheckResult, compact = false) => {
    // Extract coherence issues if present
    const coherenceIssues = check.details?.issues as Array<{
      type: 'repetition' | 'contradiction' | 'flow';
      severity: 'low' | 'medium' | 'high';
      description: string;
    }> | undefined;

    const getSeverityColor = (severity: 'low' | 'medium' | 'high') => {
      switch (severity) {
        case 'high': return 'var(--color-destructive)';
        case 'medium': return 'var(--color-warning)';
        default: return 'var(--color-text-muted)';
      }
    };

    const checkResultClassName = compact
      ? `${styles.diagCheckResult} ${styles.diagCheckResultCompact}`
      : styles.diagCheckResult;

    return (
      <div
        key={check.id}
        className={checkResultClassName}
        style={{ borderLeftColor: getCheckStatusColor(check.status) }}
      >
        <div className={styles.diagCheckHeader}>
          <span className={styles.diagCheckStatusIcon} style={{ color: getCheckStatusColor(check.status) }}>
            {getCheckStatusIcon(check.status)}
          </span>
          <span className={styles.diagCheckName}>{check.name}</span>
          {compact && <span className={styles.diagCheckCompactMessage}>{check.message}</span>}
        </div>
        {!compact && <p className={styles.diagCheckMessage}>{check.message}</p>}
        {/* Show coherence issues if present */}
        {!compact && coherenceIssues && coherenceIssues.length > 0 && (
          <div className={styles.diagCoherenceIssues}>
            {coherenceIssues.map((issue, idx) => (
              <div key={idx} className={styles.diagCoherenceIssue}>
                <span className={styles.diagCoherenceIssueTag} style={{ color: getSeverityColor(issue.severity) }}>
                  [{issue.severity}] {issue.type}
                </span>
                <span className={styles.diagCoherenceIssueDescription}>{issue.description}</span>
              </div>
            ))}
          </div>
        )}
        {check.remediation && check.status !== 'pass' && (
          <p className={styles.diagCheckRemediation}>
            Fix: {check.remediation}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        data-section="supportDiagnostics"
        data-focus-target-section="systemHealth"
        data-testid="settings-section-support-diagnostics"
      >
        <SettingSection
          title="System Health"
          description="Run a comprehensive diagnostic check of your system configuration."
          data-section="systemHealth"
        >
          <div className={styles.flexColLarge}>
          {!healthReport && !healthLoading && !healthError && (
            <>
              <p className={`${styles.diagInfoText} ${styles.diagInfoTextSpacingSm}`}>
                Check your workspace, API keys, MCP configuration, and system permissions.
              </p>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleRunHealthCheck()}
              >
                Run System Check
              </Button>
            </>
          )}

          {healthLoading && (
            <p className={styles.diagInfoText}>
              Running diagnostics...
            </p>
          )}

          {healthError && (
            <>
              <p className={`${styles.diagStatusMessage} ${styles.diagStatusError}`}>
                Health check failed: {healthError}
              </p>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleRunHealthCheck()}
              >
                Try again
              </Button>
            </>
          )}

          {healthReport && (() => {
            const checks = Object.values(healthReport.checks);
            const failedChecks = checks.filter((c): c is CheckResult => c.status === 'fail');
            const warnChecks = checks.filter((c): c is CheckResult => c.status === 'warn');
            const passedChecks = checks.filter((c): c is CheckResult => c.status === 'pass');
            const skippedChecks = checks.filter((c): c is CheckResult => c.status === 'skip');
            const issueCount = failedChecks.length + warnChecks.length;

            return (
              <>
                <div className={styles.diagHealthSummary}>
                  <span
                    className={styles.diagHealthStatusDot}
                    style={{ backgroundColor: getStatusColor(healthReport.status) }}
                  />
                  <span className={styles.diagHealthSummaryStatus} style={{ color: getStatusColor(healthReport.status) }}>
                    {healthReport.status === 'healthy' ? 'All Systems Healthy' :
                     healthReport.status === 'degraded' ? `${issueCount} Issue${issueCount > 1 ? 's' : ''} Detected` : 
                     'Critical Issues Found'}
                  </span>
                  <span className={styles.diagHealthSummaryMeta}>
                    ({passedChecks.length} passed)
                  </span>
                </div>

                {/* Show issues prominently */}
                {(failedChecks.length > 0 || warnChecks.length > 0) && (
                  <div className={styles.diagCollapsibleSection}>
                    {failedChecks.map(c => renderCheckResult(c))}
                    {warnChecks.map(c => renderCheckResult(c))}
                  </div>
                )}

                {/* Collapsible passed checks */}
                {passedChecks.length > 0 && (
                  <div className={styles.diagCollapsibleSection}>
                    <button
                      type="button"
                      onClick={() => setShowPassedChecks(!showPassedChecks)}
                      className={styles.diagCollapsibleToggle}
                    >
                      <span className={`${styles.diagChevron} ${showPassedChecks ? styles.diagChevronExpanded : ''}`}>
                        ▶
                      </span>
                      {showPassedChecks ? 'Hide' : 'Show'} {passedChecks.length} passed checks
                    </button>
                    {showPassedChecks && (
                      <div className={styles.diagCollapsibleContent}>
                        {passedChecks.map(c => renderCheckResult(c, true))}
                      </div>
                    )}
                  </div>
                )}

                {/* Collapsible skipped checks */}
                {skippedChecks.length > 0 && (
                  <div className={styles.diagCollapsibleSection}>
                    <button
                      type="button"
                      onClick={() => setShowSkippedChecks(!showSkippedChecks)}
                      className={styles.diagCollapsibleToggle}
                    >
                      <span className={`${styles.diagChevron} ${showSkippedChecks ? styles.diagChevronExpanded : ''}`}>
                        ▶
                      </span>
                      {showSkippedChecks ? 'Hide' : 'Show'} {skippedChecks.length} skipped checks
                    </button>
                    {showSkippedChecks && (
                      <div className={styles.diagCollapsibleContent}>
                        {skippedChecks.map(c => renderCheckResult(c, true))}
                      </div>
                    )}
                  </div>
                )}

                <div className={styles.actionButtonGroup}>
                  <Button
                    variant="outline"
                    size="lg"
                    className={styles.actionButton}
                    onClick={() => void handleRunHealthCheck()}
                  >
                    Re-run
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    className={styles.actionButton}
                    onClick={() => void handleCopyHealthReport()}
                  >
                    Copy Report
                  </Button>
                </div>
              </>
            );
          })()}

          {/* Export Format Selector - always visible */}
          <div className={styles.diagExportSection}>
            <div className={styles.diagExportLabel}>
              Download Diagnostic Logs
            </div>
            <DecisionCardGroup
              aria-label="Diagnostic log download format"
              options={diagnosticExportOptions}
              value={exportFormat}
              onValueChange={setExportFormat}
              className={styles.diagExportDecisionGroup}
            />
                  
            <Button
              variant="outline"
              size="lg"
              className={styles.actionButton}
              onClick={() => void handleDownloadDiagnostics()}
              disabled={downloading}
            >
              {downloading ? 'Preparing...' : `Download ${exportFormat === 'standard' ? 'Report' : 'Bundle'}`}
            </Button>
          </div>
          </div>
        </SettingSection>
      </div>

      <SettingSection
        title="Tools Connection"
        description="Restart the tools connection if apps and actions are unavailable."
        data-section="toolsConnection"
      >
        <div className={styles.flexColLarge}>
          <p className={`${styles.diagInfoText} ${styles.diagInfoTextSpacingSm}`}>
            This waits for active turns to finish before reconnecting tools.
          </p>
          <SuperMcpRestartButton />
        </div>
      </SettingSection>

      <ProviderReachabilitySection activeProvider={draftSettings.activeProvider} />

      <RecentDiagnosticActivitySection />

      <SettingSection
        title="App Updates"
        description="Check for and install the latest version of the app."
        data-section="appUpdates"
      >
        <div className={styles.flexColLarge}>
          <SettingRow label="Current version">
            <span className={styles.diagInlineValue}>
              v{displayVersion}
            </span>
          </SettingRow>
          <div className={styles.diagButtonRow}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWhatsNewOpen(true)}
            >
              View changelog
            </Button>
          </div>
          
          {updateStatus.state === 'idle' && (
            <Button
              variant="outline"
              size="lg"
              className={styles.actionButton}
              onClick={() => void handleCheckForUpdates()}
            >
              Check for updates
            </Button>
          )}
          
          {updateStatus.state === 'checking' && (
            <p className={styles.diagInfoText}>
              Checking for updates...
            </p>
          )}
          
          {updateStatus.state === 'up-to-date' && (
            <>
              <p className={`${styles.diagStatusMessage} ${styles.diagStatusSuccess}`}>
                You are running the latest version.
              </p>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleCheckForUpdates()}
              >
                Check again
              </Button>
            </>
          )}
          
          {updateStatus.state === 'update-available' && (
            <>
              <p className={`${styles.diagStatusMessage} ${styles.diagStatusWarning}`}>
                {isValidSemver(updateStatus.latestVersion)
                  ? `A new version is available: v${updateStatus.latestVersion.replace(/^v/, '')}`
                  : 'A new version is available'}
              </p>
              {updateStatus.downloadUrl ? (
                <Button
                  variant="outline"
                  size="lg"
                  className={styles.actionButton}
                  onClick={() => {
                    if (updateStatus.downloadUrl) {
                      void window.appApi.openUrl(updateStatus.downloadUrl);
                    }
                  }}
                >
                  Download update
                </Button>
              ) : (
                <p className={styles.diagInfoText}>
                  The update should begin downloading automatically. If prompted, restart to apply.
                </p>
              )}
            </>
          )}
          
          {updateStatus.state === 'error' && (
            <>
              <p className={`${styles.diagStatusMessage} ${styles.diagStatusError}`}>
                Failed to check for updates: {updateStatus.message}
              </p>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleCheckForUpdates()}
              >
                Try again
              </Button>
            </>
          )}
        </div>
      </SettingSection>

      <SettingSection
        title="Safe Mode"
        description="Start with tools disabled for troubleshooting. All other features remain accessible."
        data-section="safeMode"
      >
        <div className={styles.flexColLarge}>
          {safeModeState?.isEnabled ? (
            <>
              <div className={styles.diagSafeModeAlert}>
                <AlertTriangle size={18} className={styles.diagSafeModeAlertIcon} />
                <div>
                  <p className={styles.diagSafeModeAlertTitle}>
                    Safe Mode is active
                  </p>
                  <p className={styles.diagSafeModeAlertDescription}>
                    Tools are disabled. Exit Safe Mode to restore full functionality.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleExitSafeMode()}
                disabled={safeModeLoading}
              >
                {safeModeLoading ? 'Restarting...' : 'Exit Safe Mode'}
              </Button>
            </>
          ) : (
            <>
              <p className={`${styles.diagInfoText} ${styles.diagInfoTextSpacingMd}`}>
                If you&apos;re experiencing issues with tools, enter Safe Mode to access Settings and Diagnostics for troubleshooting. The app will restart.
              </p>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => setShowSafeModeConfirm(true)}
                disabled={safeModeLoading || safeModeState === null}
              >
                {safeModeState === null ? 'Loading...' : 'Enter Safe Mode'}
              </Button>
            </>
          )}
        </div>
      </SettingSection>

      {/* Safe Mode Confirmation Dialog */}
      <Dialog open={showSafeModeConfirm} onOpenChange={setShowSafeModeConfirm}>
        <DialogContent size="sm">
          <DialogHeader icon={<AlertTriangle size={24} className="text-amber-500" />}>
            <DialogTitle>Enter Safe Mode?</DialogTitle>
            <DialogDescription>
              The app will restart with tools disabled.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-secondary-foreground">
              Safe Mode allows you to access all app features except tools. This is useful for
              troubleshooting issues with MCP servers or tool configurations. You can exit Safe Mode
              anytime from Settings.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSafeModeConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setShowSafeModeConfirm(false);
                void handleEnterSafeMode();
              }}
              disabled={safeModeLoading}
            >
              {safeModeLoading ? 'Restarting...' : 'Enter Safe Mode'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingSection
        title="Onboarding & Actions"
        description="Relaunch the guided setup or reset your onboarding progress."
        data-section="onboarding"
      >
        <div className={styles.flexColLarge}>
          <SettingRow
            label="Full onboarding"
            description="Restart the complete onboarding experience from the beginning."
            variant="stacked"
          >
            <Button variant="outline" size="lg" className={styles.actionButton} onClick={onRelaunchOnboarding}>
              Restart full onboarding
            </Button>
          </SettingRow>

          <SettingRow
            label="Onboarding checklist"
            description="Reset just the checklist to step 1 without restarting the full wizard."
            variant="stacked"
          >
            <Button variant="outline" size="lg" className={styles.actionButton} onClick={onResetOnboardingChecklist}>
              Reset checklist
            </Button>
          </SettingRow>
        </div>
      </SettingSection>

      <SettingSection
        advanced
        title="Advanced"
        description="Enable developer-only settings in a separate tab."
        data-section="diagnosticsAdvanced"
      >
        <SettingRow label="Developer mode" tooltip="Show advanced developer settings tab">
          <input
            type="checkbox"
            checked={draftSettings.diagnostics?.developerMode ?? false}
            onChange={(e) => updateDiagnostics('developerMode', e.target.checked)}
          />
        </SettingRow>
      </SettingSection>

      <WhatsNewDialog
        open={whatsNewOpen}
        onOpenChange={setWhatsNewOpen}
        currentVersion={currentVersion}
      />
    </>
  );
};
