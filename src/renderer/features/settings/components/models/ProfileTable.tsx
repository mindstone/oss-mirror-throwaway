/**
 * ProfileTable — compact table view of configured model profiles.
 *
 * Replaces the old card-based `renderProfileList` inside `LocalModelSection`.
 * Uses real `<table>` semantics for accessibility. See
 * `docs/plans/260424_model_profile_ui_redesign.md` (Stage 2) for the intent.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  CircleCheck,
  Loader2,
  Pencil,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { Badge, Button, IconButton, Toggle, Tooltip } from '@renderer/components/ui';
import {
  selectHasAnyActiveTurn,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import type {
  CustomProvider,
  ModelProfile,
  ProviderKeys,
} from '@shared/types';
import {
  getLocalInferencePresetByPresetKey,
  getModelCapabilityDefaults,
} from '@shared/data/modelProviderPresets';
import { getProfileProviderDisplayName } from '@shared/utils/providerDisplay';
import { isConnectionManagedProfile } from '@shared/utils/profileHelpers';
import { resolveProfileReasoningEffort } from '@shared/utils/reasoningSuppression';
import { ChatCompatibilityBadge } from './ChatCompatibilityBadge';
import { ProfileMembershipChips, type ProfileMembershipDisabledReason } from './ProfileMembershipChips';
import { ThinkingLevelPill } from './ThinkingLevelPill';
import { getProviderDisplayLabel } from './profileHelpers';
import type { TestResult, TestStateEntry } from './useProfileTester';
import styles from './ProfileTable.module.css';

export interface ProfileTableProps {
  profiles: ModelProfile[];
  customProviders?: CustomProvider[];
  /** Reserved for future use (API-key-status badges etc.). */
  providerKeys?: ProviderKeys;
  /** Connection-managed profiles whose source provider needs reconnect/setup. */
  needsSetupProfileIds?: ReadonlySet<string>;
  /** Keyed map of in-flight + settled test state for each profile. */
  testState: Record<string, TestStateEntry>;
  /**
   * Full profile list used for membership writes when this table renders a
   * filtered bucket (Active / Available). Defaults to `profiles` for tests and
   * standalone use.
   */
  allProfiles?: ModelProfile[];
  onProfilesChange: (profiles: ModelProfile[]) => void;
  /** Profile ID that should flash + scroll after save. */
  justAddedId: string | null;
  /**
   * Optional test/story override. Production defaults to the live agent-session
   * in-flight selector.
   */
  turnInFlight?: boolean;
  /**
   * Profile currently assigned the "working" / Main work role. When provided,
   * the row gets a "Main" badge and its membership chips switch to passive mode
   * (the main model is always in the Smart picking pool).
   */
  workingProfileId?: string | null;
  onToggleEnabled: (profileId: string) => void;
  onTest: (profile: ModelProfile) => void;
  onEdit: (profile: ModelProfile) => void;
  onRequestDelete: (profileId: string) => void;
  onConfirmDelete: (profileId: string) => void;
  getReconnectHandler?: (profile: ModelProfile) => (() => void) | undefined;
  deleteConfirmId: string | null;
  onHighlightDone: () => void;
}

const HIGHLIGHT_DURATION_MS = 1200;
const MODEL_PROFILE_ENRICHMENT_EVENT = 'rebel:start-model-profile-enrichment';

function buildModelProfileEnrichmentPrompt(profile: ModelProfile): string {
  const modelId = profile.model || profile.serverUrl;
  return `Research the model "${profile.name}" (${modelId}) and update its profile notes using the UpdateModelProfileNotes tool.
Search the web for recent benchmarks, reviews, and capability assessments.
Write comprehensive notes covering: what it excels at, what to avoid, speed/cost characteristics, and any known quirks.
Use profile ID "${profile.id}".`;
}

function requestModelProfileEnrichment(profile: ModelProfile): void {
  window.dispatchEvent(new CustomEvent(MODEL_PROFILE_ENRICHMENT_EVENT, {
    detail: {
      profileId: profile.id,
      profileName: profile.name,
      prompt: buildModelProfileEnrichmentPrompt(profile),
    },
  }));
}

/**
 * Whether the profile genuinely lacks routing notes — i.e. the planner would
 * resolve `modelNotes` to nothing. Mirrors the resolution in
 * `planningMode.ts` (`profile.modelNotes || defaults?.modelNotes || mergedLegacy`,
 * see ~line 346) so the "Research this model" button appears exactly when there's
 * no guidance to route with: no per-profile notes, no legacy strengths/weaknesses,
 * and no catalog default. Catalog models (which ship notes) therefore stop nagging;
 * only custom/unknown endpoints offer enrichment.
 */
function lacksRoutingNotes(profile: ModelProfile): boolean {
  if (profile.modelNotes?.trim()) return false;
  // Mirror `mergeLegacyModelNotes` in useProfileWizard.ts (~line 321): legacy
  // strengths/weaknesses count as notes when explicit notes are absent.
  if (profile.strengths?.trim() || profile.weaknesses?.trim()) return false;
  if (getModelCapabilityDefaults(profile.model)?.modelNotes) return false;
  return true;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const ProfileTable = ({
  profiles,
  customProviders,
  testState,
  allProfiles,
  onProfilesChange,
  justAddedId,
  turnInFlight,
  workingProfileId,
  onToggleEnabled,
  needsSetupProfileIds,
  onTest,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  getReconnectHandler,
  deleteConfirmId,
  onHighlightDone,
}: ProfileTableProps) => {
  const liveTurnInFlight = useSessionStore(selectHasAnyActiveTurn);
  const effectiveTurnInFlight = turnInFlight ?? liveTurnInFlight;
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const checkboxRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const writeProfiles = allProfiles ?? profiles;

  const setRowRef = useCallback(
    (id: string) => (el: HTMLTableRowElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    [],
  );

  const setCheckboxRef = useCallback(
    (id: string) => (el: HTMLInputElement | null) => {
      if (el) checkboxRefs.current.set(id, el);
      else checkboxRefs.current.delete(id);
    },
    [],
  );

  const handleToggleMembership = useCallback(
    (profileId: string, key: 'councilEnabled' | 'routingEligible') => {
      onProfilesChange(
        writeProfiles.map((profile) => {
          if (profile.id !== profileId) return profile;
          return { ...profile, [key]: !Boolean(profile[key]) };
        }),
      );
    },
    [onProfilesChange, writeProfiles],
  );

  // Auto-highlight: scroll into view, focus the enable checkbox, let the
  // `.justAdded` class drive a 1.2s fade, then clear. Respects
  // `prefers-reduced-motion` by skipping the scroll behaviour that would
  // animate (CSS handles dropping the fade animation).
  useEffect(() => {
    if (!justAddedId) return;
    const row = rowRefs.current.get(justAddedId);
    if (!row) {
      onHighlightDone();
      return;
    }

    const reduceMotion = prefersReducedMotion();
    try {
      row.scrollIntoView({
        block: 'center',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    } catch {
      // `scrollIntoView` without options isn't always supported; fall back.
      row.scrollIntoView();
    }

    const frame = requestAnimationFrame(() => {
      const checkbox = checkboxRefs.current.get(justAddedId);
      // `preventScroll`: the explicit `scrollIntoView` above already owns row
      // visibility through the proper inner scroll container. A focus-driven
      // scroll would be redundant (and historically helped scroll the shell
      // itself — see REBEL-68G note in app-shell.css).
      checkbox?.focus({ preventScroll: true });
    });

    const timer = setTimeout(() => {
      onHighlightDone();
    }, HIGHLIGHT_DURATION_MS);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [justAddedId, onHighlightDone]);

  if (profiles.length === 0) return null;

  return (
    <table className={styles.table} role="table" data-testid="settings-models-profile-table">
      <caption className={styles.srOnly}>Your configured model profiles</caption>
      <thead>
        <tr>
          <th scope="col" className={`${styles.colName} ${styles.th}`}>
            Name
          </th>
          <th scope="col" className={`${styles.colProvider} ${styles.th}`}>
            Provider
          </th>
          <th scope="col" className={`${styles.colThinking} ${styles.th}`}>
            Thinking
          </th>
          <th scope="col" className={`${styles.colStatus} ${styles.th}`}>
            Status
          </th>
          <th scope="col" className={`${styles.colActions} ${styles.th}`}>
            <span className={styles.srOnly}>Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            customProviders={customProviders}
            testState={testState}
            needsSetup={needsSetupProfileIds?.has(profile.id) === true}
            justAddedId={justAddedId}
            deleteConfirmId={deleteConfirmId}
            turnInFlight={effectiveTurnInFlight}
            isWorkingProfile={!!workingProfileId && profile.id === workingProfileId}
            onToggleEnabled={onToggleEnabled}
            onToggleCouncil={() => handleToggleMembership(profile.id, 'councilEnabled')}
            onToggleSmartPicking={() => handleToggleMembership(profile.id, 'routingEligible')}
            onTest={onTest}
            onEdit={onEdit}
            onRequestDelete={onRequestDelete}
            onConfirmDelete={onConfirmDelete}
            reconnectHandler={getReconnectHandler?.(profile)}
            rowRef={setRowRef(profile.id)}
            checkboxRef={setCheckboxRef(profile.id)}
          />
        ))}
      </tbody>
    </table>
  );
};

interface ProfileRowProps {
  profile: ModelProfile;
  customProviders?: CustomProvider[];
  testState: Record<string, TestStateEntry>;
  needsSetup: boolean;
  justAddedId: string | null;
  deleteConfirmId: string | null;
  turnInFlight: boolean;
  isWorkingProfile: boolean;
  onToggleEnabled: (profileId: string) => void;
  onToggleCouncil: () => void;
  onToggleSmartPicking: () => void;
  onTest: (profile: ModelProfile) => void;
  onEdit: (profile: ModelProfile) => void;
  onRequestDelete: (profileId: string) => void;
  onConfirmDelete: (profileId: string) => void;
  reconnectHandler?: () => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
  checkboxRef: (el: HTMLInputElement | null) => void;
}

const WORKING_ROW_CHIPS_TOOLTIP =
  'Your main model is always available. It stays in the Smart picking pool.';

function ProfileRow({
  profile,
  customProviders,
  testState,
  needsSetup,
  justAddedId,
  deleteConfirmId,
  turnInFlight,
  isWorkingProfile,
  onToggleEnabled,
  onToggleCouncil,
  onToggleSmartPicking,
  onTest,
  onEdit,
  onRequestDelete,
  onConfirmDelete,
  reconnectHandler,
  rowRef,
  checkboxRef,
}: ProfileRowProps) {
  const localPreset = getLocalInferencePresetByPresetKey(profile.presetKey);
  const providerLabel = localPreset
    ? `${localPreset.label} (local)`
    : getProviderDisplayLabel(profile, customProviders ?? []);
  const orphaned =
    Boolean(profile.customProviderId) &&
    providerLabel === 'Provider removed';
  const disabled = profile.enabled === false;
  const isJustAdded = justAddedId === profile.id;
  const entry = testState[profile.id];
  const confirming = deleteConfirmId === profile.id;
  const reconnectLabel = `Reconnect ${getProfileProviderDisplayName(profile)}`;
  const showReconnectButton = needsSetup && isConnectionManagedProfile(profile) && Boolean(reconnectHandler);
  const membershipDisabledReason = getMembershipDisabledReason({
    companyManaged: profile.companyManaged === true,
    disabled,
    orphaned,
    turnInFlight,
  });

  const classNames = [styles.row];
  if (disabled) classNames.push(styles.disabled);
  if (isJustAdded) classNames.push(styles.justAdded);

  return (
    <tr
      ref={rowRef}
      className={classNames.join(' ')}
      data-testid="settings-models-profile-row"
      data-profile-id={profile.id}
      aria-disabled={disabled ? 'true' : undefined}
    >
      <td className={`${styles.colName} ${styles.cell}`}>
        <div className={styles.nameRow}>
          <span className={styles.name}>{profile.name}</span>
          {isWorkingProfile && (
            <Tooltip content={WORKING_ROW_CHIPS_TOOLTIP}>
              <Badge
                variant="outline"
                size="sm"
                className={styles.mainBadge}
                data-testid={`settings-models-profile-main-badge-${profile.id}`}
              >
                Main
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className={styles.modelId}>{profile.model || profile.serverUrl}</div>
        {/* Narrow-width fallbacks: provider + thinking pill shown inline below
            model ID. Hidden via display:none at wide widths (which removes them
            from the a11y tree, so screen readers don't double-read). At narrow
            widths the dedicated columns are display:none and these become the
            sole carrier of the info — so they MUST NOT be aria-hidden. */}
        <div className={styles.narrowProvider}>{providerLabel}</div>
        <div className={styles.narrowThinking}>
          <ThinkingLevelPill effort={resolveProfileReasoningEffort(profile)} />
        </div>
      </td>

      <td className={`${styles.colProvider} ${styles.cell}`}>
        <span className={orphaned ? styles.providerOrphaned : styles.provider}>
          {providerLabel}
        </span>
      </td>

      <td className={`${styles.colThinking} ${styles.cell}`}>
        <ThinkingLevelPill effort={resolveProfileReasoningEffort(profile)} />
      </td>

      <td className={`${styles.colStatus} ${styles.cell}`}>
        <span className={styles.statusCellContent}>
          <span
            role="status"
            aria-live="polite"
            className={styles.statusWrapper}
          >
            {needsSetup ? (
              <>
                <Badge
                  variant="warning"
                  size="sm"
                  className={`${styles.statusPill} ${styles.iconOnlyBelow720}`}
                >
                  <span>Needs setup</span>
                </Badge>
                {showReconnectButton && reconnectHandler && (
                  <Button
                    variant="outline"
                    size="xs"
                    className={styles.enrichButton}
                    onClick={reconnectHandler}
                    data-testid={`settings-models-profile-reconnect-${profile.id}`}
                  >
                    {reconnectLabel}
                  </Button>
                )}
              </>
            ) : entry?.testing ? (
              <Badge
                variant="secondary"
                size="sm"
                className={`${styles.statusPill} ${styles.iconOnlyBelow720}`}
              >
                <Loader2 size={12} aria-hidden="true" className={styles.spinner} />
                <span>Testing…</span>
              </Badge>
            ) : entry?.result ? (
              <>
                <TestResultPill
                  result={entry.result}
                  className={styles.iconOnlyBelow720}
                />
                {entry.result.success && lacksRoutingNotes(profile) && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className={styles.enrichButton}
                    onClick={() => requestModelProfileEnrichment(profile)}
                    title="Looks up what this model is good at, so Rebel knows when to use it."
                    data-testid={`settings-models-profile-enrich-${profile.id}`}
                  >
                    Research this model
                  </Button>
                )}
              </>
            ) : (
              <ChatCompatibilityBadge
                compatibility={profile.chatCompatibility}
                checkedAt={profile.chatCompatibilityCheckedAt}
                jsonCompatibility={profile.jsonCompatibility}
                jsonCheckedAt={profile.jsonCompatibilityCheckedAt}
                thinkingCompatibility={profile.thinkingCompatibility}
                thinkingCheckedAt={profile.thinkingCompatibilityCheckedAt}
                toolUseCompatibility={profile.toolUseCompatibility}
                toolUseCheckedAt={profile.toolUseCompatibilityCheckedAt}
                className={styles.iconOnlyBelow720}
              />
            )}
          </span>
          <ProfileMembershipChips
            councilEnabled={profile.councilEnabled}
            routingEligible={isWorkingProfile ? true : profile.routingEligible}
            disabledReason={isWorkingProfile ? null : membershipDisabledReason}
            passive={isWorkingProfile}
            passiveTooltip={isWorkingProfile ? WORKING_ROW_CHIPS_TOOLTIP : undefined}
            onToggleCouncil={onToggleCouncil}
            onToggleSmartPicking={onToggleSmartPicking}
            testIdPrefix={`settings-models-profile-membership-${profile.id}`}
          />
          <span className={styles.badgeGroup}>
            {profile.companyManaged && (
              <Badge variant="outline" size="sm">
                Managed
              </Badge>
            )}
          </span>
        </span>
      </td>

      <td className={`${styles.colActions} ${styles.cell}`}>
        <div className={styles.actions}>
          {/* Enable/disable toggle — first in actions cell so it reads as
              "temporarily switch off, not delete". Tooltip reinforces
              reversibility. Ref forwarded here for just-added focus. */}
          <Tooltip
            content={
              disabled
                ? 'Enable this model. It will return to rotation.'
                : 'Disable this model. It stays configured — just out of rotation.'
            }
          >
            {/* Compose Toggle directly (not InlineToggle) so we can attach
                data-testid and aria-label to the underlying <input>. InlineToggle
                only passes id/checked/disabled/className/onCheckedChange to its
                inner Toggle; arbitrary props land on the outer <label> instead. */}
            <label className={styles.enableToggleLabel}>
              <Toggle
                ref={checkboxRef}
                checked={!disabled}
                onCheckedChange={() => onToggleEnabled(profile.id)}
                aria-label={
                  disabled
                    ? 'Enable this model. It will return to rotation.'
                    : 'Disable this model. It stays configured — just out of rotation.'
                }
                data-testid={`settings-models-profile-enabled-${profile.id}`}
              />
              <span className={styles.enableToggleText} aria-hidden="true">
                {disabled ? 'Off' : 'On'}
              </span>
            </label>
          </Tooltip>
          {/* Divider separates the non-destructive toggle from the icon actions. */}
          <span className={styles.actionsDivider} aria-hidden="true" />
          {orphaned ? (
            // Disabled buttons don't fire hover/focus, so wrap a non-disabled
            // focusable span with the Tooltip. The button stays visually
            // disabled and clicks do nothing (no onClick handler).
            <Tooltip content="This profile's custom provider was deleted. Edit it to pick a new one.">
              <span
                tabIndex={0}
                className={styles.disabledTooltipWrap}
                role="button"
                aria-disabled="true"
                aria-label="Test disabled — custom provider removed"
                data-testid={`settings-models-profile-test-${profile.id}`}
              >
                <IconButton
                  variant="ghost"
                  size="xs"
                  className={styles.iconButton}
                  disabled
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <Zap size={12} aria-hidden="true" />
                </IconButton>
              </span>
            </Tooltip>
          ) : (
            <Tooltip content={isAnyCapabilityIncompatible(profile) ? 'Re-test this model — clears any stale "Not compatible" verdict before running' : 'Test this model'}>
              <IconButton
                variant="ghost"
                size="xs"
                className={styles.iconButton}
                onClick={() => onTest(profile)}
                disabled={Boolean(entry?.testing)}
                aria-label={isAnyCapabilityIncompatible(profile) ? 'Re-test this model' : 'Test this model'}
                data-testid={`settings-models-profile-test-${profile.id}`}
              >
                <Zap size={12} aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
          {!profile.companyManaged && (
            <Tooltip content="Edit this profile">
              <IconButton
                variant="ghost"
                size="xs"
                className={styles.iconButton}
                onClick={() => onEdit(profile)}
                aria-label="Edit this profile"
                data-testid={`settings-models-profile-edit-${profile.id}`}
              >
                <Pencil size={12} aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
          {!profile.companyManaged &&
            (confirming ? (
              <Button
                variant="ghost"
                size="xs"
                className={styles.deleteConfirmButton}
                onClick={() => onConfirmDelete(profile.id)}
                aria-label="Confirm delete"
                data-testid={`settings-models-profile-delete-${profile.id}`}
              >
                Delete?
              </Button>
            ) : (
              <Tooltip content="Delete this profile">
                <IconButton
                  variant="ghost"
                  size="xs"
                  danger
                  className={styles.iconButton}
                  onClick={() => onRequestDelete(profile.id)}
                  aria-label="Delete this profile"
                  data-testid={`settings-models-profile-delete-${profile.id}`}
                >
                  <Trash2 size={12} aria-hidden="true" />
                </IconButton>
              </Tooltip>
            ))}
        </div>
      </td>
    </tr>
  );
}

function isAnyCapabilityIncompatible(profile: ModelProfile): boolean {
  return (
    profile.chatCompatibility === 'incompatible'
    || profile.jsonCompatibility === 'incompatible'
    || profile.thinkingCompatibility === 'incompatible'
    || profile.toolUseCompatibility === 'incompatible'
  );
}

function getMembershipDisabledReason({
  companyManaged,
  disabled,
  orphaned,
  turnInFlight,
}: {
  companyManaged: boolean;
  disabled: boolean;
  orphaned: boolean;
  turnInFlight: boolean;
}): ProfileMembershipDisabledReason | null {
  if (companyManaged) return 'companyManaged';
  if (disabled) return 'profileDisabled';
  if (turnInFlight) return 'turnInFlight';
  if (orphaned) return 'orphanedProvider';
  return null;
}

function TestResultPill({ result, className }: { result: TestResult; className?: string }) {
  if (result.success) {
    const tooltip = result.modelResponse
      ? `${result.latencyMs ?? 0}ms · ${result.modelResponse}`
      : `${result.latencyMs ?? 0}ms`;
    return (
      <Tooltip content={tooltip}>
        <Badge variant="success" size="sm" className={className}>
          <CircleCheck size={12} aria-hidden="true" />
          <span>{`Works · ${result.latencyMs ?? 0}ms`}</span>
        </Badge>
      </Tooltip>
    );
  }
  const tooltip = result.error?.trim() || 'Test failed.';
  return (
    <Tooltip content={tooltip}>
      <Badge variant="destructive" size="sm" className={className}>
        <X size={12} aria-hidden="true" />
        <span>Failed</span>
      </Badge>
    </Tooltip>
  );
}
