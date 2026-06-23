import { useMemo } from 'react';
import { Notice, Toggle, Tooltip } from '@renderer/components/ui';
import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import { normalizeCatalogModelId } from '@shared/data/providerCatalogs';
import {
  getFunctionalRoutingProfiles,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';
import styles from './SmartPickingToolbar.module.css';

const MASTER_TOGGLE_TOOLTIP =
  'When on, Rebel can pick from the models below for individual plan steps. Toggle the Smart picking chip on a row to add or remove it from the pool.';

export interface SmartPickingToolbarProps {
  settings: AppSettings;
  profiles: ModelProfile[];
  workingAssignment?: RoleAssignment;
  connectivity?: ProfileConnectivity;
  onSettingsChange: (updates: Partial<AppSettings>) => void;
  onAddModel: () => void;
  onOpenProfileManager: (profileId: string) => void;
}

function modelKey(model: string | null | undefined): string {
  return model?.trim() ?? '';
}

function routingProfileSurface(profile: ModelProfile): string {
  if (profile.routeSurface) return profile.routeSurface;
  if (profile.providerType === 'local') return 'local';
  if (profile.providerType === 'openrouter') return 'pool';
  if (profile.authSource === 'codex-subscription') return 'subscription';
  return 'api-key';
}

function duplicateRoutingKey(profile: ModelProfile): string {
  const providerType = profile.providerType ?? 'other';
  return [
    providerType,
    routingProfileSurface(profile),
    normalizeCatalogModelId(profile.model ?? ''),
  ].join(':');
}

function containsModel(profiles: readonly ModelProfile[], model: string | null | undefined): boolean {
  const targetModel = modelKey(model);
  if (!targetModel) return false;
  return profiles.some((profile) => modelKey(profile.model) === targetModel);
}

function findFirstDuplicateRoutingProfile(profiles: readonly ModelProfile[]): ModelProfile | null {
  const seenByRouteKey = new Map<string, ModelProfile>();
  for (const profile of profiles) {
    const model = modelKey(profile.model);
    if (!model) continue;
    const routeKey = duplicateRoutingKey(profile);
    const existing = seenByRouteKey.get(routeKey);
    if (existing) return existing;
    seenByRouteKey.set(routeKey, profile);
  }
  return null;
}

function pluralizeModel(count: number): string {
  return count === 1 ? 'model' : 'models';
}

function settingsWithProfiles(settings: AppSettings, profiles: ModelProfile[]): AppSettings {
  return {
    ...settings,
    localModel: {
      ...(settings.localModel ?? { activeProfileId: null }),
      profiles,
    },
  };
}

export function SmartPickingToolbar({
  settings,
  profiles,
  workingAssignment,
  connectivity,
  onSettingsChange,
  onAddModel,
  onOpenProfileManager,
}: SmartPickingToolbarProps) {
  const adaptiveRoutingEnabled = settings.experimental?.adaptiveRoutingEnabled === true;

  const effectiveSettings = useMemo(
    () => settingsWithProfiles(settings, profiles),
    [settings, profiles],
  );
  const routingEligibleProfiles = useMemo(
    () => getFunctionalRoutingProfiles(effectiveSettings, connectivity),
    [connectivity, effectiveSettings],
  );

  const workingModelId = workingAssignment?.effectiveModelId ?? null;
  const includeWorkingMember = !containsModel(routingEligibleProfiles, workingModelId);
  const poolCount = routingEligibleProfiles.length + (includeWorkingMember ? 1 : 0);
  const noSmartPickingChoice = poolCount < 2;
  const duplicateRoutingProfile = useMemo(
    () => (adaptiveRoutingEnabled ? findFirstDuplicateRoutingProfile(routingEligibleProfiles) : null),
    [adaptiveRoutingEnabled, routingEligibleProfiles],
  );

  const handleToggleSmartPicking = (checked: boolean) => {
    onSettingsChange({
      experimental: {
        ...settings.experimental,
        adaptiveRoutingEnabled: checked,
      },
    });
  };

  return (
    <section
      className={styles.toolbar}
      data-section="modelTeam"
      data-testid="settings-smart-picking-toolbar"
    >
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <h3 className={styles.title} data-section-focus-target>
            Smart model picking
          </h3>
          <p className={styles.description}>
            When on, Rebel picks the best model for each step from the pool below. Toggle the
            <span className={styles.chipName}> Smart picking </span>
            chip on any model row to add or remove it.
          </p>
        </div>
        <label className={styles.masterToggle} htmlFor="smart-picking-master-toggle">
          <Tooltip content={MASTER_TOGGLE_TOOLTIP} maxWidth="280px">
            <span>Smart model picking</span>
          </Tooltip>
          {/* Master Smart picking toggle is intentionally NOT gated on turnInFlight.
              Per-row chip-toggles disable mid-turn (snapshot safety), but the master toggle
              pre-stages the policy for the user's NEXT turn — that's the user's natural
              intent when flipping it during a running turn. */}
          <Toggle
            id="smart-picking-master-toggle"
            data-testid="settings-smart-picking-master-toggle"
            checked={adaptiveRoutingEnabled}
            onCheckedChange={handleToggleSmartPicking}
          />
        </label>
      </div>

      <p
        className={styles.poolCount}
        data-testid="settings-smart-picking-pool-count"
      >
        Smart picking pool: {poolCount} {pluralizeModel(poolCount)}
      </p>

      <div className={styles.notices}>
        {adaptiveRoutingEnabled && noSmartPickingChoice && (
          <Notice
            tone="warning"
            density="compact"
            placement="inline"
            actions={[
              {
                label: 'Add a model',
                onClick: onAddModel,
                'data-testid': 'settings-smart-picking-notice-add-model',
              },
            ]}
            data-testid="settings-smart-picking-no-effect-notice"
          >
            Smart picking is on, but Rebel needs at least one extra model to pick between.
          </Notice>
        )}
        {!adaptiveRoutingEnabled && routingEligibleProfiles.length > 0 && (
          <Notice
            tone="info"
            density="compact"
            placement="inline"
            actions={[
              {
                label: 'Turn on',
                onClick: () => handleToggleSmartPicking(true),
                'data-testid': 'settings-smart-picking-turn-on',
              },
            ]}
            data-testid="settings-smart-picking-off-notice"
          >
            Smart picking is off, so these models won't be chosen automatically.
          </Notice>
        )}
        {duplicateRoutingProfile && (
          <Notice
            tone="warning"
            density="compact"
            placement="inline"
            actions={[
              {
                label: 'Open Profile Manager',
                onClick: () => onOpenProfileManager(duplicateRoutingProfile.id),
                'data-testid': 'settings-smart-picking-open-profile-manager',
              },
            ]}
            data-testid="settings-smart-picking-duplicate-notice"
          >
            Two profiles use the same model. Rebel will only choose one of them while Smart picking is on.
          </Notice>
        )}
      </div>
    </section>
  );
}
