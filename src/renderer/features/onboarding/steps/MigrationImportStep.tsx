import { useCallback, useState } from 'react';
import { Button, RebelLoadingIndicator } from '@renderer/components/ui';
import type { MigrationValidateImportResponse } from '@shared/ipc/channels/migration';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import styles from './MigrationImportStep.module.css';

type ImportState =
  | { kind: 'entry' }
  | { kind: 'validating' }
  | { kind: 'confirm'; result: Extract<MigrationValidateImportResponse, { status: 'valid' }>; understood: boolean }
  | { kind: 'adopting' }
  | { kind: 'incompatible' }
  | { kind: 'corrupt' }
  | { kind: 'not-fresh' }
  | { kind: 'error'; message: string };

export type MigrationImportStepProps = {
  onBackToWelcome: () => void;
};

const GENERIC_IMPORT_ERROR_MESSAGE = 'Rebel could not finish the transfer step.';

export const MigrationImportStep = ({ onBackToWelcome }: MigrationImportStepProps) => {
  const [state, setState] = useState<ImportState>({ kind: 'entry' });
  const [currentExtractedBundleDir, setCurrentExtractedBundleDir] = useState<string | null>(null);

  const discardExtractedBundle = useCallback(async (extractedBundleDir: string | null) => {
    if (!extractedBundleDir) return;
    try {
      await window.migrationApi.discardExtracted({ extractedBundleDir });
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.import.ui.discard-extracted',
        reason: 'best-effort temp cleanup',
      });
      // Best-effort cleanup; the UI still needs to keep moving.
    } finally {
      setCurrentExtractedBundleDir((current) => current === extractedBundleDir ? null : current);
    }
  }, []);

  const chooseFile = useCallback(async () => {
    await discardExtractedBundle(currentExtractedBundleDir);
    setState({ kind: 'validating' });
    let result: MigrationValidateImportResponse;
    try {
      result = await window.migrationApi.validateImport();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'migration.import.ui.validate',
        reason: 'UI shows generic import error fallback',
      });
      setState({ kind: 'error', message: GENERIC_IMPORT_ERROR_MESSAGE });
      return;
    }
    switch (result.status) {
      case 'cancelled':
        setState({ kind: 'entry' });
        return;
      case 'valid':
        setCurrentExtractedBundleDir(result.extractedBundleDir);
        setState({ kind: 'confirm', result, understood: false });
        return;
      case 'incompatible':
        setState({ kind: 'incompatible' });
        return;
      case 'corrupt':
        setState({ kind: 'corrupt' });
        return;
      case 'not-fresh':
        setState({ kind: 'not-fresh' });
        return;
      case 'error':
        setState({ kind: 'error', message: result.error.message });
        return;
    }
  }, [currentExtractedBundleDir, discardExtractedBundle]);

  const continueWithCurrentSetup = useCallback(async () => {
    await discardExtractedBundle(currentExtractedBundleDir);
    onBackToWelcome();
  }, [currentExtractedBundleDir, discardExtractedBundle, onBackToWelcome]);

  const prepareImport = useCallback(async () => {
    if (state.kind !== 'confirm' || !state.understood) return;
    const extractedBundleDir = state.result.extractedBundleDir;
    setState({ kind: 'adopting' });
    try {
      const result = await window.migrationApi.prepareImport({
        extractedBundleDir,
      });
      if (result.status === 'ready-to-relaunch') {
        await discardExtractedBundle(extractedBundleDir);
        await window.migrationApi.relaunch();
        return;
      }
      if (result.status === 'incompatible') {
        setState({ kind: 'incompatible' });
        return;
      }
      if (result.status === 'corrupt') {
        setState({ kind: 'corrupt' });
        return;
      }
      if (result.status === 'not-fresh') {
        setState({ kind: 'not-fresh' });
        return;
      }
      setState({ kind: 'error', message: result.error.message });
    } catch {
      setState({ kind: 'error', message: GENERIC_IMPORT_ERROR_MESSAGE });
    }
  }, [discardExtractedBundle, state]);

  if (state.kind === 'validating') {
    return (
      <div className={styles.panel} data-testid="migration-import-validating">
        <p className={styles.eyebrow}>Rebel transfer file</p>
        <h1 className={styles.title}>Checking the transfer file.</h1>
        <p className={styles.body}>Making sure it belongs to Rebel and can be opened here.</p>
        <RebelLoadingIndicator
          layout="stacked"
          size="lg"
          label="Checking the transfer file"
          description="Making sure it belongs to Rebel and can be opened here."
        />
      </div>
    );
  }

  if (state.kind === 'confirm') {
    return (
      <div className={styles.panel} data-testid="migration-import-confirm">
        <p className={styles.eyebrow}>Rebel transfer file</p>
        <h1 className={styles.title}>Bring this Rebel setup over?</h1>
        <p className={styles.body}>
          Rebel will copy your conversations, settings, memories, automations, inbox, spaces, and local workspace content from the transfer file. Cloud-synced folders are not copied; reconnect those with Google Drive, OneDrive, or your usual cloud app.
        </p>
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>You’ll need to sign in again</h2>
          <p className={styles.body}>
            Connector sign-ins, AI provider keys, and cloud pairing stay tied to the old computer. That’s deliberate. Slightly inconvenient, much safer.
          </p>
        </div>
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>First-launch setup files</h2>
          <p className={styles.body}>
            Setup files Rebel created during first launch will be moved aside first. A recoverable backup is kept.
          </p>
        </div>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={state.understood}
            onChange={(event) => setState({ ...state, understood: event.target.checked })}
            data-testid="migration-import-replace-checkbox"
          />
          <span>I understand Rebel will move this computer’s first-launch setup files aside and keep a backup.</span>
        </label>
        <div className={styles.actions}>
          <Button
            onClick={() => void prepareImport()}
            disabled={!state.understood}
            data-testid="migration-import-confirm-button"
          >
            Bring Rebel over and restart
          </Button>
          <Button variant="ghost" onClick={() => void chooseFile()} data-testid="migration-import-different-file-button">
            Choose a different file
          </Button>
          <Button variant="ghost" onClick={() => void continueWithCurrentSetup()}>
            Start fresh instead
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'adopting') {
    return (
      <div className={styles.panel} data-testid="migration-import-adopting">
        <p className={styles.eyebrow}>Rebel transfer file</p>
        <h1 className={styles.title}>Putting everything in place.</h1>
        <p className={styles.body}>Rebel will restart once to finish. A backup of first-launch setup files is kept.</p>
        <RebelLoadingIndicator
          layout="stacked"
          size="lg"
          label="Putting everything in place"
          description="Rebel will restart once to finish."
        />
      </div>
    );
  }

  if (state.kind === 'incompatible') {
    return (
      <div className={styles.panel} data-testid="migration-import-incompatible">
        <h1 className={styles.title}>This transfer file was made with a newer Rebel.</h1>
        <p className={styles.body}>Update Rebel on this computer first, then try again. Time travel remains badly supported.</p>
        <div className={styles.actions}>
          <Button onClick={() => void chooseFile()}>Choose another file</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'corrupt') {
    return (
      <div className={styles.panel} data-testid="migration-import-corrupt">
        <h1 className={styles.title}>Rebel couldn’t read this transfer file.</h1>
        <p className={styles.body}>It may be incomplete, damaged, or not a Rebel transfer file.</p>
        <div className={styles.actions}>
          <Button onClick={() => void chooseFile()}>Choose another file</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'not-fresh') {
    return (
      <div className={styles.panel} data-testid="migration-import-not-fresh">
        <h1 className={styles.title}>This computer already has Rebel set up.</h1>
        <p className={styles.body}>To avoid mixing two setups, transfers only run on a fresh install. Your current Rebel data has not been changed.</p>
        <div className={styles.actions}>
          <Button onClick={() => void continueWithCurrentSetup()}>Continue with this setup</Button>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className={styles.panel} data-testid="migration-import-error">
        <h1 className={styles.title}>Rebel couldn’t read this transfer file.</h1>
        <p className={styles.body}>{state.message}</p>
        <div className={styles.actions}>
          <Button onClick={() => void chooseFile()}>Choose another file</Button>
          <Button variant="ghost" onClick={() => void continueWithCurrentSetup()}>Start fresh instead</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="migration-import-entry">
      <p className={styles.eyebrow}>Rebel transfer file</p>
      <h1 className={styles.title}>Choose your Rebel transfer file.</h1>
      <p className={styles.body}>It’s the file you created on your old computer.</p>
      <div className={styles.statusBox}>
        <p className={styles.statusTitle}>Already using Rebel? Bring it over.</p>
        <p className={styles.statusBody}>Use a Rebel transfer file from your old computer.</p>
      </div>
      <div className={styles.actions}>
        <Button onClick={() => void chooseFile()} data-testid="migration-import-choose-file-button">
          Choose transfer file
        </Button>
        <Button variant="ghost" onClick={() => void continueWithCurrentSetup()}>Start fresh instead</Button>
      </div>
    </div>
  );
};
