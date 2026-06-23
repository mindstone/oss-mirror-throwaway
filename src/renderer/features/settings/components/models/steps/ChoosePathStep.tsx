import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Badge, BillingBadge, Button, IconButton, Input } from '@renderer/components/ui';
import type { ModelProfile } from '@shared/types';
import type { BillingSource } from '@shared/utils/billingSource';
import {
  findExistingManagedProfile,
  type ConnectorCatalogEntry,
} from '@shared/utils/catalogMaterialization';
import { normalizeCatalogModelId, PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import styles from './ChoosePathStep.module.css';

export type CatalogConnectionHandle = 'codex' | 'openrouter' | 'anthropic' | 'gemini';

export interface CatalogProviderConnectionState {
  connected: boolean;
  onConnect?: () => void;
}

export type CatalogProviderConnections = Partial<
  Record<CatalogConnectionHandle, CatalogProviderConnectionState>
>;

export interface ChoosePathStepProps {
  onAddCatalogEntry: (entry: ConnectorCatalogEntry) => Promise<void>;
  onSelectCustom: () => void;
  connectorCatalogEntries: readonly ConnectorCatalogEntry[];
  existingProfiles: readonly ModelProfile[];
  onRemoveFromTeam: (profile: ModelProfile) => Promise<void>;
  providerConnections?: CatalogProviderConnections;
  busyEntryKey?: string | null;
  /**
   * Managed allowed model IDs (from useManagedDefaults). Non-empty only for a
   * Mindstone subscriber. When non-empty, the "Included with your Mindstone plan"
   * group renders regardless of active provider. Defaults to [] so other
   * callers/tests are unaffected.
   */
  managedAllowedModels?: readonly string[];
  /**
   * Whether the active provider is Mindstone (activeProvider === 'mindstone').
   * Defaults to false. Does NOT control managed-group visibility (that's driven
   * by managedAllowedModels); it controls whether managed rows are addable
   * (on-Mindstone) vs informational (off-Mindstone) — because a managed model
   * only routes via the managed key when Mindstone is the active provider.
   */
  isMindstoneActive?: boolean;
}

interface ProviderGroupConfig {
  handle: CatalogConnectionHandle;
  title: string;
  billingSource: BillingSource;
}

type UsefulActionPriority = 'add' | 'reconnect' | 'remove' | 'custom';

const PROVIDER_GROUPS: readonly ProviderGroupConfig[] = [
  {
    handle: 'codex',
    title: 'ChatGPT Pro',
    billingSource: 'subscription',
  },
  {
    handle: 'openrouter',
    title: 'OpenRouter',
    billingSource: 'pool',
  },
  {
    handle: 'anthropic',
    title: 'Anthropic',
    billingSource: 'pay-per-use',
  },
  {
    handle: 'gemini',
    title: 'Gemini',
    billingSource: 'pay-per-use',
  },
];

const SHOW_MAIN_ONLY_THRESHOLD = 10;

/**
 * Cap for the Recommended section shortlist. Keeps it a genuine "start here"
 * set rather than a near-duplicate of the full connection groups.
 * See PLAN.md § Stage 3 (DA #3).
 */
const RECOMMENDED_CAP = 6;

const EMPTY_USEFUL_ACTION_REFS: Record<UsefulActionPriority, HTMLButtonElement | null> = {
  add: null,
  reconnect: null,
  remove: null,
  custom: null,
};

export function catalogEntryKey(entry: ConnectorCatalogEntry): string {
  return `${entry.providerType}:${entry.routeSurface}:${entry.model}`;
}

function providerHandleForEntry(entry: ConnectorCatalogEntry): CatalogConnectionHandle {
  if (entry.providerType === 'openrouter') return 'openrouter';
  if (entry.providerType === 'anthropic') return 'anthropic';
  if (entry.providerType === 'google') return 'gemini';
  return 'codex';
}

function reconnectGuidanceForProvider(handle: CatalogConnectionHandle, title: string): string {
  if (handle === 'anthropic') {
    return 'Re-add your Anthropic API key in Settings to use these again.';
  }
  if (handle === 'gemini') {
    return 'Re-add your Gemini API key in Settings to use these again.';
  }
  return `Reconnect ${title} in Settings to use these again.`;
}

function capNonMaterializedEntries(
  allEntries: readonly ConnectorCatalogEntry[],
  nonMaterializedEntries: readonly ConnectorCatalogEntry[],
  showAll: boolean,
): readonly ConnectorCatalogEntry[] {
  if (showAll || allEntries.length <= SHOW_MAIN_ONLY_THRESHOLD) return nonMaterializedEntries;
  const mainEntries = nonMaterializedEntries.filter((entry) => entry.isMainModel);
  return mainEntries.length > 0
    ? mainEntries
    : nonMaterializedEntries.slice(0, SHOW_MAIN_ONLY_THRESHOLD);
}

/**
 * Returns the display title for a catalog entry's provider group, used as an
 * additional search haystack field so queries like "OpenRouter", "ChatGPT Pro",
 * "Gemini", or "Anthropic" reliably match their provider's models.
 * Falls back to the provider handle if no group config is found.
 */
function providerTitleForEntry(entry: ConnectorCatalogEntry): string {
  const handle = providerHandleForEntry(entry);
  return PROVIDER_GROUPS.find((g) => g.handle === handle)?.title ?? handle;
}

function matchesSearchQuery(entry: ConnectorCatalogEntry, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const label = entry.label.toLowerCase();
  const modelId = normalizeCatalogModelId(entry.model);
  const description = (entry.description ?? '').toLowerCase();
  const providerTitle = providerTitleForEntry(entry).toLowerCase();
  const providerHandle = providerHandleForEntry(entry).toLowerCase();
  return (
    label.includes(normalizedQuery) ||
    modelId.includes(normalizedQuery) ||
    description.includes(normalizedQuery) ||
    providerTitle.includes(normalizedQuery) ||
    providerHandle.includes(normalizedQuery)
  );
}

// ---------------------------------------------------------------------------
// PickerModelRow
//
// Extracted from the connection-group row render loop so the Recommended
// section (and Stage 4's Managed section) can reuse identical anatomy + test-ids
// without routing through the reconnect/cap/materialized-pinning machinery.
// Row anatomy, props, and test-ids are intentionally identical to the inline
// version; see PLAN.md § Refactor Assessment.
// ---------------------------------------------------------------------------

interface PickerModelRowProps {
  entry: ConnectorCatalogEntry;
  existingProfile: ModelProfile | undefined;
  adding: boolean;
  removing: boolean;
  actionLockActive: boolean;
  /** Whether the Add button is enabled (false for disconnected groups). */
  canAdd: boolean;
  /** Optional reconnect-required meta label (connection groups only). */
  reconnectRequired?: boolean;
  /**
   * Informational mode: renders an "On your plan" badge instead of the Add
   * button when the row is visible but not yet actionable (e.g. managed models
   * visible to a subscriber whose active provider is not Mindstone). Mirrors the
   * canAdd/reconnectRequired vocabulary — the same component, one more honest state.
   * Ignored when existingProfile is present (existing rows always show Remove).
   */
  informational?: boolean;
  /** Ref callback for the Add button (used for focus-priority assignment). */
  addButtonRef?: (node: HTMLButtonElement | null) => void;
  /** Ref callback for the Remove button (used for focus-priority assignment). */
  removeButtonRef?: (node: HTMLButtonElement | null) => void;
  onAdd: () => void;
  onRemove: () => void;
  /**
   * Optional section namespace for test-ids. When provided, row/add/remove
   * test-ids are prefixed with `settings-models-picker-${sectionKey}-` instead
   * of the default `settings-models-picker-` so models rendered in multiple
   * sections (Recommended, Managed, connection group) have unambiguous test-ids.
   * Connection groups omit this to keep their stable external test-id contract.
   */
  sectionKey?: string;
}

function PickerModelRow({
  entry,
  existingProfile,
  adding,
  removing,
  actionLockActive,
  canAdd,
  reconnectRequired,
  informational,
  addButtonRef,
  removeButtonRef,
  onAdd,
  onRemove,
  sectionKey,
}: PickerModelRowProps) {
  const entryKey = catalogEntryKey(entry);
  // Namespace test-ids when a sectionKey is provided so each section's rows
  // have unambiguous IDs. Connection groups omit sectionKey to preserve their
  // stable external test-id contract (AgentsTab/ProfileWizardDialog tests).
  const rowTestId = sectionKey
    ? `settings-models-picker-${sectionKey}-row-${entryKey}`
    : `settings-models-picker-row-${entryKey}`;
  const addTestId = sectionKey
    ? `settings-models-picker-${sectionKey}-add-${entryKey}`
    : `settings-models-picker-add-${entryKey}`;
  const removeTestId = sectionKey
    ? `settings-models-picker-${sectionKey}-remove-${entryKey}`
    : `settings-models-picker-remove-${entryKey}`;

  return (
    <li
      className={styles.modelRow}
      data-testid={rowTestId}
    >
      <div className={styles.modelInfo}>
        <div className={styles.modelName} title={entry.label}>
          {entry.label}
        </div>
        <div className={styles.modelDescription}>
          {entry.description}
        </div>
        <div className={styles.modelMetaLine}>
          <span className={styles.modelId} title={entry.model}>
            {entry.model}
          </span>
          {reconnectRequired && existingProfile && (
            <span className={styles.reconnectMeta}>Reconnect to use</span>
          )}
        </div>
      </div>

      {existingProfile ? (
        <div className={styles.rowActions}>
          <Badge variant="success" size="sm">On your team</Badge>
          <Button
            ref={removeButtonRef}
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRemove}
            disabled={actionLockActive}
            aria-label={`Remove ${entry.label} from team`}
            data-testid={removeTestId}
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      ) : informational ? (
        <Badge variant="outline" size="sm">On your plan</Badge>
      ) : (
        <Button
          ref={addButtonRef}
          type="button"
          size="xs"
          onClick={onAdd}
          disabled={!canAdd || actionLockActive}
          aria-label={`Add ${entry.label} to team`}
          data-testid={addTestId}
        >
          {adding ? 'Adding…' : 'Add to team'}
        </Button>
      )}
    </li>
  );
}

export function ChoosePathStep({
  onAddCatalogEntry,
  onSelectCustom,
  connectorCatalogEntries,
  existingProfiles,
  onRemoveFromTeam,
  providerConnections,
  busyEntryKey,
  managedAllowedModels = [],
  isMindstoneActive = false,
}: ChoosePathStepProps) {
  const firstUsefulActionRef = useRef<Record<UsefulActionPriority, HTMLButtonElement | null>>({
    ...EMPTY_USEFUL_ACTION_REFS,
  });
  const hasFocusedInitialActionRef = useRef(false);
  const [expandedProviders, setExpandedProviders] = useState<
    Partial<Record<CatalogConnectionHandle, boolean>>
  >({});
  const [localBusyEntryKey, setLocalBusyEntryKey] = useState<string | null>(null);
  const [removingProfileId, setRemovingProfileId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const actionLockActive = Boolean(busyEntryKey || localBusyEntryKey || removingProfileId);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearchActive = normalizedQuery.length > 0;

  const filteredEntries = useMemo(() => {
    if (!isSearchActive) return connectorCatalogEntries;
    return connectorCatalogEntries.filter((entry) => matchesSearchQuery(entry, normalizedQuery));
  }, [connectorCatalogEntries, normalizedQuery, isSearchActive]);

  // ---------------------------------------------------------------------------
  // Recommended entries
  //
  // Derived from connectorCatalogEntries filtered to:
  //   1. isMainModel === true (curated "start here" flag)
  //   2. The corresponding provider handle is CONNECTED — so only models the
  //      user can actually add in one tap appear here. Entries for disconnected
  //      providers are excluded (they still appear in their connection group
  //      with the Needs-reconnect affordance).
  //
  // Deduped by catalogEntryKey and capped at RECOMMENDED_CAP when search is
  // not active so it stays a genuine shortlist. When search is active the
  // normalizedQuery filter is applied first (via filteredEntries) so the
  // Recommended section participates in the empty-result logic.
  // See PLAN.md § Stage 3.
  // ---------------------------------------------------------------------------
  const recommendedEntries = useMemo(() => {
    const sourceEntries = isSearchActive ? filteredEntries : connectorCatalogEntries;
    const mainConnectedEntries = sourceEntries.filter((entry) => {
      if (!entry.isMainModel) return false;
      // Only include entries whose provider handle is currently connected.
      const handle = providerHandleForEntry(entry);
      return providerConnections?.[handle]?.connected === true;
    });
    // Dedup within the section by catalogEntryKey.
    const seen = new Set<string>();
    const deduped: ConnectorCatalogEntry[] = [];
    for (const entry of mainConnectedEntries) {
      const key = catalogEntryKey(entry);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(entry);
      }
    }
    // Cap at RECOMMENDED_CAP when not searching so it stays a genuine shortlist.
    // When search is active show all matching isMainModel rows without an extra
    // cap — the query has already narrowed the set.
    return isSearchActive ? deduped : deduped.slice(0, RECOMMENDED_CAP);
  }, [connectorCatalogEntries, filteredEntries, isSearchActive, providerConnections]);

  // ---------------------------------------------------------------------------
  // Managed entries — "Included with your Mindstone plan"
  //
  // Visibility gated solely on managedAllowedModels.length > 0 (data presence —
  // non-empty only for a Mindstone subscriber; on cloud/mobile it's empty so the
  // group does not render; no synced flag, no hard-coded model IDs). Shown
  // regardless of active provider.
  //
  // Populated by joining managedAllowedModels against PROVIDER_CATALOGS.openrouter
  // (routeSurface 'pool'). Filtered by active search query when search is active.
  //
  // Addable ONLY when isMindstoneActive — because a managed model routes via the
  // managed key only when Mindstone is the active provider. Off-Mindstone, rows
  // are informational (no Add button, "On your plan" badge) to avoid the footgun
  // of an "add" that would silently bill the personal OpenRouter key (or break).
  // NOTE: the same covered model id may still be addable via the Recommended /
  // OpenRouter connection groups when the user has a personal OpenRouter
  // connection — that is intentional BYOK behaviour (billed to their own OR
  // account), NOT the managed-plan footgun; only the MANAGED group must avoid
  // implying plan-billing for an off-Mindstone add.
  // See PLAN.md § Stage 4 + the 260614 (b) design + Failure Mode Matrix.
  // ---------------------------------------------------------------------------
  const managedEntries = useMemo(() => {
    // Gate solely on data presence: show managed group whenever the subscriber
    // has covered models, regardless of active provider.
    // (isMindstoneActive is retained for the addable-vs-informational distinction
    // in the render below, but visibility is driven only by managedAllowedModels.)
    if (managedAllowedModels.length === 0) return [];
    // Build a lookup from normalized model id → catalog entry.
    const orCatalog = PROVIDER_CATALOGS.openrouter;
    const allowedSet = new Set(managedAllowedModels.map((id) => normalizeCatalogModelId(id)));
    const matched = orCatalog.filter((entry) =>
      allowedSet.has(normalizeCatalogModelId(entry.model)),
    );
    // Apply active search query filter if search is active.
    const sourceEntries = isSearchActive
      ? matched.filter((entry) => matchesSearchQuery(entry as ConnectorCatalogEntry, normalizedQuery))
      : matched;
    return sourceEntries as ConnectorCatalogEntry[];
  }, [managedAllowedModels, isSearchActive, normalizedQuery]);

  // ---------------------------------------------------------------------------
  // F1 — Observable warning for managed allow-list ids missing from the catalog.
  //
  // If the server allow-list gets ahead of the bundled desktop catalog, those
  // allowed models silently disappear (the "silent failure is a bug" anti-pattern;
  // see AGENTS.md). This effect fires whenever the unmatched set changes and emits
  // a structured console.warn so the gap is observable in logs.
  //
  // This does NOT change what renders — only matched rows are shown (403-by-
  // construction invariant holds). Renderer console.warn is captured to logs
  // with the [Renderer] prefix. See PLAN.md § Failure Mode Matrix (silent-drift).
  // ---------------------------------------------------------------------------
  // Stable serialised key so the effect only re-runs when the allow-list changes
  // (not on every render if the parent produces a new array reference with the
  // same contents). Sorted so order changes do not trigger spurious warnings.
  const managedAllowedModelsKey = useMemo(
    () => [...managedAllowedModels].sort().join('\0'),
    [managedAllowedModels],
  );
  useEffect(() => {
    // Gate on allow-list presence only (not isMindstoneActive) so catalog-drift
    // is observable for off-Mindstone subscribers whose managed group is now visible.
    if (managedAllowedModelsKey === '') return;
    // Reconstruct the allow-list from the stable key for the warning computation.
    // The key is sorted ids joined by NUL — split and filter empty-string sentinel.
    const allowList = managedAllowedModelsKey.split('\0').filter(Boolean);
    if (allowList.length === 0) return;
    const orCatalog = PROVIDER_CATALOGS.openrouter;
    const catalogNormalized = new Set(orCatalog.map((e) => normalizeCatalogModelId(e.model)));
    const unmatched = allowList
      .map((id) => normalizeCatalogModelId(id))
      .filter((id) => !catalogNormalized.has(id));
    if (unmatched.length > 0) {
      console.warn('[ChoosePathStep] Mindstone allow-list ids missing from bundled catalog', {
        unmatched,
        allowListSize: allowList.length,
        matched: allowList.length - unmatched.length,
      });
    }
  }, [managedAllowedModelsKey]);

  const entriesByProvider = useMemo(() => {
    const groups = new Map<CatalogConnectionHandle, ConnectorCatalogEntry[]>();
    for (const entry of filteredEntries) {
      const handle = providerHandleForEntry(entry);
      const existing = groups.get(handle);
      if (existing) {
        existing.push(entry);
      } else {
        groups.set(handle, [entry]);
      }
    }
    return groups;
  }, [filteredEntries]);

  const pickerGroups = useMemo(() => (
    PROVIDER_GROUPS.map((group) => {
      const entries = entriesByProvider.get(group.handle) ?? [];
      const connected = providerConnections?.[group.handle]?.connected === true;
      const onConnect = providerConnections?.[group.handle]?.onConnect;
      const showAll = expandedProviders[group.handle] === true;
      const materializedEntries = entries.filter((entry) =>
        Boolean(findExistingManagedProfile(existingProfiles, entry)),
      );
      const materializedKeys = new Set(materializedEntries.map(catalogEntryKey));
      const nonMaterializedEntries = entries.filter((entry) => !materializedKeys.has(catalogEntryKey(entry)));
      // When search is active, bypass the cap so all matching entries are visible.
      const visibleNonMaterializedEntries = connected
        ? capNonMaterializedEntries(entries, nonMaterializedEntries, showAll || isSearchActive)
        : [];
      const visibleEntries = [...materializedEntries, ...visibleNonMaterializedEntries];
      return {
        ...group,
        connected,
        onConnect,
        showAll,
        visibleEntries,
        hiddenCount: entries.length - visibleEntries.length,
        reconnectRequired: !connected,
      };
    }).filter((group) => group.visibleEntries.length > 0)
  ), [entriesByProvider, expandedProviders, existingProfiles, providerConnections, isSearchActive]);

  const hasVisiblePickerRows = pickerGroups.some((group) => group.visibleEntries.length > 0);
  const connectionGroupRowCount = pickerGroups.reduce((sum, group) => sum + group.visibleEntries.length, 0);
  // Total visible rows includes recommended + managed + connection-group rows for aria-live count.
  const searchResultCount = recommendedEntries.length + managedEntries.length + connectionGroupRowCount;
  const hasSearchResults = !isSearchActive || searchResultCount > 0;

  useEffect(() => {
    if (hasFocusedInitialActionRef.current) return;
    const priorityOrder: readonly UsefulActionPriority[] = ['add', 'reconnect', 'remove', 'custom'];
    const firstEnabledAction = priorityOrder
      .map((priority) => firstUsefulActionRef.current[priority])
      .find((element): element is HTMLButtonElement => Boolean(element && !element.disabled));

    if (firstEnabledAction) {
      firstEnabledAction.focus();
      hasFocusedInitialActionRef.current = true;
    }
  }, [actionLockActive, hasVisiblePickerRows]);

  const handleAdd = async (entry: ConnectorCatalogEntry) => {
    if (actionLockActive) return;
    const key = catalogEntryKey(entry);
    setLocalBusyEntryKey(key);
    setErrorMessage(null);
    try {
      await onAddCatalogEntry(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add that model.';
      setErrorMessage(message);
    } finally {
      setLocalBusyEntryKey(null);
    }
  };

  const handleRemove = async (profile: ModelProfile) => {
    if (actionLockActive) return;
    setRemovingProfileId(profile.id);
    setErrorMessage(null);
    try {
      await onRemoveFromTeam(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not remove that model.';
      setErrorMessage(message);
    } finally {
      setRemovingProfileId(null);
    }
  };

  const handleSelectCustom = () => {
    if (actionLockActive) return;
    onSelectCustom();
  };

  let firstAddActionAssigned = false;
  let firstReconnectActionAssigned = false;
  let firstRemoveActionAssigned = false;

  return (
    <div className={styles.stepRoot} data-testid="settings-models-choose-path-step">
      <div className={styles.searchComposition}>
        <label htmlFor="model-search" className={styles.searchLabel}>
          Search models
        </label>
        <div className={styles.searchInputWrapper}>
          <Search className={styles.searchIcon} size={14} aria-hidden="true" />
          <Input
            id="model-search"
            type="search"
            inputSize="sm"
            placeholder="Search models by name or provider"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); }}
            className={styles.searchInput}
            data-testid="settings-models-search-input"
            autoComplete="off"
          />
          {isSearchActive && (
            <IconButton
              size="xs"
              variant="ghost"
              aria-label="Clear search"
              className={styles.searchClearButton}
              onClick={() => { setSearchQuery(''); }}
              data-testid="settings-models-search-clear"
            >
              <X size={12} />
            </IconButton>
          )}
        </div>
        <div
          className={styles.searchResultsAnnouncement}
          aria-live="polite"
          aria-atomic="true"
          role="status"
        >
          {isSearchActive
            ? searchResultCount === 0
              ? 'No models match your search.'
              : `${searchResultCount} model${searchResultCount === 1 ? '' : 's'} found.`
            : ''}
        </div>
      </div>

      {/* Recommended for most people — plain section, above connection groups.
          Rendered as a simple <section> (not through the reconnect/cap/
          materialized-pinning machinery). See PLAN.md § Refactor Assessment. */}
      {recommendedEntries.length > 0 && (
        <section
          className={styles.recommendedSection}
          data-testid="settings-models-picker-group-recommended"
        >
          <div className={styles.sectionHeaderText}>
            <h3 className={styles.sectionTitle}>Recommended for most people</h3>
            <p className={styles.sectionHelper}>
              A short, sensible default set. You can add more below.
            </p>
          </div>
          <ul className={styles.modelList}>
            {recommendedEntries.map((entry) => {
              const existingProfile = findExistingManagedProfile(existingProfiles, entry);
              const entryKey = catalogEntryKey(entry);
              const adding = busyEntryKey === entryKey || localBusyEntryKey === entryKey;
              const removing = existingProfile?.id === removingProfileId;
              const shouldAssignFirstAddAction = !firstAddActionAssigned && !existingProfile;
              if (shouldAssignFirstAddAction) firstAddActionAssigned = true;
              const shouldAssignFirstRemoveAction =
                !firstRemoveActionAssigned && Boolean(existingProfile);
              if (shouldAssignFirstRemoveAction) firstRemoveActionAssigned = true;

              return (
                <PickerModelRow
                  key={entryKey}
                  entry={entry}
                  existingProfile={existingProfile}
                  adding={adding}
                  removing={removing}
                  actionLockActive={actionLockActive}
                  canAdd={true}
                  sectionKey="recommended"
                  addButtonRef={(node) => {
                    if (shouldAssignFirstAddAction) {
                      firstUsefulActionRef.current.add = node;
                    }
                  }}
                  removeButtonRef={(node) => {
                    if (shouldAssignFirstRemoveAction) {
                      firstUsefulActionRef.current.remove = node;
                    }
                  }}
                  onAdd={() => void handleAdd(entry)}
                  onRemove={() => { if (existingProfile) void handleRemove(existingProfile); }}
                />
              );
            })}
          </ul>
        </section>
      )}

      {/* Included with your Mindstone plan — plain section, below Recommended,
          above connection groups. Gated on data presence only (managedAllowedModels
          non-empty). On cloud/mobile managedAllowedModels is empty so the group
          simply does not render. When isMindstoneActive, rows are addable. When
          not isMindstoneActive (subscriber on a different active provider), rows
          are informational: no Add button, "On your plan" badge, guidance copy.
          See PLAN.md § Design option (b) + Decision Log 260614. */}
      {managedEntries.length > 0 && (
        <section
          className={styles.managedSection}
          data-testid="settings-models-picker-group-managed"
        >
          <div className={styles.sectionHeader}>
            <div className={styles.sectionHeaderText}>
              <h3 className={styles.sectionTitle}>Included with your Mindstone plan</h3>
              <p className={styles.sectionHelper}>
                {isMindstoneActive
                  ? <>These come with your plan - no extra setup. It&rsquo;s a small, fixed set; connect your own OpenRouter key for the full catalog.</>
                  : 'Part of your Mindstone plan. To use these, switch your active provider to Mindstone in Provider settings - then add them here.'}
              </p>
            </div>
            <BillingBadge source="subscription" />
          </div>
          <ul className={styles.modelList}>
            {managedEntries.map((entry) => {
              const existingProfile = findExistingManagedProfile(existingProfiles, entry);
              const entryKey = catalogEntryKey(entry);
              const adding = busyEntryKey === entryKey || localBusyEntryKey === entryKey;
              const removing = existingProfile?.id === removingProfileId;
              // Informational rows (off-Mindstone, no existing profile) have no Add button
              // and must not claim the initial-focus "add" slot.
              const isInformational = !isMindstoneActive && !existingProfile;
              const shouldAssignFirstAddAction =
                !firstAddActionAssigned && !existingProfile && !isInformational;
              if (shouldAssignFirstAddAction) firstAddActionAssigned = true;
              const shouldAssignFirstRemoveAction =
                !firstRemoveActionAssigned && Boolean(existingProfile);
              if (shouldAssignFirstRemoveAction) firstRemoveActionAssigned = true;

              return (
                <PickerModelRow
                  key={entryKey}
                  entry={entry}
                  existingProfile={existingProfile}
                  adding={adding}
                  removing={removing}
                  actionLockActive={actionLockActive}
                  canAdd={isMindstoneActive}
                  informational={isInformational}
                  sectionKey="managed"
                  addButtonRef={(node) => {
                    if (shouldAssignFirstAddAction) {
                      firstUsefulActionRef.current.add = node;
                    }
                  }}
                  removeButtonRef={(node) => {
                    if (shouldAssignFirstRemoveAction) {
                      firstUsefulActionRef.current.remove = node;
                    }
                  }}
                  onAdd={() => void handleAdd(entry)}
                  onRemove={() => { if (existingProfile) void handleRemove(existingProfile); }}
                />
              );
            })}
          </ul>
        </section>
      )}

      <section className={styles.catalogSection} data-testid="settings-models-catalog-picker">
        {/* Orphan-header fix (Part C Fix 2): hide the section header when search
            is active and no connection-group rows match the query. This prevents
            a floating "Included with your connections" header above empty groups
            when only Recommended or Managed rows match. */}
        {(!isSearchActive || connectionGroupRowCount > 0) && (
          <div className={styles.sectionHeader}>
            <div className={styles.sectionHeaderText}>
              <h3 className={styles.sectionTitle}>Included with your connections</h3>
              <p className={styles.sectionHelper}>
                Add one to give Rebel another option for Smart picking. Council stays optional.
              </p>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className={styles.inlineError} role="alert">
            {errorMessage}
          </div>
        )}

        {!hasVisiblePickerRows && !isSearchActive ? (
          <div className={styles.emptyState}>
            <h4 className={styles.emptyTitle}>No connected providers yet</h4>
            <p className={styles.emptyBody}>
              Connect ChatGPT Pro, OpenRouter, Anthropic, or Gemini to add included models here.
              {' '}If you already have a model URL and name, custom setup is still available.
            </p>
            <Button
              ref={(node) => {
                firstUsefulActionRef.current.custom = node;
              }}
              type="button"
              variant="default"
              size="sm"
              onClick={handleSelectCustom}
              disabled={actionLockActive}
              data-testid="settings-models-choose-custom"
            >
              Add custom model
            </Button>
          </div>
        ) : isSearchActive && !hasSearchResults ? (
          <div className={styles.emptyState} data-testid="settings-models-search-empty-state">
            <p className={styles.emptyBody}>
              No models match &ldquo;{searchQuery}&rdquo;. If you have a model URL and name, you can add it with custom setup.
            </p>
            <Button
              ref={(node) => {
                firstUsefulActionRef.current.custom = node;
              }}
              type="button"
              variant="default"
              size="sm"
              onClick={handleSelectCustom}
              disabled={actionLockActive}
              data-testid="settings-models-choose-custom"
            >
              Add custom model
            </Button>
          </div>
        ) : (
          <div className={styles.providerGroups}>
            {pickerGroups.map((group) => {
              const shouldAssignFirstReconnectAction =
                !firstReconnectActionAssigned && group.reconnectRequired && Boolean(group.onConnect);
              if (shouldAssignFirstReconnectAction) firstReconnectActionAssigned = true;

              return (
                <section
                  key={group.handle}
                  className={styles.providerGroup}
                  data-testid={`settings-models-picker-group-${group.handle}`}
                >
                <header className={styles.providerGroupHeader}>
                  <div className={styles.providerTitleLine}>
                    <h4 className={styles.providerTitle}>{group.title}</h4>
                    <BillingBadge source={group.billingSource} />
                    {group.reconnectRequired && (
                      <Badge variant="warning" size="sm">
                        Needs reconnect
                      </Badge>
                    )}
                  </div>
                  {group.reconnectRequired && group.onConnect && (
                    <Button
                      ref={(node) => {
                        if (shouldAssignFirstReconnectAction) {
                          firstUsefulActionRef.current.reconnect = node;
                        }
                      }}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={group.onConnect}
                      disabled={actionLockActive}
                      data-testid={`settings-models-picker-connect-${group.handle}`}
                    >
                      Reconnect {group.title}
                    </Button>
                  )}
                </header>
                {group.reconnectRequired && !group.onConnect && (
                  <p className={styles.reconnectGuidance}>
                    {reconnectGuidanceForProvider(group.handle, group.title)}
                  </p>
                )}

                <ul className={styles.modelList}>
                  {group.visibleEntries.map((entry) => {
                    const existingProfile = findExistingManagedProfile(existingProfiles, entry);
                    const entryKey = catalogEntryKey(entry);
                    const adding = busyEntryKey === entryKey || localBusyEntryKey === entryKey;
                    const removing = existingProfile?.id === removingProfileId;
                    const shouldAssignFirstAddAction =
                      !firstAddActionAssigned && group.connected && !existingProfile;
                    if (shouldAssignFirstAddAction) firstAddActionAssigned = true;
                    const shouldAssignFirstRemoveAction =
                      !firstRemoveActionAssigned && Boolean(existingProfile);
                    if (shouldAssignFirstRemoveAction) firstRemoveActionAssigned = true;

                    return (
                      <PickerModelRow
                        key={entryKey}
                        entry={entry}
                        existingProfile={existingProfile}
                        adding={adding}
                        removing={removing}
                        actionLockActive={actionLockActive}
                        canAdd={group.connected}
                        reconnectRequired={group.reconnectRequired}
                        addButtonRef={(node) => {
                          if (shouldAssignFirstAddAction) {
                            firstUsefulActionRef.current.add = node;
                          }
                        }}
                        removeButtonRef={(node) => {
                          if (shouldAssignFirstRemoveAction) {
                            firstUsefulActionRef.current.remove = node;
                          }
                        }}
                        onAdd={() => void handleAdd(entry)}
                        onRemove={() => { if (existingProfile) void handleRemove(existingProfile); }}
                      />
                    );
                  })}
                </ul>

                {group.connected && group.hiddenCount > 0 && !isSearchActive && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className={styles.showAllButton}
                    onClick={() =>
                      setExpandedProviders((prev) => ({
                        ...prev,
                        [group.handle]: !group.showAll,
                      }))
                    }
                    disabled={actionLockActive}
                    data-testid={`settings-models-picker-show-all-${group.handle}`}
                  >
                    {group.showAll ? 'Show recommended' : `Show all (${group.hiddenCount} more)`}
                  </Button>
                )}
              </section>
              );
            })}
          </div>
        )}
      </section>

      {(hasVisiblePickerRows || (isSearchActive && hasSearchResults)) && (
        <section className={styles.customSection}>
          <div className={styles.sectionHeaderText}>
            <h3 className={styles.sectionTitle}>Custom setup</h3>
            <p className={styles.sectionHelper}>
              Use this if your model is not listed or needs a custom URL.
            </p>
          </div>
          <Button
            ref={(node) => {
              firstUsefulActionRef.current.custom = node;
            }}
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleSelectCustom}
            disabled={actionLockActive}
            data-testid="settings-models-choose-custom"
          >
            Add custom model
          </Button>
        </section>
      )}
    </div>
  );
}
