// @vitest-environment happy-dom
 

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';
import { CloudTab } from '../CloudTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.hoisted(() => vi.fn());
const mockState = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  sync: {} as Record<string, unknown>,
  provisioning: {} as Record<string, unknown>,
  capacity: {} as Record<string, unknown>,
}));

vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useNavigationSafe: () => ({ navigate: mockNavigate }),
}));

vi.mock('@renderer/contexts/AppContext', () => ({
  useAppContextSafe: () => ({ emitLog: vi.fn() }),
}));

vi.mock('../../../hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockState.connection,
}));

vi.mock('../../../hooks/useCloudSync', () => ({
  useCloudSync: () => mockState.sync,
}));

vi.mock('../../../hooks/useCloudProvisioning', () => ({
  useCloudProvisioning: () => mockState.provisioning,
}));

vi.mock('../../../hooks/useCloudCapacity', () => ({
  useCloudCapacity: () => mockState.capacity,
}));

vi.mock('../../../hooks/useCloudStatusRefresh', () => ({
  useCloudStatusRefresh: vi.fn(),
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function connectedCloud(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    mode: 'cloud',
    cloudUrl: 'https://test.fly.dev',
    cloudToken: 'test-token',
    provisionMode: 'byok',
    providerId: 'fly',
    flyAppName: 'test-app',
    flyMachineId: 'machine-1',
    flyRegion: 'iad',
    vmTierId: 'standard',
    lastKnownStatus: 'running',
    lastSyncedAt: Date.now(),
    ...overrides,
  } as CloudInstanceConfig;
}

function settings(cloudInstance = connectedCloud()): AppSettings {
  return {
    cloudInstance,
    managedCloudEnabled: true,
  } as AppSettings;
}

function makeCloudApi() {
  return {
    exportDiagnostics: vi.fn().mockResolvedValue({
      success: true,
      bundle: {
        remote: {
          recentLogs: [
            { timestamp: '2026-05-09T12:00:00Z', level: 'info', msg: 'cloud log line' },
          ],
        },
      },
    }),
    shareList: vi.fn().mockResolvedValue({ success: true, shares: [] }),
    shareRevoke: vi.fn().mockResolvedValue({ success: true }),
    getVmTier: vi.fn().mockResolvedValue({ success: true }),
    changeVmTier: vi.fn().mockResolvedValue({ success: true }),
    getVolumeStatus: vi.fn().mockResolvedValue({
      kind: 'ok',
      sizeGb: 100,
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 10 * 1024 ** 3,
      availableBytes: 90 * 1024 ** 3,
      lastCheckedAt: Date.now(),
    }),
    resizeVolume: vi.fn().mockResolvedValue({ success: true }),
  };
}

function installWindowApis(cloudApi = makeCloudApi()) {
  const win = window as unknown as Record<string, unknown>;
  win.cloudApi = cloudApi;
  win.appApi = { openUrl: vi.fn() };
  win.cloudContinuityApi = { getAll: vi.fn().mockResolvedValue({}) };
  return cloudApi;
}

function baseConnection() {
  return {
    mode: 'cloud',
    isConnected: true,
    isSetupNeeded: false,
    status: 'running',
    urlInput: '',
    tokenInput: '',
    setUrlInput: vi.fn(),
    setTokenInput: vi.fn(),
    connectError: null,
    connectPhase: null,
    setConnectError: vi.fn(),
    confirmDisconnect: false,
    cloudHealth: {
      status: 'ok',
      version: '1.2.3',
      buildCommit: 'abcdef1',
      buildDate: '2026-05-09T12:00:00Z',
      uptimeSeconds: 3600,
    },
    outboxStatus: null,
    continuityStats: { cloudActive: 1, pinned: 0 },
    copiedField: null,
    busy: false,
    setBusy: vi.fn(),
    handleDisconnect: vi.fn(),
    handleCheckHealth: vi.fn(),
    handleCopyField: vi.fn(),
    handleOpenWebLink: vi.fn(),
    handleModeChange: vi.fn(),
    handleConnect: vi.fn(),
    refreshCloudStatus: vi.fn(),
  };
}

function baseSync() {
  return {
    migrationProgress: null,
    migrationResult: null,
    migrationResultIsError: false,
    syncInProgress: false,
    confirmFullResync: false,
    setConfirmFullResync: vi.fn(),
    handleSync: vi.fn(),
    handleFullResync: vi.fn().mockResolvedValue(undefined),
    migrate: vi.fn(),
    clearResults: vi.fn(),
    setMigrationResult: vi.fn(),
    setMigrationResultIsError: vi.fn(),
    setMigrationProgress: vi.fn(),
    __resetForTesting: vi.fn(),
  };
}

function baseProvisioning(overrides: Record<string, unknown> = {}) {
  return {
    selectedProvider: 'fly',
    setSelectedProvider: vi.fn(),
    showByokPicker: false,
    setShowByokPicker: vi.fn(),
    providerConfig: { id: 'fly', name: 'Fly.io' },
    providerTokenInput: '',
    setProviderTokenInput: vi.fn(),
    showManualSetup: false,
    setShowManualSetup: vi.fn(),
    showTokenHelp: false,
    setShowTokenHelp: vi.fn(),
    provisionBusy: false,
    provisionError: null,
    setProvisionError: vi.fn(),
    provisionProgress: null,
    provisionCleanupMessage: null,
    selectedRegion: 'iad',
    setSelectedRegion: vi.fn(),
    doReconnectNeeded: false,
    confirmDeprovision: false,
    doOAuthStatus: { connected: false },
    doOAuthLoading: false,
    showPatFallback: false,
    setShowPatFallback: vi.fn(),
    switchInProgress: false,
    switchError: null,
    setSwitchError: vi.fn(),
    showSwitchDialog: false,
    setShowSwitchDialog: vi.fn(),
    switchProviderSelection: 'fly',
    setSwitchProviderSelection: vi.fn(),
    switchTokenInput: '',
    setSwitchTokenInput: vi.fn(),
    switchCleanupWarning: null,
    setSwitchCleanupWarning: vi.fn(),
    flyLinkTokenInput: 'FlyV1 token',
    setFlyLinkTokenInput: vi.fn(),
    flyLinkBusy: false,
    flyLinkError: null,
    hasFlyToken: true,
    flyDiagnostic: null,
    repairIngressBusy: false,
    repairIngressResult: null,
    repairIngressError: null,
    repairTokenBusy: false,
    repairTokenResult: null,
    repairTokenError: null,
    repairTokenConflict: false,
    repairFlyTokenBusy: false,
    repairFlyTokenResult: null,
    repairFlyTokenError: null,
    updateStatus: 'idle',
    updateError: null,
    updateProgress: null,
    currentChannel: 'stable',
    confirmChannelSwitch: false,
    setConfirmChannelSwitch: vi.fn(),
    discoveryResult: null,
    conflictResolving: false,
    conflictResolveError: null,
    lastConflictKeepRef: null,
    footprint: null,
    footprintLoading: false,
    volumeSizeGb: 10,
    setVolumeSizeGb: vi.fn(),
    customizing: false,
    setCustomizing: vi.fn(),
    handleProvision: vi.fn(),
    handleDeprovision: vi.fn().mockResolvedValue(undefined),
    handleSwitchProvider: vi.fn(),
    handleStartDigitalOceanOAuth: vi.fn(),
    handleDisconnectDigitalOceanOAuth: vi.fn(),
    connectorSetupGuidance: { guidance: null, isOpen: false, handleResult: vi.fn(), open: vi.fn(), setOpen: vi.fn(), close: vi.fn() },
    handleCheckForUpdate: vi.fn(),
    handleApplyUpdate: vi.fn(),
    handleChannelToggle: vi.fn(),
    handleStopWaiting: vi.fn(),
    handleLinkFlyToken: vi.fn(),
    handleRepairIngress: vi.fn(),
    handleRepairToken: vi.fn(),
    handleRepairFlyToken: vi.fn(),
    handleResolveConflict: vi.fn(),
    ...overrides,
  };
}

function baseCapacity() {
  return {
    volume: {
      kind: 'ok',
      sizeGb: 100,
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 10 * 1024 ** 3,
      availableBytes: 90 * 1024 ** 3,
      lastCheckedAt: Date.now(),
    },
    loading: false,
    resizing: false,
    resizeResult: null,
    lastTierChangeSuccess: null,
    dismissTierChangeNotice: vi.fn(),
    recordTierChangeSuccess: vi.fn(),
    setResizeResult: vi.fn(),
    pollNow: vi.fn(),
    resize: vi.fn(),
  };
}

function resetHookState(overrides: {
  provisioning?: Record<string, unknown>;
  cloud?: Partial<CloudInstanceConfig>;
} = {}) {
  mockState.connection = baseConnection();
  mockState.sync = baseSync();
  mockState.provisioning = baseProvisioning(overrides.provisioning);
  mockState.capacity = baseCapacity();
  return settings(connectedCloud(overrides.cloud));
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: Element | null) {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function renderCloudTab(draftSettings = resetHookState()) {
  return mount(<CloudTab draftSettings={draftSettings} updateDraft={vi.fn()} />);
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  const win = window as unknown as Record<string, unknown>;
  delete win.cloudApi;
  delete win.appApi;
  delete win.cloudContinuityApi;
  delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = false;
  installWindowApis();
});

describe('CloudTab OSS managed-cloud visibility', () => {
  function setupUnconnectedCloudTab(isOss: boolean) {
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = isOss;
    const draft = resetHookState();
    draft.cloudInstance = { mode: 'local' } as CloudInstanceConfig;
    draft.managedCloudEnabled = true;
    mockState.connection = {
      ...baseConnection(),
      mode: 'cloud',
      isConnected: false,
      isSetupNeeded: true,
      status: 'not_configured',
    };
    return renderCloudTab(draft);
  }

  it('hides managed setup and renders the BYOK picker in OSS', () => {
    const { container, unmount } = setupUnconnectedCloudTab(true);

    expect(container.textContent).not.toContain('Enable Mindstone Cloud');
    expect(container.textContent).not.toContain('Managed by Mindstone');
    expect(container.textContent).toContain('Get started');
    expect(container.textContent).toContain('Fly.io');
    expect(container.querySelector('input[name="cloud-provider"][value="fly"]')).not.toBeNull();

    unmount();
  });

  it('keeps managed setup visible in enterprise when enabled', () => {
    const { container, unmount } = setupUnconnectedCloudTab(false);

    expect(container.textContent).toContain('Mindstone Cloud');
    expect(container.textContent).toContain('Enable Mindstone Cloud');
    expect(container.textContent).not.toContain('Get started');

    unmount();
  });
});

describe('CloudTab AdvancedTroubleshootingDrawer', () => {
  it('is closed by default', () => {
    const { container, unmount } = renderCloudTab();

    expect(container.querySelector('[data-testid="cloud-advanced-troubleshooting-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-advanced-troubleshooting-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="cloud-advanced-troubleshooting-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="cloud-full-resync-button"]')).toBeNull();
    expect(container.textContent).not.toContain('Connection details');

    unmount();
  });

  it('opens to reveal moved subsections and closes to hide them', () => {
    const { container, unmount } = renderCloudTab();
    const toggle = container.querySelector('[data-testid="cloud-advanced-troubleshooting-toggle"]');

    click(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="cloud-connection-details-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-full-resync-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-auto-update-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-recent-logs-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-report-bug-button"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-channel-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cloud-deprovision-section"]')).not.toBeNull();

    click(toggle);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="cloud-advanced-troubleshooting-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="cloud-deprovision-section"]')).toBeNull();

    unmount();
  });

  it('renders connected sections in the contracted order', () => {
    const { container, unmount } = renderCloudTab();

    const titles = Array.from(container.querySelectorAll('section h2'))
      .map((heading) => heading.textContent?.trim())
      .filter((title): title is string => Boolean(title))
      .filter((title) => title !== 'Cloud continuity');

    expect(titles).toEqual([
      'Continuity is on',
      'Cloud capacity',
      'Continue on mobile',
      'Continue on web',
      'Messaging',
      'Who can message Rebel',
      'Recent message attempts',
      'Shared conversations',
      'Advanced troubleshooting',
    ]);

    unmount();
  });

  it('keeps moved subsection actions wired', async () => {
    const cloudApi = installWindowApis();
    const draftSettings = resetHookState();
    const { container, unmount } = renderCloudTab(draftSettings);

    click(container.querySelector('[data-testid="cloud-advanced-troubleshooting-toggle"]'));

    click(container.querySelector('[data-testid="cloud-full-resync-button"]'));
    expect(mockState.sync.handleFullResync).toHaveBeenCalledTimes(1);

    click(container.querySelector('[data-testid="cloud-channel-toggle"]'));
    expect(mockState.provisioning.setConfirmChannelSwitch).toHaveBeenCalledWith(true);

    click(container.querySelector('[data-testid="cloud-deprovision-button"]'));
    expect(mockState.provisioning.handleDeprovision).toHaveBeenCalledTimes(1);

    click(container.querySelector('[data-testid="cloud-repair-fly-token-button"]'));
    expect(mockState.provisioning.handleRepairFlyToken).toHaveBeenCalledTimes(1);

    click(container.querySelector('[data-testid="cloud-recent-logs-toggle"]'));
    await flushAsyncWork();
    expect(cloudApi.exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('cloud log line');

    click(container.querySelector('[data-testid="cloud-report-bug-button"]'));
    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'feedback',
      feedbackType: 'bug',
    }));

    unmount();
  });

  it('keeps Fly token linking inside the drawer when token recovery is needed', () => {
    const draftSettings = resetHookState({ provisioning: { hasFlyToken: false } });
    const { container, unmount } = renderCloudTab(draftSettings);

    expect(container.textContent).not.toContain('Connect Fly.io access token');

    click(container.querySelector('[data-testid="cloud-advanced-troubleshooting-toggle"]'));
    expect(container.querySelector('[data-testid="cloud-link-fly-token-section"]')).not.toBeNull();
    expect(container.textContent).toContain('Connect Fly.io access token');

    click(container.querySelector('[data-testid="cloud-link-fly-token-button"]'));
    expect(mockState.provisioning.handleLinkFlyToken).toHaveBeenCalledTimes(1);

    unmount();
  });
});

describe('CloudTab cloud-update rollback notice', () => {
  function setRolledBack(quarantinedTags: string[] = ['ghcr.io/mindstone/rebel-cloud:prod-bad']) {
    (mockState.connection.cloudHealth as Record<string, unknown>).cloudUpdate = {
      status: 'recently-rolled-back',
      quarantinedTags,
    };
  }

  it('managed: shows a soft "we are handling it" notice', () => {
    const draft = resetHookState({ cloud: { provisionMode: 'managed' } });
    setRolledBack();
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    const notice = container.querySelector('[data-testid="cloud-rollback-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Mindstone is handling it');
    expect(notice?.textContent).toContain('No action needed');
    unmount();
  });

  it('byok: shows the (non-managed) auto-recovered notice', () => {
    const draft = resetHookState({ cloud: { provisionMode: 'byok' } });
    setRolledBack();
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    const notice = container.querySelector('[data-testid="cloud-rollback-notice"]');
    expect(notice).not.toBeNull();
    // BYOK branch (the "Check for updates" nudge itself is gated on the update
    // controls being rendered — covered precisely in the cloudTabUtils unit tests).
    expect(notice?.textContent).toContain('running normally on an earlier build');
    expect(notice?.textContent).not.toContain('Mindstone is handling it');
    unmount();
  });

  it('renders no notice when the cloud reports a normal (non-rolled-back) update status', () => {
    const draft = resetHookState({ cloud: { provisionMode: 'byok' } });
    // baseConnection().cloudHealth has no cloudUpdate field → no notice.
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);
    expect(container.querySelector('[data-testid="cloud-rollback-notice"]')).toBeNull();
    unmount();
  });
});
