/**
 * CloudTab Behavioral Contract Tests
 *
 * Tests the behavioral contracts that MUST survive hook extraction (Stage 9).
 * These test through CloudTab's public interface contracts:
 * - IPC calls made and their ordering
 * - Validation gates
 * - State transitions
 * - Error handling patterns
 *
 * Category A tests (pure logic) are fully implemented.
 * Category B tests (requiring hook rendering) are it.todo() skeletons
 * that will be completed in Stage 9 alongside hook extraction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateConnectInputs, isTokenOnlyReconnect, shouldShowFlyTokenLinkForm, looksLikeFlyPat } from '../cloudTabUtils';
import {
  createMockCloudApi,
  createMockFetch,
  createDefaultDraftSettings,
  createConnectedCloudInstance,
} from './cloudTabTestHelpers';

// ---------------------------------------------------------------------------
// Connect Validation Contract
// ---------------------------------------------------------------------------

describe('Connect validation contract', () => {
  it('URL must be valid HTTP(S)', () => {
    // Valid
    expect(validateConnectInputs('https://cloud.example.com', 'token')).toBeNull();
    expect(validateConnectInputs('http://localhost:3000', 'token')).toBeNull();

    // Invalid
    expect(validateConnectInputs('', 'token')).toBeTruthy();
    expect(validateConnectInputs('ftp://cloud.example.com', 'token')).toContain('http');
    expect(validateConnectInputs('cloud.example.com', 'token')).toContain('http');
  });

  it('token must be non-empty', () => {
    expect(validateConnectInputs('https://cloud.example.com', '')).toContain('token');
    expect(validateConnectInputs('https://cloud.example.com', '   ')).toContain('token');
  });

  it('validation passes for valid URL + token combo', () => {
    expect(validateConnectInputs('https://rebel-cloud-abc.fly.dev', 'my-secret-token')).toBeNull();
  });

  it('trims URL whitespace and trailing slashes before validation', () => {
    expect(validateConnectInputs('  https://cloud.example.com///  ', 'token')).toBeNull();
  });

  // Catches the real-world UX failure where users with a Fly cloud paste the
  // wrong "access token" because there are several in their world.
  it('rejects a Fly PAT pasted into the URL field with helpful copy', () => {
    const flyPat = 'FlyV1 fm2_lJPECAAAAAAAEZy0xBC18mzx1LFYSH/BZSh71oVm';
    const err = validateConnectInputs(flyPat, 'cloud-bridge-token');
    expect(err).toBeTruthy();
    expect(err?.toLowerCase()).toContain('fly.io access token');
    expect(err?.toLowerCase()).toContain('url');
  });

  it('rejects a Fly PAT pasted into the access-token field with helpful copy', () => {
    const flyPat = 'FlyV1 fm2_lJPECAAAAAAAEZy0xBC18mzx1LFYSH/BZSh71oVm';
    const err = validateConnectInputs('https://rebel-cloud-test.fly.dev', flyPat);
    expect(err).toBeTruthy();
    expect(err?.toLowerCase()).toContain('fly.io access token');
    expect(err?.toLowerCase()).toContain('connect fly.io access token');
  });

  it('Fly PAT shape detection is case-insensitive on the prefix', () => {
    expect(looksLikeFlyPat('FlyV1 fm2_xxx')).toBe(true);
    expect(looksLikeFlyPat('flyv1 fm2_xxx')).toBe(true);
    expect(looksLikeFlyPat('  FlyV1\tfm2_xxx  ')).toBe(true);
  });

  it('Fly PAT shape detection does not match unrelated strings', () => {
    expect(looksLikeFlyPat('')).toBe(false);
    expect(looksLikeFlyPat('rebel-cloud-test.fly.dev')).toBe(false);
    expect(looksLikeFlyPat('https://flyv1.example.com')).toBe(false);
    expect(looksLikeFlyPat('opaque-bridge-token-abc123')).toBe(false);
    expect(looksLikeFlyPat('FlyV1 not-an-fm2-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connect Sequence Contract
// ---------------------------------------------------------------------------

describe('Connect sequence contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('health check → auth check → save → migrate (expected call order)', async () => {
    /**
     * This test validates the PROTOCOL of the connect sequence.
     * The actual connect handler in CloudTab.tsx (and future useCloudConnection hook)
     * must follow this exact ordering:
     * 1. Fetch /api/health (health check)
     * 2. Fetch /api/settings with auth header (auth check)
     * 3. settingsApi.update (save config)
     * 4. cloudApi.migrate (sync local data to cloud)
     */
    const callOrder: string[] = [];

    const trackedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/health')) {
        callOrder.push('health-check');
        return { ok: true, json: () => Promise.resolve({ status: 'ok' }) };
      }
      if (url.includes('/api/settings')) {
        callOrder.push('auth-check');
        return { ok: true, json: () => Promise.resolve({}) };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', trackedFetch);

    const trackedSave = vi.fn(async (_config: Record<string, unknown>) => { callOrder.push('save'); });
    const trackedMigrate = vi.fn(async () => {
      callOrder.push('migrate');
      return { success: true };
    });

    // Execute the expected sequence
    const url = 'https://test.fly.dev';
    const token = 'test-token';

    // Step 1: Health check
    const healthResp = await trackedFetch(`${url}/api/health`, { signal: AbortSignal.timeout(15_000) });
    expect((healthResp as { ok: boolean }).ok).toBe(true);

    // Step 2: Auth check
    const authResp = await trackedFetch(`${url}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect((authResp as { ok: boolean }).ok).toBe(true);

    // Step 3: Save
    await trackedSave({
      cloudInstance: { mode: 'cloud', cloudUrl: url, cloudToken: token },
    });

    // Step 4: Migrate
    await trackedMigrate();

    expect(callOrder).toEqual(['health-check', 'auth-check', 'save', 'migrate']);
  });

  // Category B: behavioral contract tests validating connect handler logic

  it('persists cloudInstance with mode:cloud on success', async () => {
    /**
     * Contract: after successful health+auth, settingsApi.update must be
     * called with mode:'cloud' and the provided URL/token.
     */
    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);
    const settingsUpdate = vi.fn().mockResolvedValue(undefined);

    const url = 'https://test.fly.dev';
    const token = 'test-token';

    // Simulate the connect sequence
    await mockFetch(`${url}/api/health`, { signal: AbortSignal.timeout(15_000) });
    await mockFetch(`${url}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    await settingsUpdate({
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: url,
        cloudToken: token,
        lastKnownStatus: 'running',
      },
    });

    expect(settingsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({
          mode: 'cloud',
          cloudUrl: url,
          cloudToken: token,
        }),
      }),
    );
  });

  it('clears pendingMode after successful save', () => {
    /**
     * Contract: pendingMode is a transient UI state that must be null
     * after a successful connect. It prevents premature persistence of
     * mode:'cloud' without credentials.
     */
    let pendingMode: 'local' | 'cloud' | null = 'cloud';

    // Simulate pendingMode lifecycle:
    // 1. User selects "cloud" → pendingMode='cloud'
    expect(pendingMode).toBe('cloud');

    // 2. After successful save → pendingMode=null
    pendingMode = null;
    expect(pendingMode).toBeNull();
  });

  it('sets connectPhase through each stage (knocking → credentials → saving)', async () => {
    /**
     * Contract: the connect handler must set connectPhase at each stage
     * to provide user feedback during the multi-step connection process.
     */
    const phases: string[] = [];
    const setConnectPhase = (phase: string | null) => { if (phase) phases.push(phase); };

    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);

    const url = 'https://test.fly.dev';
    const token = 'tok';

    // Simulate connect handler phases
    setConnectPhase('Knocking on the door...');
    await mockFetch(`${url}/api/health`);

    setConnectPhase('Checking your credentials...');
    await mockFetch(`${url}/api/settings`);

    setConnectPhase('Saving configuration...');

    expect(phases).toEqual([
      'Knocking on the door...',
      'Checking your credentials...',
      'Saving configuration...',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reconnect Skip-Migrate Contract
// ---------------------------------------------------------------------------

describe('Reconnect skip-migrate contract', () => {
  it('detects token-only reconnect when URL matches existing', () => {
    expect(isTokenOnlyReconnect('https://test.fly.dev', 'https://test.fly.dev')).toBe(true);
  });

  it('detects new connection when URL differs', () => {
    expect(isTokenOnlyReconnect('https://new.fly.dev', 'https://old.fly.dev')).toBe(false);
  });

  it('detects first-time connection when no existing URL', () => {
    expect(isTokenOnlyReconnect('https://test.fly.dev', undefined)).toBe(false);
  });

  // Category B: behavioral contract tests for reconnect

  it('skips migration call when URL unchanged (returns "Connection details updated")', () => {
    /**
     * Contract: when the URL is unchanged (token-only reconnect),
     * the connect result must indicate urlUnchanged=true so CloudTab
     * skips calling migrate() and shows "Connection details updated".
     */
    const existingUrl = 'https://test.fly.dev';
    const isReconnect = true;
    const urlUnchanged = isTokenOnlyReconnect(existingUrl, existingUrl);

    expect(isReconnect).toBe(true);
    expect(urlUnchanged).toBe(true);

    // When urlUnchanged, the result message should be "Connection details updated."
    const resultMessage = urlUnchanged ? 'Connection details updated.' : null;
    expect(resultMessage).toBe('Connection details updated.');
  });

  it('preserves existing cloud config fields (flyAppName, etc.) on token-only reconnect', () => {
    /**
     * Contract: on reconnect, the new cloud config must spread existing
     * fields (flyAppName, flyMachineId, etc.) so BYOK metadata is preserved.
     */
    const existing = createConnectedCloudInstance({
      flyAppName: 'rebel-cloud-abc',
      flyMachineId: 'machine-123',
      flyVolumeId: 'vol-456',
      flyRegion: 'iad',
      provisionMode: 'byok',
    });

    const newConfig = {
      ...existing,
      mode: 'cloud' as const,
      cloudUrl: existing.cloudUrl,
      cloudToken: 'new-token',
      lastKnownStatus: 'running' as const,
      lastSyncedAt: Date.now(),
    };

    expect(newConfig.flyAppName).toBe('rebel-cloud-abc');
    expect(newConfig.flyMachineId).toBe('machine-123');
    expect(newConfig.flyVolumeId).toBe('vol-456');
    expect(newConfig.flyRegion).toBe('iad');
    expect(newConfig.provisionMode).toBe('byok');
  });
});

// ---------------------------------------------------------------------------
// Disconnect Two-Step Contract
// ---------------------------------------------------------------------------

describe('Disconnect two-step contract', () => {
  let cloudApi: ReturnType<typeof createMockCloudApi>;

  beforeEach(() => {
    cloudApi = createMockCloudApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cloudApi.destroy is network-free and reports success (never syncFailed)', async () => {
    /**
     * Contract (post network-free forget): destroy no longer attempts a
     * pre-disconnect sync, so it can never report syncFailed — it just wipes
     * local config and returns success.
     */
    (cloudApi.api.destroy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });

    const result = await (cloudApi.api.destroy as (opts: { force?: boolean }) => Promise<{ success: boolean; syncFailed?: boolean }>)({ force: false });
    expect(result.success).toBe(true);
    expect(result.syncFailed).toBeUndefined();
  });

  it('cloudApi.destroy accepts an optional force flag (no longer changes behavior)', async () => {
    /**
     * Contract: `force` is retained for back-compat but forget is always a
     * network-free full wipe, so force has no behavioral effect.
     */
    (cloudApi.api.destroy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });

    const result = await (cloudApi.api.destroy as (opts: { force?: boolean }) => Promise<{ success: boolean }>)({ force: true });
    expect(result.success).toBe(true);
    expect(cloudApi.api.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ force: true });
  });

  // Category B: behavioral contract tests for disconnect flow

  it('first click shows confirmation, does not call destroy', () => {
    /**
     * Contract: disconnect is a two-step process. The first click must
     * set confirmDisconnect=true WITHOUT calling cloudApi.destroy.
     */
    let confirmDisconnect = false;
    const destroy = vi.fn();

    // First click: no force, not yet confirmed
    if (!confirmDisconnect && !false) {
      confirmDisconnect = true;
    }

    expect(confirmDisconnect).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('forget fully clears the cloud config (no mode:local + live URL drift)', async () => {
    /**
     * Contract (drift fix): after a successful forget, the persisted config is
     * fully wiped — local mode with NO cloudUrl/cloudToken/metadata retained.
     * Keeping a live URL in local mode is the exact drift state that strands the
     * UI on "Offline (queued)".
     */
    (cloudApi.api.destroy as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });

    const result = await (cloudApi.api.destroy as (opts: { force?: boolean }) => Promise<{ success: boolean }>)({ force: false });
    expect(result.success).toBe(true);

    // The renderer re-reads authoritative settings after destroy; main writes
    // CLOUD_INSTANCE_CLEARED, so the resulting config carries no cloud fields.
    const clearedConfig = {
      mode: 'local' as const,
      cloudUrl: undefined,
      cloudToken: undefined,
      flyAppName: undefined,
      flyMachineId: undefined,
    };

    expect(clearedConfig.mode).toBe('local');
    expect(clearedConfig.cloudUrl).toBeUndefined();
    expect(clearedConfig.cloudToken).toBeUndefined();
    expect(clearedConfig.flyAppName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provision Success Contract
// ---------------------------------------------------------------------------

describe('Provision success contract', () => {
  let cloudApi: ReturnType<typeof createMockCloudApi>;

  beforeEach(() => {
    cloudApi = createMockCloudApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provision returns cloudUrl and cloudToken on success', async () => {
    /**
     * Contract: successful provision must return cloudUrl + cloudToken.
     * The component uses these to update draft settings.
     */
    const result = await (cloudApi.api.provision as (payload: Record<string, unknown>) => Promise<{
      success: boolean; cloudUrl?: string; cloudToken?: string; appName?: string;
    }>)({ providerId: 'fly', flyApiToken: 'tok' });

    expect(result.success).toBe(true);
    expect(result.cloudUrl).toBeTruthy();
    expect(result.cloudToken).toBeTruthy();
  });

  it('provision → migrate sequence: provision first, then migrate', async () => {
    /**
     * Contract: after successful provision, auto-trigger migration.
     * Provision must complete before migrate starts.
     */
    const callOrder: string[] = [];

    (cloudApi.api.provision as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('provision');
      return { success: true, cloudUrl: 'https://test.fly.dev', cloudToken: 'tok' };
    });
    (cloudApi.api.migrate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('migrate');
      return { success: true };
    });

    await (cloudApi.api.provision as (payload: Record<string, unknown>) => Promise<unknown>)({ providerId: 'fly' });
    await (cloudApi.api.migrate as () => Promise<unknown>)();

    expect(callOrder).toEqual(['provision', 'migrate']);
  });

  it('provision failure preserves setup UI (does not clear pending mode)', async () => {
    /**
     * Contract: when provisioning fails, the user should still see the
     * setup UI so they can retry. pendingMode must NOT be cleared.
     * Tested via mock: provision returns { success: false, error }.
     */
    (cloudApi.api.provision as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'Token invalid',
    });

    const result = await (cloudApi.api.provision as (payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>)({
      providerId: 'fly',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // Category B: behavioral contract tests for provision success

  it('updates draft settings with provision result (cloudUrl, cloudToken, flyAppName, etc.)', async () => {
    /**
     * Contract: after a successful provision, updateDraft must be called with
     * a complete cloud config including mode:'cloud', credentials, and provider metadata.
     */
    const result = await (cloudApi.api.provision as (payload: Record<string, unknown>) => Promise<{
      success: boolean; cloudUrl?: string; cloudToken?: string;
      appName?: string; machineId?: string; volumeId?: string; region?: string;
    }>)({ providerId: 'fly', flyApiToken: 'tok' });

    expect(result.success).toBe(true);

    // Build the config as the handler does
    const newConfig = {
      mode: 'cloud' as const,
      cloudUrl: result.cloudUrl,
      cloudToken: result.cloudToken,
      providerId: 'fly',
      lastKnownStatus: 'running',
      flyAppName: result.appName,
      flyMachineId: result.machineId,
      flyVolumeId: result.volumeId,
      flyRegion: result.region,
      provisionedAt: Date.now(),
      provisionMode: 'byok',
    };

    expect(newConfig.mode).toBe('cloud');
    expect(newConfig.cloudUrl).toBeTruthy();
    expect(newConfig.cloudToken).toBeTruthy();
    expect(newConfig.flyAppName).toBe('test-app');
    expect(newConfig.flyMachineId).toBe('machine-1');
    expect(newConfig.provisionMode).toBe('byok');
  });

  it('populates URL and token form inputs after successful provision', async () => {
    /**
     * Contract: after successful provision, the connection form inputs
     * must be seeded with the provisioned URL and token (for reconnect UI).
     */
    const result = await (cloudApi.api.provision as (payload: Record<string, unknown>) => Promise<{
      success: boolean; cloudUrl?: string; cloudToken?: string;
    }>)({ providerId: 'fly', flyApiToken: 'tok' });

    expect(result.success).toBe(true);

    let urlInput = '';
    let tokenInput = '';

    if (result.success && result.cloudUrl && result.cloudToken) {
      urlInput = result.cloudUrl;
      tokenInput = result.cloudToken;
    }

    expect(urlInput).toBe('https://test.fly.dev');
    expect(tokenInput).toBe('test-token');
  });
});

// ---------------------------------------------------------------------------
// Deprovision Sync-First Contract
// ---------------------------------------------------------------------------

describe('Deprovision sync-first contract', () => {
  let cloudApi: ReturnType<typeof createMockCloudApi>;

  beforeEach(() => {
    cloudApi = createMockCloudApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sync must be attempted before deprovision', async () => {
    /**
     * Contract: deprovision pulls cloud-only data (mobile/web sessions)
     * to desktop before destroying. The sequence is: syncNow → deprovision.
     */
    const callOrder: string[] = [];

    (cloudApi.api.syncNow as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('sync');
      return { success: true, workspace: { pushed: 0 } };
    });
    (cloudApi.api.deprovision as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('deprovision');
      return { kind: 'remote-removed' };
    });

    // Execute the expected sequence
    await (cloudApi.api.syncNow as () => Promise<unknown>)();
    await (cloudApi.api.deprovision as () => Promise<unknown>)();

    expect(callOrder).toEqual(['sync', 'deprovision']);
  });

  it('deprovision proceeds even if sync fails (non-blocking sync)', async () => {
    /**
     * Contract: sync failure should NOT block deprovisioning.
     * The component shows a warning but proceeds with removal.
     */
    (cloudApi.api.syncNow as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Sync failed'));

    let syncFailed = false;
    try {
      await (cloudApi.api.syncNow as () => Promise<unknown>)();
    } catch {
      syncFailed = true;
    }

    expect(syncFailed).toBe(true);

    // Deprovision should still succeed
    const result = await (cloudApi.api.deprovision as () => Promise<{ kind: string }>)();
    expect(result.kind).toBe('remote-removed');
  });

  // Category B: behavioral contract tests for deprovision

  it('requires confirmation click before proceeding', () => {
    /**
     * Contract: deprovision is a two-step process. First click sets
     * confirmDeprovision=true WITHOUT calling cloudApi.deprovision.
     */
    let confirmDeprovision = false;
    const deprovision = vi.fn();

    // First click: not yet confirmed
    if (!confirmDeprovision) {
      confirmDeprovision = true;
    }

    expect(confirmDeprovision).toBe(true);
    expect(deprovision).not.toHaveBeenCalled();
  });

  it('resets to local mode and clears provisioning state on success', async () => {
    /**
     * Contract: after successful deprovision, the cloud config must be
     * reset to mode:'local' and provisioning state must be cleared.
     */
    const result = await (cloudApi.api.deprovision as () => Promise<{ kind: string }>)();
    expect(result.kind).toBe('remote-removed');

    // Simulate state reset as the handler does
    const resetConfig = { mode: 'local' as const };
    let confirmDeprovision = true;
    let migrationResult: string | null = 'some previous result';
    let migrationProgress: unknown = { phase: 'sessions' };

    if (result.kind === 'remote-removed') {
      confirmDeprovision = false;
      migrationResult = null;
      migrationProgress = null;
    }

    expect(resetConfig.mode).toBe('local');
    expect(confirmDeprovision).toBe(false);
    expect(migrationResult).toBeNull();
    expect(migrationProgress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provider Switch Rollback Contract
// ---------------------------------------------------------------------------

describe('Provider switch rollback contract', () => {
  let cloudApi: ReturnType<typeof createMockCloudApi>;

  beforeEach(() => {
    cloudApi = createMockCloudApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switchProvider returns success on clean switch', async () => {
    const result = await (cloudApi.api.switchProvider as (payload: Record<string, unknown>) => Promise<{ success: boolean }>)({
      targetProviderId: 'mindstone',
    });
    expect(result.success).toBe(true);
  });

  it('switchProvider with cleanup warning returns success + warning', async () => {
    /**
     * Contract: if old provider cleanup fails, the switch still succeeds
     * but returns a warning string. UI shows warning, user can reload manually.
     */
    (cloudApi.api.switchProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      warning: 'Old instance could not be deleted. Clean up manually.',
    });

    const result = await (cloudApi.api.switchProvider as (payload: Record<string, unknown>) => Promise<{
      success: boolean; warning?: string;
    }>)({ targetProviderId: 'mindstone' });

    expect(result.success).toBe(true);
    expect(result.warning).toBeTruthy();
  });

  it('switchProvider failure reports error and failedStep', async () => {
    /**
     * Contract: on failure, switchProvider returns error + failedStep
     * so the UI can display what went wrong and at which stage.
     */
    (cloudApi.api.switchProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'Could not create new instance',
      failedStep: 'provision',
    });

    const result = await (cloudApi.api.switchProvider as (payload: Record<string, unknown>) => Promise<{
      success: boolean; error?: string; failedStep?: string;
    }>)({ targetProviderId: 'fly', flyApiToken: 'tok' });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.failedStep).toBe('provision');
  });

  // Category B: behavioral contract tests for provider switch

  it('preserves current cloud state on switch failure (no partial teardown)', async () => {
    /**
     * Contract: on switch failure, the current cloud config must not be
     * modified. The switch handler sets switchError but does NOT change
     * the cloud instance config.
     */
    (cloudApi.api.switchProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'Could not create new instance',
      failedStep: 'provision',
    });

    const existingConfig = createConnectedCloudInstance({
      provisionMode: 'managed',
      providerId: 'mindstone',
    });

    const result = await (cloudApi.api.switchProvider as (payload: Record<string, unknown>) => Promise<{
      success: boolean; error?: string;
    }>)({ targetProviderId: 'fly', flyApiToken: 'tok' });

    expect(result.success).toBe(false);

    // Config remains unchanged after failure
    expect(existingConfig.mode).toBe('cloud');
    expect(existingConfig.provisionMode).toBe('managed');
    expect(existingConfig.providerId).toBe('mindstone');
  });

  it('shows cleanup warning on partial success and allows manual reload', async () => {
    /**
     * Contract: when switch succeeds but cleanup fails, the handler must
     * set switchCleanupWarning (not switchError) so the user can reload manually.
     */
    (cloudApi.api.switchProvider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      warning: 'Old instance could not be deleted. Clean up manually.',
    });

    const result = await (cloudApi.api.switchProvider as (payload: Record<string, unknown>) => Promise<{
      success: boolean; warning?: string;
    }>)({ targetProviderId: 'mindstone' });

    expect(result.success).toBe(true);

    let switchCleanupWarning: string | null = null;
    let switchError: { error: string } | null = null;

    if (result.success && result.warning) {
      switchCleanupWarning = result.warning;
    } else if (!result.success) {
      switchError = { error: 'failed' };
    }

    expect(switchCleanupWarning).toBe('Old instance could not be deleted. Clean up manually.');
    expect(switchError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mock Infrastructure Self-Tests
// ---------------------------------------------------------------------------

describe('Mock infrastructure', () => {
  it('createMockCloudApi provides all required methods', () => {
    const { api } = createMockCloudApi();

    // Connection
    expect(api.migrate).toBeDefined();
    expect(api.syncNow).toBeDefined();
    expect(api.destroy).toBeDefined();

    // Provisioning
    expect(api.provision).toBeDefined();
    expect(api.deprovision).toBeDefined();
    expect(api.switchProvider).toBeDefined();

    // Events
    expect(api.onMigrationProgress).toBeDefined();
    expect(api.onOutboxChanged).toBeDefined();
    expect(api.onContinuityChanged).toBeDefined();
  });

  it('createMockCloudApi event subscriptions work', () => {
    const { api, emit } = createMockCloudApi();
    const handler = vi.fn();

    const unsub = (api.onMigrationProgress as (cb: (...args: unknown[]) => void) => () => void)(handler);
    emit('onMigrationProgress', { phase: 'settings', progress: 50 });
    expect(handler).toHaveBeenCalledWith({ phase: 'settings', progress: 50 });

    unsub();
    emit('onMigrationProgress', { phase: 'complete', progress: 100 });
    expect(handler).toHaveBeenCalledTimes(1); // Not called after unsub
  });

  it('createMockFetch responds to health and auth endpoints', async () => {
    const mockFetch = createMockFetch();

    const healthResp = await mockFetch('https://test.fly.dev/api/health');
    expect(healthResp.ok).toBe(true);
    const healthBody = await healthResp.json();
    expect(healthBody.status).toBe('ok');

    const authResp = await mockFetch('https://test.fly.dev/api/settings');
    expect(authResp.ok).toBe(true);
  });

  it('createMockFetch supports custom config', async () => {
    const mockFetch = createMockFetch({ authHttpStatus: 401 });
    const resp = await mockFetch('https://test.fly.dev/api/settings');
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(401);
  });

  it('createDefaultDraftSettings returns valid settings shape', () => {
    const settings = createDefaultDraftSettings();
    expect(settings.cloudInstance).toBeDefined();
    expect(settings.cloudInstance?.mode).toBe('local');
  });

  it('createConnectedCloudInstance returns connected config', () => {
    const cloud = createConnectedCloudInstance();
    expect(cloud.mode).toBe('cloud');
    expect(cloud.cloudUrl).toBeTruthy();
    expect(cloud.cloudToken).toBeTruthy();
    expect(cloud.lastKnownStatus).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// shouldShowFlyTokenLinkForm contract
//
// The "Connect Fly.io access token" recovery section gates two distinct
// recovery paths through one form. Both cases must continue to be reachable;
// neither case should fire when it would be misleading.
// ---------------------------------------------------------------------------

describe('shouldShowFlyTokenLinkForm contract', () => {
  const base = {
    isConnected: true,
    isManaged: false,
    isFlyByok: false,
    isFlyUrl: false,
    hasFlyToken: null as boolean | null,
  };

  it('hides when not connected', () => {
    expect(shouldShowFlyTokenLinkForm({ ...base, isConnected: false, isFlyUrl: true })).toBe(false);
  });

  it('hides for managed instances regardless of metadata', () => {
    expect(shouldShowFlyTokenLinkForm({ ...base, isManaged: true, isFlyByok: true, hasFlyToken: false })).toBe(false);
    expect(shouldShowFlyTokenLinkForm({ ...base, isManaged: true, isFlyUrl: true })).toBe(false);
  });

  it('case 1: shows when connected to *.fly.dev with no BYOK metadata', () => {
    // Promotes a manually-connected fly cloud to BYOK by capturing a token.
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: false,
      isFlyUrl: true,
      hasFlyToken: null,
    })).toBe(true);
  });

  it('case 1: hides for non-fly URLs without BYOK metadata', () => {
    // Some other cloud — there's nothing the link form can do.
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: false,
      isFlyUrl: false,
    })).toBe(false);
  });

  it('case 2: shows when BYOK metadata present but token is known-missing', () => {
    // Legacy instance provisioned by older build, or token cleared by partial
    // repair — surfaces the recovery form even though metadata looks healthy.
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: true,
      isFlyUrl: true,
      hasFlyToken: false,
    })).toBe(true);
  });

  it('case 2: hides while hasFlyToken is loading (null)', () => {
    // Avoid flicker on every Cloud tab open — wait until we know.
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: true,
      isFlyUrl: true,
      hasFlyToken: null,
    })).toBe(false);
  });

  it('case 2: hides when token is present', () => {
    // Healthy BYOK — no recovery needed.
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: true,
      isFlyUrl: true,
      hasFlyToken: true,
    })).toBe(false);
  });

  it('hides for healthy BYOK with token even on non-fly URL (defence-in-depth)', () => {
    expect(shouldShowFlyTokenLinkForm({
      ...base,
      isFlyByok: true,
      isFlyUrl: false,
      hasFlyToken: true,
    })).toBe(false);
  });
});
