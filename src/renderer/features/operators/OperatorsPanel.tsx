import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Sparkles, Users } from 'lucide-react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { createOperatorId } from '@shared/types/operators';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useToast,
} from '@renderer/components/ui';
import { useSettingsSafe } from '@renderer/features/settings';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import styles from './OperatorsPanel.module.css';
import { invalidateOperatorRegistryCache, useOperatorRegistry } from './hooks/useOperatorRegistry';
import { usePersonalisationLifecycle } from './hooks/usePersonalisationLifecycle';
import { getActivationErrorMessage } from './utils/activationErrorMessages';
import { OperatorCard, type OperatorCardActivationTarget, type OperatorCardState } from './components/OperatorCard';
import { OperatorsTabs, type OperatorsTabValue } from './components/OperatorsTabs';
import { OperatorHistoryDialog } from './components/OperatorHistoryDialog';
import { DuplicateOperatorDialog } from './components/DuplicateOperatorDialog';

type BusyAction =
  | 'activate'
  | 'remove'
  | 'rename'
  | 'duplicate'
  | 'instructions'
  | 'live-toggle'
  | 'personalise';

type ActivationErrorState = {
  title: string;
  message: string;
  severity: 'error' | 'warning';
  details?: string;
};

type RemoveConfirmationState = {
  operator: OperatorMetadata;
};

type RenameDialogState = {
  operator: OperatorMetadata;
};

type DuplicateDialogState = {
  operator: OperatorMetadata;
  errorMessage: string | null;
};

type HistoryDialogState = {
  operator: OperatorMetadata;
};

export interface TeamPanelProps {
  activeSpacePath?: string | null;
  selectedOperatorId?: string | null;
}

const STARTER_OPERATORS = [
  'Head of Marketing',
  'Skeptical Engineer',
  'Brand Critic',
  'Investor View',
  'Customer Voice',
  'Risk & Compliance',
];

function basenameFromPath(sourcePath: string): string {
  return sourcePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? sourcePath;
}

function normalizeFilePathForMatch(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/\/+$/u, '');
}

function metadataForActivatedOperator(
  bundledOperator: OperatorMetadata,
  targetSpacePath: string,
): OperatorMetadata {
  const operatorDir = `${targetSpacePath.replace(/[\\/]+$/u, '')}/operators/${bundledOperator.operatorSlug}`;
  return {
    ...bundledOperator,
    id: createOperatorId(targetSpacePath, bundledOperator.operatorSlug),
    spacePath: targetSpacePath,
    sourceSpacePath: targetSpacePath,
    category: 'space',
    operatorFileAbsolutePath: `${operatorDir}/OPERATOR.md`,
    groundingPath: `${operatorDir}/grounding.md`,
    diaryPath: `${operatorDir}/diary.md`,
  };
}

export const TeamPanel: React.FC<TeamPanelProps> = ({
  activeSpacePath,
  selectedOperatorId: selectedOperatorIdProp,
}) => {
  const { showToast } = useToast();
  const removeDialogTitleId = useId();
  const renameDialogTitleId = useId();
  const settingsContext = useSettingsSafe();
  const navigation = useNavigationSafe();
  const coreDirectory = settingsContext?.settings?.coreDirectory ?? null;
  const navigationSelectedOperatorId = navigation?.teamSelectedOperatorId ?? null;
  const requestedSelectedOperatorId = selectedOperatorIdProp ?? navigationSelectedOperatorId;
  const {
    operators,
    failures,
    loading,
    error,
    refresh,
    sourceSpaces,
  } = useOperatorRegistry({
    coreDirectory,
    ...(activeSpacePath !== undefined ? { activeSpacePath } : {}),
    mode: 'panel',
  });

  const [activeTab, setActiveTab] = useState<OperatorsTabValue>('operators');
  const [busyActions, setBusyActions] = useState<Record<string, BusyAction | null>>({});
  const [activationErrors, setActivationErrors] = useState<Record<string, ActivationErrorState | null>>({});
  const [optimisticOperators, setOptimisticOperators] = useState<OperatorMetadata[]>([]);
  const [removeConfirmation, setRemoveConfirmation] = useState<RemoveConfirmationState | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [duplicateDialog, setDuplicateDialog] = useState<DuplicateDialogState | null>(null);
  const [historyDialog, setHistoryDialog] = useState<HistoryDialogState | null>(null);
  const [highlightedOperatorId, setHighlightedOperatorId] = useState<string | null>(null);
  const [starterSeedRequested, setStarterSeedRequested] = useState(false);
  const personalisation = usePersonalisationLifecycle();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightLiveTogglesRef = useRef<Set<string>>(new Set());

  const sourceSpaceByPath = useMemo(
    () => new Map(sourceSpaces.map((space) => [space.sourceSpacePath, space])),
    [sourceSpaces],
  );

  const targetSpaces = useMemo<OperatorCardActivationTarget[]>(
    () => sourceSpaces
      .filter((space) => space.category === 'space')
      .map((space) => ({
        sourceSpacePath: space.sourceSpacePath,
        label: space.label,
        ...(space.isChiefOfStaff ? { isChiefOfStaff: true } : {}),
      })),
    [sourceSpaces],
  );

  const allOperators = useMemo(() => {
    const seen = new Set<string>();
    return [...operators, ...optimisticOperators].filter((operator) => {
      if (seen.has(operator.id)) return false;
      seen.add(operator.id);
      return true;
    });
  }, [operators, optimisticOperators]);

  const operatorsTabOperators = useMemo(
    () => allOperators.filter((operator) => operator.roles.includes('operator')),
    [allOperators],
  );
  const liveCoachesTabOperators = useMemo(
    () => allOperators.filter((operator) => operator.roles.includes('live_meeting')),
    [allOperators],
  );
  const visibleOperators = activeTab === 'operators' ? operatorsTabOperators : liveCoachesTabOperators;

  const bundledDescriptionsBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const op of allOperators) {
      if (op.category === 'bundled') {
        map.set(op.operatorSlug, op.description.trim());
      }
    }
    return map;
  }, [allOperators]);

  const isOperatorPersonalised = useCallback((operator: OperatorMetadata): boolean => {
    const description = operator.description.trim();
    if (description.length === 0) return false;
    const bundledDescription = bundledDescriptionsBySlug.get(operator.operatorSlug);
    if (bundledDescription !== undefined) {
      return description !== bundledDescription;
    }
    return true;
  }, [bundledDescriptionsBySlug]);

  useEffect(() => {
    if (!requestedSelectedOperatorId) return;
    const target = allOperators.find((operator) => operator.id === requestedSelectedOperatorId);
    if (!target) return;
    setActiveTab(target.roles.includes('operator') ? 'operators' : 'live-coaches');
    setHighlightedOperatorId(requestedSelectedOperatorId);
  }, [allOperators, requestedSelectedOperatorId]);

  useEffect(() => {
    if (!highlightedOperatorId) return;
    const card = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-operator-id]') ?? [])
      .find((element) => element.dataset.operatorId === highlightedOperatorId);
    card?.scrollIntoView?.({ block: 'nearest' });
    card?.focus({ preventScroll: true });
  }, [highlightedOperatorId, visibleOperators]);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    };
  }, []);

  const highlightOperatorCard = useCallback((operatorId: string) => {
    setHighlightedOperatorId(operatorId);
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedOperatorId((current) => (current === operatorId ? null : current));
      highlightTimeoutRef.current = null;
    }, 2000);
  }, []);

  const showExistingOperatorFromPath = useCallback((existingOperatorPath: string): boolean => {
    const normalized = normalizeFilePathForMatch(existingOperatorPath);
    const existing = allOperators.find((candidate) =>
      candidate.category === 'space'
      && normalizeFilePathForMatch(candidate.operatorFileAbsolutePath) === normalized,
    );
    if (!existing) return false;
    setActiveTab(existing.roles.includes('operator') ? 'operators' : 'live-coaches');
    highlightOperatorCard(existing.id);
    return true;
  }, [allOperators, highlightOperatorCard]);

  const dropOperatorFromLocalState = useCallback((operatorId: string) => {
    setOptimisticOperators((current) => current.filter((op) => op.id !== operatorId));
    setBusyActions((current) => {
      if (!(operatorId in current)) return current;
      const next = { ...current };
      delete next[operatorId];
      return next;
    });
    setActivationErrors((current) => {
      if (!(operatorId in current)) return current;
      const next = { ...current };
      delete next[operatorId];
      return next;
    });
  }, []);

  const activateOperator = useCallback(async (
    operator: OperatorMetadata,
    targetSpacePath: string,
  ) => {
    const targetLabel = sourceSpaceByPath.get(targetSpacePath)?.label ?? basenameFromPath(targetSpacePath);
    setBusyActions((current) => ({ ...current, [operator.id]: 'activate' }));
    setActivationErrors((current) => ({ ...current, [operator.id]: null }));
    try {
      const response = await window.operatorsApi.activate({
        operatorSlug: operator.operatorSlug,
        sourceSpacePath: operator.sourceSpacePath,
        targetSpacePath,
      });
      if (!response.success) {
        const rawErrorCode = response.errorCode ?? 'activation_failed';
        const mapped = getActivationErrorMessage(rawErrorCode, {
          spaceName: targetLabel,
          details: rawErrorCode,
        });
        setActivationErrors((current) => ({ ...current, [operator.id]: mapped }));
        if (rawErrorCode === 'already_activated' && response.existingOperatorPath) {
          showToast({
            title: mapped.title,
            description: mapped.message,
            variant: mapped.severity,
            action: {
              label: 'Show existing',
              onClick: () => { void showExistingOperatorFromPath(response.existingOperatorPath ?? ''); },
            },
          });
        }
        return;
      }
      const activated = metadataForActivatedOperator(operator, targetSpacePath);
      setOptimisticOperators((current) => [
        ...current.filter((item) => item.id !== activated.id),
        activated,
      ]);
      highlightOperatorCard(activated.id);
      invalidateOperatorRegistryCache();
      await refresh();
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('activation_failed', {
        spaceName: targetLabel,
        details,
      });
      setActivationErrors((current) => ({ ...current, [operator.id]: mapped }));
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [highlightOperatorCard, refresh, showExistingOperatorFromPath, showToast, sourceSpaceByPath]);

  const requestRemoveOperator = useCallback((operator: OperatorMetadata) => {
    setRemoveConfirmation({ operator });
  }, []);

  const confirmRemoveOperator = useCallback(async (operator: OperatorMetadata) => {
    const targetLabel = sourceSpaceByPath.get(operator.spacePath)?.label ?? basenameFromPath(operator.spacePath);
    setBusyActions((current) => ({ ...current, [operator.id]: 'remove' }));
    try {
      const response = await window.operatorsApi.remove({
        operatorSlug: operator.operatorSlug,
        targetSpacePath: operator.spacePath,
      });
      if (!response.success) {
        const mapped = getActivationErrorMessage(response.errorCode, {
          spaceName: targetLabel,
          details: response.errorCode,
        });
        showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
        setRemoveConfirmation(null);
        return;
      }
      setRemoveConfirmation(null);
      dropOperatorFromLocalState(operator.id);
      invalidateOperatorRegistryCache();
      await refresh();
      showToast({ title: `Removed ${operator.displayName ?? operator.name}`, variant: 'success' });
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('delete_failed', {
        spaceName: targetLabel,
        details,
      });
      showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [dropOperatorFromLocalState, refresh, showToast, sourceSpaceByPath]);

  const openRenameDialog = useCallback((operator: OperatorMetadata) => {
    setRenameDialog({ operator });
    setRenameDraft(operator.displayName ?? '');
  }, []);

  const saveOperatorDisplayName = useCallback(async () => {
    if (!renameDialog) return;
    const operator = renameDialog.operator;
    const targetLabel = sourceSpaceByPath.get(operator.spacePath)?.label ?? basenameFromPath(operator.spacePath);
    const trimmed = renameDraft.trim();
    const payload = trimmed.length > 0 ? trimmed : null;

    setBusyActions((current) => ({ ...current, [operator.id]: 'rename' }));
    try {
      const response = await window.operatorsApi.setDisplayName({
        operatorSlug: operator.operatorSlug,
        targetSpacePath: operator.spacePath,
        displayName: payload,
      });
      if (!response.success) {
        const mapped = getActivationErrorMessage(response.errorCode, {
          spaceName: targetLabel,
          details: response.errorCode,
        });
        showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
        return;
      }
      setOptimisticOperators((current) => current.map((item) => (
        item.id === operator.id
          ? { ...item, ...(payload ? { displayName: payload } : { displayName: undefined }) }
          : item
      )));
      setRenameDialog(null);
      setRenameDraft('');
      highlightOperatorCard(operator.id);
      invalidateOperatorRegistryCache();
      await refresh();
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('write_failed', {
        spaceName: targetLabel,
        details,
      });
      showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [highlightOperatorCard, refresh, renameDialog, renameDraft, showToast, sourceSpaceByPath]);

  const openDuplicateDialog = useCallback((operator: OperatorMetadata) => {
    setDuplicateDialog({ operator, errorMessage: null });
  }, []);

  const submitDuplicate = useCallback(async (newDisplayName: string) => {
    if (!duplicateDialog) return;
    const operator = duplicateDialog.operator;
    const targetLabel = sourceSpaceByPath.get(operator.spacePath)?.label ?? basenameFromPath(operator.spacePath);
    setBusyActions((current) => ({ ...current, [operator.id]: 'duplicate' }));
    setDuplicateDialog((current) => (current ? { ...current, errorMessage: null } : current));
    try {
      const response = await window.operatorsApi.duplicate({
        sourceSlug: operator.operatorSlug,
        sourceSpacePath: operator.spacePath,
        newDisplayName,
      });
      if (!response.success) {
        const mapped = getActivationErrorMessage(response.errorCode, {
          spaceName: targetLabel,
          details: response.errorCode,
        });
        setDuplicateDialog((current) => (current ? { ...current, errorMessage: mapped.message } : current));
        return;
      }
      setDuplicateDialog(null);
      const newOperatorId = createOperatorId(operator.spacePath, response.newSlug);
      invalidateOperatorRegistryCache();
      await refresh();
      highlightOperatorCard(newOperatorId);
      showToast({ title: `Duplicated as ${newDisplayName}`, variant: 'success' });
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('write_failed', {
        spaceName: targetLabel,
        details,
      });
      setDuplicateDialog((current) => (current ? { ...current, errorMessage: mapped.message } : current));
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [duplicateDialog, highlightOperatorCard, refresh, showToast, sourceSpaceByPath]);

  const openInstructions = useCallback(async (operator: OperatorMetadata) => {
    setBusyActions((current) => ({ ...current, [operator.id]: 'instructions' }));
    const emitFallbackBreadcrumb = (reason: string, error?: unknown) => {
      console.warn('[Renderer] operators:library_navigation_fallback_toast', {
        operatorId: operator.id,
        operatorName: operator.displayName ?? operator.name,
        filePath: operator.operatorFileAbsolutePath,
        reason,
        ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
      });
    };
    const showFallbackToast = () => {
      showToast({
        title: 'Couldn’t open instructions',
        description: 'The operator file is no longer in the Library. Try refreshing or check folder permissions.',
        variant: 'warning',
      });
    };
    try {
      let exists = false;
      try {
        const stat = await window.libraryApi.statFile({ target: operator.operatorFileAbsolutePath });
        exists = stat.exists;
      } catch (statError) {
        ignoreBestEffortCleanup(statError, {
          operation: 'operators:open_instructions_stat',
          reason: 'statFile failure means the file is missing or unreadable; fall through to user-visible toast',
        });
        exists = false;
      }
      if (!exists || !navigation) {
        emitFallbackBreadcrumb(navigation ? 'file_missing' : 'navigation_unavailable');
        showFallbackToast();
        return;
      }
      try {
        await navigation.navigate({
          type: 'library',
          filePath: operator.operatorFileAbsolutePath,
        });
      } catch (navigateError) {
        emitFallbackBreadcrumb('navigate_failed', navigateError);
        showFallbackToast();
      }
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [navigation, showToast]);

  const handleToggleLiveMeeting = useCallback(async (
    operator: OperatorMetadata,
    next: boolean,
  ) => {
    if (inFlightLiveTogglesRef.current.has(operator.id)) {
      return;
    }
    inFlightLiveTogglesRef.current.add(operator.id);
    const targetLabel = sourceSpaceByPath.get(operator.spacePath)?.label ?? basenameFromPath(operator.spacePath);
    setBusyActions((current) => ({ ...current, [operator.id]: 'live-toggle' }));
    setOptimisticOperators((current) => {
      const others = current.filter((item) => item.id !== operator.id);
      const baseRoles = operator.roles.filter((role) => role !== 'live_meeting');
      const optimisticRoles = next ? [...baseRoles, 'live_meeting' as const] : baseRoles;
      if (optimisticRoles.length === 0) {
        return current;
      }
      const optimistic: OperatorMetadata = {
        ...operator,
        roles: optimisticRoles,
      };
      return [...others, optimistic];
    });

    const revertOptimistic = () => {
      setOptimisticOperators((current) => {
        const others = current.filter((item) => item.id !== operator.id);
        return [...others, operator];
      });
    };

    try {
      const response = await window.operatorsApi.setLiveMeetingEnabled({
        operatorSlug: operator.operatorSlug,
        targetSpacePath: operator.spacePath,
        enabled: next,
      });
      if (!response.success) {
        revertOptimistic();
        const mapped = getActivationErrorMessage(response.errorCode, {
          spaceName: targetLabel,
          details: response.errorCode,
        });
        if (response.errorCode === 'live_prompt_missing') {
          showToast({
            title: mapped.title,
            description: mapped.message,
            variant: mapped.severity,
            action: {
              label: 'Open Instructions',
              onClick: () => { void openInstructions(operator); },
            },
          });
        } else {
          showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
        }
        return;
      }
      invalidateOperatorRegistryCache();
      await refresh();
    } catch (err) {
      revertOptimistic();
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('write_failed', {
        spaceName: targetLabel,
        details,
      });
      showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
    } finally {
      inFlightLiveTogglesRef.current.delete(operator.id);
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [openInstructions, refresh, showToast, sourceSpaceByPath]);

  const handlePersonalise = useCallback(async (operator: OperatorMetadata) => {
    const targetLabel = sourceSpaceByPath.get(operator.spacePath)?.label ?? basenameFromPath(operator.spacePath);
    setBusyActions((current) => ({ ...current, [operator.id]: 'personalise' }));
    try {
      const response = await window.operatorsApi.startPersonalisation({
        operatorSlug: operator.operatorSlug,
        targetSpacePath: operator.spacePath,
      });
      if (!response.success) {
        const mapped = getActivationErrorMessage(response.errorCode, {
          spaceName: targetLabel,
          details: response.errorCode,
        });
        showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
        return;
      }
      personalisation.markStarted({ operatorId: operator.id, sessionId: response.sessionId });
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      const mapped = getActivationErrorMessage('broadcast_failed', {
        spaceName: targetLabel,
        details,
      });
      showToast({ title: mapped.title, description: mapped.message, variant: mapped.severity });
    } finally {
      setBusyActions((current) => ({ ...current, [operator.id]: null }));
    }
  }, [personalisation, showToast, sourceSpaceByPath]);

  const operatorTabsCounts = useMemo(() => ({
    operators: operatorsTabOperators.length,
    liveCoaches: liveCoachesTabOperators.length,
  }), [liveCoachesTabOperators.length, operatorsTabOperators.length]);

  const renderCard = useCallback((operator: OperatorMetadata) => {
    const source = sourceSpaceByPath.get(operator.sourceSpacePath);
    const spaceLabel = source?.label
      ?? (operator.category === 'bundled' ? 'Bundled' : basenameFromPath(operator.sourceSpacePath));
    const defaultTarget = targetSpaces.find((t) => t.isChiefOfStaff)?.sourceSpacePath
      ?? targetSpaces[0]?.sourceSpacePath;
    const personalising = personalisation.isPersonalising(operator.id);
    const cardState: OperatorCardState = operator.category === 'bundled'
      ? { kind: 'bundled' }
      : { kind: 'activated', personalised: isOperatorPersonalised(operator), personalising };
    const busyAction = busyActions[operator.id] ?? null;
    const cardBusyAction =
      busyAction === 'activate' || busyAction === 'remove' || busyAction === 'rename'
      || busyAction === 'duplicate' || busyAction === 'instructions' || busyAction === 'live-toggle'
      || busyAction === 'personalise'
        ? busyAction
        : null;
    const activationError = activationErrors[operator.id] ?? null;
    const liveMeetingEnabled = operator.roles.includes('live_meeting');

    return (
      <OperatorCard
        key={operator.id}
        operator={operator}
        state={cardState}
        spaceLabel={spaceLabel}
        highlighted={highlightedOperatorId === operator.id}
        busyAction={cardBusyAction}
        activationTargets={targetSpaces}
        {...(defaultTarget ? { defaultActivationTargetSpacePath: defaultTarget } : {})}
        activationErrorMessage={activationError?.message ?? null}
        activationErrorDetails={activationError?.details ?? null}
        liveMeetingEnabled={liveMeetingEnabled}
        onActivate={(target) => void activateOperator(operator, target)}
        onPersonalise={() => void handlePersonalise(operator)}
        onOpenInstructions={() => void openInstructions(operator)}
        onToggleLiveMeeting={(next) => { void handleToggleLiveMeeting(operator, next); }}
        onRename={operator.category === 'space' ? () => openRenameDialog(operator) : undefined}
        onDuplicate={operator.category === 'space' ? () => openDuplicateDialog(operator) : undefined}
        onHistory={operator.category === 'space' ? () => setHistoryDialog({ operator }) : undefined}
        onRemove={operator.category === 'space' ? () => requestRemoveOperator(operator) : undefined}
      />
    );
  }, [
    activateOperator,
    activationErrors,
    busyActions,
    handleToggleLiveMeeting,
    handlePersonalise,
    highlightedOperatorId,
    isOperatorPersonalised,
    openDuplicateDialog,
    openInstructions,
    openRenameDialog,
    personalisation,
    requestRemoveOperator,
    sourceSpaceByPath,
    targetSpaces,
  ]);

  const totalCount = allOperators.length;

  return (
    <div className={styles.panel} data-testid="operators-panel" ref={panelRef}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.heroIcon} aria-hidden>
            <Users size={24} strokeWidth={1.6} />
          </div>
          <div>
            <p className={styles.heroKicker}>Operators</p>
            <h2 className={styles.heroTitle}>
              {totalCount > 0
                ? `${totalCount} perspective${totalCount === 1 ? '' : 's'} available`
                : 'No Operators are available in this Space.'}
            </h2>
            <p className={styles.heroDescription}>
              Rebel can ask Operators for a second opinion when the work needs one.
              Think specialist colleagues, minus the calendar wrestling.
            </p>
          </div>
        </div>
        <div className={styles.heroStats} aria-label="Operator counts">
          <Badge variant="secondary">{operatorTabsCounts.operators} operators</Badge>
          <Badge variant="secondary">{operatorTabsCounts.liveCoaches} live coaches</Badge>
        </div>
      </section>

      <OperatorsTabs
        value={activeTab}
        onValueChange={setActiveTab}
        operatorsCount={operatorTabsCounts.operators}
        liveCoachesCount={operatorTabsCounts.liveCoaches}
      />

      {error && <p className={styles.errorText}>Couldn&apos;t load Operators: {error}</p>}

      {failures.length > 0 && (
        <section className={styles.diagnosticBanner} role="alert" aria-live="polite">
          <AlertTriangle size={18} aria-hidden />
          <div className={styles.diagnosticBannerContent}>
            <p className={styles.diagnosticBannerHeadline}>
              {failures.length === 1
                ? `1 Operator couldn’t be loaded.`
                : `${failures.length} Operators couldn’t be loaded.`}
            </p>
            <ul className={styles.diagnosticList}>
              {failures.slice(0, 5).map((failure) => (
                <li key={failure.operatorFileAbsolutePath}>
                  <code>{failure.operatorSlug || basenameFromPath(failure.operatorFileAbsolutePath)}</code>{' '}
                  <span className={styles.diagnosticCode}>({failure.errorCode})</span>: {failure.message}
                </li>
              ))}
              {failures.length > 5 && (
                <li className={styles.diagnosticMuted}>
                  …and {failures.length - 5} more. Check the dev console for the full list.
                </li>
              )}
            </ul>
          </div>
        </section>
      )}

      {!loading && totalCount === 0 ? (
        <section className={styles.emptyHero}>
          <div className={styles.emptyHeroContent}>
            <div className={styles.emptyIcon}>
              <Sparkles size={26} strokeWidth={1.5} />
            </div>
            <h2 className={styles.emptyHeadline}>No Operators are available in this Space.</h2>
            <p className={styles.emptyDescription}>
              Starter Operators will include {STARTER_OPERATORS.slice(0, 3).join(', ')},
              and three more people who are paid entirely in useful criticism.
            </p>
            <Button onClick={() => setStarterSeedRequested(true)}>
              Add starter Operators
            </Button>
            {starterSeedRequested && (
              <p className={styles.mutedText}>
                Starter Operators are on the way. We&apos;ll let you know.
              </p>
            )}
          </div>
        </section>
      ) : !loading && visibleOperators.length === 0 ? (
        <section className={styles.emptyHero}>
          <div className={styles.emptyHeroContent}>
            <h2 className={styles.emptyHeadline}>
              {activeTab === 'operators' ? 'No operators yet.' : 'No live coaches yet.'}
            </h2>
            <p className={styles.emptyDescription}>
              Activate one from a Bundled card to get started. They&apos;re in the other tab too.
            </p>
          </div>
        </section>
      ) : (
        <section className={styles.operatorsGrid} aria-label={activeTab === 'operators' ? 'Operators' : 'Live coaches'}>
          {loading && totalCount === 0 && <p className={styles.mutedText}>Loading Operators…</p>}
          {visibleOperators.map(renderCard)}
        </section>
      )}

      <Dialog
        open={Boolean(removeConfirmation)}
        onOpenChange={(open) => { if (!open) setRemoveConfirmation(null); }}
        ariaLabelledBy={removeDialogTitleId}
      >
        <DialogContent size="sm">
          <DialogHeader onClose={() => setRemoveConfirmation(null)}>
            <DialogTitle id={removeDialogTitleId}>
              Remove {removeConfirmation?.operator.displayName ?? removeConfirmation?.operator.name ?? 'Operator'}?
            </DialogTitle>
            <DialogDescription>
              The Operator file is deleted from this Space. Your conversation history with this Operator stays put.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRemoveConfirmation(null)}
              disabled={removeConfirmation ? busyActions[removeConfirmation.operator.id] === 'remove' : false}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!removeConfirmation) return;
                void confirmRemoveOperator(removeConfirmation.operator);
              }}
              disabled={removeConfirmation ? busyActions[removeConfirmation.operator.id] === 'remove' : false}
              data-testid="operator-remove-confirm-button"
            >
              {removeConfirmation && busyActions[removeConfirmation.operator.id] === 'remove' ? 'Removing' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameDialog)}
        onOpenChange={(open) => { if (!open) { setRenameDialog(null); setRenameDraft(''); } }}
        ariaLabelledBy={renameDialogTitleId}
      >
        <DialogContent size="sm">
          <DialogHeader onClose={() => { setRenameDialog(null); setRenameDraft(''); }}>
            <DialogTitle id={renameDialogTitleId}>
              Rename {renameDialog?.operator.displayName ?? renameDialog?.operator.name ?? 'Operator'}
            </DialogTitle>
            <DialogDescription>
              This updates the display name only. The Operator slug and file path stay the same.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className={styles.renameField}>
              <label htmlFor="operator-display-name-input" className={styles.renameFieldLabel}>
                Name in this Space
              </label>
              <Input
                id="operator-display-name-input"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.currentTarget.value)}
                placeholder={renameDialog?.operator.name ?? 'Operator name'}
                maxLength={120}
                autoFocus
              />
              <p className={styles.renameHint}>
                Leave blank to use the canonical name.
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setRenameDialog(null); setRenameDraft(''); }}
              disabled={renameDialog ? busyActions[renameDialog.operator.id] === 'rename' : false}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void saveOperatorDisplayName()}
              disabled={renameDialog ? busyActions[renameDialog.operator.id] === 'rename' : false}
              data-testid="operator-rename-save-button"
            >
              {renameDialog && busyActions[renameDialog.operator.id] === 'rename' ? 'Saving' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DuplicateOperatorDialog
        operator={duplicateDialog?.operator ?? null}
        open={Boolean(duplicateDialog)}
        busy={Boolean(duplicateDialog && busyActions[duplicateDialog.operator.id] === 'duplicate')}
        errorMessage={duplicateDialog?.errorMessage ?? null}
        onCancel={() => setDuplicateDialog(null)}
        onConfirm={(newDisplayName) => void submitDuplicate(newDisplayName)}
      />

      <OperatorHistoryDialog
        operator={historyDialog?.operator ?? null}
        open={Boolean(historyDialog)}
        onClose={() => setHistoryDialog(null)}
      />
    </div>
  );
};

export function _resetOperatorsPanelTelemetryForTests(): void {
  // No module-level telemetry to reset; kept as a stable test seam.
}
