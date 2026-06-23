/**
 * Settings navigation compatibility contract (IA redesign).
 *
 * Encodes the planned legacy tab/section → destination / leaf / public anchor mapping.
 * Stage 2–3 wire SettingsSurface, search, and callers to consume this; Stage 1 establishes
 * types, aliases, and scroll disambiguation only.
 */

import type { SettingsTabId } from './types';

/** Top-level sidebar destination after IA redesign (analytics + shell). */
export type SettingsDestinationId =
  | 'agent_voice'
  | 'connectors'
  | 'privacy_safety'
  | 'meetings'
  | 'workspace'
  | 'account_preferences'
  | 'usage'
  | 'advanced';

/** Public section ids (globally unique within Settings) from the redesign plan. */
export const PUBLIC_SETTINGS_SECTION_IDS = [
  'spaces',
  'cloudSync',
  'messagingChannels',
  'coreDirectory',
  'scratchpad',
  'profile',
  'safetyRules',
  'standingPermissions',
  'safetyActivity',
  'privacySafety',
  'appearance',
  'notifications',
  'supportDiagnostics',
  'appUpdates',
  'labsPlugins',
  'developerTools',
  'advancedOperations',
  'diagnosticsAdvanced',
  'notetaker',
  'experimental-meetings',
  'voiceAudio',
  'connectors',
  'localInference',
  'focus',
  'suggestions',
] as const;

export type PublicSettingsSectionId = (typeof PUBLIC_SETTINGS_SECTION_IDS)[number];

export function isPublicSettingsSectionId(value: string): value is PublicSettingsSectionId {
  return (PUBLIC_SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * Maps legacy hash ids to canonical public section ids.
 * Does not include `advanced` — that id is tab-scoped (see resolveSettingsSectionForScroll).
 */
export const SETTINGS_SECTION_ALIASES: Record<string, string> = {
  privacyData: 'privacySafety',
};

export type SettingsNavigationInput = {
  tab?: SettingsTabId;
  section?: string;
};

export type ResolvedSettingsNavigation = {
  leafTab: SettingsTabId;
  /** Canonical section id for scroll / secondary nav (after alias resolution). */
  section?: string;
  destination: SettingsDestinationId;
  redirectedFrom?: { tab?: SettingsTabId; section?: string };
};

export type ResolveSettingsNavigationOptions = {
  /** When false, `developer` targets resolve to Support & Diagnostics. Omitted skips gating (e.g. unit tests). */
  developerModeEnabled?: boolean;
};

function destinationForLeaf(leaf: SettingsTabId): SettingsDestinationId {
  switch (leaf) {
    case 'agents':
    case 'voice':
      return 'agent_voice';
    case 'tools':
      return 'connectors';
    case 'meetings':
      return 'meetings';
    case 'spaces':
    case 'cloud':
    case 'system':
      return 'workspace';
    case 'account':
      return 'account_preferences';
    case 'safety':
      return 'privacy_safety';
    case 'usage':
      return 'usage';
    case 'diagnostics':
    case 'plugins':
    case 'developer':
      return 'advanced';
    default:
      return 'workspace';
  }
}

/** Visible settings sidebar destination for a canonical leaf tab (post–IA redesign). */
export function getSettingsDestinationForLeafTab(leafTab: SettingsTabId): SettingsDestinationId {
  return destinationForLeaf(leafTab);
}

/** Apply non-ambiguous section aliases (privacy, meetings). */
export function canonicalizeSettingsSectionId(raw?: string): string | undefined {
  if (!raw) return undefined;
  return SETTINGS_SECTION_ALIASES[raw] ?? raw;
}

/**
 * Map a URL/caller section to the `data-section` value in the DOM for the active leaf tab.
 * Disambiguates legacy `advanced` (System vs Diagnostics vs Meetings).
 */
export function resolveSettingsSectionForScroll(
  activeLeafTab: SettingsTabId,
  targetSection?: string,
): string | undefined {
  if (!targetSection) return undefined;

  if (targetSection === 'advanced') {
    if (activeLeafTab === 'diagnostics') return 'diagnosticsAdvanced';
    if (activeLeafTab === 'meetings') return 'advanced';
    return 'advancedOperations';
  }

  return canonicalizeSettingsSectionId(targetSection) ?? targetSection;
}

/**
 * Planned resolution per compatibility matrix (docs/plans/260401_settings_navigation_ia_redesign.md).
 * Not yet wired to all imperative openSettings callers — use for tests, search, and future routing.
 */
function applyDeveloperGate(
  resolved: ResolvedSettingsNavigation,
  input: SettingsNavigationInput,
  developerModeEnabled: boolean | undefined,
): ResolvedSettingsNavigation {
  if (developerModeEnabled !== false) return resolved;
  if (resolved.leafTab !== 'developer') return resolved;
  return {
    leafTab: 'diagnostics',
    section: 'supportDiagnostics',
    destination: 'advanced',
    redirectedFrom: { tab: 'developer', section: input.section },
  };
}

export function resolveSettingsNavigation(
  input: SettingsNavigationInput,
  options?: ResolveSettingsNavigationOptions,
): ResolvedSettingsNavigation {
  const rawSection = input.section;
  const section = rawSection ? canonicalizeSettingsSectionId(rawSection) ?? rawSection : undefined;

  if (!input.tab && rawSection) {
    const only = resolveSectionOnlyLink(section ?? rawSection, rawSection);
    if (only) return applyDeveloperGate(only, input, options?.developerModeEnabled);
  }

  const tab = input.tab;

  if (tab === 'agents' && rawSection === 'voiceAudio') {
    return applyDeveloperGate(
      {
        leafTab: 'voice',
        section: 'voiceAudio',
        destination: 'agent_voice',
        redirectedFrom: { tab: 'agents', section: rawSection },
      },
      input,
      options?.developerModeEnabled,
    );
  }

  if (tab === 'system') {
    if (!rawSection) {
      return applyDeveloperGate(
        {
          leafTab: 'spaces',
          destination: 'workspace',
          redirectedFrom: { tab: 'system' },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    const sec = section ?? rawSection;
    if (sec === 'coreDirectory' || sec === 'scratchpad') {
      return applyDeveloperGate(
        {
          leafTab: 'spaces',
          section: sec,
          destination: 'workspace',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (sec === 'appearance' || sec === 'notifications' || sec === 'powerPerformance') {
      return applyDeveloperGate(
        {
          leafTab: 'account',
          section: sec,
          destination: 'account_preferences',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (sec === 'advancedOperations' || rawSection === 'advanced') {
      return applyDeveloperGate(
        {
          leafTab: 'diagnostics',
          section: 'advancedOperations',
          destination: 'advanced',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (rawSection === 'experimental-meetings') {
      return applyDeveloperGate(
        {
          leafTab: 'meetings',
          section: 'experimental-meetings',
          destination: 'meetings',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (sec === 'notetaker') {
      return applyDeveloperGate(
        {
          leafTab: 'meetings',
          section: 'notetaker',
          destination: 'meetings',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (sec === 'localInference' || sec === 'contextCompaction' || sec === 'focus' || sec === 'roles' || sec === 'preventSleep') {
      return applyDeveloperGate(
        {
          leafTab: 'diagnostics',
          section: sec,
          destination: 'advanced',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    if (sec === 'suggestions') {
      return applyDeveloperGate(
        {
          leafTab: 'account',
          section: sec,
          destination: 'account_preferences',
          redirectedFrom: { tab: 'system', section: rawSection },
        },
        input,
        options?.developerModeEnabled,
      );
    }
    return applyDeveloperGate(
      {
        leafTab: 'spaces',
        section: sec,
        destination: 'workspace',
        redirectedFrom: { tab: 'system', section: rawSection },
      },
      input,
      options?.developerModeEnabled,
    );
  }

  if (!tab) {
    return applyDeveloperGate(
      { leafTab: 'agents', destination: 'agent_voice' },
      input,
      options?.developerModeEnabled,
    );
  }

  switch (tab) {
    case 'agents':
      return applyDeveloperGate(
        { leafTab: 'agents', section, destination: 'agent_voice' },
        input,
        options?.developerModeEnabled,
      );
    case 'voice':
      return applyDeveloperGate(
        { leafTab: 'voice', section, destination: 'agent_voice' },
        input,
        options?.developerModeEnabled,
      );
    case 'tools':
      return applyDeveloperGate(
        { leafTab: 'tools', section, destination: 'connectors' },
        input,
        options?.developerModeEnabled,
      );
    case 'meetings':
      return applyDeveloperGate(
        { leafTab: 'meetings', section, destination: 'meetings' },
        input,
        options?.developerModeEnabled,
      );
    case 'spaces':
      return applyDeveloperGate(
        { leafTab: 'spaces', section: section ?? 'spaces', destination: 'workspace' },
        input,
        options?.developerModeEnabled,
      );
    case 'cloud':
      return applyDeveloperGate(
        { leafTab: 'cloud', section: section ?? 'cloudSync', destination: 'workspace' },
        input,
        options?.developerModeEnabled,
      );
    case 'account':
      return applyDeveloperGate(
        { leafTab: 'account', section: section ?? 'profile', destination: 'account_preferences' },
        input,
        options?.developerModeEnabled,
      );
    case 'safety':
      return applyDeveloperGate(
        { leafTab: 'safety', section: section ?? 'privacySafety', destination: 'privacy_safety' },
        input,
        options?.developerModeEnabled,
      );
    case 'usage':
      return applyDeveloperGate(
        { leafTab: 'usage', destination: 'usage' },
        input,
        options?.developerModeEnabled,
      );
    case 'diagnostics':
      return applyDeveloperGate(
        { leafTab: 'diagnostics', section: section ?? 'supportDiagnostics', destination: 'advanced' },
        input,
        options?.developerModeEnabled,
      );
    case 'plugins':
      return applyDeveloperGate(
        { leafTab: 'plugins', section: section ?? 'labsPlugins', destination: 'advanced' },
        input,
        options?.developerModeEnabled,
      );
    case 'developer':
      return applyDeveloperGate(
        { leafTab: 'developer', section: section ?? 'developerTools', destination: 'advanced' },
        input,
        options?.developerModeEnabled,
      );
    default:
      return applyDeveloperGate(
        { leafTab: tab, section, destination: destinationForLeaf(tab) },
        input,
        options?.developerModeEnabled,
      );
  }
}

function resolveSectionOnlyLink(
  normalized: string,
  raw: string,
): ResolvedSettingsNavigation | null {
  if (normalized === 'voiceAudio' || raw === 'voiceAudio') {
    return { leafTab: 'voice', section: 'voiceAudio', destination: 'agent_voice' };
  }
  if (normalized === 'connectors' || normalized === 'experimental-connectors') {
    return { leafTab: 'tools', section: normalized, destination: 'connectors' };
  }
  if (['spaces', 'coreDirectory', 'scratchpad'].includes(normalized)) {
    return {
      leafTab: 'spaces',
      section: normalized === 'spaces' ? 'spaces' : normalized,
      destination: 'workspace',
    };
  }
  if (normalized === 'cloudSync') {
    return { leafTab: 'cloud', section: 'cloudSync', destination: 'workspace' };
  }
  if (normalized === 'messagingChannels') {
    return { leafTab: 'cloud', section: 'messagingChannels', destination: 'workspace' };
  }
  if (['profile', 'appearance', 'notifications', 'powerPerformance'].includes(normalized)) {
    return { leafTab: 'account', section: normalized, destination: 'account_preferences' };
  }
  if (
    normalized === 'privacySafety' ||
    normalized === 'safetyRules' ||
    normalized === 'standingPermissions' ||
    normalized === 'safetyActivity' ||
    raw === 'privacyData'
  ) {
    const section = raw === 'privacyData' ? 'privacySafety' : normalized;
    return { leafTab: 'safety', section, destination: 'privacy_safety' };
  }
  if (
    ['supportDiagnostics', 'appUpdates', 'systemHealth', 'safeMode', 'onboarding', 'diagnosticsAdvanced'].includes(
      normalized,
    )
  ) {
    return { leafTab: 'diagnostics', section: normalized, destination: 'advanced' };
  }
  if (normalized === 'labsPlugins') {
    return { leafTab: 'plugins', section: 'labsPlugins', destination: 'advanced' };
  }
  if (normalized === 'developerTools') {
    return { leafTab: 'developer', section: 'developerTools', destination: 'advanced' };
  }
  if (normalized === 'advancedOperations' || raw === 'advanced') {
    return { leafTab: 'diagnostics', section: 'advancedOperations', destination: 'advanced' };
  }
  if (raw === 'experimental-meetings') {
    return { leafTab: 'meetings', section: 'experimental-meetings', destination: 'meetings' };
  }
  if (['notetaker', 'join-behavior'].includes(normalized)) {
    return { leafTab: 'meetings', section: normalized, destination: 'meetings' };
  }
  if (normalized === 'usage') {
    return { leafTab: 'usage', destination: 'usage' };
  }
  if (normalized === 'localInference' || normalized === 'contextCompaction' || normalized === 'focus' || normalized === 'roles' || normalized === 'preventSleep') {
    return { leafTab: 'diagnostics', section: normalized, destination: 'advanced' };
  }
  if (normalized === 'suggestions') {
    return { leafTab: 'account', section: 'suggestions', destination: 'account_preferences' };
  }
  return null;
}
