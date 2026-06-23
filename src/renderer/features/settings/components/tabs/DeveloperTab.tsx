import { useCallback, useEffect, useState } from 'react';
import { Button } from '@renderer/components/ui';
import { useAppContext } from '@renderer/contexts';
import { DemoModeDialog } from '@renderer/components/DemoModeDialog';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import styles from '../SettingsSurface.module.css';
import type { DeveloperTabProps } from './types';
import type { AnalyticsStatusPayload, McpConfigSummary, TelemetrySettings } from '@shared/types';
import { rendererIsOss } from '../../../../src/rendererIsOss';
import { SuperMcpRestartButton } from './SuperMcpRestartButton';

import { DEFAULT_SYSTEM_SKILL_PATHS } from '@shared/systemSkills';

interface FrequentToolInfo {
  toolName: string;
  shortName: string;
  usageCount: number;
}

type SystemSkillKey = 'safetyGuardPath' | 'memoryUpdatePath';

export const DeveloperTab = ({
  draftSettings,
  updateDraft,
}: DeveloperTabProps) => {
  const { showToast } = useAppContext();

  const [demoModeActive, setDemoModeActive] = useState(false);
  const [demoModeDialogOpen, setDemoModeDialogOpen] = useState(false);

  const [mcpSummary, setMcpSummary] = useState<McpConfigSummary | null>(null);
  const [mcpSummaryLoading, setMcpSummaryLoading] = useState(false);

  const [analyticsStatus, setAnalyticsStatus] = useState<AnalyticsStatusPayload | null>(null);
  const [analyticsStatusLoading, setAnalyticsStatusLoading] = useState(false);

  const [frequentTools, setFrequentTools] = useState<FrequentToolInfo[]>([]);
  const [frequentToolsLoading, setFrequentToolsLoading] = useState(false);
  const [frequentToolsResetting, setFrequentToolsResetting] = useState(false);

  useEffect(() => {
    window.demoApi.status().then((status) => setDemoModeActive(status.active));
    const unsubscribe = window.api.onDemoModeChange((data) => setDemoModeActive(data.active));
    return () => unsubscribe();
  }, []);

  const loadFrequentTools = useCallback(async () => {
    setFrequentToolsLoading(true);
    try {
      const tools = await window.settingsApi.getFrequentTools();
      setFrequentTools(tools);
    } catch (error) {
      console.error('Failed to load frequent tools:', error);
    } finally {
      setFrequentToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFrequentTools();
  }, [loadFrequentTools]);

  const loadMcpSummary = useCallback(async () => {
    setMcpSummaryLoading(true);
    try {
      const summary = await window.settingsApi.mcpSummary({ skipMetadata: true });
      setMcpSummary(summary);
    } catch (error) {
      console.error('Failed to load MCP summary:', error);
      setMcpSummary(null);
    } finally {
      setMcpSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMcpSummary();
  }, [loadMcpSummary]);

  const loadAnalyticsStatus = useCallback(async () => {
    setAnalyticsStatusLoading(true);
    try {
      const status = await window.api.getAnalyticsStatus();
      setAnalyticsStatus(status);
    } catch (error) {
      console.error('Failed to load analytics status:', error);
      setAnalyticsStatus(null);
    } finally {
      setAnalyticsStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAnalyticsStatus();
  }, [loadAnalyticsStatus]);

  const updateDiagnostics = useCallback(
    (key: 'forceDirectMcp', value: boolean) => {
      updateDraft('diagnostics', {
        ...draftSettings.diagnostics,
        [key]: value,
      });
    },
    [draftSettings.diagnostics, updateDraft],
  );

  const handleForceDirectMcpToggle = useCallback(() => {
    const current = draftSettings.diagnostics?.forceDirectMcp ?? false;
    updateDiagnostics('forceDirectMcp', !current);
  }, [draftSettings.diagnostics?.forceDirectMcp, updateDiagnostics]);

  const updateTelemetry = useCallback(
    (key: keyof TelemetrySettings, value: TelemetrySettings[keyof TelemetrySettings]) => {
      updateDraft('telemetry', {
        enabled: draftSettings.telemetry?.enabled ?? false,
        ...draftSettings.telemetry,
        [key]: value,
      });
    },
    [draftSettings.telemetry, updateDraft],
  );

  const handleTelemetryToggle = useCallback(() => {
    const current = draftSettings.telemetry?.enabled ?? false;
    updateTelemetry('enabled', !current);
  }, [draftSettings.telemetry?.enabled, updateTelemetry]);

  const handleResetFrequentTools = useCallback(async () => {
    setFrequentToolsResetting(true);
    try {
      const result = await window.settingsApi.resetToolUsage();
      if (result.success) {
        await loadFrequentTools();
        showToast({ title: 'Tool usage statistics reset' });
      } else {
        showToast({ title: 'Failed to reset - store may be in read-only mode' });
      }
    } catch (error) {
      console.error('Failed to reset tool usage:', error);
      showToast({ title: 'Failed to reset tool usage' });
    } finally {
      setFrequentToolsResetting(false);
    }
  }, [loadFrequentTools, showToast]);

  const handleChooseSystemSkill = useCallback(
    async (key: SystemSkillKey) => {
      const coreDir = draftSettings.coreDirectory;
      if (!coreDir) {
        showToast({ title: 'Configure Library directory first' });
        return;
      }

      const selection = await window.settingsApi.chooseFileInDirectory({
        baseDir: `${coreDir}/rebel-system`,
        filters: [
          { name: 'Skill files', extensions: ['md'] },
          { name: 'All files', extensions: ['*'] },
        ],
        returnRelative: true,
      });

      if (!selection) {
        return;
      }

      updateDraft('systemSkills', {
        ...draftSettings.systemSkills,
        [key]: selection,
      });
    },
    [draftSettings.coreDirectory, draftSettings.systemSkills, showToast, updateDraft],
  );

  return (
    <>
      <div
        data-section="developerTools"
        data-focus-target-section="demoMode"
        data-testid="settings-section-developer-tools"
      >
        <SettingSection
          title="Demo Mode"
          description="Enter a demonstration mode with preset data for showcasing the app."
          data-section="demoMode"
        >
          <SettingRow
            label="Demo mode"
            tooltip="Starts a sandbox session with preset conversation data for demos. Your real session data stays untouched."
            variant="stacked"
          >
            {demoModeActive ? (
              <p className={`${styles.developerInfoText} ${styles.developerInfoTextSpacingMd} ${styles.developerInfoTextSuccess}`}>
                Demo mode is currently active. Conversation data is simulated.
              </p>
            ) : (
              <p className={`${styles.developerInfoText} ${styles.developerInfoTextSpacingMd}`}>
                Enter demo mode to showcase the app with preset conversation data. Your real conversations will be preserved.
              </p>
            )}
            {!demoModeActive && (
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => setDemoModeDialogOpen(true)}
              >
                Enter Demo Mode
              </Button>
            )}
          </SettingRow>
        </SettingSection>
      </div>

      <SettingSection
        title="Developer Debug"
        description="Advanced debugging options for MCP tool integration."
        data-section="developerDebug"
      >
        <div className={styles.flexColLarge}>
          <SettingRow
            label="MCP mode"
            tooltip="By default, MCP tools go through Super-MCP routing. Enable direct mode only to debug routing-specific issues."
            description="By default, all MCP tools are routed through Super-MCP for improved session compacting and concurrent stability."
            variant="stacked"
          >
            <div className={styles.developerMcpModeRow}>
              <input
                type="checkbox"
                id="forceDirectMcp"
                checked={draftSettings.diagnostics?.forceDirectMcp ?? false}
                onChange={handleForceDirectMcpToggle}
                className={styles.developerMcpModeCheckbox}
              />
              <label htmlFor="forceDirectMcp" className={styles.developerMcpModeLabel}>
                Force direct MCP mode (bypass Super-MCP router)
              </label>
            </div>
          </SettingRow>

          <SuperMcpRestartButton onRestarted={loadMcpSummary} />

          <SettingRow
            label="MCP configuration"
            tooltip="Shows the active MCP config source, merged config files, and direct/upstream server counts."
            variant="stacked"
          >
            {mcpSummaryLoading ? (
              <p className={styles.developerInfoText}>Loading...</p>
            ) : mcpSummary ? (
              <div className={styles.developerMcpSummary}>
                <p className={styles.developerMcpSummaryLine}>
                  <strong>Primary config:</strong>{' '}
                  <code className={styles.developerInlineCode}>
                    {mcpSummary.configPath || 'None'}
                  </code>
                </p>
                <p className={styles.developerMcpSummaryLine}>
                  <strong>Mode:</strong> {mcpSummary.mode}
                  {mcpSummary.router?.isRunning && ` (HTTP port ${mcpSummary.router.port})`}
                </p>
                {mcpSummary.router?.configPaths && mcpSummary.router.configPaths.length > 0 && (
                  <div className={styles.developerMcpMergedConfigs}>
                    <p className={styles.developerMcpSummaryLine}><strong>Merged configs ({mcpSummary.router.configPaths.length}):</strong></p>
                    <ul className={styles.developerMcpConfigList}>
                      {mcpSummary.router.configPaths.map((configPath) => (
                        <li key={configPath} className={styles.developerMcpConfigListItem}>
                          <code className={`${styles.developerInlineCode} ${styles.developerInlineCodeBreak}`}>
                            {configPath}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className={styles.developerMcpSummaryFootnote}>
                  <strong>Servers:</strong> {mcpSummary.editableServers?.length ?? mcpSummary.servers?.length ?? 0} direct
                  {mcpSummary.upstreamCount > 0 && `, ${mcpSummary.upstreamCount} upstream`}
                </p>
              </div>
            ) : (
              <p className={styles.developerInfoText}>No MCP configuration loaded</p>
            )}
          </SettingRow>
        </div>
      </SettingSection>

      <SettingSection
        title="Advanced Overrides"
        description="Power-user options for customizing system behavior."
        data-section="advancedOverrides"
      >
        <div className={styles.flexColLarge}>
          <SettingRow
            label="Safety Guard skill path"
            description="Path to the safety evaluation skill, relative to rebel-system."
            variant="stacked"
            htmlFor="safety-guard-skill"
          >
            <div className={styles.filePathRow}>
              <input
                id="safety-guard-skill"
                value={draftSettings.systemSkills?.safetyGuardPath ?? ''}
                placeholder={DEFAULT_SYSTEM_SKILL_PATHS.safetyGuard}
                onChange={(event) => updateDraft('systemSkills', {
                  ...draftSettings.systemSkills,
                  safetyGuardPath: event.target.value || null,
                })}
              />
              <Button
                variant="ghost"
                className={styles.minWidthAuto}
                onClick={() => void handleChooseSystemSkill('safetyGuardPath')}
              >
                Choose...
              </Button>
              {draftSettings.systemSkills?.safetyGuardPath && (
                <Button
                  variant="ghost"
                  className={styles.minWidthAuto}
                  onClick={() => updateDraft('systemSkills', {
                    ...draftSettings.systemSkills,
                    safetyGuardPath: null,
                  })}
                >
                  Clear
                </Button>
              )}
            </div>
          </SettingRow>

          <SettingRow
            label="Memory Update skill path"
            description="Path to the memory update skill, relative to rebel-system."
            variant="stacked"
            htmlFor="memory-update-skill"
          >
            <div className={styles.filePathRow}>
              <input
                id="memory-update-skill"
                value={draftSettings.systemSkills?.memoryUpdatePath ?? ''}
                placeholder={DEFAULT_SYSTEM_SKILL_PATHS.memoryUpdate}
                onChange={(event) => updateDraft('systemSkills', {
                  ...draftSettings.systemSkills,
                  memoryUpdatePath: event.target.value || null,
                })}
              />
              <Button
                variant="ghost"
                className={styles.minWidthAuto}
                onClick={() => void handleChooseSystemSkill('memoryUpdatePath')}
              >
                Choose...
              </Button>
              {draftSettings.systemSkills?.memoryUpdatePath && (
                <Button
                  variant="ghost"
                  className={styles.minWidthAuto}
                  onClick={() => updateDraft('systemSkills', {
                    ...draftSettings.systemSkills,
                    memoryUpdatePath: null,
                  })}
                >
                  Clear
                </Button>
              )}
            </div>
          </SettingRow>
        </div>
      </SettingSection>

      <SettingSection
        title="Frequent Tools"
        description="Tools you use most often are shown to Rebel for faster access. These are personalized based on your usage."
        data-section="frequentTools"
      >
        <div className={styles.flexColLarge}>
          {frequentToolsLoading ? (
            <p className={styles.developerInfoText}>Loading...</p>
          ) : frequentTools.length > 0 ? (
            <>
              <div className={styles.developerFrequentToolsList}>
                {frequentTools.map((tool) => (
                  <div
                    key={tool.toolName}
                    className={styles.developerFrequentToolItem}
                  >
                    <code className={styles.developerFrequentToolName}>
                      {tool.shortName}
                    </code>
                    <span className={styles.developerFrequentToolCount}>
                      {tool.usageCount} use{tool.usageCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="lg"
                className={styles.actionButton}
                onClick={() => void handleResetFrequentTools()}
                disabled={frequentToolsResetting}
              >
                {frequentToolsResetting ? 'Resetting...' : 'Reset Statistics'}
              </Button>
            </>
          ) : (
            <p className={styles.developerInfoText}>
              No tool usage recorded yet. Use some tools with Rebel to see your frequently used tools here.
            </p>
          )}
        </div>
      </SettingSection>

      {rendererIsOss() ? (
        <SettingSection
          title="Analytics & Telemetry"
          description="Rebel doesn't phone home. If you want your own crash reports and usage data sent to your own Sentry / RudderStack, add your credentials here — nothing is sent otherwise."
          data-section="analytics"
          data-testid="settings-section-telemetry-oss"
        >
          <div className={styles.flexColLarge}>
            <SettingRow
              label="Telemetry opt-in"
              description="Off by default. Enable only if you've added your own credentials below."
              variant="stacked"
            >
              <div className={styles.developerMcpModeRow}>
                <input
                  type="checkbox"
                  id="telemetryEnabled"
                  checked={draftSettings.telemetry?.enabled ?? false}
                  onChange={handleTelemetryToggle}
                  className={styles.developerMcpModeCheckbox}
                />
                <label htmlFor="telemetryEnabled" className={styles.developerMcpModeLabel}>
                  Send anonymous usage data to help improve Rebel
                </label>
              </div>
            </SettingRow>

            {(draftSettings.telemetry?.enabled ?? false) && (
              <>
                <SettingRow
                  label="Sentry DSN"
                  description="Your own Sentry project DSN. Crash reports are sent here when set."
                  variant="stacked"
                  htmlFor="telemetrySentryDsn"
                >
                  <div className={styles.filePathRow}>
                    <input
                      id="telemetrySentryDsn"
                      value={draftSettings.telemetry?.sentryDsn ?? ''}
                      placeholder="https://[external-email]/0"
                      onChange={(event) => updateTelemetry('sentryDsn', event.target.value || undefined)}
                    />
                  </div>
                </SettingRow>

                <SettingRow
                  label="RudderStack write key"
                  description="Your own RudderStack source write key. Required together with the data-plane URL."
                  variant="stacked"
                  htmlFor="telemetryRudderWriteKey"
                >
                  <div className={styles.filePathRow}>
                    <input
                      id="telemetryRudderWriteKey"
                      value={draftSettings.telemetry?.rudderWriteKey ?? ''}
                      placeholder="your_write_key"
                      onChange={(event) => updateTelemetry('rudderWriteKey', event.target.value || undefined)}
                    />
                  </div>
                </SettingRow>

                <SettingRow
                  label="RudderStack data-plane URL"
                  description="Your own RudderStack data-plane URL. Required together with the write key."
                  variant="stacked"
                  htmlFor="telemetryRudderDataPlaneUrl"
                >
                  <div className={styles.filePathRow}>
                    <input
                      id="telemetryRudderDataPlaneUrl"
                      value={draftSettings.telemetry?.rudderDataPlaneUrl ?? ''}
                      placeholder="https://your-dataplane.rudderstack.com"
                      onChange={(event) => updateTelemetry('rudderDataPlaneUrl', event.target.value || undefined)}
                    />
                  </div>
                </SettingRow>
              </>
            )}
          </div>
        </SettingSection>
      ) : (
        <SettingSection
          title="Analytics & Telemetry"
          description="Check RudderStack configuration and runtime status."
          data-section="analytics"
        >
          <SettingRow
            label="RudderStack status"
            tooltip="Shows whether analytics is disabled, pending verification, healthy, or misconfigured based on current runtime env vars."
            variant="stacked"
          >
            <p className={`${styles.developerInfoText} ${styles.developerInfoTextSpacingSm}`}>
              {analyticsStatusLoading && 'Verifying analytics configuration…'}
              {!analyticsStatusLoading && !analyticsStatus && 'Status unavailable.'}
              {!analyticsStatusLoading &&
                analyticsStatus?.state === 'disabled' &&
                'Analytics disabled (no keys or DISABLED sentinel).'}
              {!analyticsStatusLoading &&
                analyticsStatus?.state === 'pending' &&
                'Analytics enabled – verifying configuration…'}
              {!analyticsStatusLoading && analyticsStatus?.state === 'healthy' && 'Analytics enabled and healthy.'}
              {!analyticsStatusLoading &&
                analyticsStatus?.state === 'error' &&
                `Analytics enabled but misconfigured – ${analyticsStatus.error ?? 'see logs for details.'}`}
            </p>
            <p className={`${styles.developerInfoText} ${styles.developerInfoTextTopSpacing}`}>
              Set <code>RUDDERSTACK_WRITE_KEY</code> and <code>RUDDERSTACK_DATA_PLANE_URL</code> to{' '}
              <code>DISABLED</code> to turn analytics off without breaking packaging. Any other non-empty values are
              treated as a live RudderStack configuration.
            </p>
          </SettingRow>
        </SettingSection>
      )}

      <DemoModeDialog
        open={demoModeDialogOpen}
        onOpenChange={setDemoModeDialogOpen}
        showToast={showToast}
      />
    </>
  );
};
