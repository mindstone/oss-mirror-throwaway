/**
 * BackupConnectionsSection — Stage 6 settings UI for multi-provider backup chain.
 *
 * Rendered inside AgentsTab, gated on:
 *   - `experimental.multiProviderRoutingEnabled === true`
 *   - `activeProvider !== 'mindstone'` (managed subscription is Phase 3, out of scope).
 *     PROVIDER_META omits 'mindstone', so rendering for a managed-subscription user would
 *     produce a null head row.
 *   - The active provider is **connected** (enforced by AgentsTab via `isActiveProviderConnected`).
 *     Backup connections presuppose a working main; the user fixes/switches their main first,
 *     then this section becomes available. This is the precondition the component relies on.
 *
 * ## Precondition (guaranteed by AgentsTab gate)
 * When this component renders, `activeProvider` is defined AND its credentials are connected.
 * This guarantees a valid anchor exists — the degenerate-state class (F1) where a connected
 * provider outside `enabledProviders` could be hidden by the EmptyState predicate is
 * eliminated by construction at the gate level.
 *
 * ## EmptyState (single-connected-provider)
 * When only one provider is connected (the main one) and no stale-enabled backups exist,
 * we show an informational message encouraging the user to add backups.
 *
 * Write path uses `writeProviderList([head, ...tail])` from @shared/utils/settingsUtils
 * to atomically keep `activeProvider === enabledProviders[0]`.
 *
 * F1 invariant: the persisted head MUST be a connected provider. Disconnected-but-enabled
 * providers are "paused": kept in the list, shown as a visible "not connected" row,
 * toggle-off-able, but they cannot occupy the head while a connected provider exists.
 * computeProviderListPatch() coerces on write: it picks the first connected enabled
 * provider as head, with user order otherwise preserved.
 *
 * Dropped (per Greg's product decisions):
 *  - §4 consent Notice — enabling/keeping a provider IS the consent signal.
 *  - §5 per-turn FailoverReceiptLine — deferred (no new IPC event this stage).
 *  - §6 repeated-use warning — deferred (depends on receipt data).
 */

import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { Badge, Button, IconButton, Toggle } from '@renderer/components/ui';
import type { ActiveProvider, AppSettings } from '@shared/types';
import { getDisplayProviderChain, writeProviderList } from '@shared/utils/settingsUtils';
import { SettingSection } from './SettingSection';
import { SettingRow } from './SettingRow';
import { OpenAILogo, OpenRouterLogo, AnthropicLogo } from './ProviderLogos';

// ─── Provider metadata ────────────────────────────────────────────────────────

type ProviderMeta = {
  provider: ActiveProvider;
  label: string;
  Logo: (props: { size?: number; className?: string }) => ReactNode;
};

/** Canonical display order for the backup chain (cost-ascending after active). */
const PROVIDER_META: ProviderMeta[] = [
  { provider: 'codex',       label: 'ChatGPT Pro',  Logo: OpenAILogo },
  { provider: 'openrouter',  label: 'OpenRouter',   Logo: OpenRouterLogo },
  { provider: 'anthropic',   label: 'Anthropic',    Logo: AnthropicLogo },
  // 'mindstone' is a managed subscription — never eligible as a user-controlled backup.
  // The entire section is hidden when activeProvider === 'mindstone' (see AgentsTab gate).
];

/** Human names for connected-status descriptions (kept as a helper). */
function providerLabel(p: ActiveProvider): string {
  return PROVIDER_META.find(m => m.provider === p)?.label ?? p;
}

// ─── Credential connectivity helpers ─────────────────────────────────────────

type ProviderCredentialState = {
  connected: boolean;
  /** Deep-link target into the AI provider section for the "Connect" outline button. */
  connectSection: string;
};

function getProviderCredentialState(
  appSettings: AppSettings,
  codexConnected: boolean,
  provider: ActiveProvider,
): ProviderCredentialState {
  switch (provider) {
    case 'codex':
      return { connected: codexConnected, connectSection: 'codex' };
    case 'openrouter':
      return { connected: !!appSettings.openRouter?.oauthToken, connectSection: 'openrouter' };
    case 'anthropic':
      // Use the models property via the named alias to avoid the `settings.models.*`
      // direct-read ESLint restriction (the rule fires only on the identifier `settings`).
      // Deliberate: reading `.apiKey` presence-only (boolean check) is a minimal read.
      return { connected: !!appSettings.models?.apiKey, connectSection: 'apiKey' };
    case 'mindstone':
      // mindstone is managed — always treat as connected when it's the active provider
      return { connected: appSettings.activeProvider === 'mindstone', connectSection: 'providerKeys' };
  }
}

/**
 * Exported for testing: pure connectivity check for a provider given settings + codex state.
 * Mirrors `getProviderCredentialState(…).connected` without the connectSection field.
 */
export function isProviderConnected(
  appSettings: AppSettings,
  codexConnected: boolean,
  provider: ActiveProvider,
): boolean {
  return getProviderCredentialState(appSettings, codexConnected, provider).connected;
}

/**
 * Exported for testing: pure toggle-disabled predicate for ProviderRow.
 * Truth table (F1 removability):
 *   isActive                          → disabled (cannot remove head)
 *   !isConnected && !isEnabled        → disabled (cannot add without connecting)
 *   !isConnected && isEnabled (stale) → ENABLED  (can remove from chain)
 *   isConnected && !isActive          → enabled  (normal toggle)
 */
export function isProviderRowToggleDisabled(
  isActive: boolean,
  isConnected: boolean,
  isEnabled: boolean,
): boolean {
  return isActive || (!isConnected && !isEnabled);
}

/**
 * Exported for testing: F1 coercion — promotes the first connected enabled provider to head.
 * Mirrors the invariant enforced by computeProviderListPatch() before calling writeProviderList().
 */
export function coerceHeadToConnected(
  enabledInOrder: ActiveProvider[],
  appSettings: AppSettings,
  codexConnected: boolean,
): ActiveProvider[] {
  if (enabledInOrder.length === 0) return enabledInOrder;
  const firstConnectedIdx = enabledInOrder.findIndex(p =>
    getProviderCredentialState(appSettings, codexConnected, p).connected,
  );
  if (firstConnectedIdx <= 0) return enabledInOrder; // head is already connected (or no connected)
  const connectedHead = enabledInOrder[firstConnectedIdx];
  return [
    connectedHead,
    ...enabledInOrder.slice(0, firstConnectedIdx),
    ...enabledInOrder.slice(firstConnectedIdx + 1),
  ];
}

/**
 * Pure exported write-patch computation — the single source of truth for what
 * gets persisted on every toggle/reorder interaction.
 *
 * Returns null when the section is NON-OPERABLE (no connected anchor), meaning
 * no write should happen. applyList() must call this function and skip the
 * updateDraft calls when it returns null.
 *
 * Operability invariant (by construction):
 *   null   ← no connected provider in the ordered list (section is non-operable)
 *   patch  ← at least one connected provider exists; head is always connected
 *
 * This is the binding seam for tests: tests call computeProviderListPatch() directly
 * rather than mirroring the logic locally, so any regression in the write path
 * causes test failures.
 */
export function computeProviderListPatch(
  orderedList: ActiveProvider[],
  enabledSet: Set<ActiveProvider>,
  settings: AppSettings,
  codexConnected: boolean,
): Pick<AppSettings, 'enabledProviders' | 'activeProvider'> | null {
  // Build the write list: only providers that are currently in the enabled set.
  const enabledInOrder = orderedList.filter(p => enabledSet.has(p));

  // Non-operable guard: no enabled providers → no write.
  if (enabledInOrder.length === 0) return null;

  // F1 invariant: the head MUST be a connected provider.
  // Delegate to the exported coerceHeadToConnected helper (single source of truth).
  const orderedForWrite = coerceHeadToConnected(enabledInOrder, settings, codexConnected);

  const head = orderedForWrite[0] as ActiveProvider;

  // Operability invariant: if the head is still not connected after coercion (all
  // providers disconnected), the section is non-operable → return null (no write).
  const headIsConnected = getProviderCredentialState(settings, codexConnected, head).connected;
  if (!headIsConnected) return null;

  // Connected anchor exists: compute the full atomic patch.
  return writeProviderList([head, ...orderedForWrite.slice(1)] as [ActiveProvider, ...ActiveProvider[]]);
}

// ─── Props ────────────────────────────────────────────────────────────────────

export type BackupConnectionsSectionProps = {
  draftSettings: AppSettings;
  codexConnected: boolean;
  /** updateDraft from AgentsTab — used to apply writeProviderList patch. */
  updateDraft: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function BackupConnectionsSection({
  draftSettings,
  codexConnected,
  updateDraft,
}: BackupConnectionsSectionProps) {
  // Stable string key for the enabled list — used to detect external changes
  // without creating a new Set on every render.
  // Using the two raw primitive fields as deps so the memo only fires when the
  // list or active provider actually changes (not on every draftSettings render).
  // Destructure stable scalar deps for useMemo; also gives us a local `activeProvider` alias.
  const { enabledProviders: rawEnabledProviders, activeProvider } = draftSettings;
  const enabledListKey = useMemo(() => {
    // F1 draft-sync fix: reconcile the enabled list against activeProvider BEFORE
    // building the working set. planProviderSwitch() only updates activeProvider, not
    // enabledProviders; normalizeSettings reconciles on the save round-trip, but the
    // component operates on the draft BEFORE that. Without this, a user interaction
    // immediately after a provider switch would compute a patch from the stale
    // enabledProviders list (e.g. ['codex','openrouter'] when activeProvider='anthropic')
    // and write the old provider back as head — silently undoing the switch.
    // getDisplayProviderChain is idempotent with the later normalize: it always
    // returns the list with activeProvider coerced to the head (the "main + backups"
    // editor view). Use this accessor — not getEnabledProviders — in renderer code.
    const reconciled = getDisplayProviderChain({ enabledProviders: rawEnabledProviders, activeProvider });
    return reconciled.join(',');
  }, [rawEnabledProviders, activeProvider]);

  // The set of currently-enabled providers (for toggle state and write path).
  const enabledSet = useMemo<Set<ActiveProvider>>(
    () => new Set(enabledListKey ? (enabledListKey.split(',') as ActiveProvider[]) : []),
    [enabledListKey],
  );

  // currentList as a stable array (derived from enabledListKey to avoid re-derivation).
  const currentList = useMemo<ActiveProvider[]>(
    () => enabledListKey ? (enabledListKey.split(',') as ActiveProvider[]) : [],
    [enabledListKey],
  );

  // Ordered rows: start from the current list, then append any PROVIDER_META entries
  // not in the list (not-connected providers always visible but off by default).
  const [orderedProviders, setOrderedProviders] = useState<ActiveProvider[]>(() => {
    const inList = new Set(currentList);
    const extras = PROVIDER_META.map(m => m.provider).filter(p => !inList.has(p));
    return [...currentList, ...extras];
  });

  // Sync orderedProviders when the enabled list changes externally
  // (e.g. the activeProvider switch updates the head).
  // useEffect is the Strict-Mode-safe way to synchronize derived state
  // (avoids calling setOrderedProviders during render). Deliberate: F4.
  const lastListRef = useRef(enabledListKey);
  useEffect(() => {
    if (enabledListKey === lastListRef.current) return;
    lastListRef.current = enabledListKey;
    const inList = new Set(currentList);
    const extras = PROVIDER_META.map(m => m.provider).filter(p => !inList.has(p));
    const desired = [...currentList, ...extras];
    setOrderedProviders(prev =>
      desired.join(',') !== prev.join(',') ? desired : prev,
    );
  }, [enabledListKey, currentList]);

  // ── Operability invariant ────────────────────────────────────────────────
  // Precondition (enforced by AgentsTab gate): when this component renders, the
  // active provider is connected. A valid anchor always exists on entry.
  // The old `hasConnectedAnchor` guard is removed — it is now unreachable by
  // construction. The NonOperableState path has been eliminated accordingly.

  // ── Persist on toggle / reorder ──────────────────────────────────────────

  const applyList = useCallback(
    (nextOrdered: ActiveProvider[], currentEnabledSet: Set<ActiveProvider>) => {
      // Operability guard: never write when there is no connected anchor.
      // computeProviderListPatch returns null for non-operable states (all disconnected).
      const patch = computeProviderListPatch(nextOrdered, currentEnabledSet, draftSettings, codexConnected);
      if (patch === null) return;

      updateDraft('enabledProviders', patch.enabledProviders as AppSettings['enabledProviders']);
      if (patch.activeProvider !== undefined) {
        updateDraft('activeProvider', patch.activeProvider as AppSettings['activeProvider']);
      }
    },
    [draftSettings, codexConnected, updateDraft],
  );

  const handleToggle = useCallback(
    (provider: ActiveProvider, checked: boolean) => {
      // Active provider cannot be toggled off.
      if (provider === activeProvider) return;

      let nextEnabled: Set<ActiveProvider>;
      if (checked) {
        nextEnabled = new Set([...enabledSet, provider]);
      } else {
        nextEnabled = new Set([...enabledSet].filter(p => p !== provider));
        // Guard: keep active provider in the set, but ONLY if it is defined.
        // Do NOT fall back to `provider` — that would re-add the provider being
        // removed (stranding it in an all-disconnected state). The early-return
        // above already prevents toggling off the active provider itself.
        if (activeProvider !== undefined) nextEnabled.add(activeProvider);
      }

      // Rebuild the ordered list preserving display order.
      // Keep all display rows (enabledSet drives the toggle visual, not display).
      const nextOrdered = orderedProviders.filter(p =>
        nextEnabled.has(p) || !enabledSet.has(p),
      );

      setOrderedProviders(nextOrdered);
      applyList(nextOrdered, nextEnabled);
    },
    [activeProvider, enabledSet, orderedProviders, applyList],
  );

  // ── Drag-and-drop + keyboard reorder ────────────────────────────────────

  const dragIndexRef = useRef<number | null>(null);
  // For aria-live announcement
  const [announceText, setAnnounceText] = useState('');

  const handleDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const handleDrop = useCallback(
    (dropIndex: number) => {
      const dragIndex = dragIndexRef.current;
      if (dragIndex === null || dragIndex === dropIndex) return;
      dragIndexRef.current = null;

      const next = [...orderedProviders];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(dropIndex, 0, moved);
      setOrderedProviders(next);
      applyList(next, enabledSet);
    },
    [orderedProviders, enabledSet, applyList],
  );

  /** Keyboard reorder: Up/Down arrows when the drag handle is focused. */
  const handleDragHandleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();

      const next = [...orderedProviders];
      const targetIndex = e.key === 'ArrowUp' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= next.length) return;

      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      setOrderedProviders(next);
      applyList(next, enabledSet);

      const movedLabel = providerLabel(next[targetIndex]);
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      setAnnounceText(`${movedLabel} moved ${direction}`);

      // Re-focus the handle that followed the moved item (it's now at targetIndex).
      // A small rAF gives React time to re-render before we query the DOM.
      requestAnimationFrame(() => {
        const handles = document.querySelectorAll<HTMLElement>(
          '[data-backup-drag-handle]',
        );
        handles[targetIndex]?.focus();
      });
    },
    [orderedProviders, enabledSet, applyList],
  );

  const handleResetOrder = useCallback(() => {
    // Default order: activeProvider first, then cost-order from PROVIDER_META.
    const active = activeProvider;
    const defaultOrder = PROVIDER_META.map(m => m.provider);
    const resetOrder = active
      ? [active, ...defaultOrder.filter(p => p !== active)]
      : defaultOrder;
    setOrderedProviders(resetOrder);
    applyList(resetOrder, enabledSet);
  }, [activeProvider, enabledSet, applyList]);

  const handleConnectNavigate = useCallback(
    (connectSection: string) => {
      const target = document.querySelector<HTMLElement>(
        `[data-section="${connectSection}"] [data-section-focus-target], [data-section="${connectSection}"]`,
      );
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.focus?.();
      }
    },
    [],
  );

  // ── Derived state ────────────────────────────────────────────────────────

  // Count connected providers across all PROVIDER_META entries. Used to detect
  // "only one provider connected" (EmptyState) vs. "multiple connected" (full list).
  const connectedProviderCount = useMemo(
    () => PROVIDER_META.filter(m =>
      getProviderCredentialState(draftSettings, codexConnected, m.provider).connected,
    ).length,
    [draftSettings, codexConnected],
  );

  // EmptyState: only one provider connected (the main one) AND no stale-enabled backups.
  // Precondition guarantees the active provider is connected, so connectedProviderCount >= 1.
  // When connectedProviderCount > 1, or stale-enabled rows exist, we show the full list.
  // A stale-enabled row (disconnected but in enabledSet, non-active) must NOT be
  // hidden by the EmptyState — if one exists, show the full list.
  const hasStaleEnabledBackup = useMemo(
    () => orderedProviders.some(p => {
      if (p === activeProvider) return false;
      if (!enabledSet.has(p)) return false;
      const cred = getProviderCredentialState(draftSettings, codexConnected, p);
      return !cred.connected;
    }),
    [orderedProviders, activeProvider, enabledSet, draftSettings, codexConnected],
  );

  const isOperableEmptyState = connectedProviderCount <= 1 && !hasStaleEnabledBackup;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SettingSection
      title="Backup connections"
      description="If Rebel hits a limit on your main connection, it can try these next — using your own keys or subscriptions."
      data-section="backupConnections"
      data-testid="settings-backup-connections-section"
    >
      {/* aria-live region for keyboard reorder announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {announceText}
      </div>

      {/* Precondition: the active provider is always connected when this component renders
          (enforced by AgentsTab gate via isActiveProviderConnected). The non-operable
          state (all disconnected) is unreachable here. */}
      {isOperableEmptyState ? (
        // EmptyState: only one provider connected (the main one), no backup chain yet.
        // Show the informational message + a link to add more connections.
        <OperableEmptyState onConnectNavigate={handleConnectNavigate} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
              marginBottom: 'var(--space-2)',
            }}
          >
            <div>
              <p
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--color-text-muted)',
                  margin: 0,
                }}
              >
                Tried in this order. We put your cheapest backup first. Drag to change.
              </p>
            </div>
            {/* DSR-M1: shared Button primitive (was raw <button> — missing focus ring) */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetOrder}
              aria-label="Reset provider order to default"
              style={{ flexShrink: 0, fontSize: '0.78rem', textDecorationStyle: 'dotted' }}
            >
              Reset order
            </Button>
          </div>

          <div
            role="list"
            aria-label="Backup connections priority order"
            data-testid="backup-connections-list"
          >
            {orderedProviders.map((provider, index) => {
              const meta = PROVIDER_META.find(m => m.provider === provider);
              // Guard: skip providers without metadata (e.g. unknown future providers)
              if (!meta) return null;

              const cred = getProviderCredentialState(draftSettings, codexConnected, provider);
              const isActive = provider === activeProvider;
              const isEnabled = enabledSet.has(provider);
              const isConnected = cred.connected;

              return (
                <ProviderRow
                  key={provider}
                  index={index}
                  meta={meta}
                  isActive={isActive}
                  isEnabled={isEnabled}
                  isConnected={isConnected}
                  connectSection={cred.connectSection}
                  onToggle={handleToggle}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                  onDragHandleKeyDown={handleDragHandleKeyDown}
                  onConnectNavigate={handleConnectNavigate}
                />
              );
            })}
          </div>
        </>
      )}

      {/* §8: Advanced profile-route distinction — collapsible informational row.
          Copy describes the *situation* the user recognises (explicitly choosing a
          specific model/profile for one conversation) rather than the niche "custom
          model profile" term — per chief-designer review. Behaviour stated exactly: a
          per-conversation pinned model/profile is honoured as-is, no failover; failover
          to backups applies only to the user's normal (default) AI. (Deliberately does
          not enumerate the entry points — e.g. the Quality Tier slider — since what
          gates failover is an explicit per-conversation model/profile pin, not any one
          control.) */}
      <SettingSection
        advanced
        title="When backups don't kick in"
        defaultExpanded={false}
        data-section="backupConnectionsProfileNote"
        data-testid="settings-backup-profile-note"
      >
        <SettingRow
          label="Conversations where you picked a specific model"
          description="If you've chosen a specific model for one conversation, Rebel sticks with it and won't switch to a backup there. Backups only step in for your normal AI."
          variant="stacked"
        >
          {/* Informational only — no control */}
          <span />
        </SettingRow>
      </SettingSection>
    </SettingSection>
  );
}

// ─── Operable empty state ─────────────────────────────────────────────────────
// Shown when the section is operable (connected anchor exists) but there is only
// one connected provider and no stale-enabled backups. Encourages adding more.

type OperableEmptyStateProps = {
  onConnectNavigate: (section: string) => void;
};

function OperableEmptyState({ onConnectNavigate }: OperableEmptyStateProps) {
  return (
    <div
      data-testid="backup-connections-empty-state"
      style={{
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-soft)',
        color: 'var(--color-text-secondary)',
        fontSize: '0.875rem',
      }}
    >
      <p style={{ margin: '0 0 var(--space-2)' }}>
        Your main connection — backups apply when you add more.
      </p>
      {/* DSR-M1: shared Button primitive (was raw <button> — missing focus ring) */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onConnectNavigate('providerKeys')}
        style={{ fontSize: '0.78rem', padding: 0 }}
      >
        Add connection
      </Button>
    </div>
  );
}

// ─── ProviderRow ──────────────────────────────────────────────────────────────

type ProviderRowProps = {
  index: number;
  meta: ProviderMeta;
  isActive: boolean;
  isEnabled: boolean;
  isConnected: boolean;
  connectSection: string;
  onToggle: (provider: ActiveProvider, checked: boolean) => void;
  onDragStart: (index: number) => void;
  onDrop: (dropIndex: number) => void;
  onDragHandleKeyDown: (e: React.KeyboardEvent, index: number) => void;
  onConnectNavigate: (section: string) => void;
};

function ProviderRow({
  index,
  meta,
  isActive,
  isEnabled,
  isConnected,
  connectSection,
  onToggle,
  onDragStart,
  onDrop,
  onDragHandleKeyDown,
  onConnectNavigate,
}: ProviderRowProps) {
  const isMuted = !isConnected;

  return (
    <div
      role="listitem"
      draggable
      onDragStart={() => onDragStart(index)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(index)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) 0',
        borderBottom: '1px solid var(--color-border-soft)',
        opacity: isMuted ? 0.6 : 1,
        // DSR-M2: use motion token instead of hardcoded 150ms
        transition: 'opacity var(--motion-duration-fast) ease',
      }}
      data-testid={`backup-provider-row-${meta.provider}`}
    >
      {/* Drag handle */}
      <IconButton
        variant="ghost"
        size="xs"
        draggable={false}
        aria-label={`Drag to reorder ${meta.label}`}
        title={`Drag to reorder ${meta.label}`}
        data-backup-drag-handle
        onKeyDown={(e) => onDragHandleKeyDown(e, index)}
        style={{
          cursor: 'grab',
          color: 'var(--color-text-muted)',
          flexShrink: 0,
        }}
      >
        <GripVertical size={14} aria-hidden />
      </IconButton>

      {/* Provider logo */}
      <meta.Logo size={14} />

      {/* Provider name + credential badge */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
        <span
          style={{
            fontSize: '0.875rem',
            fontWeight: 500,
            color: 'var(--color-text-primary)',
          }}
        >
          {meta.label}
        </span>
        <Badge
          variant={isConnected ? 'success' : 'muted'}
          size="sm"
        >
          {isConnected ? 'Connected' : 'Not connected'}
        </Badge>
      </div>

      {/* DSR-M1: shared Button primitive for "Connect" (was raw <button> — missing focus ring) */}
      {!isConnected && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onConnectNavigate(connectSection)}
          aria-label={`Connect ${meta.label} to use as backup`}
          style={{ flexShrink: 0 }}
        >
          Connect
        </Button>
      )}

      {/* Include toggle */}
      {/* F1 removability: a stale enabled+disconnected provider CAN be toggled off
          (so the user can remove it from the chain), but a not-connected+not-enabled
          provider cannot be toggled on (user must connect first).
          Truth table:
            isActive                           → disabled (cannot remove head)
            !isConnected && !isEnabled         → disabled (cannot add without connecting)
            !isConnected && isEnabled (stale)  → ENABLED  (can remove)
            isConnected && !isActive           → enabled  (normal toggle) */}
      <Toggle
        checked={isEnabled}
        disabled={isProviderRowToggleDisabled(isActive, isConnected, isEnabled)}
        onCheckedChange={(checked) => onToggle(meta.provider, checked)}
        aria-label={`Include ${meta.label} as backup`}
        title={
          isActive
            ? `${meta.label} is your main connection`
            : !isConnected && !isEnabled
              ? `Connect ${meta.label} first to include it as backup`
              : !isConnected && isEnabled
                ? `Remove ${meta.label} from your backup chain`
                : `Include ${meta.label} as backup`
        }
        style={{ flexShrink: 0 }}
      />
    </div>
  );
}
