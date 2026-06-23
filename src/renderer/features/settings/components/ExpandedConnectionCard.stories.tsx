import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useRef } from 'react';

import { ToastProvider } from '@renderer/components/ui';
import { ExpandedConnectionCard } from './ExpandedConnectionCard';
import { createUntrackedConnectionCardOps } from './useConnectionCardOps';
import type { UnifiedConnection, ConnectionInstance } from '../hooks/useUnifiedConnections';
import type { ConnectorCatalog, ConnectorCatalogEntry, McpServerConfigDetails } from '@shared/types';
import catalogData from '../../../../../resources/connector-catalog.json';

const catalog = catalogData as ConnectorCatalog;

const meta = {
  title: 'Settings/Expanded Connection Card',
  component: ExpandedConnectionCard,
  parameters: {
    layout: 'centered',
    controls: { disable: true },
  },
} satisfies Meta<typeof ExpandedConnectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

type SaveMode = 'resolve' | 'pending' | 'reject';
type ValidationMode = 'ok' | 'error' | 'unavailable' | 'pending';

function catalogEntry(id: string): ConnectorCatalogEntry {
  const entry = catalog.connectors.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Story fixture catalog entry not found: ${id}`);
  }
  return entry;
}

const gammaEntry = catalogEntry('bundled-gamma');
const klingEntry = catalogEntry('bundled-kling');
const slackEntry = catalogEntry('bundled-slack');

const internalApiKeyEntry: ConnectorCatalogEntry = {
  id: 'story-internal-api-key',
  name: 'Internal MCP',
  description: 'Internal connector baseline.',
  category: 'productivity',
  icon: 'bot',
  provider: 'bundled',
  requiresSetup: true,
  isInternal: true,
  accountIdentity: 'email',
  bundledConfig: {
    authType: 'api-key',
    serverName: 'InternalMcp',
  },
  setupFields: [
    {
      id: 'apiKey',
      label: 'Internal API Key',
      type: 'password',
      envVar: 'INTERNAL_API_KEY',
    },
  ],
};

function serverNameFor(entry: ConnectorCatalogEntry): string {
  return entry.bundledConfig?.serverName ?? entry.name;
}

function connectedConnection(
  entry: ConnectorCatalogEntry,
  status: UnifiedConnection['status'] = 'connected',
): UnifiedConnection {
  const serverName = serverNameFor(entry);
  const health = status === 'error' ? 'error' : 'ok';
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status,
    provider: entry.provider,
    catalogEntry: entry,
    serverPreview: {
      name: serverName,
      transport: 'stdio',
      health,
      catalogId: entry.id,
      email: 'story@example.com',
      toolCount: entry.tools?.length ?? 0,
    },
    health,
    toolCount: entry.tools?.length ?? 0,
  };
}

function availableConnection(entry: ConnectorCatalogEntry): UnifiedConnection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    status: 'available',
    provider: entry.provider,
    catalogEntry: entry,
  };
}

function detailsFor(entry: ConnectorCatalogEntry): McpServerConfigDetails {
  const env: Record<string, string> = {};
  for (const field of entry.setupFields ?? []) {
    if (!field.envVar) continue;
    if (field.id === 'apiKey') {
      env[field.envVar] = 'saved-api-key';
    } else if (field.id === 'accessKey') {
      env[field.envVar] = 'saved-access-key';
    } else if (field.id === 'secretKey') {
      env[field.envVar] = 'saved-secret-key';
    }
  }

  return {
    name: serverNameFor(entry),
    type: null,
    transport: 'stdio',
    command: 'npx',
    args: [],
    url: null,
    cwd: null,
    env,
    headers: null,
    description: entry.description,
    catalogId: entry.id,
    email: 'story@example.com',
    workspace: null,
    lastConnectedAt: Date.now() - 60_000,
  };
}

function installStoryApis(entry: ConnectorCatalogEntry, saveMode: SaveMode, validationMode: ValidationMode): void {
  Object.assign(window, {
    appApi: {
      openUrl: async () => undefined,
    },
    miscApi: {
      mcpCheckHealth: async () => ({ health: 'ok' }),
    },
    settingsApi: {
      mcpListTools: async () => ({ tools: [], nextPageToken: null }),
      mcpToggleServerEnabled: async () => ({ success: true }),
      mcpAddBundledServer: async () => {
        if (saveMode === 'pending') {
          return new Promise(() => undefined);
        }
        if (saveMode === 'reject') {
          throw new Error('The new credentials were rejected.');
        }
        return { success: true };
      },
      mcpValidateServer: async () => {
        if (validationMode === 'pending') {
          return new Promise(() => undefined);
        }
        if (validationMode === 'error') {
          return { status: 'error', error: 'The new credentials were rejected.' };
        }
        if (validationMode === 'unavailable') {
          return { status: 'unavailable' };
        }
        return { status: 'ok' };
      },
      get: async () => ({}),
      update: async () => ({ success: true }),
    },
  });

  // Keep the fixture entry referenced so each story installs APIs for the card it renders.
  void entry;
}

function StoryFrame({
  connection,
  loadEntry,
  saveMode = 'resolve',
  validationMode = 'ok',
  autoOpenUpdate = false,
  autoSave = false,
  isConnecting = false,
  isRemoving = false,
  deferredKind,
}: {
  connection: UnifiedConnection;
  loadEntry: ConnectorCatalogEntry;
  saveMode?: SaveMode;
  validationMode?: ValidationMode;
  autoOpenUpdate?: boolean;
  autoSave?: boolean;
  isConnecting?: boolean;
  isRemoving?: boolean;
  deferredKind?: 'connect' | 'disconnect';
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  installStoryApis(loadEntry, saveMode, validationMode);
  const ops = useMemo(() => createUntrackedConnectionCardOps(
    'storybook card fixture has no queued-state owner',
    {
      addBundledServer: (payload) => window.settingsApi.mcpAddBundledServer(payload),
      upsertServer: async () => undefined,
      removeServer: async () => undefined,
      toggleServerEnabled: (serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId }),
    },
  ), []);

  useEffect(() => {
    if (!autoOpenUpdate) {
      return undefined;
    }

    let stopped = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const clickWhenAvailable = (selector: string, next?: () => void) => {
      const attempt = () => {
        if (stopped) return;
        const button = ref.current?.querySelector<HTMLButtonElement>(selector);
        if (button) {
          button.click();
          next?.();
          return;
        }
        timers.push(setTimeout(attempt, 50));
      };
      attempt();
    };

    clickWhenAvailable('[data-testid="connector-update-credentials-button"]', () => {
      if (autoSave) {
        clickWhenAvailable('[data-testid="connector-setup-save-button"]');
      }
    });

    return () => {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [autoOpenUpdate, autoSave]);

  return (
    <div ref={ref} className="light" style={{ width: 720, maxWidth: '100%' }}>
      <ToastProvider>
        <ExpandedConnectionCard
          connection={connection}
          onClose={() => undefined}
          onConnect={() => undefined}
          onDisconnect={() => undefined}
          onLoadServer={async () => detailsFor(loadEntry)}
          ops={ops}
          onRefresh={() => undefined}
          isConnecting={isConnecting}
          isRemoving={isRemoving}
          deferredKind={deferredKind}
          onCancelConnect={() => undefined}
        />
      </ToastProvider>
    </div>
  );
}

function story(args: Parameters<typeof StoryFrame>[0]): Story {
  return {
    render: () => <StoryFrame {...args} />,
  };
}

export const ConnectedHealthyUpdateKeyFooter = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
  }),
  name: 'Connected — Healthy — Update key footer (single-secret)',
};

export const ConnectedHealthyUpdateDetailsFooter = {
  ...story({
    connection: connectedConnection(klingEntry),
    loadEntry: klingEntry,
  }),
  name: 'Connected — Healthy — Update details footer (multi-field)',
};

export const ConnectedHealthyOauthNoUpdateButton = {
  ...story({
    connection: connectedConnection(slackEntry),
    loadEntry: slackEntry,
  }),
  name: 'Connected — Healthy — OAuth (no update button)',
};

export const UpdateFormSingleSecretOpen = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    autoOpenUpdate: true,
  }),
  name: 'Update form — single-secret — open',
};

export const UpdateFormMultiFieldOpen = {
  ...story({
    connection: connectedConnection(klingEntry),
    loadEntry: klingEntry,
    autoOpenUpdate: true,
  }),
  name: 'Update form — multi-field — open',
};

export const UpdateFormSavingSpinner = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    saveMode: 'pending',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — saving spinner',
};

export const UpdateFormSaveError = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    saveMode: 'reject',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — save error',
};

export const UpdateFormSavedValidationPending = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    validationMode: 'pending',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — saved (validation pending)',
};

export const UpdateFormSavedValidationOk = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    validationMode: 'ok',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — saved + validation ok',
};

export const UpdateFormSavedValidationFailed = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    validationMode: 'error',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — saved + validation failed',
};

export const UpdateFormSavedValidationUnavailable = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    validationMode: 'unavailable',
    autoOpenUpdate: true,
    autoSave: true,
  }),
  name: 'Update form — saved + validation unavailable',
};

export const ConnectedHealthyInternalNoUpdateButton = {
  ...story({
    connection: connectedConnection(internalApiKeyEntry),
    loadEntry: internalApiKeyEntry,
  }),
  name: 'Connected — Healthy — Internal MCP (no update button)',
};

export const ConnectedAuthFailureNoticeSingleSecret = {
  ...story({
    connection: connectedConnection(gammaEntry, 'error'),
    loadEntry: gammaEntry,
  }),
  name: 'Connected — Auth-failure — Notice (single-secret)',
};

export const ConnectedAuthFailureNoticeMultiField = {
  ...story({
    connection: connectedConnection(klingEntry, 'error'),
    loadEntry: klingEntry,
  }),
  name: 'Connected — Auth-failure — Notice (multi-field)',
};

export const ConnectedAuthFailureNoticeFormOpen = {
  ...story({
    connection: connectedConnection(gammaEntry, 'error'),
    loadEntry: gammaEntry,
    autoOpenUpdate: true,
  }),
  name: 'Connected — Auth-failure — Notice + form open',
};

export const DisconnectedFreshSetup = {
  ...story({
    connection: availableConnection(gammaEntry),
    loadEntry: gammaEntry,
  }),
  name: 'Disconnected — fresh setup',
};

export const ActiveConnecting = {
  ...story({
    connection: availableConnection(gammaEntry),
    loadEntry: gammaEntry,
    isConnecting: true,
  }),
  name: 'Active — connecting',
};

export const ActiveDisconnecting = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    isRemoving: true,
  }),
  name: 'Active — disconnecting',
};

export const DeferredConnectQueued = {
  ...story({
    connection: availableConnection(gammaEntry),
    loadEntry: gammaEntry,
    isConnecting: true,
    deferredKind: 'connect',
  }),
  name: 'Deferred — connect queued',
};

export const DeferredDisconnectQueued = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
    isRemoving: true,
    deferredKind: 'disconnect',
  }),
  name: 'Deferred — disconnect queued',
};

export const DoneConnected = {
  ...story({
    connection: connectedConnection(gammaEntry),
    loadEntry: gammaEntry,
  }),
  name: 'Done — connected',
};

export const ErrorNeedsAttention = {
  ...story({
    connection: connectedConnection(gammaEntry, 'error'),
    loadEntry: gammaEntry,
  }),
  name: 'Error — needs attention',
};

// ---------------------------------------------------------------------------
// Stage 3 (260611_calendar-cache-attention): per-account Google Workspace
// reconnect state. Storybook coverage required by the Picker Decision
// (Designer F7 / DSR F2): multi-account with one LONG-email sign-in-expired
// account + one healthy, AND single-account sign-in-expired. Review in BOTH
// themes via the global theme toolbar (these frames deliberately do not pin a
// theme class). The generic "Error — needs attention" story above is NOT a
// substitute — needsReconnect is a distinct, account-scoped state.
// ---------------------------------------------------------------------------

const googleEntry = catalogEntry('bundled-google');

const GW_LONG_EMAIL = '[external-email]';
const GW_LONG_EMAIL_SLUG = 'GoogleWorkspace-firstname-lastname-subdomain-company-name-co-uk';
const GW_HEALTHY_EMAIL = '[Mindstone-email]';
const GW_HEALTHY_SLUG = 'GoogleWorkspace-teammember-mindstone-com';

function googleWorkspaceConnection(instances: ConnectionInstance[]): UnifiedConnection {
  return {
    id: 'catalog:bundled-google',
    name: googleEntry.name,
    description: googleEntry.description,
    icon: googleEntry.icon,
    status: 'connected',
    provider: googleEntry.provider,
    catalogEntry: googleEntry,
    serverPreview: {
      name: instances[0].serverName,
      transport: 'stdio',
      health: 'ok',
      catalogId: googleEntry.id,
      email: instances[0].label,
      toolCount: 12,
    },
    health: 'ok',
    toolCount: 12,
    instances,
  };
}

function installGoogleWorkspaceStoryApis(emails: string[]): void {
  installStoryApis(googleEntry, 'resolve', 'ok');
  Object.assign(window, {
    contributionApi: {
      list: async () => ({ contributions: [] }),
    },
    calendarApi: {
      listAvailableCalendars: async () => ({ success: true, calendars: [] }),
      triggerSync: async () => ({ success: true }),
    },
    googleWorkspaceApi: {
      getAccounts: async () => ({
        accounts: emails.map((email) => ({
          email,
          category: 'personal',
          description: 'Connected via Rebel',
          status: 'active' as const,
        })),
      }),
      startAuth: async () => ({ success: true, email: emails[0] }),
      removeAccount: async () => ({ success: true }),
      cancelAuth: async () => undefined,
    },
  });
}

function GoogleWorkspaceStoryFrame({
  instances,
  emails,
}: {
  instances: ConnectionInstance[];
  emails: string[];
}) {
  installGoogleWorkspaceStoryApis(emails);
  const ops = useMemo(() => createUntrackedConnectionCardOps(
    'storybook google-workspace fixture has no queued-state owner',
    {
      addBundledServer: (payload) => window.settingsApi.mcpAddBundledServer(payload),
      upsertServer: async () => undefined,
      removeServer: async () => undefined,
      toggleServerEnabled: (serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId }),
    },
  ), []);
  return (
    // No hardcoded theme class: the global Storybook theme toolbar must be
    // able to drive both light and dark review of this state.
    <div style={{ width: 720, maxWidth: '100%' }}>
      <ToastProvider>
        <ExpandedConnectionCard
          connection={googleWorkspaceConnection(instances)}
          onClose={() => undefined}
          onConnect={() => undefined}
          onDisconnect={() => undefined}
          ops={ops}
          onRefresh={() => undefined}
        />
      </ToastProvider>
    </div>
  );
}

export const GoogleWorkspaceMultiAccountSignInExpired: Story = {
  render: () => (
    <GoogleWorkspaceStoryFrame
      instances={[
        { serverName: GW_HEALTHY_SLUG, label: GW_HEALTHY_EMAIL, health: 'ok' },
        { serverName: GW_LONG_EMAIL_SLUG, label: GW_LONG_EMAIL, health: 'ok', needsReconnect: true },
      ]}
      emails={[GW_HEALTHY_EMAIL, GW_LONG_EMAIL]}
    />
  ),
  name: 'Google Workspace — multi-account — sign-in expired (long email truncation)',
};

export const GoogleWorkspaceSingleAccountSignInExpired: Story = {
  render: () => (
    <GoogleWorkspaceStoryFrame
      instances={[
        { serverName: GW_LONG_EMAIL_SLUG, label: GW_LONG_EMAIL, health: 'ok', needsReconnect: true },
      ]}
      emails={[GW_LONG_EMAIL]}
    />
  ),
  name: 'Google Workspace — single account — sign-in expired',
};
