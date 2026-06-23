import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Badge, BillingBadge, Button } from '@renderer/components/ui';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ModelProfile, ThinkingEffort } from '@shared/types';
import { getModelEffort } from '@shared/utils/modelNormalization';
import type { BillingSource } from '@shared/utils/billingSource';
import type { CatalogEntry } from '@shared/data/providerCatalogs';
import { findExistingManagedProfile } from '@shared/utils/catalogMaterialization';
import { ChatCompatibilityBadge, type ChatCompatibility } from './ChatCompatibilityBadge';
import { ProviderCatalogRow } from './ProviderCatalogRow';
import localSectionStyles from '../LocalModelSection.module.css';
import styles from './CatalogProviderGroup.module.css';

export interface CatalogProviderGroupProps {
  title: string;
  providerName: string;
  entries: readonly CatalogEntry[];
  reconnectRequired?: boolean;
  onReconnect?: () => void;
  claudeSettings?: {
    apiKey?: string | null;
    thinkingEffort?: ThinkingEffort;
    modelEfforts?: Partial<Record<string, ThinkingEffort>>;
  };
  onModelEffortChange?: (modelId: string, effort: ThinkingEffort) => void;
  existingProfiles?: readonly ModelProfile[];
  onRemoveFromTeam?: (profile: ModelProfile) => void;
  billingSource: BillingSource;
  /** Whether this group should default to expanded (smart defaults). */
  defaultExpanded?: boolean;
  /** Role names that currently use this provider's models. */
  activeRoles?: string[];
  /**
   * Optional `data-section` ID on the group's outer `<section>`, so settings
   * search/deep-links can target this catalog. When the group is rendered
   * inside a collapsed `SettingSection advanced` disclosure,
   * `useScrollToSection` walks up to the nearest `[data-advanced-section]`
   * and clicks the toggle to expand the disclosure before scrolling.
   */
  dataSection?: string;
}

const catalogProviderLabel = (entry: CatalogEntry): string => {
  switch (entry.providerType) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'google':
      return 'Gemini';
    case 'openrouter':
      return 'OpenRouter';
  }
};

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const formatModelCount = (count: number): string =>
  `${count} ${count === 1 ? 'model' : 'models'}`;

const resolveEffectiveReasoning = (entry: CatalogEntry): boolean | undefined =>
  entry.reasoning ?? entry.supportsReasoning;

const resolveThinkingCompatibility = (
  entry: CatalogEntry,
): ChatCompatibility | undefined => {
  const effective = resolveEffectiveReasoning(entry);
  if (effective === true) return 'compatible';
  if (effective === false) return 'incompatible';
  return undefined;
};

export function CatalogProviderGroup({
  title,
  providerName,
  entries,
  reconnectRequired,
  onReconnect,
  claudeSettings,
  onModelEffortChange,
  existingProfiles,
  onRemoveFromTeam,
  billingSource,
  defaultExpanded,
  activeRoles,
  dataSection,
}: CatalogProviderGroupProps) {
  const requestedExpanded = defaultExpanded ?? false;
  const [isExpanded, setIsExpanded] = useState(requestedExpanded);
  const [userHasToggled, setUserHasToggled] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const previousDefaultExpandedRef = useRef(requestedExpanded);
  const reactId = useId();
  const slug = useMemo(() => slugify(title), [title]);
  const buttonId = `catalog-provider-group-${slug}-${reactId}-button`;
  const panelId = `catalog-provider-group-${slug}-${reactId}-panel`;

  useEffect(() => {
    if (previousDefaultExpandedRef.current !== requestedExpanded) {
      previousDefaultExpandedRef.current = requestedExpanded;
      setUserHasToggled(false);
      setIsExpanded(requestedExpanded);
      return;
    }

    if (userHasToggled || !requestedExpanded) return;
    setIsExpanded(true);
  }, [requestedExpanded, userHasToggled]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
    setUserHasToggled(true);
  }, []);

  const visibleEntries = useMemo(() => {
    if (!reconnectRequired) return entries;
    return entries.filter((entry) => (
      Boolean(findExistingManagedProfile(existingProfiles ?? [], entry))
    ));
  }, [entries, existingProfiles, reconnectRequired]);

  const representativeNames = useMemo(() => {
    const mainEntries = visibleEntries.filter((entry) => entry.isMainModel);
    const representatives = (mainEntries.length > 0 ? mainEntries : visibleEntries).slice(0, 3);
    return representatives.map((entry) => entry.label);
  }, [visibleEntries]);

  const { mainEntries, auxEntries, hasMultipleGroups } = useMemo(() => {
    const main = visibleEntries.filter((entry) => entry.isMainModel);
    const auxiliary = visibleEntries.filter(
      (entry) =>
        entry.isAuxiliaryModel || (!entry.isMainModel && !entry.isAuxiliaryModel),
    );
    return {
      mainEntries: main,
      auxEntries: auxiliary,
      hasMultipleGroups: main.length > 0 && auxiliary.length > 0,
    };
  }, [visibleEntries]);

  const uniqueActiveRoles = useMemo(
    () => Array.from(new Set(activeRoles ?? [])).filter(Boolean),
    [activeRoles],
  );

  return (
    <section
      className={styles.providerGroup}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-testid={`settings-models-catalog-${slug}`}
      data-section={dataSection}
    >
      <Button
        id={buttonId}
        type="button"
        variant="ghost"
        className={styles.summaryButton}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        onClick={handleToggle}
        data-testid={`settings-models-catalog-${slug}-toggle`}
      >
        <span className={styles.summaryContent}>
          <span className={styles.summaryTopLine}>
            <span className={styles.providerName} role="heading" aria-level={4}>
              {providerName}
            </span>
            <BillingBadge source={billingSource} />
            {uniqueActiveRoles.map((role) => (
              <Badge key={role} variant="secondary" size="sm" className={styles.activeRoleBadge}>
                {role} model
              </Badge>
            ))}
          </span>
          <span className={styles.summarySecondaryLine}>
            <span>{formatModelCount(visibleEntries.length)}</span>
            {representativeNames.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className={styles.representativeNames}>
                  {representativeNames.join(', ')}
                </span>
              </>
            )}
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={isExpanded ? styles.chevronExpanded : styles.chevron}
        />
      </Button>

      {reconnectRequired && (
        <div className={localSectionStyles.reconnectCallout}>
          <span>Not ready: reconnect {providerName}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={onReconnect}
            disabled={!onReconnect}
            data-testid={`settings-models-reconnect-${slug}`}
          >
            Reconnect
          </Button>
        </div>
      )}

      {isExpanded && visibleEntries.length > 0 && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className={styles.panelOuter}
          data-testid={`settings-models-catalog-${slug}-panel`}
        >
          <div className={styles.catalogRows}>
            {hasMultipleGroups && (
              <h5 className={styles.subGroupHeader}>Recommended</h5>
            )}
            {mainEntries.map((entry) => {
              const effort = getModelEffort(claudeSettings, entry.model) as ThinkingEffort;
              const existingProfile = findExistingManagedProfile(existingProfiles ?? [], entry);
              return (
                <ProviderCatalogRow
                  key={`${entry.providerType}:${entry.routeSurface}:${entry.model}`}
                  model={{ value: entry.model, label: entry.label }}
                  providerLabel={catalogProviderLabel(entry)}
                  billingSource={billingSource}
                  description={entry.description}
                  effort={effort}
                  reasoning={resolveEffectiveReasoning(entry)}
                  showEffortControl={showAdvanced}
                  onTeam={Boolean(existingProfile)}
                  setupHint={
                    reconnectRequired && existingProfile
                      ? `Reconnect ${providerName} to use`
                      : undefined
                  }
                  onRemoveFromTeam={
                    existingProfile && onRemoveFromTeam
                      ? () => onRemoveFromTeam(existingProfile)
                      : undefined
                  }
                  capabilityBadges={
                    <ChatCompatibilityBadge
                      compatibility="compatible"
                      jsonCompatibility={entry.jsonSupport}
                      thinkingCompatibility={resolveThinkingCompatibility(entry)}
                      toolUseCompatibility={entry.toolUseSupport}
                      className={styles.capabilityBadge}
                    />
                  }
                  onEffortChange={(next) => onModelEffortChange?.(entry.model, next)}
                />
              );
            })}
            {hasMultipleGroups && auxEntries.length > 0 && (
              <h5 className={styles.subGroupHeader}>Faster / lighter</h5>
            )}
            {auxEntries.map((entry) => {
              const effort = getModelEffort(claudeSettings, entry.model) as ThinkingEffort;
              const existingProfile = findExistingManagedProfile(existingProfiles ?? [], entry);
              return (
                <ProviderCatalogRow
                  key={`${entry.providerType}:${entry.routeSurface}:${entry.model}`}
                  model={{ value: entry.model, label: entry.label }}
                  providerLabel={catalogProviderLabel(entry)}
                  billingSource={billingSource}
                  description={entry.description}
                  effort={effort}
                  reasoning={resolveEffectiveReasoning(entry)}
                  showEffortControl={showAdvanced}
                  onTeam={Boolean(existingProfile)}
                  setupHint={
                    reconnectRequired && existingProfile
                      ? `Reconnect ${providerName} to use`
                      : undefined
                  }
                  onRemoveFromTeam={
                    existingProfile && onRemoveFromTeam
                      ? () => onRemoveFromTeam(existingProfile)
                      : undefined
                  }
                  capabilityBadges={
                    <ChatCompatibilityBadge
                      compatibility="compatible"
                      jsonCompatibility={entry.jsonSupport}
                      thinkingCompatibility={resolveThinkingCompatibility(entry)}
                      toolUseCompatibility={entry.toolUseSupport}
                      className={styles.capabilityBadge}
                    />
                  }
                  onEffortChange={(next) => onModelEffortChange?.(entry.model, next)}
                />
              );
            })}
          </div>
          {entries.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.advancedButton}
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((prev) => !prev)}
              data-testid={`settings-models-catalog-${slug}-advanced-toggle`}
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
              {showAdvanced ? 'Hide advanced tuning' : 'Advanced tuning'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
