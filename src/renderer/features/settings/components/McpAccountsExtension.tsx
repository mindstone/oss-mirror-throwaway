import { useCallback, useEffect, useState } from 'react';
import { Button, Notice, Tooltip } from '@renderer/components/ui';
import { Plus, Check, Loader2, AlertCircle, AlertTriangle, Pause, Play } from 'lucide-react';
import { AccountDisconnectButton } from './AccountDisconnectButton';
import { ConnectorSetupDialog } from './ConnectorSetupDialog';
import { useConnectorSetupGuidance, type MaybeSetupGuidanceResult } from '../hooks/useConnectorSetupGuidance';
import type { ConnectionInstance } from '../hooks/useUnifiedConnections';
import type { ConnectionCardOps } from './useConnectionCardOps';
import { buildMcpServerToggleRestartContext } from '@shared/utils/mcpRestartContexts';
import styles from './SettingsSurface.module.css';

// MCP account management extension for Google and HubSpot.
type ExtensionType = 'google' | 'hubspot' | null;

interface GoogleAccount {
  email: string;
  status: 'active' | 'expired' | 'error';
}

interface HubSpotAccount {
  email: string;
  hubId: number;
  status: 'active' | 'expired' | 'error';
  scopeTier?: 'readonly' | 'full';
}

interface McpAccountsExtensionProps {
  serverName: string;
  onRefresh?: () => void;
  /** Parent is connecting (e.g., OAuth in progress). Disables disconnect buttons. */
  isParentConnecting?: boolean;
  /** Connection instances for per-account disable/enable (from useUnifiedConnections) */
  instances?: ConnectionInstance[];
  /**
   * Stage 3 (260611_calendar-cache-attention): selected-account state owned by
   * `ExpandedConnectionCard` (same state that scopes the tool list). When
   * wired, multi-account rows become selectable (adopting the selected-row
   * anatomy from `AccountInstancesList`) and the per-account sign-in-expired
   * recovery Notice renders for the selected account. The card auto-seeds the
   * selection to a needs-reconnect instance via `preferredInstanceServerName`.
   */
  selectedServerName?: string | null;
  onSelectInstance?: (serverName: string) => void;
  ops: ConnectionCardOps;
  /**
   * Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): register/clear a
   * `connect`-kind deferred op around the "Add another account" auth IPC. The
   * google-workspace:start-auth leg resolves promptly when its Super-MCP
   * restart is deferred ({ queued: true }), so the parent's queued state is
   * the honest signal that routing is still pending. Pre-bound by
   * ExpandedConnectionCard with the `google-workspace-connect` context —
   * Google-only: this component must NOT invoke it for HubSpot (whose connect
   * handler never awaits a reconfigure).
   */
  onTrackConnectDeferredOperation?: () => void;
  onClearConnectDeferredOperation?: () => void;
}

const detectExtensionType = (name: string): ExtensionType => {
  const lower = name.toLowerCase();
  // Handle both base name and multi-instance names (e.g., "GoogleWorkspace-user_example_com")
  if (lower === 'googleworkspace' || lower === 'google-workspace' || lower.startsWith('googleworkspace-')) return 'google';
  if (lower === 'hubspot' || lower.startsWith('hubspot-')) return 'hubspot';
  return null;
};

export const McpAccountsExtension = ({ serverName, onRefresh, isParentConnecting, instances, selectedServerName, onSelectInstance, ops, onTrackConnectDeferredOperation, onClearConnectDeferredOperation }: McpAccountsExtensionProps) => {
  const extensionType = detectExtensionType(serverName);

  const [googleAccounts, setGoogleAccounts] = useState<GoogleAccount[]>([]);
  const [hubspotAccounts, setHubspotAccounts] = useState<HubSpotAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [reconnectingEmail, setReconnectingEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupGuidanceDialog = useConnectorSetupGuidance();

  // HubSpot-specific: show add account flow with read-only option
  const [showHubspotAddFlow, setShowHubspotAddFlow] = useState(false);
  const [hubspotReadOnlyMode, setHubspotReadOnlyMode] = useState(false);

  // Helper to find matching instance by email (for per-account toggle)
  // Per review: normalize with lowercase + trim
  const findInstanceByEmail = useCallback((email: string): ConnectionInstance | undefined => {
    if (!instances || instances.length === 0) return undefined;
    const normalizedEmail = email.toLowerCase().trim();
    return instances.find(i => i.label.toLowerCase().trim() === normalizedEmail);
  }, [instances]);

  // Load data based on extension type
  useEffect(() => {
    if (!extensionType) return;
    
    const load = async () => {
      setLoading(true);
      try {
        if (extensionType === 'google') {
          const result = await window.googleWorkspaceApi.getAccounts();
          setGoogleAccounts(result.accounts);
        } else if (extensionType === 'hubspot') {
          const result = await window.hubspotApi.getAccounts();
          setHubspotAccounts(result.accounts);
        }
        setError(null);
      } catch (err) {
        console.error('Failed to load accounts:', err);
        setError("Couldn't load accounts");
      } finally {
        setLoading(false);
      }
    };
    
    void load();
  }, [extensionType]);

  const handleConnect = useCallback(async (options?: { scopeTier?: 'readonly' | 'full' }) => {
    if (!extensionType) return;
    
    setConnecting(true);
    setError(null);
    // Google-only (see prop jsdoc): track the deferred op BEFORE the start-auth
    // IPC so the google-workspace-connect deferral broadcast finds it.
    if (extensionType === 'google') {
      onTrackConnectDeferredOperation?.();
    }
    try {
      let result: MaybeSetupGuidanceResult & { success: boolean; error?: string };

      if (extensionType === 'google') {
        result = await window.googleWorkspaceApi.startAuth();
        if (result.success) {
          const accounts = await window.googleWorkspaceApi.getAccounts();
          setGoogleAccounts(accounts.accounts);
        }
      } else if (extensionType === 'hubspot') {
        // Pass scopeTier for read-only mode support
        result = await window.hubspotApi.startAuth({ scopeTier: options?.scopeTier });
        if (result.success) {
          const accounts = await window.hubspotApi.getAccounts();
          setHubspotAccounts(accounts.accounts);
        }
      } else {
        return;
      }

      if (!result.success) {
        // Broken-by-default (no OAuth client credentials): open the setup dialog instead of an
        // inline error string; otherwise fall back to the existing inline error.
        if (!setupGuidanceDialog.handleResult(result)) {
          setError(result.error ?? 'Connection failed');
        }
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to connect:', err);
      setError("Couldn't connect");
    } finally {
      setConnecting(false);
      if (extensionType === 'google') {
        onClearConnectDeferredOperation?.();
      }
    }
  }, [extensionType, onRefresh, setupGuidanceDialog, onTrackConnectDeferredOperation, onClearConnectDeferredOperation]);

  /**
   * Per-account reconnect (Google only) — Stage 3 [GPT-F2],
   * 260611_calendar-cache-attention. Re-runs OAuth scoped to the affected
   * email: `targetEmail` makes the auth service reject the callback when the
   * user signs into a different account, so this CTA cannot silently
   * reconnect the wrong one. Tracks the same connect-kind deferred op as
   * "Add another account" (the start-auth leg resolves promptly when the
   * Super-MCP restart is deferred).
   */
  const handleReconnect = useCallback(async (email: string) => {
    if (extensionType !== 'google') return;

    setReconnectingEmail(email);
    setError(null);
    onTrackConnectDeferredOperation?.();
    try {
      const result = await window.googleWorkspaceApi.startAuth({ targetEmail: email });
      if (result.success) {
        const accounts = await window.googleWorkspaceApi.getAccounts();
        setGoogleAccounts(accounts.accounts);
      } else if (!setupGuidanceDialog.handleResult(result)) {
        setError(result.error ?? "Couldn't reconnect");
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to reconnect:', err);
      setError("Couldn't reconnect");
    } finally {
      setReconnectingEmail(null);
      onClearConnectDeferredOperation?.();
    }
  }, [extensionType, onRefresh, setupGuidanceDialog, onTrackConnectDeferredOperation, onClearConnectDeferredOperation]);

  // Handler for HubSpot "Add another account" with read-only option
  const handleHubspotAddClick = useCallback(() => {
    setHubspotReadOnlyMode(false);
    setShowHubspotAddFlow(true);
    setError(null);
  }, []);

  const handleHubspotAddConfirm = useCallback(async () => {
    setShowHubspotAddFlow(false);
    await handleConnect({ scopeTier: hubspotReadOnlyMode ? 'readonly' : 'full' });
  }, [handleConnect, hubspotReadOnlyMode]);

  const handleHubspotAddCancel = useCallback(() => {
    setShowHubspotAddFlow(false);
    setHubspotReadOnlyMode(false);
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    if (!extensionType) return;
    
    setRemoving(id);
    try {
      let result: { success: boolean; error?: string };
      
      if (extensionType === 'google') {
        result = await window.googleWorkspaceApi.removeAccount({ email: id });
        if (result.success) {
          const accounts = await window.googleWorkspaceApi.getAccounts();
          setGoogleAccounts(accounts.accounts);
        }
      } else if (extensionType === 'hubspot') {
        result = await window.hubspotApi.removeAccount({ email: id });
        if (result.success) {
          const accounts = await window.hubspotApi.getAccounts();
          setHubspotAccounts(accounts.accounts);
        }
      } else {
        return;
      }
      
      if (!result.success) {
        setError(result.error ?? 'Failed to remove');
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to remove:', err);
      setError("Couldn't remove that.");
    } finally {
      setRemoving(null);
    }
  }, [extensionType, onRefresh]);

  // Handle toggle enable/disable for a specific account (Google only - HubSpot is connector-level)
  const handleToggle = useCallback(async (email: string) => {
    const instance = findInstanceByEmail(email);
    if (!instance) {
      console.warn('Cannot toggle: no matching instance for email', email);
      return;
    }
    
    setToggling(email);
    try {
      // Stage 4 matrix: tracked toggle. This is the only settingsApi restart-family
      // call in the extension; Google/HubSpot OAuth APIs are a different family.
      const result = await ops.toggleServerEnabled(
        instance.serverName,
        { kind: 'toggle', context: buildMcpServerToggleRestartContext(instance.serverName) },
      );
      if (!result.success) {
        setError(result.error ?? 'Failed to toggle');
      }
      onRefresh?.();
    } catch (err) {
      console.error('Failed to toggle:', err);
      setError("Couldn't toggle that.");
    } finally {
      setToggling(null);
    }
  }, [findInstanceByEmail, onRefresh, ops]);

  // Don't render if not a special MCP
  if (!extensionType) return null;

  // Build items with disabled state from instances (for Google, which has per-email instances)
  const items = extensionType === 'google'
    ? googleAccounts.map(a => {
        const instance = findInstanceByEmail(a.email);
        return {
          id: a.email,
          label: a.email,
          status: a.status,
          scopeTier: undefined as 'readonly' | 'full' | undefined,
          disabled: instance?.disabled ?? false,
          canToggle: !!instance, // Can only toggle if we have a matching instance
          serverName: instance?.serverName,
          needsReconnect: instance?.needsReconnect === true,
        };
      })
    : hubspotAccounts.map(a => ({
        id: a.email,
        label: a.email,
        status: a.status,
        scopeTier: a.scopeTier,
        disabled: false, // HubSpot doesn't support per-account disable
        canToggle: false,
        serverName: undefined as string | undefined,
        needsReconnect: false,
      }));

  const labels: Record<ExtensionType & string, { title: string; addButton: string }> = {
    google: { title: 'Connected Accounts', addButton: 'Add another account' },
    hubspot: { title: 'Connected Accounts', addButton: 'Add another account' },
  };
  
  const { title, addButton } = labels[extensionType];
  
  // Only show "Add another" button when there's at least one item already
  const showAddButton = items.length > 0 || connecting;

  // For single account, show compact inline view
  const singleItem = items.length === 1 ? items[0] : null;

  // Per-account sign-in-expired recovery (Stage 3, Google only).
  // Single account: the Notice renders right below the row. Multi-account:
  // it renders for the SELECTED account (rows are selectable; the card
  // auto-selects the affected instance on expand). Without selection wiring,
  // fall back to the first affected account so recovery is never unreachable.
  const reconnectCandidates = extensionType === 'google'
    ? items.filter((item) => item.needsReconnect && !item.disabled)
    : [];
  const reconnectNoticeItem = (() => {
    if (reconnectCandidates.length === 0) return null;
    if (singleItem) {
      return reconnectCandidates.includes(singleItem) ? singleItem : null;
    }
    if (onSelectInstance) {
      return reconnectCandidates.find((item) => item.serverName === selectedServerName) ?? null;
    }
    return reconnectCandidates[0];
  })();

  const reconnectActionsBusy = connecting || !!removing || !!toggling || !!isParentConnecting;

  const renderReconnectNotice = (item: NonNullable<typeof reconnectNoticeItem>) => (
    <Notice
      tone="warning"
      placement="section"
      title={`${item.label} sign-in expired`}
      actions={[{
        label: 'Reconnect',
        onClick: () => void handleReconnect(item.id),
        loading: reconnectingEmail === item.id,
        disabled: reconnectActionsBusy,
        'data-testid': 'mcp-account-reconnect-button',
      }]}
      data-testid="mcp-account-reconnect-notice"
    >
      Reconnect to get this account back in sync.
    </Notice>
  );

  // Row marker anatomy (Picker Decision): leading AlertTriangle in warning
  // tokens (replaces the status icon — the expired sign-in IS the status)
  // paired with a visible "Sign-in expired" text label after the email.
  // Tooltip is supplementary, never the sole signal.
  const renderReconnectIcon = () => (
    <Tooltip content="Sign-in expired. Reconnect this account to resume sync.">
      <AlertTriangle size={14} className={styles.mcpExtensionReconnectIcon} aria-hidden />
    </Tooltip>
  );

  const renderReconnectLabel = (email: string) => (
    <span
      className={styles.mcpExtensionReconnectLabel}
      data-testid={`mcp-account-reconnect-marker-${email}`}
    >
      Sign-in expired
    </span>
  );

  return (
    <div className={styles.mcpExtension}>
      {loading ? (
        <div className={styles.mcpExtensionLoading}>
          <Loader2 size={16} className={styles.spinnerIcon} />
          Loading...
        </div>
      ) : singleItem ? (
        /* Single account: compact inline view */
        <div className={`${styles.mcpExtensionSingle} ${singleItem.disabled ? styles.mcpExtensionItemDisabled : ''}`}>
          <div className={styles.mcpExtensionSingleRow}>
            <div className={`${styles.mcpExtensionSingleInfo} ${styles.mcpExtensionItemInfoFlexible}`}>
              {singleItem.disabled ? (
                <Tooltip content="This account is disabled - tools are paused">
                  <Pause size={14} className={styles.chipMuted} />
                </Tooltip>
              ) : singleItem.needsReconnect ? (
                renderReconnectIcon()
              ) : singleItem.status === 'active' ? (
                <Check size={14} className={styles.chipCheck} />
              ) : singleItem.status === 'expired' ? (
                <Tooltip content="Token expired - will refresh on next use">
                  <AlertCircle size={14} className={styles.chipWarning} />
                </Tooltip>
              ) : (
                <Tooltip content="Connection error - may need to reconnect">
                  <AlertCircle size={14} className={styles.chipMuted} />
                </Tooltip>
              )}
              <span className={`${styles.mcpExtensionSingleLabel} ${styles.mcpExtensionItemLabelTruncated}`}>
                Connected as <strong>{singleItem.label}</strong>
                {singleItem.disabled && (
                  <span className={styles.mcpExtensionItemDisabledBadge}>Disabled</span>
                )}
                {singleItem.scopeTier === 'readonly' && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-muted-foreground)' }}>(read-only)</span>
                )}
              </span>
              {!singleItem.disabled && singleItem.needsReconnect && renderReconnectLabel(singleItem.id)}
            </div>
            <div className={styles.mcpExtensionItemActions}>
              {singleItem.canToggle && (
                <Tooltip content={singleItem.disabled ? 'Enable this account' : 'Disable this account (tools will be paused)'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggle(singleItem.id)}
                    disabled={toggling === singleItem.id || !!removing || !!isParentConnecting || !!connecting}
                    className={styles.mcpExtensionItemToggle}
                    data-testid={`mcp-account-toggle-${singleItem.id}`}
                  >
                    {toggling === singleItem.id ? (
                      <Loader2 size={14} className={styles.spinnerIcon} />
                    ) : singleItem.disabled ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}
                  </Button>
                </Tooltip>
              )}
              <AccountDisconnectButton
                label={singleItem.label}
                isRemoving={removing === singleItem.id}
                disabled={isParentConnecting || connecting || toggling === singleItem.id}
                onClick={() => handleRemove(singleItem.id)}
              />
            </div>
          </div>
          {/* Single-account recovery: Notice immediately below the row (Picker Decision) */}
          {reconnectNoticeItem && reconnectNoticeItem === singleItem && renderReconnectNotice(reconnectNoticeItem)}
          {/* HubSpot: show add flow with read-only option */}
          {extensionType === 'hubspot' && showHubspotAddFlow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={hubspotReadOnlyMode}
                  onChange={(e) => setHubspotReadOnlyMode(e.target.checked)}
                  disabled={connecting}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <span style={{ fontWeight: 500 }}>Read-only mode</span>
                  <span style={{ color: 'var(--color-muted-foreground)', marginLeft: 4 }}>(for free HubSpot accounts)</span>
                </span>
              </label>
              <p style={{ fontSize: 11, color: 'var(--color-muted-foreground)', margin: '0 0 0 24px' }}>
                Connect without write permissions. You can view contacts, companies, and deals, but not create or modify them.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleHubspotAddCancel}
                  disabled={connecting}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleHubspotAddConfirm}
                  disabled={connecting}
                >
                  {connecting ? (
                    <>
                      <Loader2 size={14} className={styles.spinnerIcon} />
                      Connecting...
                    </>
                  ) : (
                    'Connect'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={extensionType === 'hubspot' ? handleHubspotAddClick : () => handleConnect()}
              disabled={connecting || loading}
            >
              {connecting ? (
                <>
                  <Loader2 size={14} className={styles.spinnerIcon} />
                  Connecting...
                </>
              ) : (
                <>
                  <Plus size={14} />
                  {addButton}
                </>
              )}
            </Button>
          )}
        </div>
      ) : items.length === 0 ? (
        <p className={styles.mcpExtensionEmpty}>No accounts connected yet</p>
      ) : (
        /* Multiple accounts: full list view */
        <>
          <div className={styles.mcpExtensionHeader}>
            <span className={styles.mcpExtensionTitle}>{title}</span>
            {showAddButton && !showHubspotAddFlow && (
              <Button
                variant="ghost"
                size="sm"
                onClick={extensionType === 'hubspot' ? handleHubspotAddClick : () => handleConnect()}
                disabled={connecting || loading}
              >
                {connecting ? (
                  <>
                    <Loader2 size={14} className={styles.spinnerIcon} />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Plus size={14} />
                    {addButton}
                  </>
                )}
              </Button>
            )}
          </div>
          {/* HubSpot: show add flow with read-only option */}
          {extensionType === 'hubspot' && showHubspotAddFlow && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: 12, background: 'var(--color-subtle)', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={hubspotReadOnlyMode}
                  onChange={(e) => setHubspotReadOnlyMode(e.target.checked)}
                  disabled={connecting}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <span style={{ fontWeight: 500 }}>Read-only mode</span>
                  <span style={{ color: 'var(--color-muted-foreground)', marginLeft: 4 }}>(for free HubSpot accounts)</span>
                </span>
              </label>
              <p style={{ fontSize: 11, color: 'var(--color-muted-foreground)', margin: '0 0 0 24px' }}>
                Connect without write permissions. You can view contacts, companies, and deals, but not create or modify them.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleHubspotAddCancel}
                  disabled={connecting}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleHubspotAddConfirm}
                  disabled={connecting}
                >
                  {connecting ? (
                    <>
                      <Loader2 size={14} className={styles.spinnerIcon} />
                      Connecting...
                    </>
                  ) : (
                    'Connect'
                  )}
                </Button>
              </div>
            </div>
          )}
          <div className={styles.mcpExtensionList}>
            {items.map(item => {
              const isTogglingThis = toggling === item.id;
              // Stage 3: rows adopt the selected-row behavior from
              // AccountInstancesList when the card wires selection — the
              // selected account drives the recovery Notice below the list.
              const canSelect = !!onSelectInstance && !!item.serverName;
              const isSelected = canSelect && item.serverName === selectedServerName;
              const handleSelect = canSelect
                ? () => onSelectInstance(item.serverName as string)
                : undefined;
              // A11y (Phase 6, DSR F1): role="button" rows must be fully
              // keyboard-operable (Enter AND Space, Space prevented from
              // scrolling) and must announce their state — aria-pressed for
              // the selected row driving the recovery Notice, aria-label
              // mirroring the visible row state ("Sign-in expired" /
              // "Disabled") so the state survives name computation.
              const rowStateSuffix = item.disabled
                ? ' — Disabled'
                : item.needsReconnect
                  ? ' — Sign-in expired'
                  : '';
              return (
                <div
                  key={item.id}
                  className={`${styles.mcpExtensionItem} ${isSelected ? styles.mcpExtensionItemSelected : ''} ${item.disabled ? styles.mcpExtensionItemDisabled : ''}`}
                  onClick={handleSelect}
                  role={canSelect ? 'button' : undefined}
                  tabIndex={canSelect ? 0 : undefined}
                  aria-pressed={canSelect ? isSelected : undefined}
                  aria-label={canSelect ? `${item.label}${rowStateSuffix}` : undefined}
                  onKeyDown={handleSelect
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelect();
                        }
                      }
                    : undefined}
                  style={canSelect ? { cursor: 'pointer' } : undefined}
                  data-testid={`mcp-account-row-${item.id}`}
                >
                  <div className={`${styles.mcpExtensionItemInfo} ${styles.mcpExtensionItemInfoFlexible}`}>
                    {item.disabled ? (
                      <Tooltip content="This account is disabled - tools are paused">
                        <Pause size={14} className={styles.chipMuted} />
                      </Tooltip>
                    ) : item.needsReconnect ? (
                      renderReconnectIcon()
                    ) : item.status === 'active' ? (
                      <Tooltip content="Connected and ready">
                        <Check size={14} className={styles.chipCheck} />
                      </Tooltip>
                    ) : item.status === 'expired' ? (
                      <Tooltip content="Token expired - will refresh on next use">
                        <AlertCircle size={14} className={styles.chipWarning} />
                      </Tooltip>
                    ) : (
                      <Tooltip content="Connection error - may need to reconnect">
                        <AlertCircle size={14} className={styles.chipMuted} />
                      </Tooltip>
                    )}
                    <span className={`${styles.mcpExtensionItemLabel} ${styles.mcpExtensionItemLabelTruncated}`}>{item.label}</span>
                    {!item.disabled && item.needsReconnect && renderReconnectLabel(item.id)}
                    {item.disabled && <span className={styles.mcpExtensionItemDisabledBadge}>Disabled</span>}
                    {item.scopeTier === 'readonly' && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--color-muted-foreground)' }}>(read-only)</span>
                    )}
                  </div>
                  {/* Don't let action clicks/keys double as row selection */}
                  <div
                    className={styles.mcpExtensionItemActions}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {item.canToggle && (
                      <Tooltip content={item.disabled ? 'Enable this account' : 'Disable this account (tools will be paused)'}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggle(item.id)}
                          disabled={isTogglingThis || !!removing || !!isParentConnecting || !!connecting}
                          className={styles.mcpExtensionItemToggle}
                          data-testid={`mcp-account-toggle-${item.id}`}
                        >
                          {isTogglingThis ? (
                            <Loader2 size={14} className={styles.spinnerIcon} />
                          ) : item.disabled ? (
                            <Play size={14} />
                          ) : (
                            <Pause size={14} />
                          )}
                        </Button>
                      </Tooltip>
                    )}
                    <AccountDisconnectButton
                      label={item.label}
                      isRemoving={removing === item.id}
                      disabled={isParentConnecting || connecting || isTogglingThis}
                      onClick={() => handleRemove(item.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {/* Multi-account recovery: Notice for the selected (auto-selected
              on expand) sign-in-expired account */}
          {reconnectNoticeItem && renderReconnectNotice(reconnectNoticeItem)}
        </>
      )}

      {error && (
        <p className={styles.mcpExtensionError}>
          <AlertCircle size={12} />
          {error}
        </p>
      )}

      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </div>
  );
};
