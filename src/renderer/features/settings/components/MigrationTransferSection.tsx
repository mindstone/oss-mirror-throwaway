import { useCallback, useState } from 'react';
import { Button } from '@renderer/components/ui';
import { CheckCircle2, FolderOpen, MoveRight, RefreshCw } from 'lucide-react';
import type { MigrationExportResponse } from '@shared/ipc/channels/migration';
import { MigrationReAuthChecklist } from '@renderer/features/migration/MigrationReAuthChecklist';
import { useMigrationNoticeSafe } from '@renderer/features/migration/MigrationNoticeContext';
import { SettingRow } from './SettingRow';
import { SettingSection } from './SettingSection';
import styles from './MigrationTransferSection.module.css';

type ExportState =
  | { kind: 'idle' }
  | { kind: 'exporting' }
  | { kind: 'success'; result: Extract<MigrationExportResponse, { status: 'success' }> }
  | { kind: 'error'; message: string };

export const MigrationTransferSection = () => {
  const [state, setState] = useState<ExportState>({ kind: 'idle' });
  // Single reactive source: the same App-level migration-import notice the
  // startup card reads. "Finish settling in" renders only when a transfer
  // actually happened; fresh setups have no notice. Dismiss is coupled.
  // See docs/plans/260611_transfer-ui-tweaks/PLAN.md (Stage 3 mechanism).
  // Gate on the notice's existence (parity with the App-level startup card,
  // which renders on `migrationImportNotice` truthiness) rather than on the
  // re-auth checklist field, so the section's visibility tracks transfer-origin
  // intent directly.
  const activeNotice = useMigrationNoticeSafe()?.notice ?? null;

  const createTransferFile = useCallback(async () => {
    setState({ kind: 'exporting' });
    const result = await window.migrationApi.export();
    if (result.status === 'cancelled') {
      setState({ kind: 'idle' });
      return;
    }
    if (result.status === 'success') {
      setState({ kind: 'success', result });
      return;
    }
    setState({
      kind: 'error',
      message: result.error.message || 'Rebel couldn’t create the transfer file.',
    });
  }, []);

  const showInFolder = useCallback((filePath: string) => {
    void window.appApi.revealPath(filePath);
  }, []);

  return (
    <>
      {activeNotice ? (
        <SettingSection
          title="Finish settling in"
          description="Your Rebel data is here. A few connections need fresh permission from this computer."
          icon={CheckCircle2}
          data-section="migrationReauthChecklist"
          data-testid="settings-section-migration-reauth-checklist"
        >
          <SettingRow
            label="After bringing Rebel over"
            description="This is expected after a move. Nothing has gone wrong; computers are just territorial."
            variant="stacked"
          >
            <div className={styles.content}>
              <MigrationReAuthChecklist reAuthChecklist={activeNotice.reAuthChecklist} />
            </div>
          </SettingRow>
        </SettingSection>
      ) : null}

      <SettingSection
        title="Move to a new computer"
        description="Create a Rebel transfer file to bring your conversations, settings, memories, automations, inbox, and spaces to another computer."
        icon={MoveRight}
        data-section="moveToNewComputer"
        data-testid="settings-section-move-to-new-computer"
      >
        <SettingRow
          label="Rebel transfer file"
          description="Create a Rebel transfer file to bring your conversations, settings, memories, automations, inbox, and spaces to another computer."
          variant="stacked"
          data-testid="settings-row-create-transfer-file"
        >
          <div className={styles.content}>
            {state.kind === 'idle' && (
              <Button onClick={() => void createTransferFile()} data-testid="settings-create-transfer-file-button">
                Create transfer file
              </Button>
            )}

            {state.kind === 'exporting' && (
              <div className={styles.statusPanel} data-testid="settings-transfer-exporting">
                <p className={styles.statusTitle}>Packing your Rebel setup. Neatly, for once.</p>
                <p className={styles.statusBody}>This may take a few minutes for larger local workspaces.</p>
              </div>
            )}

            {state.kind === 'success' && (
              <div className={styles.statusPanel} data-testid="settings-transfer-success">
                <p className={styles.statusTitle}>Transfer file created</p>
                <p className={styles.statusBody}>
                  Keep this file somewhere safe until the move is finished. It includes readable conversation history and some personal file paths, so treat it like something with opinions and receipts.
                </p>
                <p className={styles.statusBody}>After importing, delete the transfer file unless you need it as a temporary backup.</p>
                <p className={styles.statusBody}>On the new computer, you’ll sign in again to connectors, add AI provider keys again, and pair cloud continuity again.</p>
                <p className={styles.path}>{state.result.filePath}</p>
                <div className={styles.actions}>
                  <Button variant="outline" onClick={() => showInFolder(state.result.filePath)}>
                    <FolderOpen size={16} /> Show in folder
                  </Button>
                  <Button variant="ghost" onClick={() => setState({ kind: 'idle' })}>
                    Done
                  </Button>
                </div>
              </div>
            )}

            {state.kind === 'error' && (
              <div className={styles.statusPanel} data-testid="settings-transfer-error">
                <p className={styles.statusTitle}>Rebel couldn’t create the transfer file.</p>
                <p className={styles.statusBody}>{state.message}</p>
                <div className={styles.actions}>
                  <Button onClick={() => void createTransferFile()}>
                    <RefreshCw size={16} /> Try again
                  </Button>
                  <Button variant="ghost" onClick={() => void createTransferFile()}>
                    Choose another location
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SettingRow>
      </SettingSection>
    </>
  );
};
