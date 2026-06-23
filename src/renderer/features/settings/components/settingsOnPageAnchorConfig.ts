import type { SettingsDestinationId } from '@shared/navigation/settingsNavigationContract';
import type { SettingsTabId } from '@shared/navigation/types';

export type SettingsOnPageAnchorConfig = {
  anchorId: string;
  label: string;
  leafTab: SettingsTabId;
  scrollTarget: string;
  focusTarget: string;
  observeTargets: string[];
  hidden?: boolean;
};

const ANCHORS_BY_DESTINATION: Partial<Record<SettingsDestinationId, SettingsOnPageAnchorConfig[]>> = {
  workspace: [
    {
      anchorId: 'coreDirectory',
      label: 'Core directory',
      leafTab: 'spaces',
      scrollTarget: 'coreDirectory',
      focusTarget: 'coreDirectory',
      observeTargets: ['coreDirectory'],
    },
    {
      anchorId: 'scratchpad',
      label: 'Scratchpad',
      leafTab: 'spaces',
      scrollTarget: 'scratchpad',
      focusTarget: 'scratchpad',
      observeTargets: ['scratchpad'],
    },
    {
      anchorId: 'spaces',
      label: 'Spaces',
      leafTab: 'spaces',
      scrollTarget: 'spaces',
      focusTarget: 'spaces',
      observeTargets: ['spaces'],
    },
    {
      anchorId: 'cloudCapacity',
      label: 'Cloud capacity',
      leafTab: 'cloud',
      scrollTarget: 'cloudCapacity',
      focusTarget: 'cloudCapacity',
      observeTargets: ['cloudCapacity'],
    },
    {
      anchorId: 'cloudSync',
      label: 'Cloud sync',
      leafTab: 'cloud',
      scrollTarget: 'cloudSync',
      focusTarget: 'cloudSync',
      observeTargets: ['cloudSync'],
    },
    {
      anchorId: 'messagingChannels',
      label: 'Messaging',
      leafTab: 'cloud',
      scrollTarget: 'messagingChannels',
      focusTarget: 'messagingChannels',
      observeTargets: ['messagingChannels'],
    },
    {
      anchorId: 'who-can-message-rebel',
      label: 'Who can message Rebel',
      leafTab: 'cloud',
      scrollTarget: 'who-can-message-rebel',
      focusTarget: 'who-can-message-rebel',
      observeTargets: ['who-can-message-rebel'],
    },
    {
      anchorId: 'recent-message-attempts',
      label: 'Recent message attempts',
      leafTab: 'cloud',
      scrollTarget: 'recent-message-attempts',
      focusTarget: 'recent-message-attempts',
      observeTargets: ['recent-message-attempts'],
    },
    // Bottom of the Workspace page (below messaging). leafTab 'spaces' matches
    // searchIndex parity; the Workspace destination renders every section on one
    // scroll page, so scroll-spy keys off the `data-section` DOM position, not
    // leafTab. See docs/plans/260611_transfer-ui-tweaks/PLAN.md (Stage 4).
    {
      anchorId: 'moveToNewComputer',
      label: 'Move to a new computer',
      leafTab: 'spaces',
      scrollTarget: 'moveToNewComputer',
      focusTarget: 'moveToNewComputer',
      observeTargets: ['moveToNewComputer'],
    },
  ],
  account_preferences: [
    {
      anchorId: 'profile',
      label: 'Profile',
      leafTab: 'account',
      scrollTarget: 'profile',
      focusTarget: 'profile',
      observeTargets: ['profile'],
    },
    {
      anchorId: 'appearance',
      label: 'Appearance',
      leafTab: 'account',
      scrollTarget: 'appearance',
      focusTarget: 'appearance',
      observeTargets: ['appearance'],
    },
    {
      anchorId: 'notifications',
      label: 'Notifications',
      leafTab: 'account',
      scrollTarget: 'notifications',
      focusTarget: 'notifications',
      observeTargets: ['notifications'],
    },
  ],
  privacy_safety: [
    {
      anchorId: 'safetyRules',
      label: 'Your rules',
      leafTab: 'safety',
      scrollTarget: 'safetyRules',
      focusTarget: 'safetyRules',
      observeTargets: ['safetyRules'],
    },
    {
      anchorId: 'standingPermissions',
      label: 'What Rebel can do',
      leafTab: 'safety',
      scrollTarget: 'standingPermissions',
      focusTarget: 'standingPermissions',
      observeTargets: ['standingPermissions'],
    },
    {
      anchorId: 'safetyActivity',
      label: 'Activity',
      leafTab: 'safety',
      scrollTarget: 'safetyActivity',
      focusTarget: 'safetyActivity',
      observeTargets: ['safetyActivity'],
    },
    {
      anchorId: 'privacySafety',
      label: 'Privacy & data',
      leafTab: 'safety',
      scrollTarget: 'privacySafety',
      focusTarget: 'privacySafety',
      observeTargets: ['privacySafety'],
    },
  ],
  advanced: [
    {
      anchorId: 'supportDiagnostics',
      label: 'Support',
      leafTab: 'diagnostics',
      scrollTarget: 'supportDiagnostics',
      focusTarget: 'systemHealth',
      observeTargets: ['supportDiagnostics', 'systemHealth', 'toolsConnection', 'safeMode', 'onboarding', 'diagnosticsAdvanced'],
    },
    {
      anchorId: 'appUpdates',
      label: 'App updates',
      leafTab: 'diagnostics',
      scrollTarget: 'appUpdates',
      focusTarget: 'appUpdates',
      observeTargets: ['appUpdates'],
    },
    {
      anchorId: 'labsPlugins',
      label: 'Plugins',
      leafTab: 'plugins',
      scrollTarget: 'labsPlugins',
      focusTarget: 'pluginsActive',
      observeTargets: [
        'labsPlugins',
        'pluginsActive',
        'pluginsArchived',
        'pluginsAvailableFromSpaces',
      ],
    },
    {
      anchorId: 'developerTools',
      label: 'Developer',
      leafTab: 'developer',
      scrollTarget: 'developerTools',
      focusTarget: 'demoMode',
      observeTargets: ['developerTools', 'demoMode', 'developerDebug', 'advancedOverrides', 'frequentTools', 'analytics'],
      hidden: true,
    },
    {
      anchorId: 'advancedOperations',
      label: 'Advanced operations',
      leafTab: 'diagnostics',
      scrollTarget: 'advancedOperations',
      focusTarget: 'advancedOperations',
      observeTargets: ['advancedOperations'],
    },
    {
      anchorId: 'contextCompaction',
      label: 'Context Compaction',
      leafTab: 'diagnostics',
      scrollTarget: 'contextCompaction',
      focusTarget: 'contextCompaction',
      observeTargets: ['contextCompaction'],
    },
  ],
};

export function getSettingsOnPageAnchors(
  destination: SettingsDestinationId,
  options?: { developerModeEnabled?: boolean },
): SettingsOnPageAnchorConfig[] {
  const anchors = ANCHORS_BY_DESTINATION[destination] ?? [];
  return anchors.filter((anchor) => {
    if (anchor.anchorId === 'developerTools') {
      return options?.developerModeEnabled === true;
    }
    return !anchor.hidden;
  });
}

export function createSettingsAnchorOwnerMap(
  anchors: readonly SettingsOnPageAnchorConfig[],
): Map<string, string> {
  const ownerMap = new Map<string, string>();
  for (const anchor of anchors) {
    ownerMap.set(anchor.scrollTarget, anchor.anchorId);
    ownerMap.set(anchor.focusTarget, anchor.anchorId);
    for (const sectionId of anchor.observeTargets) {
      ownerMap.set(sectionId, anchor.anchorId);
    }
  }
  return ownerMap;
}
