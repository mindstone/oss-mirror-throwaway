import { useMemo } from 'react';
import { Button, Notice, Toggle } from '@renderer/components/ui';
import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  assessCouncilEligibility,
  COUNCIL_MANAGED_ZERO_SURVIVOR_NOTICE,
  getCouncilProfiles,
  type ManagedAllowListState,
} from '@shared/utils/councilProfiles';
import { getRoutingEligibleProfiles } from '@shared/utils/routingProfiles';
import {
  selectHasAnyActiveTurn,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import { ProfileMembershipChips, type ProfileMembershipDisabledReason } from './ProfileMembershipChips';
import styles from './ModelTeamSection.module.css';

const WORKING_ROW_TOOLTIP = "Your main model is always available — it's the default for everything.";
const UNAVAILABLE_MANAGED_ALLOW_LIST_STATE: ManagedAllowListState = { kind: 'unavailable' };

export interface ModelTeamSectionProps {
  settings: AppSettings;
  workingAssignment: RoleAssignment;
  profiles: ModelProfile[];
  onSettingsChange: (updates: Partial<AppSettings>) => void;
  onProfilesChange: (profiles: ModelProfile[]) => void;
  onAddModel: () => void;
  onOpenProfileManager: (profileId: string) => void;
  turnInFlight?: boolean;
  managedAllowListState?: ManagedAllowListState;
}

type WorkingMember = {
  id: string;
  profileId: string | null;
  name: string;
  model: string | null;
  councilEnabled: boolean;
};

function settingsWithProfiles(settings: AppSettings, profiles: ModelProfile[]): AppSettings {
  return {
    ...settings,
    localModel: {
      ...(settings.localModel ?? { activeProfileId: null }),
      profiles,
    },
  };
}

function getWorkingMember(
  assignment: RoleAssignment,
  profiles: readonly ModelProfile[],
): WorkingMember {
  if (assignment.status.kind === 'profile-unavailable-model-active') {
    return {
      id: 'working-model',
      profileId: null,
      name: assignment.display.modelLabel || assignment.effectiveModelId || 'Main work model',
      model: assignment.effectiveModelId,
      councilEnabled: false,
    };
  }

  const primary = assignment.primary;
  if (primary.kind === 'profile') {
    const profile = profiles.find((candidate) => candidate.id === primary.profileId);
    return {
      id: `working-profile-${primary.profileId}`,
      profileId: primary.profileId,
      name: profile?.name || assignment.display.modelLabel || 'Main work model',
      model: profile?.model ?? assignment.effectiveModelId,
      councilEnabled: profile?.councilEnabled === true && profile.enabled !== false && Boolean(profile.model),
    };
  }

  return {
    id: 'working-model',
    profileId: null,
    name: assignment.display.modelLabel || assignment.effectiveModelId || 'Main work model',
    model: assignment.effectiveModelId,
    councilEnabled: false,
  };
}

function getMembershipDisabledReason(
  profile: ModelProfile,
  turnInFlight: boolean,
  managedNoBYOK: boolean,
): ProfileMembershipDisabledReason | null {
  if (profile.companyManaged === true) return 'companyManaged';
  if (profile.enabled === false) return 'profileDisabled';
  if (turnInFlight) return 'turnInFlight';
  if (managedNoBYOK) return 'managedNoBYOK';
  return null;
}

function modelKey(model: string | null | undefined): string {
  return model?.trim() ?? '';
}

function containsModel(profiles: readonly ModelProfile[], model: string | null): boolean {
  const targetModel = modelKey(model);
  if (!targetModel) return false;
  return profiles.some((profile) => modelKey(profile.model) === targetModel);
}

function unionProfileMembers(
  ...profileGroups: readonly (readonly ModelProfile[])[]
): ModelProfile[] {
  const membersById = new Map<string, ModelProfile>();
  for (const profileGroup of profileGroups) {
    for (const profile of profileGroup) {
      membersById.set(profile.id, profile);
    }
  }
  return Array.from(membersById.values());
}

function getConfiguredTeamProfiles(profiles: readonly ModelProfile[]): ModelProfile[] {
  return profiles.filter((profile) => Boolean(profile.model) && (
    profile.councilEnabled === true || profile.routingEligible === true
  ));
}

function findFirstDuplicateRoutingProfile(profiles: readonly ModelProfile[]): ModelProfile | null {
  const seenByModel = new Map<string, ModelProfile>();
  for (const profile of profiles) {
    const model = modelKey(profile.model);
    if (!model) {
      continue;
    }
    const existing = seenByModel.get(model);
    if (existing) {
      return existing;
    }
    seenByModel.set(model, profile);
  }
  return null;
}

export function pluralizeModel(count: number): string {
  return count === 1 ? 'model' : 'models';
}

export function ModelTeamSection({
  settings,
  workingAssignment,
  profiles,
  onSettingsChange,
  onProfilesChange,
  onAddModel,
  onOpenProfileManager,
  turnInFlight,
  managedAllowListState = UNAVAILABLE_MANAGED_ALLOW_LIST_STATE,
}: ModelTeamSectionProps) {
  const liveTurnInFlight = useSessionStore(selectHasAnyActiveTurn);
  const effectiveTurnInFlight = turnInFlight ?? liveTurnInFlight;
  const adaptiveRoutingEnabled = settings.experimental?.adaptiveRoutingEnabled === true;
  const workingMember = useMemo(
    () => getWorkingMember(workingAssignment, profiles),
    [workingAssignment, profiles],
  );
  const effectiveSettings = useMemo(
    () => settingsWithProfiles(settings, profiles),
    [settings, profiles],
  );
  const routingEligibleProfiles = useMemo(
    () => getRoutingEligibleProfiles(effectiveSettings),
    [effectiveSettings],
  );
  const councilProfiles = useMemo(
    () => getCouncilProfiles(effectiveSettings),
    [effectiveSettings],
  );
  const councilEligibility = useMemo(
    () => assessCouncilEligibility(councilProfiles, settings, managedAllowListState),
    [councilProfiles, managedAllowListState, settings],
  );
  const configuredTeamProfiles = useMemo(
    () => getConfiguredTeamProfiles(profiles),
    [profiles],
  );
  const teamProfiles = useMemo(
    () => unionProfileMembers(councilProfiles, routingEligibleProfiles, configuredTeamProfiles),
    [councilProfiles, configuredTeamProfiles, routingEligibleProfiles],
  );
  const includeWorkingMember = !containsModel(routingEligibleProfiles, workingMember.model);
  const duplicateRoutingProfile = useMemo(
    () => adaptiveRoutingEnabled ? findFirstDuplicateRoutingProfile(routingEligibleProfiles) : null,
    [adaptiveRoutingEnabled, routingEligibleProfiles],
  );
  const managedNoByokByProfileId = useMemo(() => {
    const out = new Map<string, boolean>();
    if (settings.activeProvider !== 'mindstone' || managedAllowListState.kind === 'unavailable') {
      return out;
    }
    for (const profile of teamProfiles) {
      const model = profile.model?.trim();
      if (!model) {
        out.set(profile.id, false);
        continue;
      }
      const eligibility = assessCouncilEligibility(
        [{ ...profile, model }],
        settings,
        managedAllowListState,
      );
      out.set(profile.id, eligibility.kind === 'blocked');
    }
    return out;
  }, [managedAllowListState, settings, teamProfiles]);
  const managedZeroSurvivor = settings.activeProvider === 'mindstone'
    && councilEligibility.kind === 'blocked';

  const smartPickingPoolCount = routingEligibleProfiles.length + (includeWorkingMember ? 1 : 0);
  const noSmartPickingChoice = smartPickingPoolCount < 2;

  const handleToggleSmartPicking = (checked: boolean) => {
    onSettingsChange({
      experimental: {
        ...settings.experimental,
        adaptiveRoutingEnabled: checked,
      },
    });
  };

  const handleToggleMembership = (
    profileId: string,
    key: 'councilEnabled' | 'routingEligible',
  ) => {
    onProfilesChange(
      profiles.map((profile) => {
        if (profile.id !== profileId) return profile;
        return { ...profile, [key]: !Boolean(profile[key]) };
      }),
    );
  };

  return (
    <section
      className={styles.section}
      data-section="modelTeam"
      data-testid="settings-model-team-section"
    >
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title} data-section-focus-target>
            Optional model team
          </h2>
          <p className={styles.description}>
            Add other models for Council discussions or Smart picking on routine steps. They cost whatever they cost.
          </p>
        </div>
        <label className={styles.masterToggle} htmlFor="model-team-smart-picking-toggle">
          <span>Smart model picking</span>
          {/* Master Smart picking toggle is intentionally NOT gated on turnInFlight.
              Per-row chip-toggles disable mid-turn (snapshot safety), but the master toggle
              pre-stages the policy for the user's NEXT turn — that's the user's natural
              intent when flipping it during a running turn. */}
          <Toggle
            id="model-team-smart-picking-toggle"
            data-testid="settings-model-team-smart-picking-toggle"
            checked={adaptiveRoutingEnabled}
            onCheckedChange={handleToggleSmartPicking}
          />
        </label>
      </div>

      <p
        className={styles.poolCount}
        data-testid="settings-model-team-routing-count"
      >
        Smart picking pool: {smartPickingPoolCount} {pluralizeModel(smartPickingPoolCount)}
      </p>

      {managedZeroSurvivor && (
        <p
          className={styles.poolCount}
          data-testid="settings-model-team-managed-zero-survivor-notice"
        >
          {COUNCIL_MANAGED_ZERO_SURVIVOR_NOTICE}
        </p>
      )}

      <div className={styles.notices}>
        {adaptiveRoutingEnabled && noSmartPickingChoice && (
          <Notice
            tone="warning"
            density="compact"
            placement="inline"
            actions={[{ label: 'Add a model', onClick: onAddModel, 'data-testid': 'settings-model-team-notice-add-model' }]}
            data-testid="settings-model-team-no-effect-notice"
          >
            Smart picking is on, but Rebel needs at least one extra model to pick between.
          </Notice>
        )}
        {!adaptiveRoutingEnabled && routingEligibleProfiles.length > 0 && (
          <Notice
            tone="info"
            density="compact"
            placement="inline"
            actions={[{ label: 'Turn on', onClick: () => handleToggleSmartPicking(true), 'data-testid': 'settings-model-team-turn-on' }]}
            data-testid="settings-model-team-off-notice"
          >
            Smart picking is off, so these models are waiting politely.
          </Notice>
        )}
        {duplicateRoutingProfile && (
          <Notice
            tone="warning"
            density="compact"
            placement="inline"
            actions={[{
              label: 'Open Profile Manager',
              onClick: () => onOpenProfileManager(duplicateRoutingProfile.id),
              'data-testid': 'settings-model-team-open-profile-manager',
            }]}
            data-testid="settings-model-team-duplicate-notice"
          >
            Two profiles use the same model. Rebel will only choose one of them while Smart picking is on.
          </Notice>
        )}
      </div>

      <div className={styles.memberList} role="list" data-testid="settings-model-team-list">
        {includeWorkingMember && (
          <div
            className={`${styles.memberRow} ${styles.workingRow}`}
            role="listitem"
            data-testid="settings-model-team-row-working"
            data-profile-id={workingMember.profileId ?? undefined}
            data-member-id={workingMember.id}
          >
            <div className={styles.memberText}>
              <div className={styles.memberName}>{workingMember.name}</div>
              <div className={styles.memberMeta}>
                {workingMember.model ? <span>{workingMember.model}</span> : null}
                <span>your main model — always in the pool</span>
              </div>
            </div>
            <ProfileMembershipChips
              councilEnabled={workingMember.councilEnabled}
              routingEligible
              passive
              passiveTooltip={WORKING_ROW_TOOLTIP}
              onToggleCouncil={() => undefined}
              onToggleSmartPicking={() => undefined}
              testIdPrefix="settings-model-team-working"
            />
          </div>
        )}

        {teamProfiles.map((profile) => (
          <div
            key={profile.id}
            className={styles.memberRow}
            role="listitem"
            data-testid="settings-model-team-row"
            data-profile-id={profile.id}
          >
            <div className={styles.memberText}>
              <div className={styles.memberName}>{profile.name}</div>
              <div className={styles.memberMeta}>{profile.model || profile.serverUrl}</div>
            </div>
            <ProfileMembershipChips
              councilEnabled={profile.councilEnabled}
              routingEligible={profile.routingEligible}
              disabledReason={getMembershipDisabledReason(
                profile,
                effectiveTurnInFlight,
                managedNoByokByProfileId.get(profile.id) === true,
              )}
              onToggleCouncil={() => handleToggleMembership(profile.id, 'councilEnabled')}
              onToggleSmartPicking={() => handleToggleMembership(profile.id, 'routingEligible')}
              testIdPrefix={`settings-model-team-${profile.id}`}
            />
          </div>
        ))}
      </div>

      {teamProfiles.length === 0 && (
        <div className={styles.emptyState} data-testid="settings-model-team-empty-state">
          <p>Just your main model for now — add another to give Rebel choices.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onAddModel}
            data-testid="settings-model-team-add-model"
          >
            Add a model to your team
          </Button>
        </div>
      )}
    </section>
  );
}
