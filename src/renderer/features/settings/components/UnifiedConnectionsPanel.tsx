/**
 * UnifiedConnectionsPanel - Unified connections marketplace with chip-to-card animations
 */
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { ChevronRight, FileJson, AlertCircle, Loader2, RefreshCw, CheckCircle2, Package, Building2 } from 'lucide-react';
import { Button, Input, Tooltip, Select, Notice } from '@renderer/components/ui';
import { ConnectionChip } from './ConnectionChip';
import { ExpandedConnectionCard } from './ExpandedConnectionCard';
import { createTrackedConnectionCardOps, type ConnectionCardTracking } from './useConnectionCardOps';
import { AddConnectionModal } from './AddConnectionModal';
import { ConnectorSetupDialog } from './ConnectorSetupDialog';
import { useConnectorSetupGuidance, isOAuthSetupGuidance, type MaybeSetupGuidanceResult } from '../hooks/useConnectorSetupGuidance';

import { SettingRow } from './SettingRow';
import { SettingSection } from './SettingSection';
import {
  useUnifiedConnections,
  computeUnifiedConnectionsSnapshot,
  getConnectionAttentionState,
  type UnifiedConnection,
} from '../hooks/useUnifiedConnections';
import { useAppBridgePairedCount } from '../hooks/useAppBridgePairedCount';
import { useConnectSlackMcpAction } from '../hooks/useConnectSlackMcpAction';
import { useAppContext } from '@renderer/contexts/AppContext';
import { useSettings } from '../SettingsProvider';
import { tracking } from '@renderer/src/tracking';
import { parseMultiInstanceServer, parseEmailFromSlug, generateInstanceId, generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import {
  buildMcpServerRemovalRestartContext,
  buildSettingsUpsertRestartContext,
  isResolveOnDeferralConnectContext,
  MCP_RESTART_CONTEXT_DISCOURSE_CONNECT,
  MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT,
  MCP_RESTART_CONTEXT_MICROSOFT_CONNECT,
  MCP_RESTART_CONTEXT_SETTINGS_UPSERT_PREFIX,
  MCP_RESTART_CONTEXT_SLACK_CONNECT,
} from '@shared/utils/mcpRestartContexts';
import { getConnectorSectionId } from '@shared/utils/connectorSectionIds';
import { getCategoryIcon } from '../utils/connectorIcons';
import { CONNECTOR_CATEGORY_ORDER, CATEGORY_LABELS, type CategoryFilterId } from '../constants/connectorCategories';
import type { McpServerPreview, McpServerConfigDetails, McpConfigSummary, McpServerUpsertPayload } from '@shared/types';
import { isBundledLikeProvider } from '@shared/types';
import type { SetupWithRebelParams } from './tabs/types';
import styles from './SettingsSurface.module.css';

interface UnifiedConnectionsPanelProps {
  servers: McpServerPreview[];
  onUpsertServer: (payload: McpServerUpsertPayload) => Promise<void>;
  onRemoveServer?: (serverName: string) => Promise<void>;
  onLoadServer?: (serverName: string) => Promise<McpServerConfigDetails>;
  mcpMutationPending: boolean;
  onConfigureWithRebel?: (params: SetupWithRebelParams) => void | Promise<void>;
  onBuildConnector?: (searchQuery?: string) => void | Promise<void>;
  onExtendConnector?: (connectorId: string, connectorName: string) => void | Promise<void>;
  onShareWithCommunity?: (connectorName: string) => void | Promise<void>;
  /** Open the originating contribution conversation for a connector. */
  onOpenContributionChat?: (sessionId: string) => void | Promise<void>;
  onGetPythonHelp?: (connectorName: string) => void;
  onRefresh?: () => void;
  onReloadConnectors?: () => Promise<void>;
  mcpSummary?: McpConfigSummary | null;
  mcpSummaryLoading?: boolean;
  mcpSummaryError?: string | null;
  mcpHealthLoading?: boolean;
  onChooseConfigFile?: () => void;
  onNavigateToDiagnostics?: () => void;
  recommendedConnectorIds?: string[];
  onRequestConnector?: () => void;
  externalMcpEnabled?: boolean;
  onToggleExternalMcp?: () => void;
  interactiveViewsEnabled?: boolean;
  onToggleInteractiveViews?: () => void;
  /** Settings / toast deep link: `data-section` for a connector card (not instance-specific). */
  connectorRevealTarget?: string | null;
  onConnectorRevealReady?: (sectionId: string | null) => void;
  /**
   * True when the `mcpRuntimeHealth` system-health check is in warn/fail state.
   * Renders a section-level manager-status banner so users who follow the
   * "A connected tool needs attention" toast see a concrete next step on the
   * Tools tab. Sourced from the same `useHealthStatusPolling` cache that
   * drives the HelpMenu glow.
   */
  mcpRuntimeHealthDegraded?: boolean;
}

type DeferredConnectorOperation = {
  id: string;
  kind: 'connect' | 'disconnect' | 'toggle';
  context: string;
  isDeferred: boolean;
};

function isRestartDeferredEventRelevantToOperation(
  eventContext: string,
  operation: DeferredConnectorOperation,
): boolean {
  // Prefer an EXACT context match: with Stage 3 routing all setup/disconnect
  // entrypoints through the tracker using the same serverName the IPC emits,
  // the broadcast context normally byte-equals the tracked one. Exact-first
  // means a *different* connector's deferred event (its own exact context)
  // can no longer briefly flag this card.
  if (eventContext === operation.context) {
    return true;
  }

  // Prefix fallback — retained ONLY for `connect` ops that are THEMSELVES
  // tracking a settings-upsert context. Main can rewrite payload.name for
  // bundled connectors (idempotent catalogId+email match in
  // settingsHandlers.ts → `payload.name = existing.serverName`), so the
  // broadcast `settings-upsert:<rewrittenName>` may not equal the tracked
  // `settings-upsert:<originalName>`. Without this fallback we would
  // reintroduce the bug Harry's commit fixed (queued UX never lights up for
  // renamed bundled connectors). That rationale only exists when the tracked
  // context is itself `settings-upsert:*` — the Stage-5 static connect
  // contexts (microsoft-connect, slack-connect, …) are never rewritten, so
  // they match exactly only. Stage-5 refinement (GPT-F1/Claude-F1): without
  // this scoping, an unrelated `settings-upsert:*` deferral landing during a
  // static-context connect's OAuth window falsely marked it deferred → false
  // queued toast AND false launchRebel suppression via the DA-F1 gate.
  // The removal path (`mcp-server-removal:`) always uses the exact instance
  // name and is never rewritten, so disconnect ops match exactly only; the
  // toggle path (`mcp-server-toggle:<serverId>`) likewise.
  if (
    operation.kind === 'connect' &&
    operation.context.startsWith(MCP_RESTART_CONTEXT_SETTINGS_UPSERT_PREFIX)
  ) {
    return eventContext.startsWith(MCP_RESTART_CONTEXT_SETTINGS_UPSERT_PREFIX);
  }
  return false;
}

function dataSectionForUnifiedConnection(connection: UnifiedConnection): string | undefined {
  const serverName =
    connection.catalogEntry?.bundledConfig?.serverName ?? connection.serverPreview?.name;
  return getConnectorSectionId(serverName);
}

const _MAX_VISIBLE_CHIPS = 12;

export function UnifiedConnectionsPanel({
  servers,
  onUpsertServer,
  onRemoveServer,
  onLoadServer,
  mcpMutationPending,
  onConfigureWithRebel,
  onBuildConnector,
  onExtendConnector,
  onShareWithCommunity,
  onOpenContributionChat,
  onGetPythonHelp,
  onRefresh,
  onReloadConnectors,
  mcpSummary,
  mcpSummaryLoading,
  mcpSummaryError,
  mcpHealthLoading: _mcpHealthLoading,
  onChooseConfigFile,
  onNavigateToDiagnostics,
  recommendedConnectorIds = [],
  onRequestConnector: _onRequestConnector,
  externalMcpEnabled = false,
  onToggleExternalMcp,
  interactiveViewsEnabled = true,
  onToggleInteractiveViews,
  connectorRevealTarget,
  onConnectorRevealReady,
  mcpRuntimeHealthDegraded = false,
}: UnifiedConnectionsPanelProps) {

  const { showToast } = useAppContext();
  const setupGuidanceDialog = useConnectorSetupGuidance();
  const { settings } = useSettings();
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showAddModal, setShowAddModal] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // Track connecting state by catalog ID (stable across available→connected transition)
  // Used to disable disconnect buttons during OAuth flow
  const [connectingCatalogId, setConnectingCatalogId] = useState<string | null>(null);
  const [deferredOp, setDeferredOp] = useState<DeferredConnectorOperation | null>(null);
  // Monotonic counter to guard against stale async side effects after cancel/retry
  const connectAttemptRef = useRef(0);
  const deferredOpRef = useRef<DeferredConnectorOperation | null>(null);
  const deferredToastKeyRef = useRef<string | null>(null);
  const showToastRef = useRef(showToast);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilterId>('all');
  const [connectedFilter, setConnectedFilter] = useState<'all' | 'needs-attention' | 'inactive'>('all');
  const [sortBy, setSortBy] = useState<'alphabetical' | 'recent'>('alphabetical');
  // Track which categories are expanded (all expanded by default)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const chipsContainerRef = useRef<HTMLDivElement>(null);
  const revealMissCountRef = useRef(0);

  // Rebel Browser card status is overridden by actual paired-client count
  // rather than the internal MCP server's health (which stays 'ok' whenever
  // the local App Bridge is running, i.e. always). See
  // `useAppBridgePairedCount` for why.
  const { pairedCount: appBridgePairedCount, refresh: refreshAppBridgePaired } =
    useAppBridgePairedCount();
  const {
    connect: connectSlackMcp,
    isInFlight: isSlackMcpConnectInFlight,
  } = useConnectSlackMcpAction({ onConfigureWithRebel });

  const { connections, categoryTabs } = useUnifiedConnections({
    servers,
    settings: settings ?? undefined,
    includeAvailable: true,
    searchQuery,
    categoryFilter,
    sortBy,
    appBridgePairedCount,
  });

  // Split configured vs available and derive settings-specific scan states
  const { configuredConnections, availableConnections, needsAttentionConnections, inactiveConnections, visibleConfiguredConnections } = useMemo(() => {
    const allConnected = connections.filter((c) => c.status !== 'available');
    const withAttentionState = allConnected.map((connection) => ({
      connection,
      attentionState: getConnectionAttentionState(connection),
    }));
    const needsAttention = withAttentionState
      .filter(({ attentionState }) => attentionState === 'needs-attention')
      .map(({ connection }) => connection);
    const inactive = withAttentionState
      .filter(({ attentionState }) => attentionState === 'inactive')
      .map(({ connection }) => connection);
    const visibleConfigured = withAttentionState
      .filter(({ attentionState }) => connectedFilter === 'all' || attentionState === connectedFilter)
      .map(({ connection }) => connection);
    return {
      configuredConnections: allConnected,
      availableConnections: connections.filter((c) => c.status === 'available'),
      needsAttentionConnections: needsAttention,
      inactiveConnections: inactive,
      visibleConfiguredConnections: visibleConfigured,
    };
  }, [connections, connectedFilter]);

  const isEmptySearch = searchQuery.trim().length > 0 && connections.length === 0;
  const hasConnectedViewFilter = searchQuery.trim().length > 0 || categoryFilter !== 'all';

  // Split recommended connectors from the available pool (preserving backend order)
  const recommendedIdSet = useMemo(() => new Set(recommendedConnectorIds), [recommendedConnectorIds]);
  const recommendedConnections = useMemo(() => {
    if (recommendedIdSet.size === 0) return [];
    const availableById = new Map(availableConnections.map((c) => [c.catalogEntry?.id, c]));
    return recommendedConnectorIds
      .map((id) => availableById.get(id))
      .filter((c): c is UnifiedConnection => c !== undefined);
  }, [availableConnections, recommendedConnectorIds, recommendedIdSet]);

  // Group available connections by category, excluding recommended ones
  const availableByCategory = useMemo(() => {
    const grouped = new Map<string, typeof availableConnections>();
    for (const conn of availableConnections) {
      if (recommendedIdSet.has(conn.catalogEntry?.id ?? '')) continue;
      const category = conn.catalogEntry?.category || 'other';
      const existing = grouped.get(category) || [];
      existing.push(conn);
      grouped.set(category, existing);
    }

    // Sort by category order (from shared constants), then alphabetically within category
    const sorted: { category: string; label: string; connectors: typeof availableConnections }[] = [];
    for (const cat of CONNECTOR_CATEGORY_ORDER) {
      const connectors = grouped.get(cat);
      if (connectors && connectors.length > 0) {
        connectors.sort((a, b) => a.name.localeCompare(b.name));
        sorted.push({
          category: cat,
          label: cat === 'development' ? 'Developer tools' : CATEGORY_LABELS[cat],
          connectors,
        });
      }
    }
    return sorted;
  }, [availableConnections, recommendedIdSet]);

  const isInitialCatalogLoad = mcpSummaryLoading && servers.length === 0 && !isEmptySearch;
  const catalogSummaryUnavailable =
    !mcpSummaryLoading && Boolean(mcpSummaryError) && servers.length === 0 && !isEmptySearch;

  useEffect(() => {
    revealMissCountRef.current = 0;
  }, [connectorRevealTarget]);

  // Deep-link / toast: clear local hide-state, select bucket + card, then let the shell scroll once the chip is mounted.
  useEffect(() => {
    if (!connectorRevealTarget || !onConnectorRevealReady) return;
    if (mcpSummaryLoading) return;

    const snap = computeUnifiedConnectionsSnapshot({
      servers,
      settings: settings ?? undefined,
      includeAvailable: true,
      searchQuery: '',
      categoryFilter: 'all',
      sortBy,
    });

    const match = snap.connections.find(
      (c) => dataSectionForUnifiedConnection(c) === connectorRevealTarget,
    );

    setSearchQuery('');
    setCategoryFilter('all');
    setCollapsedCategories(new Set());

    if (!match) {
      revealMissCountRef.current += 1;
      if (revealMissCountRef.current >= 5) {
        onConnectorRevealReady(null);
      }
      return;
    }

    revealMissCountRef.current = 0;
    const attention = getConnectionAttentionState(match);
    if (attention === 'inactive') {
      setConnectedFilter('inactive');
    } else if (attention === 'needs-attention') {
      setConnectedFilter('needs-attention');
    } else {
      setConnectedFilter('all');
    }
    setExpandedId(match.id);

    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        onConnectorRevealReady(connectorRevealTarget);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [
    connectorRevealTarget,
    onConnectorRevealReady,
    mcpSummaryLoading,
    servers,
    settings,
    sortBy,
  ]);

  /** User tab changes only — never auto-switch buckets from expand/health refresh (avoids jarring jumps). Deep-link reveal still sets the filter explicitly above. */
  const handleConnectedFilterChange = useCallback(
    (tab: 'all' | 'needs-attention' | 'inactive') => {
      setConnectedFilter(tab);
      setFocusedIndex(-1);
      setExpandedId((prev) => {
        if (!prev) return null;
        const expandedConnection = configuredConnections.find((c) => c.id === prev);
        if (!expandedConnection) return null;
        if (tab === 'all') return prev;
        return getConnectionAttentionState(expandedConnection) === tab ? prev : null;
      });
    },
    [configuredConnections],
  );

  // Toggle category collapse
  const toggleCategory = useCallback((category: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const _expandedConnection = expandedId
    ? connections.find((c) => c.id === expandedId)
    : null;

  const handleChipClick = useCallback((connection: UnifiedConnection) => {
    const isExpanding = expandedId !== connection.id;
    if (isExpanding) {
      tracking.settings.connectorViewed(connection.name, connection.catalogEntry?.category || 'other');
    }
    setExpandedId((prev) => (prev === connection.id ? null : connection.id));
  }, [expandedId]);

  const handleClose = useCallback(() => {
    setExpandedId(null);
  }, []);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    const unsubscribe = window.api?.onSuperMcpRestartDeferred?.((event) => {
      const operation = deferredOpRef.current;
      if (!operation || !isRestartDeferredEventRelevantToOperation(event.context, operation)) {
        return;
      }

      // Mark the REF deferred too, not just React state: the DA-F1 launchRebel
      // gate (isTrackedConnectDeferred) reads this synchronously when the
      // connect IPC resolves — the broadcast lands before the invoke resolves
      // (main emits it synchronously before early-resolving), but a state-only
      // flag could still be un-flushed at that point.
      deferredOpRef.current = { ...operation, isDeferred: true };

      setDeferredOp((current) => {
        if (!current || current.id !== operation.id || current.kind !== operation.kind) {
          return current;
        }
        return { ...current, isDeferred: true };
      });

      const toastKey = `${operation.kind}:${operation.id}`;
      if (deferredToastKeyRef.current !== toastKey) {
        deferredToastKeyRef.current = toastKey;
        showToastRef.current({
          title: 'Connector change queued',
          description: 'Rebel will apply it automatically once the current task wraps up. No need to retry.',
          variant: 'info',
          duration: 8000,
        });
      }
    });

    return unsubscribe;
  }, []);

  const trackDeferredOperation = useCallback((operation: Omit<DeferredConnectorOperation, 'isDeferred'>) => {
    deferredToastKeyRef.current = null;
    const nextOperation = { ...operation, isDeferred: false };
    deferredOpRef.current = nextOperation;
    setDeferredOp(nextOperation);
  }, []);

  const clearDeferredOperation = useCallback((id: string, kind: DeferredConnectorOperation['kind']) => {
    if (deferredOpRef.current?.id === id && deferredOpRef.current.kind === kind) {
      deferredOpRef.current = null;
    }
    setDeferredOp((current) => {
      if (!current || current.id !== id || current.kind !== kind) {
        return current;
      }
      return null;
    });
    deferredToastKeyRef.current = null;
  }, []);

  // DA F1 (Stage 5, 260610_gworkspace-mcp-error-disconnect-hang): with the
  // connect IPCs resolving on deferral (Stage 4), a deferred connect means the
  // IPC resolved BEFORE tool routing applied. The post-connect "Set up with
  // Rebel" chat immediately asks Rebel to list_tools the new connector, so it
  // must be skipped while queued — the user has an agent task running at that
  // moment (that's why it deferred) and the queued toast/card copy explains
  // the state. Ref-backed read (not closure/React state) — see the listener
  // above for the ordering argument. settings-upsert-tracked connects return
  // false by construction (isResolveOnDeferralConnectContext): that leg awaits
  // the executed restart, so its setup chat stays safe.
  const isTrackedConnectDeferred = useCallback((connectionId: string): boolean => {
    const operation = deferredOpRef.current;
    return Boolean(
      operation &&
      operation.id === connectionId &&
      operation.kind === 'connect' &&
      operation.isDeferred &&
      isResolveOnDeferralConnectContext(operation.context),
    );
  }, []);

  const handleConnect = useCallback(
    async (connection: UnifiedConnection, email?: string, options?: { launchRebel?: boolean; scopeTier?: 'readonly' | 'full'; setupFieldValues?: Record<string, string> }) => {
      const { launchRebel = false, scopeTier, setupFieldValues } = options ?? {};
      const category = connection.catalogEntry?.category || 'other';
      const connectorType = isBundledLikeProvider(connection.provider) ? 'bundled' as const : 'custom' as const;
      const connectStartedAt = Date.now();
      tracking.settings.connectorConnectStarted(connection.name, category, { connectorType, source: 'settings_ui', isReconnect: false });
      const attemptId = ++connectAttemptRef.current;
      setConnectingId(connection.id);
      // Track by catalog ID for stable state across available→connected transition
      setConnectingCatalogId(connection.catalogEntry?.id ?? null);
      try {
        // Bundled servers - add via dedicated IPC
        if (isBundledLikeProvider(connection.provider) && connection.catalogEntry?.bundledConfig) {
          const bundledConfig = connection.catalogEntry.bundledConfig;
          const serverName = bundledConfig.serverName;
          const emailTrimmed = email?.trim();
          const authApi = bundledConfig.authApi;

          if (authApi === 'slackApi') {
            // Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): the Slack
            // auth handler owns MCP registration, so nothing tracked a deferred
            // op for this branch and the queued UX never lit. Track panel-side
            // (NOT inside the shared useConnectSlackMcpAction hook — its
            // messaging-surface callers have no panel tracker mounted, accepted
            // gap). Cleared in the finally below.
            trackDeferredOperation({
              id: connection.id,
              kind: 'connect',
              context: MCP_RESTART_CONTEXT_SLACK_CONNECT,
            });
            try {
              await connectSlackMcp({
                workspaceHint: emailTrimmed,
                connectionName: connection.name,
                category,
                catalogEntry: connection.catalogEntry,
                launchRebel,
                connectStartedAt,
                connectorType,
                isAttemptCurrent: () => connectAttemptRef.current === attemptId,
                // DA F1 gate, panel-side wrapper: skip the setup chat when this
                // connect's restart was deferred (see isTrackedConnectDeferred).
                onConfigureWithRebel: (params) => {
                  if (isTrackedConnectDeferred(connection.id)) {
                    return;
                  }
                  return onConfigureWithRebel?.(params);
                },
                onSetupGuidance: setupGuidanceDialog.handleResult,
              });
            } catch (error) {
              const setupError = error instanceof Error ? error.message : 'Slack connection failed';
              showToast({
                title: `${connection.name} connection failed`,
                description: setupError,
              });
            }

            // Skip post-connect side effects if this attempt was cancelled or superseded
            if (connectAttemptRef.current !== attemptId) return;

            setExpandedId(null);
            return;
          }
          
          // Some bundled OAuth connectors have auth handlers that own MCP registration:
          // - Microsoft: microsoftHandlers.ts creates per-service MCPs (Mail, Calendar, etc.)
          // Skip mcpAddBundledServer for these to avoid creating duplicate entries
          const authHandlerOwnsMcpRegistration = authApi === 'microsoftApi' || authApi === 'discourseApi';
          
          // Generate instance-specific name for multi-instance bundled connectors
          const instanceName = (emailTrimmed && !authHandlerOwnsMcpRegistration)
            ? generateInstanceId(serverName, emailTrimmed)
            : serverName;
          let setupSuccess = true;
          let setupError: string | undefined;
          
          // Skip mcpAddBundledServer for connectors where OAuth handler owns registration
          if (!authHandlerOwnsMcpRegistration) {
            trackDeferredOperation({
              id: connection.id,
              kind: 'connect',
              context: buildSettingsUpsertRestartContext(instanceName),
            });
            try {
              await window.settingsApi.mcpAddBundledServer({
                serverName,
                email: emailTrimmed,
                apiKey: setupFieldValues?.apiKey,
                credentials: setupFieldValues,
                scopeTier,
                catalogId: connection.catalogEntry?.id,
              });
            } catch (error) {
              console.error('Failed to add bundled server:', error);
              setupSuccess = false;
              setupError = error instanceof Error ? error.message : 'Failed to add server';
            }
          } else {
            // Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): the
            // Microsoft/Discourse auth handlers own MCP registration, so this
            // branch skipped the tracker entirely and the queued UX never lit.
            // Track with the shared connect context BEFORE the startAuth IPC
            // below (its deferred broadcast must find the op); cleared in the
            // finally.
            trackDeferredOperation({
              id: connection.id,
              kind: 'connect',
              context: authApi === 'microsoftApi'
                ? MCP_RESTART_CONTEXT_MICROSOFT_CONNECT
                : MCP_RESTART_CONTEXT_DISCOURSE_CONNECT,
            });
          }
          
          // For bundled OAuth connectors, trigger the OAuth flow
          // Bundled stdio MCPs with authApi have dedicated auth APIs that handle OAuth
          // Bundled stdio MCPs WITHOUT authApi rely on Claude calling the MCP's authenticate tool
          let oauthResult: (MaybeSetupGuidanceResult & { success: boolean; error?: string; accountIdentity?: string }) | undefined;
          if (setupSuccess && bundledConfig.authType === 'oauth' && authApi) {
            try {
              // Use dedicated auth API from catalog
              if (authApi === 'googleWorkspaceApi') {
                // Stage 5: re-track leg 2 of the Google connect. Leg 1
                // (mcpAddBundledServer above) tracked `settings-upsert:<name>`
                // and its IPC has already settled, so the single-slot overwrite
                // is safe — and the start-auth leg broadcasts
                // `google-workspace-connect`, which the settings-upsert op
                // could never match.
                trackDeferredOperation({
                  id: connection.id,
                  kind: 'connect',
                  context: MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT,
                });
                oauthResult = await window.googleWorkspaceApi.startAuth();
              } else if (authApi === 'hubspotApi') {
                // Pass scopeTier for read-only mode support (free HubSpot accounts)
                oauthResult = await window.hubspotApi.startAuth({ scopeTier });
              } else if (authApi === 'microsoftApi') {
                oauthResult = await window.microsoftApi.startAuth();
              } else if (authApi === 'discourseApi') {
                const discourseResult = await window.discourseApi.startAuth();
                oauthResult = {
                  success: discourseResult.success,
                  error: discourseResult.error,
                  accountIdentity: discourseResult.username,
                };
              }
              
              if (oauthResult && !oauthResult.success) {
                console.error('OAuth authentication failed:', oauthResult.error);
                setupSuccess = false;
                setupError = oauthResult.error;
              }
            } catch (authError) {
              console.error('Failed to trigger OAuth:', authError);
              oauthResult = { success: false, error: authError instanceof Error ? authError.message : 'Unknown error' };
              setupSuccess = false;
              setupError = oauthResult.error;
            }
          } else if (setupSuccess && bundledConfig.authType === 'oauth-user-provided') {
            // For oauth-user-provided connectors (e.g., Salesforce), user provides their own OAuth app credentials.
            // Credentials are already saved to settings. Use generic mcpAuthenticate which routes to the MCP's
            // setupToolName via invokeStdioAuthenticateTool (see mcpService.authenticateMcpServer).
            //
            // IMPORTANT: address mcpAuthenticate by the BASE serverName, not instanceName. mcpAddBundledServer
            // writes the MCP config entry under bundledConfig.serverName (no email suffix) for these connectors,
            // so Super-MCP only knows the base name. Passing instanceName here yields "Package not found" and
            // the OAuth flow never starts (no shell.openExternal, no browser). See ToolAuthStep.tsx onboarding
            // path which already uses bundledConfig.serverName correctly.
            try {
              oauthResult = await window.miscApi.mcpAuthenticate({ serverId: serverName });
              if (!oauthResult.success) {
                console.error('OAuth authentication failed:', oauthResult.error);
                setupSuccess = false;
                setupError = oauthResult.error;
              }
            } catch (authError) {
              console.error('Failed to trigger OAuth:', authError);
              oauthResult = { success: false, error: authError instanceof Error ? authError.message : 'Unknown error' };
              setupSuccess = false;
              setupError = oauthResult.error;
            }
          }
          // For bundled OAuth MCPs without authApi and not oauth-user-provided, OAuth happens via
          // Claude calling the MCP's authenticate tool in the conversation
          
          // Track connection result for bundled servers
          if (setupSuccess) {
            const method = bundledConfig.authType === 'oauth' ? 'oauth' : 'manual';
            tracking.settings.connectorConnected(connection.name, category, method);
          } else {
            // Broken-by-default (no OAuth client credentials): open the setup dialog instead of a
            // generic toast, and record a `not_configured` lastOauthStep for telemetry.
            const isNotConfigured = setupGuidanceDialog.handleResult(oauthResult);
            const lastOauthStep = isNotConfigured ? 'not_configured' : /timed?\s*out|timeout/i.test(setupError ?? '') ? 'browser_opened' : /state mismatch|invalid/i.test(setupError ?? '') ? 'callback_received' : 'not_started';
            tracking.settings.connectorConnectionFailed(connection.name, category, 'bundled_setup_failed', setupError, { connectorType, durationMs: Date.now() - connectStartedAt, lastOauthStep, source: 'settings_ui' });
            // Surface the setup failure as a toast for ALL bundled authTypes —
            // historically only OAuth flows toasted, so `authType: 'none'` IPC
            // rejects (e.g. `Unknown bundled server`) collapsed the card silently
            // and looked indistinguishable from success. See FOX-3264.
            // Skip the toast when the dialog already explains the not-configured case.
            if (setupError && !isNotConfigured) {
              showToast({
                title: `${connection.name} connection failed`,
                description: setupError,
              });
            }
          }

          // Skip post-connect side effects if this attempt was cancelled or superseded
          if (connectAttemptRef.current !== attemptId) return;

          if (launchRebel && !isTrackedConnectDeferred(connection.id)) {
            // DA F1: when the tracked connect op was marked deferred by the
            // time the connect IPC resolved, routing for the new connector has
            // NOT applied yet — the setup chat's prompt immediately asks Rebel
            // to list_tools it. Skip the chat; the queued toast/card copy
            // explains the state (the user is mid-task — that's why it
            // deferred).
            let finalServerName = instanceName;
            // rebel-oss connectors: the router entry uses the base serverName, not instance name
            if (connection.catalogEntry?.provider === 'rebel-oss') {
              finalServerName = serverName;
            }

            onConfigureWithRebel?.({
              serverName: finalServerName, // Use instance name for correct tool calls
              catalogEntry: connection.catalogEntry,
              setupResult: { success: setupSuccess, error: setupError },
              oauthResult: oauthResult as SetupWithRebelParams['oauthResult'],
              isNewConnection: true,
            });
          }
          // Don't collapse the card on oauth-user-provided failure so user can see error and retry
          if (setupSuccess || bundledConfig.authType !== 'oauth-user-provided') {
            setExpandedId(null);
          }
          return;
        }

        // Direct/community servers use mcpConfig
        if (!connection.catalogEntry?.mcpConfig) return;
        const config = connection.catalogEntry.mcpConfig;
        const catalogEntry = connection.catalogEntry;

        // For direct connectors with multi-instance support, generate instance-specific name
        const emailTrimmed = email?.trim();
        const isDirectEmailInstance = connection.provider === 'direct' && 
          catalogEntry?.accountIdentity === 'email' && 
          emailTrimmed;
        const isDirectWorkspaceInstance = connection.provider === 'direct' && 
          catalogEntry?.accountIdentity === 'workspace' && 
          emailTrimmed; // Note: "email" field is reused for workspace name input
        const serverName = isDirectEmailInstance 
          ? generateInstanceId(connection.name, emailTrimmed)
          : isDirectWorkspaceInstance
            ? generateWorkspaceInstanceId(connection.name, emailTrimmed)
            : connection.name;

        trackDeferredOperation({
          id: connection.id,
          kind: 'connect',
          context: buildSettingsUpsertRestartContext(serverName),
        });
        await onUpsertServer({
          name: serverName,
          transport: config.transport || 'stdio',
          // Pass explicit type if specified (e.g., "sse" for Atlassian) - takes precedence over transport
          type: config.type,
          url: config.url,
          command: config.command,
          args: config.args,
          oauth: config.oauth,
          oauthParams: config.oauthParams,
          oauthClientId: config.oauthClientId,
          oauthClientSecret: config.oauthClientSecret,
          // Pass email or workspace depending on identity type
          ...(isDirectEmailInstance ? { email: emailTrimmed } : {}),
          ...(isDirectWorkspaceInstance ? { workspace: emailTrimmed } : {}),
          // Pass catalogId to enable proper display name and grouping
          ...(catalogEntry?.id ? { catalogId: catalogEntry.id } : {}),
          // Track when this server was connected for "recently connected" sorting
          lastConnectedAt: Date.now(),
        });
        
        // For OAuth connectors, trigger the OAuth flow via Super-MCP
        // This opens the browser for the user to authenticate with the vendor
        let oauthResult: (MaybeSetupGuidanceResult & { success: boolean; status?: string; error?: string; accountIdentity?: string }) | undefined;
        if (config.oauth) {
          try {
            if (catalogEntry.authMethod === 'rebel-oauth') {
              // GitHub uses Rebel-side OAuth (bypasses Super-MCP's DCR which GitHub doesn't support)
              const githubResult = await window.githubApi.startAuth();
              oauthResult = {
                success: githubResult.success,
                status: githubResult.success ? 'authenticated' : 'error',
                error: githubResult.error,
                setupGuidance: githubResult.setupGuidance,
              };

              if (!githubResult.success) {
                console.error('GitHub OAuth authentication failed:', githubResult.error);
                // Broken-by-default (no OAuth client credentials): open the setup dialog instead of
                // a generic toast.
                if (!setupGuidanceDialog.handleResult(githubResult)) {
                  // Show toast so user knows auth failed (they can retry via "Re-authenticate" in tool list)
                  showToast({
                    title: `${connection.name} authentication failed`,
                    description: githubResult.error || 'Please try again or check the connection settings',
                  });
                }
              } else {
                // Reload tokens into Super-MCP by restarting it (ensures new token files are picked up)
                const restartResult = await window.settingsApi.mcpRestartSuperMcp();
                if (!restartResult.success) {
                  console.error('Failed to restart Super-MCP after GitHub auth:', restartResult.error);
                }
              }
            } else {
              oauthResult = await window.miscApi.mcpAuthenticate({ serverId: serverName });
              if (!oauthResult.success) {
                console.error('OAuth authentication failed:', oauthResult.error);
                // Broken-by-default (no OAuth client credentials): open the setup dialog instead of
                // a generic toast.
                if (!setupGuidanceDialog.handleResult(oauthResult)) {
                  // Show toast so user knows auth failed (they can retry via "Re-authenticate" in tool list)
                  showToast({
                    title: `${connection.name} authentication failed`,
                    description: oauthResult.error || 'Please try again or check the connection settings',
                  });
                }
              } else {
                // Include the email/workspace identity that was entered by the user
                oauthResult.accountIdentity = emailTrimmed;
              }
            }
          } catch (authError) {
            console.error('Failed to trigger OAuth:', authError);
            const errorMsg = authError instanceof Error ? authError.message : 'Unknown error';
            oauthResult = { success: false, error: errorMsg };
            showToast({ 
              title: `${connection.name} authentication failed`,
              description: errorMsg,
            });
          }
        }
        
        // Track connection result for direct/community servers
        const connectMethod = config.oauth ? 'oauth' : 'manual';
        if (!oauthResult || oauthResult.success) {
          tracking.settings.connectorConnected(connection.name, category, connectMethod);
        } else {
          const lastOauthStep = isOAuthSetupGuidance(oauthResult.setupGuidance) ? 'not_configured' : /timed?\s*out|timeout/i.test(oauthResult.error ?? '') ? 'browser_opened' : /state mismatch|invalid/i.test(oauthResult.error ?? '') ? 'callback_received' : 'not_started';
          tracking.settings.connectorConnectionFailed(connection.name, category, 'oauth_failed', oauthResult.error, { connectorType, durationMs: Date.now() - connectStartedAt, lastOauthStep, source: 'settings_ui' });
        }

        // Skip post-connect side effects if this attempt was cancelled or superseded
        if (connectAttemptRef.current !== attemptId) return;

        // Refresh the connector summary after a successful connect so Settings reflects the
        // live connection immediately. Without this, direct HTTP OAuth connectors (Stripe,
        // Canva, Miro) stayed "disconnected" in the UI until an app restart even though backend
        // auth completed and tools were live (REBEL-5YP). Mirrors the disconnect path, which
        // already refreshes. A non-OAuth manual connect (oauthResult undefined) also refreshes.
        if (!oauthResult || oauthResult.success) {
          onRefresh?.();
        }

        // Only launch Rebel if explicitly requested (via "Set up with Rebel" button)
        // Use the actual serverName (instance-specific for multi-instance connectors) so the prompt
        // generates correct tool calls (e.g., list_tools(package_id: "Notion-user-email-com"))
        if (launchRebel) {
          onConfigureWithRebel?.({ 
            serverName, 
            catalogEntry: connection.catalogEntry,
            oauthResult: oauthResult as SetupWithRebelParams['oauthResult'],
            isNewConnection: true,
          });
        }
        setExpandedId(null);
      } finally {
        if (connectAttemptRef.current === attemptId) {
          setConnectingId(null);
          setConnectingCatalogId(null);
          clearDeferredOperation(connection.id, 'connect');
        }
      }
    },
    [onUpsertServer, onConfigureWithRebel, showToast, connectSlackMcp, setupGuidanceDialog, trackDeferredOperation, clearDeferredOperation, isTrackedConnectDeferred, onRefresh]
  );

  const handleCancelConnect = useCallback(() => {
    connectAttemptRef.current++;
    setConnectingId(null);
    setConnectingCatalogId(null);
    if (deferredOpRef.current?.kind === 'connect') {
      deferredOpRef.current = null;
    }
    setDeferredOp((current) => current?.kind === 'connect' ? null : current);
    deferredToastKeyRef.current = null;
  }, []);

  const handleDisconnect = useCallback(
    async (
      connection: UnifiedConnection,
      serverNameOverride?: string,
      options?: {
        tracking?: 'self' | 'external' | 'none';
        closeOnSuccess?: boolean;
        rethrowOnError?: boolean;
      },
    ) => {
      if (!onRemoveServer || !connection.serverPreview) return;
      
      const trackingMode = options?.tracking ?? 'self';
      const closeOnSuccess = options?.closeOnSuccess ?? true;
      const serverName = serverNameOverride ?? connection.serverPreview.name;
      const selectedInstance = connection.instances?.find((instance) => instance.serverName === serverName);
      const connectionName = connection.name;
      const connectionId = connection.id;
      const wasActive = connection.status === 'connected';
      
      // Keep card open and show loading state on disconnect button
      setRemovingId(connectionId);
      if (trackingMode === 'self') {
        trackDeferredOperation({
          id: connectionId,
          kind: 'disconnect',
          context: buildMcpServerRemovalRestartContext(serverName),
        });
      }
      
      // Track disconnect (success tracked later)
      tracking.settings.connectorDisconnected(connectionName, wasActive);
      
      // Track if we're using a path that handles its own error toasts
      let handlesOwnErrorToast = false;
      
      try {
        const { isInstance, baseName, emailSlug } = parseMultiInstanceServer(serverName);
        
        // Route Google Workspace instances to dedicated cleanup
        if (isInstance && baseName === 'GoogleWorkspace' && emailSlug) {
          // Prefer the selected instance label, then the preview description, then slug parsing.
          const instanceEmail = selectedInstance?.label?.includes('@') ? selectedInstance.label : undefined;
          const description =
            serverName === connection.serverPreview.name ? connection.serverPreview.description : undefined;
          const emailMatch = description?.match(/^([^\s]+@[^\s]+)\s*-/);
          const email = instanceEmail ?? emailMatch?.[1] ?? parseEmailFromSlug(emailSlug);
          
          const result = await window.googleWorkspaceApi.removeAccount({ email });
          if (!result.success) {
            throw new Error(result.error ?? 'Removal failed');
          }
          showToast({ title: `Removed ${connectionName}` });
          onRefresh?.(); // Trigger list refresh
        } else if (serverName === 'RebelAppBridge') {
          // Rebel Browser is backed by an internal MCP server (RebelAppBridge)
          // that the settings MCP-remove guard refuses to delete. "Disconnect"
          // here means "unpair the browser extension" — revoke every paired
          // client and close live WS connections. The bridge itself keeps
          // running so other internal features (install flow, diagnose, etc.)
          // still work.
          //
          // We handle our own error toast here so the generic "Failed to
          // remove X" wording (appropriate for MCP removals) doesn't appear
          // for what is really an unpair action.
          handlesOwnErrorToast = true;
          try {
            const { revoked } = await window.appBridgeApi.revoke({});
            showToast({
              title:
                revoked > 0
                  ? `Disconnected ${connectionName}`
                  : `${connectionName} was already disconnected`,
            });
            // Force the paired-count hook to re-read immediately so the
            // Rebel Browser card flips to 'available' (moving to the
            // marketplace section and revealing the Install CTA) on this
            // tick instead of waiting for the pending-approval-updated
            // broadcast. Redundant-but-cheap: appBridgeManager now also
            // broadcasts on successful revoke, so this is a belt-and-
            // suspenders refresh.
            await refreshAppBridgePaired();
            onRefresh?.();
          } catch {
            showToast({ title: `Couldn't disconnect ${connectionName}` });
            throw new Error('revoke-failed'); // keep card open via outer catch
          }
        } else {
          // Generic removal for other servers
          // Note: onRemoveServer already shows toasts for success AND failure
          handlesOwnErrorToast = true;
          await onRemoveServer(serverName);
        }
        
        // Close card only after disconnect succeeds
        // Use functional update to avoid closing a different card if user expanded another
        if (closeOnSuccess) {
          setExpandedId(prev => (prev === connectionId ? null : prev));
        }
      } catch (error) {
        // Keep card open on error so user can retry
        // Only show error toast if the removal path doesn't handle its own
        if (!handlesOwnErrorToast) {
          showToast({ title: `Failed to remove ${connectionName}` });
        }
        if (options?.rethrowOnError) {
          throw error;
        }
      } finally {
        setRemovingId(null);
        if (trackingMode === 'self') {
          clearDeferredOperation(connectionId, 'disconnect');
        }
      }
    },
    [onRemoveServer, showToast, onRefresh, refreshAppBridgePaired, trackDeferredOperation, clearDeferredOperation]
  );

  const handleConfigureWithRebel = useCallback(
    (connection: UnifiedConnection, options?: { isNewConnection?: boolean; setupResult?: { success: boolean; error?: string }; serverNameOverride?: string }) => {
      // Use override if provided (for multi-instance connectors with generated names)
      // Otherwise prefer serverPreview.name (actual MCP package ID), then bundled serverName, then display name
      const name = options?.serverNameOverride ||
        connection.serverPreview?.name || 
        connection.catalogEntry?.bundledConfig?.serverName || 
        connection.name;
      
      tracking.settings.connectorConfigureWithRebelClicked(connection.name);
      
      onConfigureWithRebel?.({ 
        serverName: name, 
        catalogEntry: connection.catalogEntry,
        isNewConnection: options?.isNewConnection ?? false, // Default to reconfigure of existing connection
        setupResult: options?.setupResult,
      });
      setExpandedId(null);
    },
    [onConfigureWithRebel]
  );

  const handleGetPythonHelp = useCallback(
    (connection: UnifiedConnection) => {
      onGetPythonHelp?.(connection.name);
      setExpandedId(null);
    },
    [onGetPythonHelp]
  );

  const getDeferredKindForConnection = useCallback((connectionId: string): DeferredConnectorOperation['kind'] | undefined => {
    return deferredOp?.id === connectionId && deferredOp.isDeferred ? deferredOp.kind : undefined;
  }, [deferredOp]);

  // Helper to render the expanded card for a connection - used inline after each chip
  const renderExpandedCard = useCallback((connection: UnifiedConnection) => {
    const isConnected = connection.status !== 'available';
    const deferredKind = getDeferredKindForConnection(connection.id);
    const ops = createTrackedConnectionCardOps({
      operationId: connection.id,
      trackDeferredOperation,
      clearDeferredOperation,
      addBundledServer: (payload) => window.settingsApi.mcpAddBundledServer(payload),
      upsertServer: (payload) => onUpsertServer(payload),
      removeServer: (serverName, tracking: ConnectionCardTracking) => {
        if (!onRemoveServer || connection.catalogEntry?.isInternal) {
          console.warn('[UnifiedConnectionsPanel] Ignoring connector-card remove request', {
            serverName,
            connectionId: connection.id,
            connectorName: connection.name,
            reason: !onRemoveServer ? 'missing-onRemoveServer' : 'internal-connector',
            tracking,
          });
          return Promise.resolve();
        }
        // Stage 4 behavior-delegation pin: card removals delegate into the
        // panel's full handleDisconnect flow, never directly to the remove IPC.
        return handleDisconnect(connection, serverName, {
          tracking: 'exempt' in tracking ? 'none' : 'external',
          closeOnSuccess: !('exempt' in tracking),
          rethrowOnError: 'exempt' in tracking,
        });
      },
      toggleServerEnabled: (serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId }),
    });
    return (
      <ExpandedConnectionCard
        key={`expanded-${connection.id}`}
        connection={connection}
        onClose={handleClose}
        onConnect={
          // Allow connect for:
          // - Available cards (initial connect)
          // - Connected multi-instance cards (for "Add another account")
          // - Connected bundled OAuth connectors (may need reconnect if health check fails)
          !isConnected || 
          connection.instances ||
          connection.catalogEntry?.bundledConfig?.authType === 'oauth'
            ? (email?: string, options?: { launchRebel?: boolean; scopeTier?: 'readonly' | 'full'; setupFieldValues?: Record<string, string> }) =>
                handleConnect(connection, email, options)
            : undefined
        }
        onDisconnect={
          isConnected && 
          onRemoveServer && 
          !connection.catalogEntry?.isInternal
            ? (serverName?: string) => handleDisconnect(connection, serverName)
            : undefined
        }
        onConfigureWithRebel={
          onConfigureWithRebel
            ? (options) => handleConfigureWithRebel(connection, options)
            : undefined
        }
        onExtendConnector={
          onExtendConnector && (connection.catalogEntry?.provider === 'rebel-oss' || !connection.catalogEntry)
            ? () => void onExtendConnector(
              connection.catalogEntry ? connection.id : (connection.serverPreview?.name ?? connection.name),
              connection.name,
            )
            : undefined
        }
        onShareWithCommunity={
          // Per C8: the section now passes the contribution record's canonical
          // `connectorName`, which is more deterministic than reconstructing
          // from `connection.serverPreview?.name ?? connection.name`. The
          // App.tsx handler does case-insensitive matching on the store, so
          // either source resolves to the same record. Wrapper coerces the
          // panel-prop's `void | Promise<void>` return type into the strict
          // `void` the section expects.
          onShareWithCommunity
            ? (connectorName: string) => void onShareWithCommunity(connectorName)
            : undefined
        }
        onOpenContributionChat={
          onOpenContributionChat
            ? (sessionId: string) => void onOpenContributionChat(sessionId)
            : undefined
        }
        onGetPythonHelp={
          onGetPythonHelp
            ? () => handleGetPythonHelp(connection)
            : undefined
        }
        onLoadServer={onLoadServer}
        ops={ops}
        onRefresh={onRefresh}
        isLoading={mcpMutationPending}
        isConnecting={
          connectingId === connection.id ||
          (connectingCatalogId != null && connectingCatalogId === connection.catalogEntry?.id) ||
          (
            connection.catalogEntry?.bundledConfig?.authApi === 'slackApi' &&
            isSlackMcpConnectInFlight
          )
        }
        isRemoving={removingId === connection.id}
        deferredKind={deferredKind}
        onCancelConnect={handleCancelConnect}
        layoutId={`chip-${connection.id}`}
      />
    );
  }, [
    handleClose, handleConnect, handleDisconnect, handleConfigureWithRebel, handleGetPythonHelp,
    handleCancelConnect,
    getDeferredKindForConnection,
    trackDeferredOperation, clearDeferredOperation,
    onRemoveServer, onConfigureWithRebel, onExtendConnector, onShareWithCommunity, onOpenContributionChat, onGetPythonHelp, onLoadServer, onUpsertServer, onRefresh,
    mcpMutationPending, connectingId, connectingCatalogId, removingId, isSlackMcpConnectInFlight
  ]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const maxIndex = visibleConfiguredConnections.length - 1;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, maxIndex));
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(maxIndex);
          break;
        case 'Escape':
          if (expandedId) {
            e.preventDefault();
            setExpandedId(null);
          }
          break;
      }
    },
    [visibleConfiguredConnections.length, expandedId]
  );

  // Focus management - focus the chip when focusedIndex changes
  useEffect(() => {
    if (focusedIndex >= 0 && chipsContainerRef.current) {
      const chips = chipsContainerRef.current.querySelectorAll('[data-chip]');
      const chip = chips[focusedIndex] as HTMLButtonElement | undefined;
      chip?.focus();
    }
  }, [focusedIndex]);

  // Handle focus entering the chip container
  const handleContainerFocus = useCallback(() => {
    if (focusedIndex < 0 && visibleConfiguredConnections.length > 0) {
      setFocusedIndex(0);
    }
  }, [focusedIndex, visibleConfiguredConnections.length]);

  const [isReloading, setIsReloading] = useState(false);
  
  const handleReload = useCallback(async () => {
    if (isReloading || mcpSummaryLoading) return;
    setIsReloading(true);
    try {
      if (onReloadConnectors) {
        await onReloadConnectors();
      } else if (onRefresh) {
        await onRefresh();
      }
    } finally {
      setIsReloading(false);
    }
  }, [onReloadConnectors, onRefresh, isReloading, mcpSummaryLoading]);

  const showReloadButton = onReloadConnectors || onRefresh;

  const getConnectedSecondaryLabel = useCallback((connection: UnifiedConnection): string | null => {
    const attentionState = getConnectionAttentionState(connection);
    const instances = connection.instances ?? [];
    const instanceCount = instances?.length ?? 0;

    if (instanceCount > 1) {
      const needing = instances.filter(
        (instance) =>
          instance.health === 'error' || instance.health === 'unavailable' || instance.missingIdentity,
      ).length;
      if (attentionState === 'needs-attention' && needing > 0) {
        const nLabel = needing === 1 ? '1 needs attention' : `${needing} need attention`;
        return `${instanceCount} accounts · ${nLabel}`;
      }
      return `${instanceCount} accounts`;
    }

    if (attentionState === 'needs-attention') {
      return 'Needs attention';
    }

    return null;
  }, []);

  const connectedFilterOptions = [
    { id: 'all', label: 'All', count: configuredConnections.length },
    { id: 'needs-attention', label: 'Needs attention', count: needsAttentionConnections.length },
    { id: 'inactive', label: 'Not connected', count: inactiveConnections.length },
  ] as const;

  return (
    <section
      className={styles.connectorsPageRoot}
      data-section="connectors"
      data-testid="connectors-page-header"
    >
      <div className={styles.cluster} data-testid="connectors-panel">
        <div className={styles.pageChrome}>
          <div className={styles.connectorsHeroCopy}>
            <header className={`${styles.pageHeader} ${styles.connectorsPageHeader}`}>
              <div className={styles.connectorsHeroTopRow}>
                <div>
                  <h2 className={styles.pageTitle}>Connectors</h2>
                  <p className={styles.pageDescription}>
                    Connect your services so Rebel can read and act across your work.
                  </p>
                </div>
                <Button
                  size="sm"
                  data-testid="connector-setup-button"
                  onClick={() => {
                    void onBuildConnector?.();
                  }}
                >
                  + Set up a connector
                </Button>
              </div>
            </header>
            <div className={styles.connectorsHeroLinks}>
              {onNavigateToDiagnostics && (
                <button
                  type="button"
                  className={styles.connectorsHeroLink}
                  onClick={onNavigateToDiagnostics}
                >
                  Connection issues? Diagnostics
                </button>
              )}
            </div>
          </div>
        </div>

      {mcpRuntimeHealthDegraded && (
        <Notice
          tone="warning"
          placement="section"
          density="standard"
          role="status"
          title="Some tools may not be available"
          data-testid="mcp-runtime-health-banner"
          actions={
            onNavigateToDiagnostics
              ? [{ label: 'Open Diagnostics', onClick: onNavigateToDiagnostics }]
              : undefined
          }
        >
          Rebel had trouble starting the tool connector. Open Diagnostics for details, or restart Rebel if the issue persists.
        </Notice>
      )}

      <div className={styles.connectionsControlsBar}>
        <Input
          type="search"
          inputSize="sm"
          placeholder="Search connectors..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search connectors"
          className={styles.connectionsSearchInput}
        />
        {categoryTabs.length > 1 && (
          <Select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as CategoryFilterId)}
            aria-label="Filter by category"
            selectSize="sm"
            className={styles.connectionsControlSelect}
          >
            {categoryTabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.label} ({tab.count})
              </option>
            ))}
          </Select>
        )}
        <Select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'alphabetical' | 'recent')}
          aria-label="Sort connections"
          selectSize="sm"
          className={styles.connectionsSortSelect}
        >
          <option value="alphabetical">A-Z</option>
          <option value="recent">Recent</option>
        </Select>
      </div>


      {isEmptySearch ? (
        <div className={styles.connectionsEmptyState}>
          <p className={styles.connectionsEmptyStateHeadline}>
            No connector found for &quot;{searchQuery.trim()}&quot;
          </p>
          <p className={styles.connectionsEmptyStateMessage}>
            Rebel can help you create this connector.
          </p>
          <div className={styles.connectionsEmptyStateActions}>
            <Button
              variant="default"
              size="sm"
              type="button"
              data-testid="connector-setup-empty-search"
              onClick={() => {
                void onBuildConnector?.(searchQuery);
              }}
            >
              Create it with Rebel
            </Button>
          </div>
        </div>
      ) : isInitialCatalogLoad ? (
        <div
          className={styles.connectorsCatalogLoading}
          aria-busy="true"
          aria-live="polite"
        >
          <Loader2 size={18} className={styles.spinnerIcon} aria-hidden />
          <span className={styles.connectorsCatalogLoadingText}>Loading connectors…</span>
          <div className={styles.connectorsCatalogSkeleton} aria-hidden>
            <div className={styles.connectorsCatalogSkeletonLine} />
            <div className={styles.connectorsCatalogSkeletonLine} />
            <div className={styles.connectorsCatalogSkeletonLineShort} />
          </div>
        </div>
      ) : catalogSummaryUnavailable ? (
        <div className={styles.connectorsCatalogError} role="alert">
          <AlertCircle size={18} className={styles.connectorsCatalogErrorIcon} aria-hidden />
          <p className={styles.connectorsCatalogErrorText}>
            {mcpSummaryError ?? 'We could not load connectors right now.'}
          </p>
          {showReloadButton && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={handleReload}
              disabled={isReloading}
            >
              <RefreshCw size={14} className={isReloading ? styles.spinnerIcon : ''} />
              Try again
            </Button>
          )}
        </div>
      ) : (
        <LayoutGroup>
          <div className={`${styles.connectionsSection} ${styles.connectionsSectionConnected}`}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitleRow}>
                <div className={styles.sectionTitleMeta}>
                  <CheckCircle2 size={16} className={styles.sectionIcon} />
                  <h4 className={styles.sectionTitle}>Connected</h4>
                  <span className={styles.sectionCount}>{configuredConnections.length}</span>
                </div>
                <Select
                  value={connectedFilter}
                  onChange={(e) => handleConnectedFilterChange(e.target.value as 'all' | 'needs-attention' | 'inactive')}
                  aria-label="Filter connected connectors"
                  selectSize="sm"
                  className={styles.connectedFilterSelect}
                >
                  {connectedFilterOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} ({option.count})
                    </option>
                  ))}
                </Select>
              </div>
              <p className={styles.sectionDescription}>
                Scan what is working, what needs a quick fix, and what you have turned off. Inactive connectors stay here so you can turn them back on.
              </p>
            </div>
            
            {visibleConfiguredConnections.length > 0 ? (
              <div
                ref={chipsContainerRef}
                className={styles.connectionChips}
                role="listbox"
                aria-label="Connected integrations"
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onFocus={handleContainerFocus}
              >
                <AnimatePresence mode="popLayout">
                  {visibleConfiguredConnections.map((connection, index) => (
                    <div key={connection.id} style={{ display: 'contents' }}>
                      <ConnectionChip
                        connection={connection}
                        attentionState={getConnectionAttentionState(connection)}
                        isExpanded={expandedId === connection.id}
                        isLoading={(connectingId === connection.id || (mcpMutationPending && !removingId)) && !getDeferredKindForConnection(connection.id)}
                        isRemoving={removingId === connection.id && getDeferredKindForConnection(connection.id) !== 'disconnect'}
                        onClick={() => handleChipClick(connection)}
                        layoutId={`chip-${connection.id}`}
                        tabIndex={focusedIndex === index ? 0 : -1}
                        aria-selected={expandedId === connection.id}
                        secondaryLabel={getConnectedSecondaryLabel(connection)}
                        showIcon={true}
                        showBadge={false}
                        dataSection={dataSectionForUnifiedConnection(connection)}
                      />
                      {expandedId === connection.id && (
                        <div className={styles.expandedCardInline}>
                          {renderExpandedCard(connection)}
                        </div>
                      )}
                    </div>
                  ))}
                </AnimatePresence>
              </div>
            ) : (
              <p className={styles.sectionEmptyState}>
                {connectedFilter === 'needs-attention'
                  ? hasConnectedViewFilter
                    ? 'No connectors with issues match the current filters.'
                    : 'Everything looks healthy right now.'
                  : connectedFilter === 'inactive'
                    ? hasConnectedViewFilter
                      ? 'No inactive connectors match the current filters.'
                      : 'Nothing is turned off right now.'
                    : hasConnectedViewFilter
                      ? 'No connected connectors match the current filters.'
                      : 'No connectors are connected yet. Browse what is available below.'}
              </p>
            )}
          </div>

          {/* Available section - integrations catalog */}
          {availableConnections.length > 0 && (
            <div
              className={`${styles.connectionsSection} ${styles.connectionsSectionSpaced} ${styles.connectionsSectionAvailable}`}
            >
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <div className={styles.sectionTitleMeta}>
                    <Package size={16} className={styles.sectionIcon} />
                    <h4 className={styles.sectionTitle}>Available</h4>
                    <span className={styles.sectionCount}>{availableConnections.length}</span>
                  </div>
                </div>
                <p className={styles.sectionDescription}>
                  Connectors you have not connected yet. Search or open a category to add more — inactive connectors stay
                  under Connected so you can turn them back on.
                </p>
              </div>

              <div className={styles.categoriesContainer}>
                  {/* Recommended connectors for the user's organization */}
                  {recommendedConnections.length > 0 && (
                    <div className={`${styles.categoryGroup} ${styles.availableCategoryGroup} ${styles.availableRecommendedGroup}`}>
                      <div className={`${styles.categoryHeader} ${styles.availableCategoryHeaderStatic}`}>
                        <Building2 size={14} className={styles.categoryIcon} />
                        <span className={styles.categoryLabel}>Recommended for your company</span>
                        <span className={styles.categoryCount}>{recommendedConnections.length}</span>
                      </div>
                      <p className={styles.availableRecommendedHint}>
                        A short list based on your organization — connect only what you need.
                      </p>
                      <div
                        className={styles.connectionChips}
                        role="listbox"
                        aria-label="Recommended integrations"
                      >
                        <AnimatePresence mode="popLayout">
                          {recommendedConnections.map((connection) => (
                            <div key={connection.id} style={{ display: 'contents' }}>
                              <ConnectionChip
                                connection={connection}
                                isExpanded={expandedId === connection.id}
                                isLoading={(mcpMutationPending && !removingId) && !getDeferredKindForConnection(connection.id)}
                                onClick={() => handleChipClick(connection)}
                                layoutId={`chip-${connection.id}`}
                                tabIndex={-1}
                                aria-selected={expandedId === connection.id}
                                showIcon={false}
                                showBadge={false}
                                dataSection={dataSectionForUnifiedConnection(connection)}
                              />
                              {expandedId === connection.id && (
                                <div className={styles.expandedCardInline}>
                                  {renderExpandedCard(connection)}
                                </div>
                              )}
                            </div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}

                  {/* Available connectors grouped by collapsible categories */}
                  {availableByCategory.map(({ category, label, connectors }) => {
                    const isCollapsed = collapsedCategories.has(category);
                    const CategoryIcon = getCategoryIcon(category);
                    return (
                      <div key={category} className={`${styles.categoryGroup} ${styles.availableCategoryGroup}`}>
                        <button
                          className={styles.categoryHeader}
                          onClick={() => toggleCategory(category)}
                          aria-expanded={!isCollapsed}
                          type="button"
                        >
                          <ChevronRight 
                            size={14} 
                            className={`${styles.categoryChevron} ${!isCollapsed ? styles.categoryChevronExpanded : ''}`} 
                          />
                          <CategoryIcon size={14} className={styles.categoryIcon} />
                          <span className={styles.categoryLabel}>{label}</span>
                          <span className={styles.categoryCount}>{connectors.length}</span>
                        </button>
                        
                        <AnimatePresence initial={false}>
                          {!isCollapsed && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: 0.15, ease: 'easeOut' }}
                            >

                              <div
                                className={styles.connectionChips}
                                role="listbox"
                                aria-label={`${label} integrations`}
                              >
                                <AnimatePresence mode="popLayout">
                                  {connectors.map((connection) => (
                                    // Wrapper needed: AnimatePresence requires ref-able children,
                                    // but React.Fragment cannot hold refs (React 19 warning).
                                    // display:contents preserves flex layout.
                                    <div key={connection.id} style={{ display: 'contents' }}>
                                      <ConnectionChip
                                        connection={connection}
                                        isExpanded={expandedId === connection.id}
                                        isLoading={(mcpMutationPending && !removingId) && !getDeferredKindForConnection(connection.id)}
                                        onClick={() => handleChipClick(connection)}
                                        layoutId={`chip-${connection.id}`}
                                        tabIndex={-1}
                                        aria-selected={expandedId === connection.id}
                                        showIcon={false}
                                        showBadge={false}
                                        dataSection={dataSectionForUnifiedConnection(connection)}
                                      />
                                      {/* Expanded card renders inline right after the clicked chip */}
                                      {expandedId === connection.id && (
                                        <div className={styles.expandedCardInline}>
                                          {renderExpandedCard(connection)}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </AnimatePresence>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </LayoutGroup>
      )}

      <div className={styles.connectorsFooter}>
        <SettingSection
          title="Advanced"
          description="Custom setup options, config details, and troubleshooting context for power users."
          advanced
          data-section="experimental-connectors"
          data-testid="connectors-advanced-section"
        >
          <div className={styles.mcpConfigSection}>
            <div className={styles.mcpConfigRow}>
              <div className={styles.mcpConfigInfo}>
                <FileJson size={14} className={styles.mcpConfigIcon} />
                <div className={styles.mcpConfigDetails}>
                  <span className={styles.mcpConfigTitle}>Manual JSON setup</span>
                  <span className={styles.mcpConfigHelper}>
                    Paste a connector JSON config if you are setting up something custom.
                  </span>
                </div>
              </div>
              <div className={styles.mcpConfigActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    tracking.settings.customMcpServerClicked();
                    setShowAddModal(true);
                  }}
                  className={styles.mcpConfigButton}
                >
                  Open
                </Button>
              </div>
            </div>

            <div className={styles.mcpConfigRow}>
              <div className={styles.mcpConfigInfo}>
                <FileJson size={14} className={styles.mcpConfigIcon} />
                {mcpSummaryLoading ? (
                  <span className={styles.mcpConfigText}>
                    <Loader2 size={12} className={styles.spinnerIcon} />
                    Loading config...
                  </span>
                ) : mcpSummaryError ? (
                  <span className={`${styles.mcpConfigText} ${styles.mcpConfigError}`}>
                    <AlertCircle size={12} />
                    {mcpSummaryError}
                  </span>
                ) : mcpSummary?.configPath ? (
                  <span className={styles.mcpConfigText}>
                    <Tooltip
                      content={
                        <span>
                          {mcpSummary.configPath}
                          <br />
                          <span style={{ opacity: 0.7, fontSize: '0.9em' }}>Click to reveal in file manager</span>
                        </span>
                      }
                      maxWidth="500px"
                    >
                      <code
                        className={`${styles.mcpConfigPath} ${styles.mcpConfigPathClickable}`}
                        onClick={() => mcpSummary.configPath && window.appApi.revealPath(mcpSummary.configPath)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && mcpSummary.configPath && window.appApi.revealPath(mcpSummary.configPath)}
                      >
                        {mcpSummary.configPath}
                      </code>
                    </Tooltip>
                    <span className={styles.mcpConfigMeta}>
                      {servers.length} server{servers.length !== 1 ? 's' : ''}
                      {mcpSummary.mode === 'super-mcp' && ' via Super-MCP'}
                    </span>
                  </span>
                ) : (
                  <span className={styles.mcpConfigText}>No MCP config selected</span>
                )}
              </div>
              <div className={styles.mcpConfigActions}>
                {onChooseConfigFile && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onChooseConfigFile}
                    className={styles.mcpConfigButton}
                  >
                    {mcpSummary?.configPath ? 'Change config file' : 'Choose config'}
                  </Button>
                )}
              </div>
            </div>
          </div>

          <SettingRow
            label="Allow external MCP access"
            tooltip="Let external tools like Cursor and Claude Desktop invoke Rebel as an MCP server."
            htmlFor="allow-external-mcp-access"
          >
            <input
              id="allow-external-mcp-access"
              type="checkbox"
              checked={externalMcpEnabled}
              onChange={() => onToggleExternalMcp?.()}
            />
          </SettingRow>

          <SettingRow
            label="Interactive Views"
            tooltip="Render rich views from tools. Turn this off if tool views cause trouble."
            htmlFor="interactive-mcp-views"
          >
            <input
              id="interactive-mcp-views"
              type="checkbox"
              checked={interactiveViewsEnabled}
              onChange={() => onToggleInteractiveViews?.()}
            />
          </SettingRow>


        </SettingSection>
      </div>

      {/* Add Connection Modal - opens directly to custom server tab */}
      <AddConnectionModal
        open={showAddModal}
        onOpenChange={setShowAddModal}
        onAddServer={onUpsertServer}
        onLoadServer={onLoadServer}
        servers={servers}
        mcpMutationPending={mcpMutationPending}
        onConfigureWithRebel={onConfigureWithRebel}
        initialShowCustomForm
      />

      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
      </div>
    </section>
  );
}
