/**
 * SafetyTab
 *
 * Settings tab for safety and memory permissions, structured as 4 zones:
 *   Zone 1: Your Safety Rules — SafetyPromptEditor
 *   Zone 2: What Rebel can do without asking — Tools and Memory sub-groups
 *   Zone 3: Activity — SafetyActivityLog (actions evaluated against rules)
 *   Zone 4: Built-in protections — Collapsed safe patterns list
 */

import { useMemo } from 'react';
import { X, Lock, Users, Building2, Globe, type LucideIcon, Crown, ClipboardList, CheckCircle2, MessageSquare, ShieldCheck, HardDrive, BrainCog, EyeOff, KeyRound, Unplug, ExternalLink } from 'lucide-react';
import { Badge, Button, IconButton, Tooltip, RichSelect, type RichSelectOption } from '@renderer/components/ui';
import type { SafetyLevel, SpaceConfig } from '@shared/types';
import { tracking } from '@renderer/src/tracking';
import { rendererIsOss } from '../../../../src/rendererIsOss';
import styles from '../SettingsSurface.module.css';
import type { SafetyTabProps } from './types';
import { SafetyPromptEditor } from '../SafetyPromptEditor';
import { SafetyActivityLog } from '../SafetyActivityLog';
import { SettingSection } from '../SettingSection';
import { ConnectedAppPermissions } from '../ConnectedAppPermissions';

/**
 * Built-in safe operation patterns that always skip evaluation.
 * These are read-only/metadata operations that can't cause harm.
 */
const BUILTIN_SAFE_PATTERNS = [
  'list_*',
  'search_*',
  'get_*',
  'fetch_*',
  'find_*',
  'describe_*',
  'discover_*',
  'query_*',
  'read_*',
  'show_*',
  'check_*',
  'view_*',
  'browse_*',
  'lookup_*',
  'inspect_*',
];

/**
 * User-friendly memory safety levels with new simplified labels.
 * 
 * | Technical   | UI Label                     | Tooltip |
 * |-------------|------------------------------|---------|
 * | permissive  | Save without asking          | Only available for private spaces |
 * | balanced    | Ask, if content is sensitive | Recommended default |
 * | cautious    | Always ask before saving     | Maximum control |
 */
const MEMORY_SAFETY_LEVELS: Array<RichSelectOption<SafetyLevel> & { shortLabel: string; tooltip: string }> = [
  {
    value: 'permissive',
    label: 'Save without asking',
    shortLabel: 'Auto-save',
    description: 'Rebel saves to this space without asking.',
    tooltip: 'Rebel saves to this space without asking. Only available for private spaces.',
  },
  {
    value: 'balanced',
    label: 'Ask, if content is sensitive',
    shortLabel: 'Balanced',
    description: "Rebel evaluates whether content might be sensitive. You'll only be asked when something looks risky.",
    tooltip: "Rebel evaluates whether content might be sensitive before saving. You'll only be asked when something looks like it shouldn't be shared with everyone who can access this space.",
  },
  {
    value: 'cautious',
    label: 'Always ask before saving',
    shortLabel: 'Always ask',
    description: 'Rebel asks your permission before every save to this space.',
    tooltip: 'Rebel asks your permission before every save to this space. Use when you want to review everything.',
  },
];

/** Get options for a space based on whether it's private or shared */
const getSpaceSafetyOptions = (isPrivate: boolean): RichSelectOption<SafetyLevel>[] => {
  if (isPrivate) {
    // Private spaces can have all options
    return MEMORY_SAFETY_LEVELS.map(level => ({
      value: level.value,
      label: level.label,
      description: level.description,
    }));
  }
  // Shared spaces cannot be permissive (safety floor)
  return MEMORY_SAFETY_LEVELS.filter(level => level.value !== 'permissive').map(level => ({
    value: level.value,
    label: level.label,
    description: level.description,
  }));
};

/** Get the icon for a space based on its sharing level */
const getSharingIcon = (sharing: SpaceConfig['sharing'] | undefined): LucideIcon => {
  switch (sharing) {
    case 'private': return Lock;
    case 'restricted': return Users;
    case 'company-wide': return Building2;
    case 'public': return Globe;
    default: return Users; // Default to Users for unknown sharing
  }
};

export const SafetyTab = ({ draftSettings, updateDraft, onChatAboutSafety }: SafetyTabProps) => {
  // Memory safety - new simplified per-space configuration
  const spaceSafetyLevels = draftSettings.spaceSafetyLevels ?? {};

  // Sort spaces: Chief-of-Staff first, then by name
  const sortedSpaces = useMemo(() => {
    const trackedSpaces = draftSettings.spaces ?? [];
    return [...trackedSpaces].sort((a, b) => {
      if (a.type === 'chief-of-staff') return -1;
      if (b.type === 'chief-of-staff') return 1;
      return (a.name ?? a.path).localeCompare(b.name ?? b.path);
    });
  }, [draftSettings.spaces]);

  const handleSpaceSafetyChange = (spacePath: string, level: SafetyLevel, isPrivate: boolean) => {
    const previousLevel = spaceSafetyLevels[spacePath] ?? (isPrivate ? 'permissive' : 'balanced');
    tracking.settings.memoryPermissionChanged(level, previousLevel);
    const updated = { ...spaceSafetyLevels, [spacePath]: level };
    updateDraft('spaceSafetyLevels', updated);
  };

  return (
    <>
      {/* ====== ZONE 1: YOUR SAFETY RULES ====== */}
      <SettingSection title="" data-section="safetyRules" data-testid="settings-section-safety-rules">
        <SafetyPromptEditor />
        {onChatAboutSafety && (
          <Button variant="outline" size="sm" onClick={onChatAboutSafety}>
            <MessageSquare size={14} />
            Chat with Rebel about your rules
          </Button>
        )}
      </SettingSection>

      {/* ====== ZONE 2: WHAT REBEL CAN DO WITHOUT ASKING ====== */}
      <SettingSection
        title="What Rebel can do without asking"
        description="These always apply, regardless of your safety rules."
        icon={CheckCircle2}
        data-section="standingPermissions"
        data-testid="settings-section-standing-permissions"
      >
        {/* TOOLS sub-group */}
        <div className={styles.standingPermSubGroup}>
          <h4 className={styles.standingPermSubGroupTitle}>Tools</h4>
          <p className={styles.standingPermSubGroupDesc}>
            Always allowed — these skip your safety rules entirely
          </p>
          {(draftSettings.trustedTools?.length ?? 0) > 0 ? (
            <div className={styles.trustedToolsList}>
              {draftSettings.trustedTools?.map((tool) => (
                <div key={tool.toolId} className={styles.trustedToolItem}>
                  <div className={styles.trustedToolInfo}>
                    <span className={styles.trustedToolName}>
                      {tool.displayName || tool.toolId}
                    </span>
                    {tool.serverHint && (
                      <Badge variant="muted" size="sm">{tool.serverHint}</Badge>
                    )}
                  </div>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    danger
                    onClick={() => {
                      const updated = draftSettings.trustedTools?.filter(
                        (t) => t.toolId !== tool.toolId
                      );
                      updateDraft('trustedTools', updated?.length ? updated : undefined);
                    }}
                    aria-label={`Remove ${tool.displayName || tool.toolId} from trusted tools`}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.emptyState}>
              When you tell Rebel a tool is always OK to use, it appears here. Remove to start asking again.
            </p>
          )}
        </div>

        {/* CONNECTED APP PERMISSIONS sub-group */}
        <div className={styles.standingPermSubGroup}>
          <ConnectedAppPermissions />
        </div>

        {/* MEMORY SPACES sub-group */}
        <div className={styles.standingPermSubGroup}>
          <h4 className={styles.standingPermSubGroupTitle}>Memory Spaces</h4>
          <p className={styles.standingPermSubGroupDesc}>
            Control when Rebel asks before saving to each space
          </p>
          {sortedSpaces.length > 0 ? (
            <div className={styles.spaceOverridesList}>
              {sortedSpaces.map((space) => {
                const isChiefOfStaff = space.type === 'chief-of-staff';
                const isPrivate = space.sharing === 'private';
                const SharingIcon = isChiefOfStaff ? Crown : getSharingIcon(space.sharing);

                // Chief-of-Staff is always permissive and locked
                // Private spaces default to 'permissive', others default to 'balanced'
                const currentLevel = isChiefOfStaff
                  ? 'permissive'
                  : (spaceSafetyLevels[space.path] ?? (isPrivate ? 'permissive' : 'balanced'));

                const levelLabel = MEMORY_SAFETY_LEVELS.find(l => l.value === currentLevel)?.label ?? 'Ask, if content is sensitive';

                return (
                  <div key={space.path} className={styles.spaceOverrideRow}>
                    <div className={styles.sharingLevelInfo}>
                      <Tooltip content={isChiefOfStaff
                        ? 'Your private space'
                        : isPrivate
                          ? 'Private - only you can see this'
                          : `Shared - ${space.sharing ?? 'restricted'} access`
                      }>
                        <SharingIcon size={16} aria-hidden />
                      </Tooltip>
                      <span className={styles.spaceOverrideName}>{space.name ?? space.path}</span>
                    </div>
                    {isChiefOfStaff ? (
                      <Tooltip content="Your private space always saves automatically. This cannot be changed.">
                        <span className={styles.lockedSafetyLevel}>
                          <Lock size={12} aria-hidden />
                          {levelLabel}
                        </span>
                      </Tooltip>
                    ) : (
                      <RichSelect
                        value={currentLevel}
                        onChange={(level) => handleSpaceSafetyChange(space.path, level, isPrivate)}
                        options={getSpaceSafetyOptions(isPrivate)}
                        size="sm"
                        className={styles.sharingLevelSelect}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={styles.emptyState}>
              No spaces configured. Add spaces in the Spaces tab.
            </p>
          )}
        </div>
      </SettingSection>

      {/* ====== ZONE 3: ACTIVITY ====== */}
      <SettingSection
        title="Activity"
        description="Actions Rebel evaluated against your safety rules, including work run in the cloud. Flag anything that shouldn't have been allowed."
        icon={ClipboardList}
        data-section="safetyActivity"
        data-testid="settings-section-safety-activity"
      >
        <SafetyActivityLog />
      </SettingSection>

      {/* ====== ZONE 4: BUILT-IN PROTECTIONS ====== */}
      <SettingSection
        title="Built-in protections"
        description="Read-only operations — searching, listing, looking things up — are always safe. Rebel never asks about these."
        advanced
      >
        <div className={styles.builtinSafePatterns}>
          {BUILTIN_SAFE_PATTERNS.map((pattern) => (
            <Badge key={pattern} variant="success" size="sm" className={styles.safePatternBadge}>
              {pattern}
            </Badge>
          ))}
        </div>
      </SettingSection>

      {/* ====== ZONE 5: PRIVACY & DATA ====== */}
      <SettingSection
        title="Privacy & Data"
        description="How Rebel handles your information."
        icon={ShieldCheck}
        data-section="privacySafety"
        data-testid="settings-section-privacy-safety"
      >
        <div className={styles.privacyGrid}>
          <div className={styles.privacyCard}>
            <HardDrive size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>Local-first</span>
              <p className={styles.privacyCardDesc}>
                Your files, memory, and workspace stay on your device and your chosen cloud storage. Mindstone doesn't host your content.
              </p>
            </div>
          </div>

          <div className={styles.privacyCard}>
            <BrainCog size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>No AI training on your data</span>
              <p className={styles.privacyCardDesc}>
                Neither Mindstone nor the default AI providers (Anthropic, OpenAI) use your data to train models.
              </p>
            </div>
          </div>

          <div className={styles.privacyCard}>
            <EyeOff size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>No conversation storage</span>
              <p className={styles.privacyCardDesc}>
                {rendererIsOss()
                  ? "Rebel doesn't store your conversations on Mindstone servers, and telemetry is off — nothing is sent unless you add your own credentials in Developer settings."
                  : "Rebel doesn't store your conversations on Mindstone servers. Only limited telemetry (feature usage, errors) is collected."}
              </p>
            </div>
          </div>

          <div className={styles.privacyCard}>
            <KeyRound size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>Secrets stay local</span>
              <p className={styles.privacyCardDesc}>
                API keys and OAuth tokens are stored locally on your device — never uploaded to Mindstone.
              </p>
            </div>
          </div>

          <div className={styles.privacyCard}>
            <Lock size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>Privacy Mode</span>
              <p className={styles.privacyCardDesc}>
                Toggle the lock icon in the input bar for extra-sensitive work. Rebel asks before every action.
              </p>
            </div>
          </div>

          <div className={styles.privacyCard}>
            <Unplug size={18} className={styles.privacyCardIcon} />
            <div className={styles.privacyCardContent}>
              <span className={styles.privacyCardTitle}>Connectors you control</span>
              <p className={styles.privacyCardDesc}>
                You choose which services to connect. Disconnect any time in Settings &rarr; Connectors.
              </p>
            </div>
          </div>
        </div>

        <div className={styles.privacyFooter}>
          <a
            href="rebel://library/rebel-system%2Fhelp-for-humans%2FRebel-privacy-policy.md"
            className={styles.privacyFooterLink}
          >
            Full privacy policy <ExternalLink size={12} />
          </a>
          <a
            href="rebel://library/rebel-system%2Fhelp-for-humans%2Fsecurity-and-tool-safety.md"
            className={styles.privacyFooterLink}
          >
            Security & tool safety <ExternalLink size={12} />
          </a>
        </div>
      </SettingSection>
    </>
  );
};
