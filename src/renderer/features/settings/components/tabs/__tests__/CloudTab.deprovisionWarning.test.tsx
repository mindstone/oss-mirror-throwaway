// @vitest-environment happy-dom

/**
 * C-F3 render test. After a partial deprovision the hook sets
 * `provisionError` with `severity:'warning'` (proven in
 * `useCloudProvisioning.deprovisionPartial.test.ts`), but the realized
 * post-wipe UI state is `mode==='local'` → `isSetupNeeded` is false → the
 * setup-form banner sites at CloudTab :1634/:1947 unmount. This test mounts the
 * REAL CloudTab in that exact post-deprovision state and asserts the warning
 * banner is VISIBLE in the DOM (the kind of test the final review found missing).
 *
 * Red→green: with the warning rendered only inside the `{isSetupNeeded && ...}`
 * block, this fails (no banner in mode==='local'); it passes once the banner
 * also renders in the local-mode surface.
 */

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

type Mounted = { container: HTMLDivElement; root: Root; unmount: () => void };

function localCloud(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  // The post-deprovision wipe: settings are back to local mode (no URL/token).
  return { mode: 'local', ...overrides } as CloudInstanceConfig;
}

function settings(cloudInstance = localCloud()): AppSettings {
  return { cloudInstance, managedCloudEnabled: true } as AppSettings;
}

function installWindowApis() {
  const win = window as unknown as Record<string, unknown>;
  win.cloudApi = {
    exportDiagnostics: vi.fn().mockResolvedValue({ success: true }),
    shareList: vi.fn().mockResolvedValue({ success: true, shares: [] }),
    getVolumeStatus: vi.fn().mockResolvedValue({ kind: 'ok', sizeGb: 100, totalBytes: 0, usedBytes: 0, availableBytes: 0, lastCheckedAt: Date.now() }),
  };
  win.appApi = { openUrl: vi.fn() };
  win.cloudContinuityApi = { getAll: vi.fn().mockResolvedValue({}) };
}

// Post-deprovision connection state: mode flipped to local, setup NOT needed.
function postDeprovisionConnection() {
  return {
    mode: 'local',
    isConnected: false,
    isSetupNeeded: false,
    status: 'not_configured',
    urlInput: '',
    tokenInput: '',
    setUrlInput: vi.fn(),
    setTokenInput: vi.fn(),
    connectError: null,
    connectPhase: null,
    setConnectError: vi.fn(),
    confirmDisconnect: false,
    cloudHealth: null,
    outboxStatus: null,
    continuityStats: { cloudActive: 0, pinned: 0 },
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
    flyLinkTokenInput: '',
    setFlyLinkTokenInput: vi.fn(),
    flyLinkBusy: false,
    flyLinkError: null,
    hasFlyToken: false,
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
    orphanedManaged: false,
    reattachBusy: false,
    reattachError: null,
    footprint: null,
    footprintLoading: false,
    volumeSizeGb: 10,
    setVolumeSizeGb: vi.fn(),
    customizing: false,
    setCustomizing: vi.fn(),
    handleProvision: vi.fn(),
    handleProvisionAndMigrate: vi.fn(),
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
    handleReattachManaged: vi.fn(),
    handleDestroyOrphanedManaged: vi.fn(),
    resetProvisionProgress: vi.fn(),
    ...overrides,
  };
}

function baseCapacity() {
  return {
    volume: null,
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
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

const PARTIAL_WARNING_MESSAGE =
  'Cleared on this device, but the cloud may still be running. Remove it manually from your provider dashboard.';

function setupPostDeprovision(provisioningOverrides: Record<string, unknown> = {}) {
  mockState.connection = postDeprovisionConnection();
  mockState.sync = baseSync();
  mockState.provisioning = baseProvisioning(provisioningOverrides);
  mockState.capacity = baseCapacity();
  return settings(localCloud());
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

describe('CloudTab — partial-deprovision warning (C-F3)', () => {
  it('renders the warning banner in the post-deprovision local-mode state', () => {
    const draft = setupPostDeprovision({
      provisionError: {
        userMessage: PARTIAL_WARNING_MESSAGE,
        severity: 'warning',
      },
    });

    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    // Sanity: we are in the post-wipe local-mode state where the setup form is
    // NOT mounted (so the only way the warning shows is the local-mode render
    // site this fix added).
    expect(container.textContent).not.toContain('Enable Mindstone Cloud');

    const banner = container.querySelector('[data-testid="cloud-provision-error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(PARTIAL_WARNING_MESSAGE);

    unmount();
  });

  it('does NOT render a warning banner when there is no provisionError', () => {
    const draft = setupPostDeprovision({ provisionError: null });

    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    expect(container.querySelector('[data-testid="cloud-provision-error-banner"]')).toBeNull();

    unmount();
  });
});
