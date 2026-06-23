import { useCallback, useState, useMemo, useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Check,
  AlertTriangle,
  AlertCircle,
  ExternalLink,
  Unplug,
  Plug,
  Bot,
  ChevronRight,
  Loader2,
  Clock,
  FileCode2,
  HelpCircle,
  Copy,
  KeyRound,
  UserPlus,
  Pause,
  Play,
  Github,
} from 'lucide-react';
import { Button, Badge, InlineToggle, Notice, Tooltip, useToast } from '@renderer/components/ui';
import { CalendarSelectionSection } from './CalendarSelectionSection';
import { McpAccountsExtension } from './McpAccountsExtension';
import { McpToolList } from './McpToolList';
import { AccountDisconnectButton } from './AccountDisconnectButton';
import { ConnectorContributionSection } from './ConnectorContributionSection';
import { OfficeSidecarStatusSection } from './OfficeSidecarStatusSection';
import { SetupFieldsForm } from './SetupFieldsForm';
import type { ConnectionCardOps } from './useConnectionCardOps';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { useConnectorContribution } from '../hooks/useConnectorContribution';
import { serializeServerConfig, validateServerConfig, parseConfigToPayload, type PreserveMetadata } from '../utils/mcpConfigUtils';
import { deriveConnectorAuthHint } from '../utils/deriveConnectorAuthHint';
import { useSettingsSafe } from '../SettingsProvider';
import type { UnifiedConnection } from '../hooks/useUnifiedConnections';
import type { McpServerConfigDetails, ConnectorCatalogEntry } from '@shared/types';
import { isBundledLikeProvider } from '@shared/types';
import { getIdentityFieldDisplay, type IdentityKind } from '@shared/identityKinds';
import type { ProviderKeyId } from '@shared/types/settings';
import { generateInstanceId, generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import {
  buildMcpServerRemovalRestartContext,
  buildMcpServerToggleRestartContext,
  buildSettingsUpsertRestartContext,
  MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT,
} from '@shared/utils/mcpRestartContexts';
import { buildHeadersFromSetupFields, buildEnvFromSetupFields } from '@shared/utils/setupFieldUtils';
import { platformSupportLabel } from '@shared/utils/connectorPlatformSupport';
import { fireAndForget } from '@shared/utils/fireAndForget';
import styles from './SettingsSurface.module.css';

const MESSAGING_SETTINGS_URL = 'rebel://settings/?tab=cloud&section=messagingChannels';

interface ExpandedConnectionCardProps {
  connection: UnifiedConnection;
  onClose: () => void;
  onConnect?: (email?: string, options?: { launchRebel?: boolean; scopeTier?: 'readonly' | 'full'; setupFieldValues?: Record<string, string> }) => void;
  onDisconnect?: (serverName?: string) => void;
  onConfigureWithRebel?: (options?: { isNewConnection?: boolean; setupResult?: { success: boolean; error?: string }; serverNameOverride?: string }) => void;
  onExtendConnector?: () => void;
  /**
   * Receives the contribution's canonical `connectorName`, sourced from the
   * contribution record by `ConnectorContributionSection`. Pass-through prop —
   * `UnifiedConnectionsPanel` no longer reconstructs the name from connection
   * data (see C8 of `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`).
   */
  onShareWithCommunity?: (connectorName: string) => void;
  /** Open the originating contribution conversation. Receives the session id derived from the contribution record. */
  onOpenContributionChat?: (sessionId: string) => void;
  onGetPythonHelp?: () => void;
  onLoadServer?: (serverName: string) => Promise<McpServerConfigDetails>;
  ops: ConnectionCardOps;
  onRefresh?: () => void;
  isLoading?: boolean;
  isConnecting?: boolean;
  isRemoving?: boolean;
  deferredKind?: 'connect' | 'disconnect' | 'toggle';
  onCancelConnect?: () => void;
  layoutId?: string;
}

/**
 * Prefer the first needs-reconnect instance, then the first failing instance,
 * when expanding grouped connectors (settings scan model; no instance-level
 * deep link). The needs-reconnect preference makes the "View Connector"
 * deep-link land directly on the account whose sign-in expired (Stage 3,
 * 260611_calendar-cache-attention).
 */
function preferredInstanceServerName(connection: UnifiedConnection): string | null {
  const instances = connection.instances;
  if (!instances?.length) {
    return connection.serverPreview?.name ?? null;
  }
  const needsReconnect = instances.find((i) => i.needsReconnect && !i.disabled);
  const failing = instances.find(
    (i) => i.health === 'error' || i.health === 'unavailable' || i.missingIdentity,
  );
  return (needsReconnect ?? failing ?? instances[0])?.serverName ?? null;
}

const STATUS_CONFIG = {
  connected: {
    icon: Check,
    label: 'Connected',
    color: 'var(--color-info)',
    iconBoxClassName: styles.expandedConnectionStatusIconBoxConnected,
  },
  'needs-setup': {
    icon: AlertTriangle,
    label: 'Needs attention',
    color: 'var(--color-warning, #f59e0b)',
    iconBoxClassName: styles.expandedConnectionStatusIconBoxWarning,
  },
  error: {
    icon: AlertCircle,
    label: 'Error',
    color: 'var(--color-error, #ef4444)',
    iconBoxClassName: styles.expandedConnectionStatusIconBoxError,
  },
  available: {
    icon: null,
    label: 'Available',
    color: 'var(--color-muted, #6b7280)',
    iconBoxClassName: '',
  },
};

type SetupField = NonNullable<ConnectorCatalogEntry['setupFields']>[number];
type PostSaveValidationNotice =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string }
  | { status: 'unavailable'; message: string };

function getUpdateCredentialsPresentation(setupFields: ConnectorCatalogEntry['setupFields'] | undefined): {
  label: string;
  tooltip: string;
  authFailureTitleSuffix: string;
} {
  const credentialFields = (setupFields ?? []).filter((field) => field.id !== 'email');
  const isSingleSecret = credentialFields.length === 1 && credentialFields[0]?.type === 'password';
  return isSingleSecret
    ? {
        label: 'Update key',
        tooltip: 'Replace the saved API key without disconnecting.',
        authFailureTitleSuffix: 'needs a new key',
      }
    : {
        label: 'Update details',
        tooltip: 'Replace the saved details without disconnecting.',
        authFailureTitleSuffix: 'needs new details',
      };
}

function valueFromExistingServerDetails(field: SetupField, details: McpServerConfigDetails): string {
  if (field.type === 'password') {
    return '';
  }

  if (field.envVar) {
    return details.env?.[field.envVar] ?? field.default ?? '';
  }

  if (field.headerKey) {
    const headerValue = details.headers?.[field.headerKey];
    if (!headerValue) {
      return field.default ?? '';
    }
    const prefix = field.headerPrefix ?? '';
    return prefix && headerValue.startsWith(prefix)
      ? headerValue.slice(prefix.length)
      : headerValue;
  }

  if (field.id === 'url' && details.url) {
    return details.url;
  }

  return field.default ?? '';
}

// Shared component for multi-account instance list with account selection
// Used by both direct connectors and bundled API-key connectors
interface AccountInstancesListProps {
  instances: { serverName: string; label: string; health?: 'ok' | 'error' | 'unavailable'; disabled?: boolean; needsReconnect?: boolean }[];
  selectedServerName: string | null;
  onSelect: (serverName: string) => void;
  onRemove?: (serverName: string) => Promise<void>;
  onToggleEnabled?: (serverName: string) => Promise<void>;
  onAddAnother: () => void;
  isRemoving?: boolean;
  isConnecting?: boolean;
  accountIdentity?: Extract<IdentityKind, 'email' | 'workspace'>;
}

function AccountInstancesList({ instances, selectedServerName, onSelect, onRemove, onToggleEnabled, onAddAnother, isRemoving, isConnecting, accountIdentity }: AccountInstancesListProps) {
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const handleRemove = async (e: React.MouseEvent, serverName: string) => {
    e.stopPropagation(); // Don't trigger selection when clicking remove
    if (!onRemove) return;
    setRemovingId(serverName);
    try {
      await onRemove(serverName);
    } finally {
      setRemovingId(null);
    }
  };

  const handleToggleEnabled = async (e: React.MouseEvent, serverName: string) => {
    e.stopPropagation(); // Don't trigger selection when clicking toggle
    if (!onToggleEnabled) return;
    setTogglingId(serverName);
    try {
      await onToggleEnabled(serverName);
    } finally {
      setTogglingId(null);
    }
  };

  // Labels based on account identity type
  const isWorkspace = accountIdentity === 'workspace';
  const listTitle = isWorkspace ? 'Connected Workspaces' : 'Connected Accounts';
  const addButtonLabel = isWorkspace ? 'Add workspace' : 'Add account';

  // Always show list view for selectable accounts
  return (
    <div className={styles.mcpExtension}>
      <div className={styles.mcpExtensionHeader}>
        <span className={styles.mcpExtensionTitle}>{listTitle}</span>
        <Tooltip content="Add a separate connection with different credentials">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddAnother}
            disabled={isRemoving}
            className={styles.mcpExtensionAddButton}
          >
            <UserPlus size={14} />
            {addButtonLabel}
          </Button>
        </Tooltip>
      </div>
      <div className={styles.mcpExtensionList}>
        {instances.map(instance => {
          const isSelected = instance.serverName === selectedServerName;
          const isDisabled = instance.disabled === true;
          const isTogglingThis = togglingId === instance.serverName;
          return (
            <div 
              key={instance.serverName} 
              className={`${styles.mcpExtensionItem} ${isSelected ? styles.mcpExtensionItemSelected : ''} ${isDisabled ? styles.mcpExtensionItemDisabled : ''}`}
              onClick={() => onSelect(instance.serverName)}
              role="button"
              tabIndex={0}
              // A11y (Phase 7, S1): Space parity with the McpAccountsExtension
              // rows — role="button" must activate on Enter AND Space, with
              // Space prevented from scrolling the panel.
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(instance.serverName);
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <div className={`${styles.mcpExtensionItemInfo} ${styles.mcpExtensionItemInfoFlexible}`}>
                {isDisabled ? (
                  <Tooltip content="This account is disabled - tools are paused">
                    <Pause size={14} className={styles.chipMuted} />
                  </Tooltip>
                ) : instance.needsReconnect ? (
                  // Passive sign-in-expired marker only — the Reconnect action
                  // lives on the Google-specific McpAccountsExtension surface
                  // (Stage 3 Picker Decision: no generic reconnect action here).
                  <Tooltip content="Sign-in expired. Reconnect this account to resume sync.">
                    <AlertTriangle size={14} className={styles.mcpExtensionReconnectIcon} aria-hidden />
                  </Tooltip>
                ) : instance.health === 'ok' ? (
                  <Tooltip content="Connected and ready">
                    <Check size={14} className={styles.chipCheck} />
                  </Tooltip>
                ) : instance.health === 'error' ? (
                  <Tooltip content="Connection error - may need to reconnect">
                    <AlertCircle size={14} className={styles.chipWarning} />
                  </Tooltip>
                ) : (
                  <Tooltip content="Status unavailable">
                    <AlertCircle size={14} className={styles.chipMuted} />
                  </Tooltip>
                )}
                <span className={`${styles.mcpExtensionItemLabel} ${styles.mcpExtensionItemLabelTruncated}`}>{instance.label}</span>
                {!isDisabled && instance.needsReconnect && (
                  <span className={styles.mcpExtensionReconnectLabel}>Sign-in expired</span>
                )}
                {isDisabled && <span className={styles.mcpExtensionItemDisabledBadge}>Disabled</span>}
              </div>
              <div className={styles.mcpExtensionItemActions}>
                {onToggleEnabled && (
                  <Tooltip content={isDisabled ? 'Enable this account' : 'Disable this account (tools will be paused)'}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => handleToggleEnabled(e, instance.serverName)}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={isTogglingThis || !!removingId || !!isRemoving || !!isConnecting}
                      className={styles.mcpExtensionItemToggle}
                      data-testid={`instance-toggle-${instance.serverName}`}
                    >
                      {isTogglingThis ? (
                        <Loader2 size={14} className={styles.spinnerIcon} />
                      ) : isDisabled ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                    </Button>
                  </Tooltip>
                )}
                {onRemove && (
                  <AccountDisconnectButton
                    label={instance.label}
                    isRemoving={removingId === instance.serverName || !!isRemoving}
                    disabled={isTogglingThis}
                    onClick={(e) => handleRemove(e, instance.serverName)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {instances.length > 1 && (
        <div className={styles.mcpExtensionHint}>
          Click an account to view its tools and settings
        </div>
      )}
    </div>
  );
}

/**
 * Get the appropriate badge for a connection based on its source and maturity.
 * Returns null for stable bundled MCPs (trusted default, no badge needed).
 */
function getExpandedBadge(
  connection: UnifiedConnection,
  catalogEntry: ConnectorCatalogEntry | undefined
): { label: string; className: string } | null {
  // Custom MCP (no catalog entry) - user added this
  if (!catalogEntry) {
    return { label: 'Custom', className: styles.expandedConnectionBadgeCustom };
  }

  // Bundled / rebel-oss connectors
  if (isBundledLikeProvider(connection.provider)) {
    // Beta - new/experimental feature
    if (catalogEntry.maturity !== 'stable') {
      return { label: 'Beta', className: styles.expandedConnectionBadgeBeta };
    }
    // Stable bundled - no badge (trusted default)
    return null;
  }

  // Direct OAuth - vendor-hosted endpoint
  if (connection.provider === 'direct') {
    return { label: 'Official', className: styles.expandedConnectionBadgeOfficial };
  }

  // Community - third-party npx packages
  if (connection.provider === 'community') {
    return { label: 'Community', className: styles.expandedConnectionBadgeCommunity };
  }

  return null;
}

// Badge explanations by badge text
const badgeExplanations: Record<string, string> = {
  'Official': 'Hosted by the service provider',
  'Community': 'Community-maintained',
  'Beta': 'Experimental - may have rough edges',
  'Custom': 'Manually configured',
};

const GENERIC_CUSTOM_CONNECTION_DESCRIPTION = 'Custom MCP server';

const CALENDAR_CONNECTOR_PROVIDER_BY_ID = {
  'bundled-google': 'google',
  'bundled-microsoft-calendar': 'microsoft',
} as const;

interface CalendarSelectionAccount {
  calendarSource: string;
  disabled?: boolean;
}

function buildCalendarSelectionAccounts(connection: UnifiedConnection): CalendarSelectionAccount[] {
  const catalogId = connection.catalogEntry?.id as keyof typeof CALENDAR_CONNECTOR_PROVIDER_BY_ID | undefined;
  const provider = catalogId ? CALENDAR_CONNECTOR_PROVIDER_BY_ID[catalogId] : null;
  if (!provider) {
    return [];
  }

  if (connection.instances?.length) {
    return connection.instances.flatMap((instance) => {
      const email = instance.label.trim();
      if (!email || !email.includes('@')) {
        return [];
      }

      return [{
        calendarSource: `${provider}:${email}`,
        disabled: instance.disabled === true,
      }];
    });
  }

  const email = connection.serverPreview?.email?.trim();
  if (!email) {
    return [];
  }

  return [{
    calendarSource: `${provider}:${email}`,
    disabled: connection.serverPreview?.disabled === true,
  }];
}

export function ExpandedConnectionCard({
  connection,
  onClose,
  onConnect,
  onDisconnect,
  onConfigureWithRebel,
  onExtendConnector,
  onShareWithCommunity,
  onOpenContributionChat,
  onGetPythonHelp,
  onLoadServer,
  ops,
  onRefresh,
  isLoading,
  isConnecting,
  isRemoving,
  deferredKind,
  onCancelConnect,
  layoutId,
}: ExpandedConnectionCardProps) {
  const settingsCtx = useSettingsSafe();
  const { showToast } = useToast();
  const navigation = useNavigationSafe();
  const settings = settingsCtx?.draftSettings ?? settingsCtx?.settings ?? null;
  const statusConfig = STATUS_CONFIG[connection.status];
  const StatusIcon = statusConfig.icon;
  const isConnected = connection.status !== 'available';
  const handleOpenMessagingSettings = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigation) return;
    event.preventDefault();
    fireAndForget(
      navigation.navigate(MESSAGING_SETTINGS_URL),
      'navigateToMessagingSettingsFromSlackConnector',
    );
  }, [navigation]);

  // Check if this connector requires manual setup (setupFields or no auto-configurable mcpConfig)
  const catalogEntry = connection.catalogEntry;
  
  // Get unified badge (Custom, Beta, Official, Community, or null for stable bundled)
  const badge = getExpandedBadge(connection, catalogEntry);
  const isManualSetup = catalogEntry?.requiresSetup && (catalogEntry?.setupFields || !catalogEntry?.mcpConfig);
  const isCalendarConnector = catalogEntry?.id === 'bundled-google' || catalogEntry?.id === 'bundled-microsoft-calendar';
  const calendarSelectionAccounts = useMemo(() => {
    if (!isConnected || !isCalendarConnector || settings?.calendar?.useOtherCalendarProvider) {
      return [];
    }

    return buildCalendarSelectionAccounts(connection);
  }, [connection, isCalendarConnector, isConnected, settings?.calendar?.useOtherCalendarProvider]);
  
  // Check if this is a bundled connector that requires API key input
  const isBundledApiKey = isBundledLikeProvider(connection.provider) && 
    catalogEntry?.bundledConfig?.authType === 'api-key' &&
    catalogEntry?.setupFields;

  // Check if this is a bundled connector that requires user-provided OAuth credentials
  // (e.g., Salesforce - user must create their own Connected App and provide client ID/secret)
  const isBundledOAuthUserProvided = isBundledLikeProvider(connection.provider) &&
    catalogEntry?.bundledConfig?.authType === 'oauth-user-provided' &&
    catalogEntry?.setupFields;

  // Check if this is a bundled OAuth connector with setupFields that need to be collected BEFORE OAuth
  // (e.g., tenant subdomain fields required to construct provider-specific OAuth URLs)
  // These connectors have authType: 'oauth' with setupFields, but don't have user-provided credentials
  const _isBundledOAuthWithSetupFields = isBundledLikeProvider(connection.provider) &&
    catalogEntry?.bundledConfig?.authType === 'oauth' &&
    catalogEntry?.setupFields &&
    catalogEntry?.setupFields.length > 0;

  // Check if this is a bundled connector with no auth but needs email identity
  // These connectors don't require API keys or OAuth, but we want to collect email for account tracking
  const isBundledNoAuthWithEmail = isBundledLikeProvider(connection.provider) &&
    catalogEntry?.bundledConfig?.authType === 'none' &&
    catalogEntry?.accountIdentity === 'email';

  // Check if this is a bundled no-auth connector with custom setup fields (e.g., IBKR)
  // These need setup fields collected and passed as credentials to configure the MCP server
  const _isBundledNoAuthWithSetupFields = isBundledLikeProvider(connection.provider) &&
    catalogEntry?.bundledConfig?.authType === 'none' &&
    catalogEntry?.accountIdentity !== 'email' &&
    catalogEntry?.setupFields &&
    catalogEntry?.setupFields.length > 0;

  // Connected connector is missing account email (legacy "Account not set" state)
  const needsAccountEmail = isConnected &&
    catalogEntry?.accountIdentity === 'email' &&
    !connection.serverPreview?.email;

  // Check if this connector needs identity input (email or workspace) before connecting
  // Applies to: direct MCPs with email/workspace identity AND bundled OAuth with email identity
  // EXCEPT: manual setup connectors have their own email field in the setup UI
  const needsIdentityInput = !isConnected &&
    (catalogEntry?.accountIdentity === 'email' || catalogEntry?.accountIdentity === 'workspace') &&
    (connection.provider === 'direct' || 
     (isBundledLikeProvider(connection.provider) && catalogEntry?.bundledConfig?.authType === 'oauth')) &&
    !isManualSetup;
  
  // Label for the identity input field
  const identityFieldDisplay = getIdentityFieldDisplay(catalogEntry?.accountIdentity);
  const identityInputLabel = identityFieldDisplay.label;

  // Check if this is an internal MCP (RebelInbox, RebelSearch, etc.)
  // These are auto-configured and cannot be disconnected by users
  const isInternal = catalogEntry?.isInternal === true;

  // Check if this connector requires Python runtime
  const requiresPython = catalogEntry?.runtime === 'python';

  // Platform-support badge (e.g. "macOS only" for Apple Shortcuts).
  // Always shown when the catalog entry has `platforms` set, including when the
  // current host is the supported platform — surfaces context for cross-device
  // roaming / cloud later.
  const platformBadgeLabel = platformSupportLabel(catalogEntry?.platforms);

  // Python runtime status (checked when card is expanded for Python MCPs)
  const [pythonStatus, setPythonStatus] = useState<{
    checking: boolean;
    uvxAvailable: boolean | null;
    error: string | null;
  }>({ checking: false, uvxAvailable: null, error: null });

  // Check Python runtime when card is expanded for a Python MCP
  useEffect(() => {
    if (!requiresPython) {
      // Reset status for non-Python connectors
      setPythonStatus({ checking: false, uvxAvailable: null, error: null });
      return;
    }

    // Check Python runtime status (force refresh from Settings UI to bypass negative cache)
    setPythonStatus({ checking: true, uvxAvailable: null, error: null });
    window.miscApi.checkPythonRuntime({ forceRefresh: true })
      .then((status) => {
        setPythonStatus({
          checking: false,
          uvxAvailable: status.uvxAvailable,
          error: null,
        });
      })
      .catch((err) => {
        console.error('Failed to check Python runtime:', err);
        setPythonStatus({
          checking: false,
          uvxAvailable: null,
          error: 'Unable to check Python status',
        });
      });
  }, [requiresPython]);

  // Setup mode state for requiresSetup connectors
  const [setupMode, setSetupMode] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateIdentityEmail, setUpdateIdentityEmail] = useState<string | null>(null);
  // Ref to the expanded card body (scroll container). Used to flash the scrollbar on
  // expand so users can tell the body is scrollable.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Field values: keyed by field.id for setupFields, or single 'url' for backward compat
  // Initialize with defaults from setupFields so select fields with defaults are pre-populated
  const [setupFieldValues, setSetupFieldValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (catalogEntry?.setupFields) {
      for (const field of catalogEntry.setupFields) {
        if (field.default) initial[field.id] = field.default;
      }
    }
    return initial;
  });
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupSaving, setSetupSaving] = useState(false);
  const [postSaveValidationNotice, setPostSaveValidationNotice] = useState<PostSaveValidationNotice | null>(null);
  
  // Email for direct MCPs with email-based identity (entered before OAuth)
  const [directEmail, setDirectEmail] = useState('');
  
  // Read-only mode for HubSpot OAuth (free accounts)
  const [hubspotReadOnlyMode, setHubspotReadOnlyMode] = useState(false);
  
  // "Add another account" flow for direct multi-instance connectors
  const [showAddAnotherFlow, setShowAddAnotherFlow] = useState(false);

  // Account email setter for connected connectors missing account email ("Account not set")
  const [accountEmailInput, setAccountEmailInput] = useState('');
  const [isSettingAccountEmail, setIsSettingAccountEmail] = useState(false);
  const [accountEmailError, setAccountEmailError] = useState<string | null>(null);

  // Disable/enable toggle state
  const [isToggling, setIsToggling] = useState(false);
  
  // Selected instance for multi-instance direct connectors (controls which account's tools/settings are shown)
  const [selectedInstanceServerName, setSelectedInstanceServerName] = useState<string | null>(() =>
    preferredInstanceServerName(connection),
  );
  // Phase 7 refinement [GPT-F1] (260611_calendar-cache-attention): whether the
  // CURRENT selection came from a deliberate user row click (vs. the automatic
  // mount seed / selection repair). Only an automatic selection may be
  // re-pointed when a needs-reconnect latch arrives in a later summary refresh
  // (Settings opens off the startup-cached summary, then refreshMcpSummary()
  // overlays the latch) — a deliberate selection is never overridden.
  const userSelectedInstanceRef = useRef(false);
  const selectInstanceDeliberately = useCallback((serverName: string | null) => {
    userSelectedInstanceRef.current = true;
    setSelectedInstanceServerName(serverName);
  }, []);

  // Resync if the selected instance no longer exists (e.g., after removal); prefer a failing instance when re-picking
  useEffect(() => {
    if (!connection.instances || connection.instances.length === 0) {
      if (selectedInstanceServerName !== connection.serverPreview?.name) {
        userSelectedInstanceRef.current = false;
        setSelectedInstanceServerName(connection.serverPreview?.name ?? null);
      }
      return;
    }
    const stillExists = connection.instances.some((i) => i.serverName === selectedInstanceServerName);
    if (!stillExists) {
      userSelectedInstanceRef.current = false;
      setSelectedInstanceServerName(preferredInstanceServerName(connection));
      return;
    }
    // Phase 7 refinement [GPT-F1]: a newly latched, non-disabled
    // needs-reconnect instance takes selection when the current selection was
    // only automatic, so the deep-link recovery Notice surfaces even when the
    // latch lands AFTER the card expanded (stale-summary → refresh race).
    if (userSelectedInstanceRef.current) return;
    const latched = connection.instances.find((i) => i.needsReconnect && !i.disabled);
    if (!latched || latched.serverName === selectedInstanceServerName) return;
    const current = connection.instances.find((i) => i.serverName === selectedInstanceServerName);
    if (current?.needsReconnect && !current.disabled) return; // already on a latched instance
    setSelectedInstanceServerName(latched.serverName);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting the full `connection` object and `preferredInstanceServerName`; only the instance list, the preview-server name, and the current selection are inputs to selection repair — re-running on broader connection churn would cause unnecessary state thrash on every refetch
  }, [connection.instances, connection.serverPreview?.name, selectedInstanceServerName]);
  
  // The server name to use for tools/settings - either selected instance or serverPreview
  const activeServerName = connection.instances && connection.instances.length > 0
    ? selectedInstanceServerName
    : connection.serverPreview?.name;

  // Boolean setupFields that should remain editable after the connector is
  // connected (e.g. Browser Automation's "Show the browser window"). We only
  // surface boolean fields with an `envVar`, since the persisted state lives
  // in the server entry's `env` block — that's the single source of truth.
  const editableConnectedBooleanFields = useMemo<SetupField[]>(
    () =>
      catalogEntry?.setupFields?.filter(
        (field) => field.type === 'boolean' && Boolean(field.envVar),
      ) ?? [],
    [catalogEntry?.setupFields],
  );

  // Live values for the post-connect toggles, hydrated from the saved env on
  // mount so what the user sees is what's actually running.
  const [connectedFieldValues, setConnectedFieldValues] = useState<Record<string, string>>({});
  const [connectedFieldSavingId, setConnectedFieldSavingId] = useState<string | null>(null);
  const [connectedFieldError, setConnectedFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !connection ||
      connection.status === 'available' ||
      !activeServerName ||
      editableConnectedBooleanFields.length === 0 ||
      !onLoadServer
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const details = await onLoadServer(activeServerName);
        if (cancelled) return;
        const seeded: Record<string, string> = {};
        for (const field of editableConnectedBooleanFields) {
          const envVar = field.envVar;
          if (!envVar) {
            // Invariant: editableConnectedBooleanFields filter guarantees envVar.
            // This branch only exists to satisfy TS narrowing.
            throw new Error(`Editable boolean field ${field.id} missing envVar`);
          }
          const stored = details.env?.[envVar];
          // Persisted env wins; otherwise fall back to the field default.
          seeded[field.id] = stored ?? field.default ?? 'false';
        }
        setConnectedFieldValues(seeded);
        setConnectedFieldError(null);
      } catch (err) {
        // Non-fatal: toggles fall back to field defaults; next user change
        // reloads+merges before saving. Both logged AND surfaced inline per
        // AGENTS.md "Silent failure is a bug" — devs need the original error
        // for diagnosis; users need to know toggles may not reflect saved
        // state. Sticky error auto-clears when the user toggles (line 671).
        console.warn(
          `[ExpandedConnectionCard] Failed to seed connected field values for ${activeServerName}:`,
          err,
        );
        if (!cancelled) {
          setConnectedFieldError("Couldn't load saved settings.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, activeServerName, editableConnectedBooleanFields, onLoadServer]);

  const handleConnectedBooleanChange = useCallback(
    async (field: SetupField, next: boolean) => {
      if (!activeServerName || !onLoadServer || !field.envVar) return;
      const previous = connectedFieldValues[field.id] ?? field.default ?? 'false';
      const nextStr = next ? 'true' : 'false';
      // Optimistic update so the toggle responds immediately.
      setConnectedFieldValues((prev) => ({ ...prev, [field.id]: nextStr }));
      setConnectedFieldSavingId(field.id);
      setConnectedFieldError(null);
      try {
        // Load fresh — env is replaced wholesale on upsert, so we must merge
        // against the latest persisted state rather than our seed snapshot.
        const details = await onLoadServer(activeServerName);
        const env = { ...(details.env ?? {}), [field.envVar]: nextStr };
        // Stage 4 matrix: tracked connect. Saving a connected env-var field
        // rewrites the MCP config and waits for the settings-upsert restart.
        await ops.upsertServer({
          name: details.name,
          transport: details.transport,
          type:
            details.type === 'http' || details.type === 'sse' ? details.type : null,
          command: details.command,
          args: details.args,
          url: details.url,
          cwd: details.cwd,
          env,
          headers: details.headers,
          description: details.description,
          catalogId: details.catalogId,
          email: details.email,
          workspace: details.workspace,
        }, { kind: 'connect', context: buildSettingsUpsertRestartContext(details.name) });
      } catch (err) {
        setConnectedFieldValues((prev) => ({ ...prev, [field.id]: previous }));
        setConnectedFieldError(
          err instanceof Error ? err.message : 'Could not save the change. Please try again.',
        );
      } finally {
        setConnectedFieldSavingId(null);
      }
    },
    [activeServerName, onLoadServer, ops, connectedFieldValues],
  );

  // Contribution status for custom/extended connectors (fetch-on-mount, no polling).
  // Only look up contributions for custom MCPs (no catalog entry) or rebel-oss connectors.
  // This prevents name collisions (e.g., a custom MCP named "GitHub" lighting up the official card).
  // Use the catalog base name (not instance-specific name) since contributions are recorded
  // with the base connector name (e.g., 'humaans' not 'Humaans-teammember-mindstone-com').
  const isContribEligible = !catalogEntry || catalogEntry.provider === 'rebel-oss';
  const contribLookupName = isContribEligible
    ? (catalogEntry?.bundledConfig?.serverName ?? activeServerName ?? connection.serverPreview?.name)
    : null;
  const { contribution: connectorContribution, loading: contributionLoading } = useConnectorContribution(
    contribLookupName,
  );

  const contributorAttribution = useMemo((): ReactNode => {
    // Custom MCPs with a contribution record: show the public attribution name
    if (!catalogEntry) {
      if (connectorContribution) {
        if (connectorContribution.attributionName) {
          return `Created by ${connectorContribution.attributionName}`;
        }
        if (connectorContribution.attributionMode === 'anonymous') {
          return 'Shared anonymously';
        }
      }
      return null;
    }

    // Use contributors metadata when available (rebel-oss and community connectors)
    const primaryContributor = catalogEntry.contributors?.[0];
    if (primaryContributor?.name) {
      // When a GitHub handle is available, render the name as a link to the
      // contributor's GitHub profile with a github glyph so the handle reads
      // clearly as a handle (not as a given/family name).
      const githubHandle = primaryContributor.github?.trim();
      if (githubHandle) {
        const profileUrl = `https://github.com/${encodeURIComponent(githubHandle)}`;
        return (
          <>
            Created by{' '}
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={styles.expandedConnectionAttributionLink}
            >
              <Github size={12} aria-hidden />
              <span>{primaryContributor.name}</span>
            </a>
          </>
        );
      }
      return `Created by ${primaryContributor.name}`;
    }

    if (catalogEntry.provider === 'community') {
      return 'Created by a community contributor';
    }

    if (catalogEntry.provider === 'direct') {
      // Vendor-hosted MCP — provided by the vendor, not built by Mindstone.
      return `Provided by ${catalogEntry.name}`;
    }

    // bundled + rebel-oss: Mindstone-built connectors
    return 'Created by Mindstone';
  }, [catalogEntry, connectorContribution]);

  const shouldShowDescription = useMemo(() => {
    if (!connection.description?.trim()) return false;
    if (!catalogEntry && connection.description === GENERIC_CUSTOM_CONNECTION_DESCRIPTION) {
      return false;
    }
    return true;
  }, [catalogEntry, connection.description]);

  // Provider key pre-fill info: which setup field was pre-filled from providerKeys
  const providerKeyPreFill = useMemo(() => {
    const mapping = catalogEntry?.bundledConfig?.providerKeyMapping;
    if (!mapping || !catalogEntry?.setupFields) return null;
    const providerKeys = settingsCtx?.draftSettings?.providerKeys ?? settingsCtx?.settings?.providerKeys;
    if (!providerKeys) return null;
    for (const providerKeyId of Object.values(mapping)) {
      const key = providerKeys[providerKeyId as ProviderKeyId];
      if (key?.trim()) {
        const apiKeyField = catalogEntry.setupFields.find(f => f.type === 'password');
        if (apiKeyField) {
          const providerLabel = providerKeyId === 'openai' ? 'OpenAI' : providerKeyId === 'google' ? 'Google' : String(providerKeyId);
          return { fieldId: apiKeyField.id, providerLabel };
        }
      }
    }
    return null;
  }, [catalogEntry, settingsCtx?.draftSettings?.providerKeys, settingsCtx?.settings?.providerKeys]);

  const updateCredentialsPresentation = useMemo(
    () => getUpdateCredentialsPresentation(catalogEntry?.setupFields),
    [catalogEntry?.setupFields],
  );

  // Advanced config state
  const [showConfig, setShowConfig] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configJson, setConfigJson] = useState('');
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configCopied, setConfigCopied] = useState(false);
  const [callbackUrlCopied, setCallbackUrlCopied] = useState(false);
  const [originalJson, setOriginalJson] = useState('');
  const [editedName, setEditedName] = useState('');
  const [originalName, setOriginalName] = useState('');
  // Metadata to preserve when editing (not shown in JSON but must be included in upsert)
  const [preserveMetadata, setPreserveMetadata] = useState<PreserveMetadata | null>(null);

  // Real-time validation
  const validationState = useMemo(() => {
    if (!configJson.trim()) return { isValid: false, errors: [], warnings: [] };
    return validateServerConfig(configJson);
  }, [configJson]);

  const hasJsonChanges = configJson !== originalJson;
  const hasNameChanges = editedName !== originalName;
  const hasChanges = hasJsonChanges || hasNameChanges;
  const canShowAdvanced = isConnected && activeServerName && onLoadServer && !isInternal;

  const handleToggleConfig = useCallback(async () => {
    if (showConfig) {
      setShowConfig(false);
      return;
    }
    if (!activeServerName || !onLoadServer) return;
    
    setConfigLoading(true);
    setConfigError(null);
    try {
      const details = await onLoadServer(activeServerName);
      const json = serializeServerConfig(details);
      setConfigJson(json);
      setOriginalJson(json);
      setEditedName(details.name);
      setOriginalName(details.name);
      // Store metadata that's hidden from the editable JSON but must be preserved
      setPreserveMetadata({
        email: details.email,
        catalogId: details.catalogId,
        workspace: details.workspace,
      });
      setShowConfig(true);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to load config');
    } finally {
      setConfigLoading(false);
    }
  }, [showConfig, activeServerName, onLoadServer]);

  const handleSaveConfig = useCallback(async () => {
    if (!connection.serverPreview?.name) return;
    
    const trimmedName = editedName.trim();
    if (!trimmedName) {
      setConfigError('Server name is required');
      return;
    }
    if (!validationState.isValid) {
      setConfigError(validationState.errors.join('\n'));
      return;
    }
    
    setConfigSaving(true);
    setConfigError(null);
    try {
      // Handle rename: delete old entry first, then create new one
      const isRename = trimmedName !== originalName;
      if (isRename) {
        // Stage 4 matrix: exempt. This is the midpoint of a remove+re-add
        // rename; a queued disconnect state would misdescribe the operation.
        await ops.removeServer(originalName, { exempt: 'advanced-config-rename-removes-before-readd' });
      }
      
      // Pass preserved metadata to prevent stripping email/catalogId/workspace on save
      const payload = parseConfigToPayload(configJson, preserveMetadata ?? undefined);
      // Stage 4 matrix: tracked connect. The final JSON-config save is the
      // restart-deferring settings-upsert leg users are waiting on.
      await ops.upsertServer({
        name: trimmedName,
        ...payload,
      }, { kind: 'connect', context: buildSettingsUpsertRestartContext(trimmedName) });
      setOriginalJson(configJson);
      setOriginalName(trimmedName);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to save config');
    } finally {
      setConfigSaving(false);
    }
  }, [ops, connection.serverPreview?.name, configJson, editedName, originalName, validationState, preserveMetadata]);

  const handleCopyConfig = useCallback(async () => {
    if (!configJson || !editedName) return;
    try {
      // Wrap the config with the server name as key for paste-ready mcp.json format
      const innerConfig = JSON.parse(configJson);
      const wrappedConfig = { [editedName]: innerConfig };
      await navigator.clipboard.writeText(JSON.stringify(wrappedConfig, null, 2));
      setConfigCopied(true);
      setTimeout(() => setConfigCopied(false), 2000);
    } catch {
      // Silently fail - clipboard access may be denied or JSON parse failed
    }
  }, [configJson, editedName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  // Handle saving a connector that requires manual setup (URL or custom fields)
  const handleSaveSetup = useCallback(async () => {
    // For bundled API-key, OAuth-user-provided, and no-auth-with-email connectors,
    // the card uses ops.addBundledServer/settings update/connect rather than ops.upsertServer.
    if (!catalogEntry) return;
    
    // Check if this is a bundled API-key connector (serverName is required)
    const bundledConfig = catalogEntry.bundledConfig;
    const isBundledApiKeySetup = isBundledLikeProvider(connection.provider) &&
      bundledConfig?.authType === 'api-key' &&
      bundledConfig?.serverName;
    
    // Check if this is a bundled OAuth connector with user-provided credentials (e.g., Salesforce)
    const isBundledOAuthUserProvidedSetup = isBundledLikeProvider(connection.provider) &&
      bundledConfig?.authType === 'oauth-user-provided' &&
      bundledConfig?.serverName;
    
    // Check if this is a bundled OAuth connector with setupFields that need to be collected BEFORE OAuth
    // (e.g., tenant subdomain fields required to construct provider-specific OAuth URLs)
    const isBundledOAuthWithSetupFieldsSetup = isBundledLikeProvider(connection.provider) &&
      bundledConfig?.authType === 'oauth' &&
      bundledConfig?.serverName &&
      catalogEntry?.setupFields &&
      catalogEntry?.setupFields.length > 0;
    
    // Check if this is a bundled no-auth connector with email identity
    const isBundledNoAuthWithEmailSetup = isBundledLikeProvider(connection.provider) &&
      bundledConfig?.authType === 'none' &&
      bundledConfig?.serverName &&
      catalogEntry?.accountIdentity === 'email';
    
    // Check if this is a bundled no-auth connector with custom setup fields (e.g., IBKR)
    const isBundledNoAuthWithSetupFieldsSetup = isBundledLikeProvider(connection.provider) &&
      bundledConfig?.authType === 'none' &&
      bundledConfig?.serverName &&
      catalogEntry?.accountIdentity !== 'email' &&
      catalogEntry?.setupFields &&
      catalogEntry?.setupFields.length > 0;
    
    // For non-bundled setups, ops.upsertServer is the required chokepoint.
    
    const fields = catalogEntry.setupFields;
    
    // Validate all required fields (skip for bundled no-auth connectors that only need email)
    if (!isBundledNoAuthWithEmailSetup) {
      if (fields) {
        for (const field of fields) {
          const value = setupFieldValues[field.id]?.trim() || '';
          const isRequired = field.required !== false;
          
          if (isRequired && !value && !(isUpdating && field.type === 'password')) {
            setSetupError(`Please enter ${field.label}`);
            return;
          }
          
          if (field.type === 'url' && value) {
            try {
              const parsed = new URL(value);
              if (!['http:', 'https:'].includes(parsed.protocol)) {
                setSetupError(`${field.label} must use http:// or https://`);
                return;
              }
            } catch {
              setSetupError(`Please enter a valid URL for ${field.label}`);
              return;
            }
          }
        }
      } else {
        const url = setupFieldValues.url?.trim() || '';
        if (!url) {
          setSetupError('Please enter the MCP server URL');
          return;
        }
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            setSetupError('URL must use http:// or https://');
            return;
          }
        } catch {
          setSetupError('Please enter a valid URL');
          return;
        }
      }
    }
    
    // Validate email for bundled connectors (API-key, OAuth user-provided, or no-auth with email) with email-based identity
    if ((isBundledApiKeySetup || isBundledOAuthUserProvidedSetup || isBundledNoAuthWithEmailSetup) && catalogEntry?.accountIdentity === 'email') {
      const email = isUpdating
        ? updateIdentityEmail?.trim() || ''
        : setupFieldValues.email?.trim() || '';
      if (!email) {
        setSetupError('Please enter your account email');
        return;
      }
      // Basic email format validation (contains @ and has domain part)
      if (!email.includes('@') || email.indexOf('@') === 0 || email.indexOf('@') === email.length - 1) {
        setSetupError('Please enter a valid email address');
        return;
      }
    }
    
    setSetupError(null);
    setPostSaveValidationNotice(null);
    setSetupSaving(true);

    try {
      // Handle bundled API-key connectors via dedicated IPC
      if (isBundledApiKeySetup && bundledConfig?.serverName) {
        const serverName = isUpdating ? activeServerName : bundledConfig.serverName;
        if (!serverName) {
          setSetupError('Connector entry not found');
          setSetupSaving(false);
          return;
        }
        // Collect all field values as credentials (supports both single apiKey and multi-field like Kling)
        const credentials: Record<string, string> = {};
        const fields = catalogEntry?.setupFields || [];
        for (const field of fields) {
          const value = setupFieldValues[field.id]?.trim();
          if (value) {
            credentials[field.id] = value;
          }
        }
        // For backward compatibility, also pass apiKey if it exists
        const apiKey = credentials['apiKey'] || '';
        // Include email if provided (for account disambiguation)
        const email = isUpdating
          ? updateIdentityEmail?.trim() || undefined
          : setupFieldValues.email?.trim() || undefined;
        // Stage 4 matrix: tracked connect (preserves prior queued behavior for
        // bundled API-key setup and update mode).
        await ops.addBundledServer({
          serverName,
          apiKey,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          email,
          catalogId: catalogEntry?.id,
          ...(isUpdating ? { mode: 'update' as const } : {}),
        }, { kind: 'connect', context: buildSettingsUpsertRestartContext(serverName) });

        if (isUpdating) {
          setPostSaveValidationNotice({
            status: 'pending',
            message: 'Saved. Testing the new key now.',
          });
          const validation = await window.settingsApi.mcpValidateServer({ serverName })
            .catch(() => ({ status: 'unavailable' as const }));

          if (validation.status === 'ok') {
            setPostSaveValidationNotice({
              status: 'success',
              message: 'Updated. Tested the new key — all good.',
            });
            setSetupMode(false);
            setIsUpdating(false);
            setUpdateIdentityEmail(null);
            setSetupFieldValues({});
            showToast({
              title: updateCredentialsPresentation.label === 'Update key' ? 'Key updated' : 'Details updated',
              description: `Rebel is checking ${connection.name} now.`,
              variant: 'success',
            });
            onRefresh?.();
            return;
          }

          if (validation.status === 'error') {
            setPostSaveValidationNotice({
              status: 'error',
              message: "Saved, but the new key didn't work. Double-check it and try again.",
            });
            return;
          }

          setPostSaveValidationNotice({
            status: 'unavailable',
            message: "Saved, but we couldn't validate. Will retry next time the connector loads.",
          });
          setSetupMode(false);
          setIsUpdating(false);
          setUpdateIdentityEmail(null);
          setSetupFieldValues({});
          return;
        }

        // Success - close setup mode
        setSetupMode(false);
        setIsUpdating(false);
        setUpdateIdentityEmail(null);
        setSetupFieldValues({});
        
        // Launch conversation with Rebel to verify setup
        if (onConfigureWithRebel) {
          // For multi-instance connectors, use the generated instance name
          const instanceName = email 
            ? generateInstanceId(bundledConfig.serverName, email)
            : bundledConfig.serverName;
          onConfigureWithRebel({ 
            isNewConnection: true, 
            setupResult: { success: true },
            serverNameOverride: instanceName,
          });
        } else {
          onRefresh?.();
        }
        return;
      }
      
      // Handle bundled OAuth with user-provided credentials (e.g., Salesforce)
      // Step 1: Save credentials to settings
      // Step 2: Trigger OAuth flow via onConnect
      if (isBundledOAuthUserProvidedSetup && bundledConfig?.serverName) {
        // Collect field values - these go to settings, not directly as env vars
        const fields = catalogEntry?.setupFields || [];
        const settingsUpdates: Record<string, string> = {};
        
        for (const field of fields) {
          const value = setupFieldValues[field.id]?.trim();
          if (value && field.settingsKey) {
            settingsUpdates[field.settingsKey] = value;
          }
        }
        
        // Save credentials to settings (nested under the provider key, e.g., salesforce.clientId)
        // The settingsKey format is "provider.field" (e.g., "salesforce.clientId")
        if (Object.keys(settingsUpdates).length === 0) {
          // If no settings to save, we can't proceed with OAuth - credentials are required
          setSetupError('Configuration error: missing settingsKey for credential fields');
          setSetupSaving(false);
          return;
        }
        
        const currentSettings = await window.settingsApi.get();
        const updatedSettings = { ...currentSettings } as Record<string, unknown>;
        
        for (const [key, value] of Object.entries(settingsUpdates)) {
          const parts = key.split('.');
          if (parts.length === 2) {
            const [provider, field] = parts;
            if (!updatedSettings[provider]) {
              updatedSettings[provider] = {};
            }
            (updatedSettings[provider] as Record<string, unknown>)[field] = value;
          }
        }
        
        await window.settingsApi.update(updatedSettings as Parameters<typeof window.settingsApi.update>[0]);
        
        // Capture email before resetting state
        const email = setupFieldValues.email?.trim();
        
        // Close setup mode
        setSetupMode(false);
        setSetupFieldValues({});
        
        // Trigger OAuth flow - this will use the credentials we just saved
        // The onConnect handler will call the appropriate auth IPC (e.g., salesforce:start-auth)
        // Pass launchRebel: true so configuration chat starts after OAuth completes
        onConnect?.(email, { launchRebel: true });
        return;
      }
      
      // Handle bundled OAuth with setupFields that need to be collected BEFORE OAuth
      // (e.g., tenant subdomain fields required to construct provider-specific OAuth URLs)
      // Unlike oauth-user-provided, we don't save credentials to settings - we just pass them to OAuth
      if (isBundledOAuthWithSetupFieldsSetup && bundledConfig?.serverName) {
        // Collect the setupField values to pass to onConnect
        const collectedFields: Record<string, string> = {};
        const fields = catalogEntry?.setupFields || [];
        for (const field of fields) {
          const value = setupFieldValues[field.id]?.trim();
          if (value) {
            collectedFields[field.id] = value;
          }
        }
        
        // Close setup mode
        setSetupMode(false);
        setSetupFieldValues({});
        
        // Trigger OAuth flow with the setupField values
        // The parent handler will use these values (e.g., tenant subdomain fields for provider-specific OAuth URLs)
        onConnect?.(undefined, { launchRebel: true, setupFieldValues: collectedFields });
        return;
      }
      
      // Handle bundled no-auth connectors with email identity
      // These don't require API keys or OAuth, just email for account tracking
      if (isBundledNoAuthWithEmailSetup && bundledConfig?.serverName) {
        const email = setupFieldValues.email?.trim() || undefined;
        // Stage 4 matrix: tracked connect (preserves prior queued behavior).
        await ops.addBundledServer({
          serverName: bundledConfig.serverName,
          email,
          catalogId: catalogEntry?.id,
        }, { kind: 'connect', context: buildSettingsUpsertRestartContext(bundledConfig.serverName) });
        // Success - close setup mode
        setSetupMode(false);
        setSetupFieldValues({});
        
        // Launch conversation with Rebel to verify setup
        if (onConfigureWithRebel) {
          const instanceName = email 
            ? generateInstanceId(bundledConfig.serverName, email)
            : bundledConfig.serverName;
          onConfigureWithRebel({ 
            isNewConnection: true, 
            setupResult: { success: true },
            serverNameOverride: instanceName,
          });
        } else {
          onRefresh?.();
        }
        return;
      }
      
      // Handle bundled no-auth connectors with custom setup fields (e.g., IBKR)
      // These pass setup field values as credentials to configure the MCP server
      if (isBundledNoAuthWithSetupFieldsSetup && bundledConfig?.serverName) {
        const credentials: Record<string, string> = {};
        const setupFields = catalogEntry?.setupFields || [];
        for (const field of setupFields) {
          const value = setupFieldValues[field.id]?.trim();
          if (value) {
            credentials[field.id] = value;
          }
        }
        // Stage 4 matrix: tracked connect (preserves prior queued behavior).
        await ops.addBundledServer({
          serverName: bundledConfig.serverName,
          credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
          catalogId: catalogEntry?.id,
        }, { kind: 'connect', context: buildSettingsUpsertRestartContext(bundledConfig.serverName) });
        setSetupMode(false);
        setSetupFieldValues({});
        
        if (onConfigureWithRebel) {
          onConfigureWithRebel({ 
            isNewConnection: true, 
            setupResult: { success: true },
            serverNameOverride: bundledConfig.serverName,
          });
        } else {
          onRefresh?.();
        }
        return;
      }
      
      // Generic setup flow for non-bundled connectors (manual setup)
      // Check if identity (email or workspace) is provided for connectors with identity-based accounts
      const manualSetupEmail = catalogEntry?.accountIdentity === 'email' 
        ? setupFieldValues.email?.trim() 
        : undefined;
      const manualSetupWorkspace = catalogEntry?.accountIdentity === 'workspace'
        ? setupFieldValues.workspace?.trim()
        : undefined;
      
      // Validate email if accountIdentity requires it
      if (catalogEntry?.accountIdentity === 'email' && !manualSetupEmail) {
        setSetupError('Please enter your account email');
        setSetupSaving(false);
        return;
      }
      if (manualSetupEmail && (!manualSetupEmail.includes('@') || manualSetupEmail.indexOf('@') === 0 || manualSetupEmail.indexOf('@') === manualSetupEmail.length - 1)) {
        setSetupError('Please enter a valid email address');
        setSetupSaving(false);
        return;
      }
      
      // Validate workspace if accountIdentity requires it
      if (catalogEntry?.accountIdentity === 'workspace' && !manualSetupWorkspace) {
        setSetupError('Please enter your workspace name');
        setSetupSaving(false);
        return;
      }
      
      // Generate instance name if identity provided (for multi-account support)
      const serverName = manualSetupEmail
        ? generateInstanceId(connection.name, manualSetupEmail)
        : manualSetupWorkspace
          ? generateWorkspaceInstanceId(connection.name, manualSetupWorkspace)
          : connection.name;

      if (fields) {
        const urlField = fields.find(f => f.type === 'url' && !f.envVar);
        const baseConfig = catalogEntry.mcpConfig;
        
        // Build env and headers from setup fields using shared utilities
        const env = buildEnvFromSetupFields(fields, setupFieldValues);
        const headers = buildHeadersFromSetupFields(fields, setupFieldValues);
        
        if (baseConfig) {
          // Use the user-entered URL from setupFields if the catalog config has no static URL
          // (e.g., Zapier — user provides their personalized MCP server URL).
          // A select field with `urlOverrides` (e.g., region toggle) takes precedence over
          // the catalog URL so vendors with per-region endpoints only need a single card.
          const overrideField = fields.find(f => f.urlOverrides && setupFieldValues[f.id]);
          const overrideUrl = overrideField?.urlOverrides?.[setupFieldValues[overrideField.id]];
          const effectiveUrl = overrideUrl
            || baseConfig.url
            || (urlField ? setupFieldValues[urlField.id]?.trim() : undefined);
          // Stage 4 matrix: tracked connect (preserves prior generic setup behavior).
          await ops.upsertServer({
            name: serverName,
            transport: baseConfig.transport,
            url: effectiveUrl,
            command: baseConfig.command,
            args: baseConfig.args,
            description: connection.description,
            env: Object.keys(env).length > 0 ? env : undefined,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            // Mirror UnifiedConnectionsPanel.handleConnect — direct OAuth connectors
            // with a user-supplied URL (e.g. n8n MCP) need the oauth flag to survive
            // the setupFields save path so Super-MCP initiates the OAuth handshake.
            oauth: baseConfig.oauth,
            oauthParams: baseConfig.oauthParams,
            oauthClientId: baseConfig.oauthClientId,
            oauthClientSecret: baseConfig.oauthClientSecret,
            // Pass catalogId for community/manual connectors to enable catalog matching
            catalogId: catalogEntry?.id,
            // Pass identity for multi-account support
            email: manualSetupEmail,
            workspace: manualSetupWorkspace,
          }, { kind: 'connect', context: buildSettingsUpsertRestartContext(serverName) });
        } else if (urlField) {
          const url = setupFieldValues[urlField.id]?.trim();
          // Detect SSE transport from URL path (e.g., /sse in mcp.unframer.co/sse)
          const useSseTransport = (() => {
            try { return url && new URL(url).pathname.includes('/sse'); }
            catch { return false; }
          })();
          // Stage 4 matrix: tracked connect (preserves prior generic setup behavior).
          await ops.upsertServer({
            name: serverName,
            transport: 'http',
            type: useSseTransport ? 'sse' : 'http',
            url,
            description: connection.description,
            env: Object.keys(env).length > 0 ? env : undefined,
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            catalogId: catalogEntry?.id,
            email: manualSetupEmail,
            workspace: manualSetupWorkspace,
          }, { kind: 'connect', context: buildSettingsUpsertRestartContext(serverName) });
        } else {
          throw new Error('Invalid setup configuration');
        }
      } else {
        const url = setupFieldValues.url?.trim();
        // Detect SSE transport from URL path (e.g., /sse in mcp.unframer.co/sse)
        const useSseTransport = (() => {
          try { return url && new URL(url).pathname.includes('/sse'); }
          catch { return false; }
        })();
        // Stage 4 matrix: tracked connect (preserves prior generic setup behavior).
        await ops.upsertServer({
          name: serverName,
          transport: 'http',
          type: useSseTransport ? 'sse' : 'http',
          url,
          description: connection.description,
          email: manualSetupEmail,
          workspace: manualSetupWorkspace,
        }, { kind: 'connect', context: buildSettingsUpsertRestartContext(serverName) });
      }
      
      // Success - close setup mode
      setSetupMode(false);
      setSetupFieldValues({});
      
      // Launch conversation with Rebel to verify setup and explore capabilities
      if (onConfigureWithRebel) {
        // Pass the actual server name used (may be instance-specific if email was provided)
        onConfigureWithRebel({ 
          isNewConnection: true, 
          setupResult: { success: true },
          serverNameOverride: serverName,
        });
      } else {
        onRefresh?.();
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Failed to save connection');
    } finally {
      setSetupSaving(false);
    }
  }, [ops, onConnect, onConfigureWithRebel, catalogEntry, setupFieldValues, connection.name, connection.description, connection.provider, onRefresh, isUpdating, updateIdentityEmail, activeServerName, showToast, updateCredentialsPresentation.label]);

  const handleCancelSetup = useCallback(() => {
    setSetupMode(false);
    setIsUpdating(false);
    setUpdateIdentityEmail(null);
    setSetupFieldValues({});
    setSetupError(null);
    setPostSaveValidationNotice(null);
  }, []);

  const handleUpdateClick = useCallback(async () => {
    if (!catalogEntry?.setupFields || !activeServerName || !onLoadServer) {
      return;
    }

    setSetupError(null);
    setPostSaveValidationNotice(null);
    setSetupSaving(true);
    try {
      const details = await onLoadServer(activeServerName);
      const initialValues: Record<string, string> = {};
      for (const field of catalogEntry.setupFields) {
        initialValues[field.id] = valueFromExistingServerDetails(field, details);
      }
      const existingEmail = details.email?.trim() || '';
      if (catalogEntry.accountIdentity === 'email') {
        initialValues.email = existingEmail;
      }
      setSetupFieldValues(initialValues);
      setUpdateIdentityEmail(existingEmail || null);
      setSetupMode(false);
      setIsUpdating(true);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Failed to load saved credentials');
    } finally {
      setSetupSaving(false);
    }
  }, [activeServerName, catalogEntry, onLoadServer]);

  // Handle clicking "Set up" button for requiresSetup connectors
  const handleSetupClick = useCallback(() => {
    // Initialize field values (select fields use their default value)
    const initialValues: Record<string, string> = {};
    if (catalogEntry?.setupFields) {
      for (const field of catalogEntry.setupFields) {
        initialValues[field.id] = field.default || '';
      }
    } else {
      initialValues.url = '';
    }
    // Pre-fill API key from provider keys if the connector has a providerKeyMapping
    const mapping = catalogEntry?.bundledConfig?.providerKeyMapping;
    if (mapping && catalogEntry?.setupFields) {
      const providerKeys = settingsCtx?.draftSettings?.providerKeys ?? settingsCtx?.settings?.providerKeys;
      if (providerKeys) {
        // Find the first mapping entry whose provider key exists
        for (const providerKeyId of Object.values(mapping)) {
          const key = providerKeys[providerKeyId as ProviderKeyId];
          if (key?.trim()) {
            // Pre-fill the first password-type setup field (typically the API key field)
            const apiKeyField = catalogEntry.setupFields.find(f => f.type === 'password');
            if (apiKeyField && !initialValues[apiKeyField.id]) {
              initialValues[apiKeyField.id] = key.trim();
            }
            break;
          }
        }
      }
    }
    setSetupFieldValues(initialValues);
    setIsUpdating(false);
    setUpdateIdentityEmail(null);
    setSetupMode(true);
    setSetupError(null);
    setPostSaveValidationNotice(null);
    // Auto-open setup URL only when setupUrlBehavior is 'auto-open' (or defaults to auto-open for OAuth)
    // For 'button' behavior, user clicks the "Open X" button manually
    const shouldAutoOpen = catalogEntry?.setupUrlBehavior === 'auto-open' ||
      (!catalogEntry?.setupUrlBehavior && catalogEntry?.mcpConfig?.oauth);
    if (catalogEntry?.setupUrl && shouldAutoOpen) {
      window.appApi.openUrl(catalogEntry.setupUrl);
    }
  }, [catalogEntry, settingsCtx?.draftSettings?.providerKeys, settingsCtx?.settings?.providerKeys]);

  // Stage 5 (260610_gworkspace-mcp-error-disconnect-hang): "Add another
  // account" (McpAccountsExtension) awaits `google-workspace:start-auth`,
  // whose Super-MCP restart now resolves the IPC promptly when deferred
  // ({ queued: true }). Register a connect-kind deferred op around that IPC so
  // the `google-workspace-connect` broadcast lights the honest queued state on
  // this card. Google-only by contract (HubSpot's connect handler never awaits
  // a reconfigure) — the extension only invokes these for its google type.
  // This resolve-on-deferral context deliberately uses the ops passthrough
  // tracker, not the clear-on-settle wrapper for settings-upsert/toggle ops.
  const trackGoogleConnectDeferred = useCallback(() => {
    ops.trackResolveOnDeferralConnect?.({
      id: connection.id,
      kind: 'connect',
      context: MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT,
    });
  }, [connection.id, ops]);

  const clearGoogleConnectDeferred = useCallback(() => {
    ops.clearResolveOnDeferralConnect?.(connection.id, 'connect');
  }, [connection.id, ops]);

  // Handle toggling server enabled/disabled state
  // Uses the activeServerName as serverId - this is the actual server key in config
  const handleToggleEnabled = useCallback(async () => {
    const serverName = activeServerName;
    if (!serverName) return;

    setIsToggling(true);
    try {
      // Stage 4 matrix: tracked toggle (preserves prior queued behavior).
      const result = await ops.toggleServerEnabled(
        serverName,
        { kind: 'toggle', context: buildMcpServerToggleRestartContext(serverName) },
      );
      if (!result.success) {
        console.error('Failed to toggle server:', result.error);
      }
      // Refresh the connections list to reflect the new state
      onRefresh?.();
    } catch (error) {
      console.error('Failed to toggle server enabled state:', error);
    } finally {
      setIsToggling(false);
    }
  }, [activeServerName, onRefresh, ops]);

  // Handle toggling a specific instance's enabled/disabled state (for per-instance toggle in AccountInstancesList)
  const handleToggleInstanceEnabled = useCallback(async (serverName: string) => {
    try {
      // Stage 4 matrix: tracked toggle (preserves prior queued behavior).
      const result = await ops.toggleServerEnabled(
        serverName,
        { kind: 'toggle', context: buildMcpServerToggleRestartContext(serverName) },
      );
      if (!result.success) {
        console.error('Failed to toggle server:', result.error);
      }
      // Refresh the connections list to reflect the new state
      onRefresh?.();
    } catch (error) {
      console.error('Failed to toggle server enabled state:', error);
    }
  }, [onRefresh, ops]);

  const handleSetAccountEmail = useCallback(async () => {
    const email = accountEmailInput.trim();
    if (!email) {
      setAccountEmailError('Please enter an email address');
      return;
    }
    if (!email.includes('@') || email.indexOf('@') === 0 || email.indexOf('@') === email.length - 1) {
      setAccountEmailError('Please enter a valid email address');
      return;
    }
    if (!activeServerName || !onLoadServer) return;

    setIsSettingAccountEmail(true);
    setAccountEmailError(null);
    try {
      const details = await onLoadServer(activeServerName);
      // Build payload directly from details to preserve all fields (including internal env vars).
      // Unlike the advanced config editor which serializes/parses (stripping internal env),
      // this path must not lose any config — the user is only setting an email.
      // Stage 4 matrix: tracked connect. Setting the account email rewrites the
      // server entry and waits for the settings-upsert restart.
      await ops.upsertServer({
        name: activeServerName,
        transport: details.transport,
        type: details.type === 'http' || details.type === 'sse' ? details.type : undefined,
        command: details.command || undefined,
        args: details.args?.length ? details.args : undefined,
        url: details.url || undefined,
        description: details.description || undefined,
        env: details.env || undefined,
        headers: details.headers || undefined,
        catalogId: details.catalogId || undefined,
        workspace: details.workspace || undefined,
        email,
      }, { kind: 'connect', context: buildSettingsUpsertRestartContext(activeServerName) });
      setAccountEmailInput('');
      setAccountEmailError(null);
      onRefresh?.();
    } catch (error) {
      setAccountEmailError(error instanceof Error ? error.message : 'Failed to set account email');
    } finally {
      setIsSettingAccountEmail(false);
    }
  }, [accountEmailInput, activeServerName, onLoadServer, ops, onRefresh]);

  // Check if this server is currently disabled
  // For multi-instance connectors, check the selected instance's disabled state
  const isServerDisabled = useMemo(() => {
    if (connection.instances && connection.instances.length > 0 && selectedInstanceServerName) {
      const selectedInstance = connection.instances.find(i => i.serverName === selectedInstanceServerName);
      return selectedInstance?.disabled === true;
    }
    return connection.serverPreview?.disabled === true;
  }, [connection.instances, connection.serverPreview?.disabled, selectedInstanceServerName]);

  const canToggleSelectedConnector = Boolean(activeServerName) &&
    !(connection.instances && connection.instances.length > 1 &&
      (catalogEntry?.accountIdentity === 'email' || catalogEntry?.accountIdentity === 'workspace') &&
      (connection.provider === 'direct' || isBundledLikeProvider(connection.provider)) &&
      !['bundled-google', 'bundled-hubspot'].includes(catalogEntry?.id || '')) &&
    !(catalogEntry?.id === 'bundled-google' && connection.instances && connection.instances.length > 0);

  const showSetupUI = (!isConnected || setupMode || isUpdating) && ((isBundledApiKey || isManualSetup || isBundledNoAuthWithEmail) || (isBundledOAuthUserProvided && setupMode));
  const canShowUpdateCredentialsButton = Boolean(
    isConnected &&
      !isInternal &&
      isBundledApiKey &&
      !showSetupUI &&
      !isUpdating &&
      activeServerName &&
      onLoadServer,
  );
  const isConnectDeferred = deferredKind === 'connect';
  const isDisconnectDeferred = deferredKind === 'disconnect';
  const isToggleDeferred = deferredKind === 'toggle';
  const isActiveConnecting = Boolean(isConnecting && !isConnectDeferred);
  const isActiveRemoving = Boolean(isRemoving && !isDisconnectDeferred);
  const deferredHelperText = isConnectDeferred
    ? 'Connect queued. Rebel will finish this when the current task wraps up.'
    : isDisconnectDeferred
      ? 'Disconnect queued. Rebel will finish this when the current task wraps up.'
      : isToggleDeferred
        ? 'Change queued. Rebel will apply it when the current task wraps up.'
        : null;
  const deferredTooltipText = isConnectDeferred
    ? 'Queued safely. Rebel will finish connecting after the current task.'
    : isDisconnectDeferred
      ? 'Queued safely. Rebel will finish disconnecting after the current task.'
      : null;
  const isAuthFailure = Boolean(
    connection.status === 'error' &&
      catalogEntry?.bundledConfig?.authType === 'api-key',
  );

  // The setup form is rendered directly below the Connected Accounts list (see the
  // {showSetupUI && (...)} block after AccountInstancesList) so no scroll-into-view
  // logic is needed when users click "Add account".

  // One-time scrollbar flash when the card mounts (or its scrollable content changes),
  // so users see the card is scrollable. WebKit hides overlay scrollbars by default;
  // briefly scrolling and restoring surfaces the thumb.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (body.scrollHeight <= body.clientHeight + 1) return; // not scrollable, nothing to flash
    const originalTop = body.scrollTop;
    const raf1 = requestAnimationFrame(() => {
      body.scrollTop = originalTop + 1;
      const raf2 = requestAnimationFrame(() => {
        body.scrollTop = originalTop;
      });
      // store for cleanup
      (body as HTMLDivElement & { __flashRaf?: number }).__flashRaf = raf2;
    });
    return () => {
      cancelAnimationFrame(raf1);
      const raf2 = (body as HTMLDivElement & { __flashRaf?: number }).__flashRaf;
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [connection.id, showSetupUI, isConnected]);

  return (
    <motion.div
      layoutId={layoutId}
      className={`${styles.expandedConnectionCard}${isServerDisabled ? ` ${styles.expandedConnectionDisabled}` : ''}`}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-label={`${connection.name} details`}
    >
      {/* Header */}
      <div className={styles.expandedConnectionHeader}>
        <div className={styles.expandedConnectionTitle}>
          {StatusIcon && (
            <span className={`${styles.expandedConnectionStatusIconBox} ${statusConfig.iconBoxClassName}`}>
              <StatusIcon
                size={12}
                style={{ color: statusConfig.color }}
                aria-hidden
              />
            </span>
          )}
          <span>{connection.name}</span>
          {badge && (
            <Tooltip content={badgeExplanations[badge.label] || badge.label}>
              <Badge variant="outline" className={badge.className}>
                {badge.label}
              </Badge>
            </Tooltip>
          )}
          {requiresPython && (
            <Tooltip content="This connector requires Python to be installed on your computer">
              <Badge variant="outline" className={styles.expandedConnectionBadgePython}>
                <FileCode2 size={10} aria-hidden />
                Python
              </Badge>
            </Tooltip>
          )}
          {platformBadgeLabel && (
            <Tooltip content={`This connector is only available on ${platformBadgeLabel.replace(/\s+only$/, '')}.`}>
              <Badge variant="outline">
                {platformBadgeLabel}
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className={styles.expandedConnectionHeaderActions}>
          <button
            className={styles.expandedConnectionClose}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={bodyRef} className={styles.expandedConnectionBody}>
        {isAuthFailure && !isUpdating && (
          <Notice
            tone="warning"
            placement="section"
            title={`${connection.name} ${updateCredentialsPresentation.authFailureTitleSuffix}`}
            actions={[{
              label: updateCredentialsPresentation.label,
              onClick: () => void handleUpdateClick(),
              loading: setupSaving,
              disabled: isLoading || isRemoving,
              'data-testid': 'connector-auth-failure-update-button',
            }]}
            data-testid="connector-auth-failure-notice"
          >
            Couldn't reach this connector. If it's a credential issue, update the key below.
          </Notice>
        )}
        {contributorAttribution && (
          <p className={styles.expandedConnectionAttribution}>
            {contributorAttribution}
          </p>
        )}
        {shouldShowDescription && (
          <p className={styles.expandedConnectionDescription}>
            {connection.description}
          </p>
        )}

        {catalogEntry?.id === 'bundled-office' && <OfficeSidecarStatusSection />}

        {/* Account email setter for connected connectors missing email ("Account not set") */}
        {needsAccountEmail && onLoadServer && activeServerName && (
          <div className={styles.setupView}>
            <Notice tone="warning" placement="inline" density="compact">
              No account email set. Add one to identify which account this connector uses.
            </Notice>
            <div className={styles.setupUrlInput}>
              <label htmlFor="account-email-setter">Account Email</label>
              <input
                id="account-email-setter"
                type="email"
                placeholder="you@example.com"
                value={accountEmailInput}
                onChange={(e) => { setAccountEmailInput(e.target.value); setAccountEmailError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && accountEmailInput.trim()) handleSetAccountEmail(); }}
                className={styles.advancedConfigNameInput}
                disabled={isSettingAccountEmail}
              />
              <span className={styles.setupHint}>
                Helps organize connectors by account
              </span>
            </div>
            {accountEmailError && (
              <span className={styles.setupError}>{accountEmailError}</span>
            )}
            <div className={styles.setupActions}>
              <Button
                variant="default"
                size="sm"
                onClick={handleSetAccountEmail}
                disabled={isSettingAccountEmail || !accountEmailInput.trim()}
              >
                {isSettingAccountEmail ? (
                  <>
                    <Loader2 size={14} className={styles.spinnerIcon} />
                    Saving...
                  </>
                ) : (
                  'Set email'
                )}
              </Button>
            </div>
          </div>
        )}

        {/* For connected bundled servers with extension UI (Google, HubSpot), show account management */}
        {isConnected &&
          isBundledLikeProvider(connection.provider) &&
          connection.catalogEntry?.bundledConfig?.authType === 'oauth' &&
          connection.serverPreview?.name && (
            <McpAccountsExtension
              serverName={connection.serverPreview.name}
              isParentConnecting={isConnecting}
              instances={connection.instances}
              // Stage 3 (260611_calendar-cache-attention): rows adopt the
              // selected-row behavior from AccountInstancesList; the card's
              // selection state (auto-seeded to the needs-reconnect instance
              // via preferredInstanceServerName) drives the per-account
              // recovery Notice.
              selectedServerName={selectedInstanceServerName}
              onSelectInstance={selectInstanceDeliberately}
              onRefresh={onRefresh}
              ops={ops}
              // Stage 5: "Add another account" (Google) registers a
              // `connect`-kind deferred op for the resolve-on-deferral
              // start-auth leg.
              onTrackConnectDeferredOperation={trackGoogleConnectDeferred}
              onClearConnectDeferredOperation={clearGoogleConnectDeferred}
            />
          )}

        {/* For connected connectors with email/workspace identity and multiple instances, show instance list */}
        {/* This covers: direct connectors, bundled API-key, and bundled OAuth (except those with McpAccountsExtension) */}
        {isConnected &&
          (catalogEntry?.accountIdentity === 'email' || catalogEntry?.accountIdentity === 'workspace') &&
          connection.instances &&
          connection.instances.length > 0 &&
          (connection.provider === 'direct' || isBundledLikeProvider(connection.provider)) &&
          // Exclude Google/HubSpot which have their own McpAccountsExtension
          // Use catalog ID (stable) instead of server name (varies with multi-instance naming)
          !['bundled-google', 'bundled-hubspot'].includes(catalogEntry?.id || '') && (
            <AccountInstancesList
              instances={connection.instances}
              selectedServerName={selectedInstanceServerName}
              onSelect={selectInstanceDeliberately}
              // Stage 4 matrix: tracked disconnect. The panel delegate keeps the
              // full handleDisconnect flow instead of calling the remove IPC raw.
              onRemove={(serverName) =>
                ops.removeServer(serverName, {
                  kind: 'disconnect',
                  context: buildMcpServerRemovalRestartContext(serverName),
                })}
              onToggleEnabled={handleToggleInstanceEnabled}
              onAddAnother={() => {
                // Manual-setup connectors (setupFields present) need the full setup form
                // to collect credentials + email. Covers:
                //  - bundled API-key with bundledConfig (e.g. legacy bundled connectors)
                //  - rebel-oss connectors with setupFields but no bundledConfig (e.g. Nano Banana on main)
                //  - community/custom manual-setup connectors
                if (isManualSetup || (isBundledLikeProvider(connection.provider) && catalogEntry?.bundledConfig?.authType === 'api-key')) {
                  handleSetupClick();
                } else {
                  // For direct connectors AND bundled OAuth, show identity input flow first
                  // This ensures consistent UX: user enters workspace/email name, then OAuth opens
                  setDirectEmail('');
                  setShowAddAnotherFlow(true);
                }
              }}
              isRemoving={isRemoving}
              isConnecting={isConnecting}
              accountIdentity={catalogEntry?.accountIdentity}
            />
          )}

        {/* Setup UI for connectors requiring fields (API key, credentials, URL, or email-only).
           Rendered here (above tool list, docs, etc.) so that when the user clicks
           "Add account" on a connected connector, the credentials form appears directly
           below the Connected Accounts list instead of far down the card. */}
        {postSaveValidationNotice && (
          <Notice
            tone={
              postSaveValidationNotice.status === 'success'
                ? 'success'
                : postSaveValidationNotice.status === 'error'
                  ? 'error'
                  : postSaveValidationNotice.status === 'unavailable'
                    ? 'warning'
                    : 'info'
            }
            placement="inline"
            density="compact"
            data-testid="connector-post-save-validation-notice"
          >
            {postSaveValidationNotice.message}
          </Notice>
        )}
        {/* B-F1: when a setup-form save is queued behind an in-progress task the
            connect-confirm row (which carries the queued helper) is hidden by
            `showSetupUI`, so surface the queued affordance here next to the form
            instead of leaving a silent "Setting up…" spinner. Keyed off the same
            single-slot `deferredKind` the parent owns. */}
        {showSetupUI && isConnectDeferred && deferredHelperText && (
          <Notice
            tone="info"
            placement="inline"
            density="compact"
            aria-live="polite"
            data-testid="connector-deferred-helper"
          >
            {deferredHelperText}
          </Notice>
        )}
        {showSetupUI && catalogEntry && (
          <SetupFieldsForm
            mode={isUpdating ? 'update' : 'create'}
            catalogEntry={catalogEntry}
            connectionName={connection.name}
            fieldValues={setupFieldValues}
            onChange={(fieldId, value) => setSetupFieldValues(prev => ({ ...prev, [fieldId]: value }))}
            onSubmit={handleSaveSetup}
            onCancel={handleCancelSetup}
            isSaving={setupSaving}
            error={setupError}
            providerKeyPreFill={providerKeyPreFill}
            callbackUrlCopied={callbackUrlCopied}
            onCopyCallbackUrl={async () => {
              if (!catalogEntry.callbackUrl) return;
              try {
                await navigator.clipboard.writeText(catalogEntry.callbackUrl);
                setCallbackUrlCopied(true);
                setTimeout(() => setCallbackUrlCopied(false), 2000);
              } catch {
                // Clipboard access may be denied
              }
            }}
            onOpenSetupUrl={() => {
              let url = catalogEntry.setupUrl;
              // Check select fields for setupUrlOverrides (e.g., region-specific dashboard URLs)
              for (const field of catalogEntry.setupFields ?? []) {
                if (field.type === 'select' && field.setupUrlOverrides) {
                  const selected = setupFieldValues[field.id] || field.default || '';
                  const override = field.setupUrlOverrides[selected];
                  if (override) { url = override; break; }
                }
              }
              if (url) {
                window.appApi.openUrl(url);
              }
            }}
            submitWithRebel={Boolean((isBundledApiKey || isManualSetup || isBundledNoAuthWithEmail) && onConfigureWithRebel)}
            showBundledEmailField={Boolean((isBundledApiKey || isBundledOAuthUserProvided || isBundledNoAuthWithEmail) && catalogEntry.accountIdentity === 'email')}
            showManualEmailField={Boolean(isManualSetup && !isBundledApiKey && !isBundledOAuthUserProvided && !isBundledNoAuthWithEmail && catalogEntry.accountIdentity === 'email')}
            showManualWorkspaceField={Boolean(isManualSetup && !isBundledApiKey && !isBundledOAuthUserProvided && !isBundledNoAuthWithEmail && catalogEntry.accountIdentity === 'workspace')}
            skipDefaultUrlField={Boolean(isBundledNoAuthWithEmail)}
            panelTitle={isUpdating ? updateCredentialsPresentation.label : undefined}
          />
        )}

        {calendarSelectionAccounts.map((account) => (
          <CalendarSelectionSection
            key={account.calendarSource}
            calendarSource={account.calendarSource}
            disabled={Boolean(account.disabled) || Boolean(isLoading) || Boolean(isConnecting) || Boolean(isRemoving)}
            settings={settings}
          />
        ))}

        {/* "Add another account/workspace" flow for connected multi-instance connectors */}
        {/* Applies to: direct connectors AND bundled OAuth (like Slack) */}
        {isConnected &&
          (connection.provider === 'direct' || 
           (isBundledLikeProvider(connection.provider) && catalogEntry?.bundledConfig?.authType === 'oauth')) &&
          (catalogEntry?.accountIdentity === 'email' || catalogEntry?.accountIdentity === 'workspace') &&
          showAddAnotherFlow && (
            <div className={styles.setupView}>
              <div className={styles.setupUrlInput}>
                <label htmlFor="add-another-identity">{identityInputLabel} <span style={{ color: 'var(--color-error)' }}>*</span></label>
                <input
                  id="add-another-identity"
                  type={identityFieldDisplay.inputType}
                  placeholder={identityFieldDisplay.placeholder}
                  value={directEmail}
                  onChange={(e) => setDirectEmail(e.target.value)}
                  className={styles.advancedConfigNameInput}
                  disabled={isConnecting}
                />
                {/* OAuth hint */}
                {catalogEntry?.mcpConfig?.oauth && (
                  <span className={styles.setupHint}>
                    A browser window will open for you to sign in
                  </span>
                )}
              </div>
              <div className={styles.setupActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (isConnecting && onCancelConnect) {
                      onCancelConnect();
                    }
                    setShowAddAnotherFlow(false);
                    setDirectEmail('');
                  }}
                >
                  Cancel
                </Button>
                {onConfigureWithRebel ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      onConnect?.(directEmail.trim() || undefined, { launchRebel: true });
                      setShowAddAnotherFlow(false);
                      setDirectEmail('');
                    }}
                    disabled={isConnecting || !directEmail.trim()}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 size={14} className={styles.spinnerIcon} />
                        Setting up...
                      </>
                    ) : (
                      <>
                        <Bot size={14} />
                        Set up with Rebel
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      onConnect?.(directEmail.trim() || undefined);
                      setShowAddAnotherFlow(false);
                      setDirectEmail('');
                    }}
                    disabled={isConnecting || !directEmail.trim()}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 size={14} className={styles.spinnerIcon} />
                        Connecting...
                      </>
                    ) : (
                      'Connect'
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}

        {/* Tool list for connected servers */}
        {isConnected && activeServerName && (
          <McpToolList 
            serverId={activeServerName} 
            authHint={deriveConnectorAuthHint({
              catalogEntry,
              serverPreview: connection.serverPreview,
            })}
          />
        )}

        {/* Slack @-mention monitoring now lives in Settings → Continuity & Messaging. */}
        {isConnected && catalogEntry?.bundledConfig?.authApi === 'slackApi' && (
          <Notice tone="info" placement="inline" density="compact">
            Listening for @mentions — manage in{' '}
            <a
              href={MESSAGING_SETTINGS_URL}
              onClick={handleOpenMessagingSettings}
              className={styles.expandedConnectionLink}
            >
              Settings → Continuity &amp; Messaging
            </a>
          </Notice>
        )}

        {/* Editable boolean setupFields — persisted directly to the server
            entry's env, so users can flip preferences (e.g. "Show the browser
            window") without having to disconnect and reconfigure. */}
        {isConnected && activeServerName && editableConnectedBooleanFields.length > 0 && (
          <div className={styles.setupView}>
            {editableConnectedBooleanFields.map((field) => {
              const stored = connectedFieldValues[field.id] ?? field.default ?? 'false';
              const saving = connectedFieldSavingId === field.id;
              return (
                <div key={field.id} className={styles.setupUrlInput}>
                  <InlineToggle
                    toggleId={`connected-${field.id}`}
                    checked={stored === 'true'}
                    disabled={connectedFieldSavingId !== null}
                    label={field.label}
                    onCheckedChange={(next) => handleConnectedBooleanChange(field, next)}
                  />
                  {field.helpText && (
                    <span className={styles.setupHint}>{field.helpText}</span>
                  )}
                  {saving && (
                    <span className={styles.setupHint}>
                      <Loader2 size={12} className={styles.spinnerIcon} aria-hidden /> Saving…
                    </span>
                  )}
                </div>
              );
            })}
            {connectedFieldError && (
              <Notice tone="error" placement="inline">{connectedFieldError}</Notice>
            )}
          </div>
        )}

        {/* Contribution status for custom/extended connectors */}
        <ConnectorContributionSection
          contribution={connectorContribution}
          isConnected={isConnected}
          loading={contributionLoading}
          onShareWithCommunity={onShareWithCommunity}
          onOpenChat={onOpenContributionChat}
        />

        {/* Python runtime status for Python-based MCPs */}
        {requiresPython && (
          <div className={styles.expandedConnectionPythonStatus}>
            {pythonStatus.checking ? (
              <span className={styles.pythonStatusChecking}>
                <Loader2 size={12} className={styles.spinnerIcon} />
                Checking Python setup...
              </span>
            ) : pythonStatus.error ? (
              <span className={styles.pythonStatusError}>
                <AlertCircle size={12} />
                {pythonStatus.error}
              </span>
            ) : pythonStatus.uvxAvailable ? (
              <span className={styles.pythonStatusReady}>
                <Check size={12} />
                Python ready
              </span>
            ) : (
              <div className={styles.pythonStatusNeeded}>
                <span className={styles.pythonStatusNeededText}>
                  <HelpCircle size={12} />
                  Python setup needed
                </span>
                {onGetPythonHelp && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onGetPythonHelp}
                    className={styles.pythonHelpButton}
                  >
                    <Bot size={12} />
                    Get help setting up
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Verified source link */}
        {connection.catalogEntry?.verifiedSource && (
          <a
            href={connection.catalogEntry.verifiedSource}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.expandedConnectionLink}
          >
            <ExternalLink size={12} />
            Documentation
          </a>
        )}

        {/* Identity input for connectors with email/workspace identity (direct OAuth and bundled OAuth) */}
        {needsIdentityInput && (
          <div className={styles.setupView}>
            <div className={styles.setupUrlInput}>
              <label htmlFor="direct-identity-expanded">{identityInputLabel} <span style={{ color: 'var(--color-error)' }}>*</span></label>
              <input
                id="direct-identity-expanded"
                type={identityFieldDisplay.inputType}
                placeholder={identityFieldDisplay.placeholder}
                value={directEmail}
                onChange={(e) => setDirectEmail(e.target.value)}
                className={styles.advancedConfigNameInput}
                disabled={isConnecting}
              />
            </div>
            {/* Read-only mode checkbox for HubSpot */}
            {catalogEntry?.id === 'bundled-hubspot' && (
              <div className={styles.setupUrlInput} style={{ marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={hubspotReadOnlyMode}
                    onChange={(e) => setHubspotReadOnlyMode(e.target.checked)}
                    disabled={isConnecting}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ fontWeight: 500 }}>Read-only mode</span>
                    <span style={{ color: 'var(--color-muted-foreground)', marginLeft: 4 }}>(for free HubSpot accounts)</span>
                  </span>
                </label>
                <p style={{ fontSize: 12, color: 'var(--color-muted-foreground)', margin: '4px 0 0 24px' }}>
                  Connect without write permissions. You can view contacts, companies, and deals, but not create or modify them.
                </p>
              </div>
            )}
          </div>
        )}

        {/* OAuth hint for OAuth connectors */}
        {!isConnected && (catalogEntry?.mcpConfig?.oauth || catalogEntry?.bundledConfig?.authType === 'oauth') && (
          <span className={styles.setupHint} style={{ marginBottom: 8, display: 'block' }}>
            A browser window will open for you to sign in
          </span>
        )}

        {/* Advanced config section */}
        {canShowAdvanced && (
          <div className={styles.advancedConfigSection}>
            <button
              type="button"
              className={styles.advancedConfigToggle}
              onClick={handleToggleConfig}
              disabled={configLoading}
            >
              <span
                className={`${styles.advancedConfigChevron} ${showConfig ? styles.advancedConfigChevronExpanded : ''}`}
                aria-hidden
              >
                <ChevronRight size={12} />
              </span>
              {configLoading && <Loader2 size={12} className={styles.spinnerIcon} />}
              <span>{configLoading ? 'Loading advanced settings...' : 'Advanced settings'}</span>
            </button>

            <AnimatePresence>
              {showConfig && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className={styles.advancedConfigContent}
                >
                  {configError && (
                    <div className={styles.advancedConfigError}>{configError}</div>
                  )}
                  <div className={styles.advancedConfigNameField}>
                    <label className={styles.advancedConfigLabel}>Name</label>
                    <input
                      type="text"
                      className={styles.advancedConfigNameInput}
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      disabled={configSaving}
                      placeholder="Server name"
                    />
                  </div>
                  <div className={styles.advancedConfigEditor}>
                    <div className={styles.advancedConfigLabelRow}>
                      <label className={styles.advancedConfigLabel}>Configuration</label>
                      <Tooltip content={configCopied ? 'Copied!' : 'Copy as mcp.json entry'}>
                        <button
                          type="button"
                          className={styles.advancedConfigCopyButton}
                          onClick={handleCopyConfig}
                          aria-label={configCopied ? 'Copied!' : 'Copy configuration as mcp.json entry'}
                        >
                          {configCopied ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </Tooltip>
                    </div>
                    <textarea
                      className={styles.advancedConfigTextarea}
                      value={configJson}
                      onChange={(e) => setConfigJson(e.target.value)}
                      spellCheck={false}
                      rows={8}
                      disabled={configSaving}
                    />
                    <span 
                      className={`${styles.advancedConfigValidation} ${validationState.isValid ? styles.advancedConfigValid : styles.advancedConfigInvalid}`}
                      title={validationState.isValid ? 'Valid config' : validationState.errors.join('\n')}
                    />
                  </div>
                  {hasChanges && (
                    <div className={styles.advancedConfigActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfigJson(originalJson);
                          setEditedName(originalName);
                        }}
                        disabled={configSaving}
                      >
                        Reset
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveConfig}
                        disabled={configSaving || !validationState.isValid}
                      >
                        {configSaving ? (
                          <>
                            <Loader2 size={12} className={styles.spinnerIcon} />
                            Saving...
                          </>
                        ) : (
                          'Save'
                        )}
                      </Button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {!isConnected && !isInternal && (onConfigureWithRebel || onConnect) && !showSetupUI && (
        <>
          {deferredHelperText && (
            <p
              className={styles.expandedConnectionDeferredHelper}
              aria-live="polite"
              data-testid="connector-deferred-helper"
            >
              <Clock size={13} aria-hidden />
              {deferredHelperText}
            </p>
          )}
          <div className={styles.expandedConnectionFooterActions}>
            <div className={styles.expandedConnectionFooterPrimary}>
              {isActiveConnecting && onCancelConnect && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCancelConnect}
                >
                  Cancel
                </Button>
              )}
            </div>
            <div className={styles.expandedConnectionFooterSecondary}>
              {isConnectDeferred && deferredTooltipText ? (
                <Tooltip content={deferredTooltipText} maxWidth="280px">
                  <span
                    className={styles.expandedConnectionDeferredTooltipTarget}
                    tabIndex={0}
                    data-testid="connector-deferred-tooltip-target"
                  >
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onConnect?.(directEmail.trim() || undefined, {
                        ...(onConfigureWithRebel ? { launchRebel: true } : {}),
                        ...(catalogEntry?.id === 'bundled-hubspot' && { scopeTier: hubspotReadOnlyMode ? 'readonly' : 'full' }),
                      })}
                      disabled
                      className={`${styles.expandedConnectionFooterButton} ${styles.expandedConnectionPrimaryButton}`}
                      data-testid={`connector-connect-button-${connection.id}`}
                    >
                      <Clock size={14} />
                      Connect queued
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => onConnect?.(directEmail.trim() || undefined, {
                    ...(onConfigureWithRebel ? { launchRebel: true } : {}),
                    ...(catalogEntry?.id === 'bundled-hubspot' && { scopeTier: hubspotReadOnlyMode ? 'readonly' : 'full' }),
                  })}
                  disabled={isLoading || isConnecting || ((catalogEntry?.accountIdentity === 'email' || catalogEntry?.accountIdentity === 'workspace') && !directEmail.trim())}
                  className={`${styles.expandedConnectionFooterButton} ${styles.expandedConnectionPrimaryButton} ${isActiveConnecting ? styles.expandedConnectionConnecting : ''}`}
                  data-testid={`connector-connect-button-${connection.id}`}
                >
                  {isConnecting ? (
                    <Loader2 size={14} className={styles.spinnerIcon} />
                  ) : onConfigureWithRebel ? (
                    <Bot size={14} />
                  ) : (
                    <Plug size={14} />
                  )}
                  {isConnecting ? 'Setting up...' : onConfigureWithRebel ? 'Set up with Rebel' : 'Connect'}
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {isConnected && !isInternal && !showSetupUI && (onDisconnect || canToggleSelectedConnector || onConfigureWithRebel || onExtendConnector || canShowUpdateCredentialsButton) && (
        <>
          {deferredHelperText && (
            <p
              className={styles.expandedConnectionDeferredHelper}
              aria-live="polite"
              data-testid="connector-deferred-helper"
            >
              <Clock size={13} aria-hidden />
              {deferredHelperText}
            </p>
          )}
          <div className={styles.expandedConnectionFooterActions}>
            <div className={styles.expandedConnectionFooterPrimary}>
            {canShowUpdateCredentialsButton && (
              <Tooltip content={updateCredentialsPresentation.tooltip}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleUpdateClick()}
                  disabled={isLoading || isRemoving || setupSaving}
                  className={styles.expandedConnectionFooterButton}
                  data-testid="connector-update-credentials-button"
                >
                  {setupSaving ? (
                    <Loader2 size={14} className={styles.spinnerIcon} />
                  ) : (
                    <KeyRound size={14} />
                  )}
                  {updateCredentialsPresentation.label}
                </Button>
              </Tooltip>
            )}
            {onDisconnect && (
              isDisconnectDeferred && deferredTooltipText ? (
                <Tooltip content={deferredTooltipText} maxWidth="280px">
                  <span
                    className={styles.expandedConnectionDeferredTooltipTarget}
                    tabIndex={0}
                    data-testid="connector-deferred-tooltip-target"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDisconnect(activeServerName ?? undefined)}
                      disabled
                      className={styles.expandedConnectionFooterButton}
                      data-testid="connector-disconnect-button"
                    >
                      <Clock size={14} />
                      Disconnect queued
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDisconnect(activeServerName ?? undefined)}
                  disabled={isRemoving || isLoading}
                  className={styles.expandedConnectionFooterButton}
                  data-testid="connector-disconnect-button"
                >
                  {isActiveRemoving ? (
                    <>
                      <Loader2 size={14} className={styles.spinnerIcon} />
                      Disconnecting...
                    </>
                  ) : (
                    <>
                      <Unplug size={14} />
                      Disconnect
                    </>
                  )}
                </Button>
              )
            )}
            {canToggleSelectedConnector && (
              <Tooltip content={isServerDisabled ? 'Turn this connector back on.' : 'Turn this connector off without disconnecting it.'}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleToggleEnabled()}
                  disabled={isLoading || isRemoving || isToggling || isConnecting}
                  className={`${styles.expandedConnectionFooterButton} ${styles.expandedConnectionIconAction}`}
                  data-testid="connector-toggle-enabled-button"
                  aria-label={isServerDisabled ? 'Turn on connector' : 'Turn off connector'}
                >
                  {isToggling ? (
                    <Loader2 size={14} className={styles.spinnerIcon} />
                  ) : isServerDisabled ? (
                    <Play size={14} />
                  ) : (
                    <Pause size={14} />
                  )}
                </Button>
              </Tooltip>
            )}
            </div>
            <div className={styles.expandedConnectionFooterSecondary}>
            {onExtendConnector && (
              <Tooltip content="Get Rebel to add more tools or actions to this connector.">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    onExtendConnector();
                  }}
                  disabled={isLoading || isRemoving}
                  className={`${styles.expandedConnectionFooterButton} ${styles.expandedConnectionPrimaryButton}`}
                  data-testid="connector-extend-button"
                >
                  Add more tools
                </Button>
              </Tooltip>
            )}
            </div>
          </div>
        </>
      )}

    </motion.div>
  );
}
