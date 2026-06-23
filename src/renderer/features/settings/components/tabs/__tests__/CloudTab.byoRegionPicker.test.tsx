// @vitest-environment happy-dom

/**
 * Region-picker render test for the BYO-Fly provisioning form.
 *
 * Background: self-hosted Fly provisioning could fail with a region-capacity
 * error ("insufficient resources to create new machine with existing volume"),
 * but the BYO form had no way to change the region — `selectedRegion` was
 * stuck at `detectNearestRegion()`'s output, so users retried straight into
 * the same wall. This test mounts the REAL CloudTab in the BYO-Fly setup state
 * and asserts a region <select> renders with the expected default + options,
 * mirroring the managed-region picker.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { CloudTab } from '../CloudTab';
import { MANAGED_REGIONS } from '../cloudTabUtils';

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

function settings(): AppSettings {
  // managedCloudEnabled: false → the BYO setup form renders directly.
  return { cloudInstance: { mode: 'local' }, managedCloudEnabled: false } as AppSettings;
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

function setupNeededConnection() {
  return {
    mode: 'local',
    isConnected: false,
    isSetupNeeded: true,
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
    // managed:false → BYO branch (where the region picker lives) renders.
    providerConfig: { id: 'fly', name: 'Fly.io', managed: false, costBlurb: 'Pay Fly directly.' },
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
    selectedRegion: 'lhr',
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
    footprint: { kind: 'measured_zero', appDataBytes: 0 },
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

function setupByoFly(provisioningOverrides: Record<string, unknown> = {}) {
  mockState.connection = setupNeededConnection();
  mockState.sync = baseSync();
  mockState.provisioning = baseProvisioning(provisioningOverrides);
  mockState.capacity = baseCapacity();
  return settings();
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

describe('CloudTab — BYO Fly region picker', () => {
  it('renders a region <select> with the hook default selected', () => {
    const draft = setupByoFly();
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    const select = container.querySelector('[data-testid="setup-region-select"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    // Default reflects the hook's selectedRegion (detectNearestRegion() output).
    expect(select!.value).toBe('lhr');

    unmount();
  });

  it('renders every MANAGED_REGIONS option (parity with the managed picker)', () => {
    const draft = setupByoFly();
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    const select = container.querySelector('[data-testid="setup-region-select"]') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toEqual(MANAGED_REGIONS.map((r) => r.value));
    // iad must be a selectable option so a user defaulted there can move off it.
    expect(optionValues).toContain('iad');

    unmount();
  });

  it('calls setSelectedRegion when a new region is chosen', () => {
    const setSelectedRegion = vi.fn();
    const draft = setupByoFly({ setSelectedRegion });
    const { container, unmount } = mount(<CloudTab draftSettings={draft} updateDraft={vi.fn()} />);

    const select = container.querySelector('[data-testid="setup-region-select"]') as HTMLSelectElement;
    act(() => {
      select.value = 'fra';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setSelectedRegion).toHaveBeenCalledWith('fra');

    unmount();
  });
});
